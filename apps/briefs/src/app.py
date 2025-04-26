import os
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from flask import Flask, jsonify, request
from datetime import datetime, timedelta
from dotenv import load_dotenv
from events import get_events
from llm import call_llm
import pandas as pd
import torch
import torch.nn.functional as F
import numpy as np
from transformers import AutoTokenizer, AutoModel
from tqdm import tqdm
import hdbscan
import umap
from concurrent.futures import ThreadPoolExecutor
import json
from typing import List, Dict, Any, Tuple
from pydantic import BaseModel, Field
import requests
from helpers import process_story, get_brief_prompt, get_title_prompt, get_tldr_prompt, brief_system_prompt, average_pool
import pytz

load_dotenv()

app = Flask(__name__)

# Models
tokenizer = AutoTokenizer.from_pretrained('intfloat/multilingual-e5-small')
model = AutoModel.from_pretrained('intfloat/multilingual-e5-small')

# Constants
BATCH_SIZE = 64
CLUSTERING_PARAMS = {
    "umap": {
        "n_neighbors": 5
    },
    "hdbscan": {
        "epsilon": 0.0,
        "min_samples": 2,
        "min_cluster_size": 2
    }
}

# Cycle break times in EST
CYCLE_BREAKS = [6, 14, 22]  # 6am, 2pm, 10pm EST

def get_cycle_boundaries(dt: datetime) -> Tuple[datetime, datetime]:
    """Get the start and end times of the cycle that ended before the given datetime."""
    # Convert to EST
    est = pytz.timezone('US/Eastern')
    dt_est = dt.astimezone(est)
    
    # Find the most recent cycle break
    current_hour = dt_est.hour
    cycle_end_hour = max(h for h in CYCLE_BREAKS if h <= current_hour)
    if cycle_end_hour > current_hour:
        cycle_end_hour = CYCLE_BREAKS[-1]
        dt_est = dt_est - timedelta(days=1)
    
    # Set cycle end time
    cycle_end = dt_est.replace(hour=cycle_end_hour, minute=0, second=0, microsecond=0)
    
    # Set cycle start time (8 hours before end)
    cycle_start = cycle_end - timedelta(hours=8)
    
    return cycle_start, cycle_end

def get_events_for_cycle(cycle_start: datetime, cycle_end: datetime) -> Tuple[List[Any], List[Any]]:
    """Get events that occurred within the specified cycle."""
    sources, events = get_events()
    
    # Filter events to only include those within the cycle
    cycle_events = [
        event for event in events
        if cycle_start <= event.publishDate <= cycle_end
    ]
    
    return sources, cycle_events

@app.route('/api/generate-report', methods=['GET'])
def generate_report():
    """Generate a complete report from events for a given datetime"""
    date_str = request.args.get('date')
    if not date_str:
        return jsonify({"error": "Date parameter is required"}), 400
    
    try:
        # Parse the datetime
        dt = datetime.fromisoformat(date_str)
        
        # Get cycle boundaries
        cycle_start, cycle_end = get_cycle_boundaries(dt)
        
        # Check if a report already exists for this cycle
        response = requests.get(
            f"https://meridian-production.pmckelvy1.workers.dev/reports/cycle",
            params={
                "cycle_start": cycle_start.isoformat(),
                "cycle_end": cycle_end.isoformat()
            },
            headers={"Authorization": f"Bearer {os.environ.get('MERIDIAN_SECRET_KEY')}"}
        )
        
        if response.status_code == 200:
            return jsonify(response.json())
        
        # Step 1: Fetch and process events for this cycle
        sources, events = get_events_for_cycle(cycle_start, cycle_end)
        
        # Process events into DataFrame
        articles_df = pd.DataFrame(events)
        for col in articles_df.columns:
            articles_df[col] = articles_df[col].apply(
                lambda x: x[1] if isinstance(x, tuple) else x
            )
        articles_df.columns = [
            "id", "sourceId", "url", "title", "publishDate", 
            "content", "location", "relevance", "completeness", "summary"
        ]
        
        # Clean up summaries
        articles_df["summary"] = (
            articles_df["summary"]
            .str.split("EVENT:")
            .str[1]
            .str.split("CONTEXT:")
            .str[0]
            .str.strip()
        )
        articles_df["text_to_embed"] = "query: " + articles_df["summary"]
        
        # Generate embeddings
        all_embeddings = []
        for i in tqdm(range(0, len(articles_df), BATCH_SIZE)):
            batch_texts = articles_df['text_to_embed'].iloc[i:i+BATCH_SIZE].tolist()
            batch_dict = tokenizer(batch_texts, max_length=512, padding=True, truncation=True, return_tensors='pt')
            
            with torch.no_grad():
                outputs = model(**batch_dict)
            
            embeddings = average_pool(outputs.last_hidden_state, batch_dict['attention_mask'])
            embeddings = F.normalize(embeddings, p=2, dim=1)
            all_embeddings.extend(embeddings.numpy())
        
        # Convert embeddings to lists for JSON serialization
        articles_df['embedding'] = [embedding.tolist() for embedding in all_embeddings]
        
        # Apply UMAP and HDBSCAN
        umap_embeddings = umap.UMAP(
            n_neighbors=CLUSTERING_PARAMS['umap']['n_neighbors'],
            n_components=10,
            min_dist=0.0,
            metric="cosine",
        ).fit_transform(all_embeddings)
        
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=CLUSTERING_PARAMS['hdbscan']['min_cluster_size'],
            min_samples=CLUSTERING_PARAMS['hdbscan']['min_samples'],
            cluster_selection_epsilon=CLUSTERING_PARAMS['hdbscan']['epsilon'],
            metric="euclidean",
            prediction_data=True,
        )
        cluster_labels = clusterer.fit_predict(umap_embeddings)
        
        articles_df["cluster"] = cluster_labels.tolist()
        clusters = articles_df.to_dict(orient='records')

        # Step 2: Process clusters into stories
        clusters_with_articles = []
        unique_clusters = set(article['cluster'] for article in clusters) - {-1}
        
        for cluster_id in unique_clusters:
            cluster_articles = [article for article in clusters if article['cluster'] == cluster_id]
            articles_ids = [article['id'] for article in cluster_articles]
            clusters_with_articles.append({
                "cluster_id": cluster_id,
                "articles_ids": articles_ids
            })
        
        clusters_with_articles = sorted(clusters_with_articles, key=lambda x: len(x['articles_ids']), reverse=True)
        
        # Process stories in parallel
        with ThreadPoolExecutor() as executor:
            futures = [executor.submit(process_story, story, events) for story in clusters_with_articles]
            cleaned_clusters_raw = list(tqdm(
                (future.result() for future in futures),
                total=len(futures),
                desc="Processing stories",
            ))
        
        # Process and clean clusters
        cleaned_clusters = []
        for i in range(len(clusters_with_articles)):
            base = clusters_with_articles[i]
            res = cleaned_clusters_raw[i][0]
            
            if res.answer == "single_story":
                article_ids = base["articles_ids"]
                article_ids = [x for x in article_ids if x not in res.outliers]
                
                cleaned_clusters.append({
                    "id": len(cleaned_clusters),
                    "title": res.title,
                    "importance": res.importance,
                    "articles": article_ids,
                })
            elif res.answer == "collection_of_stories":
                for story in res.stories:
                    cleaned_clusters.append({
                        "id": len(cleaned_clusters),
                        "title": story.title,
                        "importance": story.importance,
                        "articles": story.articles,
                    })
        
        # Step 3: Generate brief content
        outline_response = call_llm(
            model="gemini-2.0-flash",
            messages=[
                {"role": "system", "content": brief_system_prompt},
                {"role": "user", "content": get_brief_prompt(cleaned_clusters, "")}
            ],
            temperature=0.0
        )
        
        brief_response = call_llm(
            model="gemini-2.5-pro-preview-03-25",
            messages=[
                {"role": "system", "content": brief_system_prompt},
                {"role": "user", "content": get_brief_prompt(cleaned_clusters, outline_response[0])}
            ],
            temperature=0.0
        )
        
        title_response = call_llm(
            model="gemini-2.0-flash",
            messages=[
                {"role": "user", "content": get_title_prompt(brief_response[0])}
            ],
            temperature=0.0
        )
        
        tldr_response = call_llm(
            model="gemini-2.0-flash",
            messages=[
                {"role": "user", "content": get_tldr_prompt(brief_response[0])}
            ],
            temperature=0.0
        )

        # Step 4: Prepare and publish report
        used_articles = set()
        used_sources = set()
        for cluster in cleaned_clusters:
            used_articles.update(cluster['articles'])
            for article in events:
                if article.id in cluster['articles']:
                    used_sources.add(article.sourceId)

        report = {
            "title": title_response[0],
            "content": brief_response[0],
            "totalArticles": len(events),
            "totalSources": len(sources),
            "usedArticles": len(used_articles),
            "usedSources": len(used_sources),
            "tldr": tldr_response[0],
            "model_author": "gemini-2.5-pro-preview-03-25",
            "createdAt": datetime.now().isoformat(),
            "cycle_start": cycle_start.isoformat(),
            "cycle_end": cycle_end.isoformat(),
            "clustering_params": CLUSTERING_PARAMS
        }
        
        # Publish report
        response = requests.post(
            "https://meridian-production.pmckelvy1.workers.dev/reports/report",
            json=report,
            headers={"Authorization": f"Bearer {os.environ.get('MERIDIAN_SECRET_KEY')}"}
        )
        
        return jsonify({
            "report": report,
            "publish_response": response.json()
        })
        
    except ValueError as e:
        return jsonify({"error": f"Invalid date format: {str(e)}"}), 400
    except Exception as e:
        return jsonify({"error": f"An error occurred: {str(e)}"}), 500

if __name__ == '__main__':
    app.run(debug=True) 