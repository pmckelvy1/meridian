import os
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from flask import Flask, jsonify, request
from datetime import datetime
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
from typing import List, Dict, Any
from pydantic import BaseModel, Field
import requests
from helpers import process_story, get_brief_prompt, get_title_prompt, get_tldr_prompt, brief_system_prompt, average_pool

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

@app.route('/api/process-events', methods=['GET'])
def process_events():
    """Fetch, process and cluster events for a given date"""
    date = request.args.get('date')
    sources, events = get_events(date=date)
    
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
    
    articles_df["cluster"] = cluster_labels.tolist()  # Convert to list for JSON serialization
    
    return jsonify({
        "sources": [source.model_dump(mode='json') for source in sources],
        "events": [event.model_dump(mode='json') for event in events],
        "clusters": articles_df.to_dict(orient='records'),
        "cluster_labels": cluster_labels.tolist()  # Convert to list for JSON serialization
    })

@app.route('/api/generate-brief', methods=['POST'])
def generate_brief():
    """Generate a brief from processed events"""
    data = request.json
    clusters = data['clusters']
    events = data['events']
    
    # Process clusters into stories
    clusters_with_articles = []
    # Get unique cluster IDs excluding -1
    unique_clusters = set(article['cluster'] for article in clusters) - {-1}
    
    for cluster_id in unique_clusters:
        # Filter articles for this cluster
        cluster_articles = [article for article in clusters if article['cluster'] == cluster_id]
        articles_ids = [article['id'] for article in cluster_articles]
        clusters_with_articles.append({
            "cluster_id": cluster_id,
            "articles_ids": articles_ids
        })
    
    # Sort clusters by size
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
    
    # Generate brief outline
    outline_response = call_llm(
        model="gemini-2.0-flash",
        messages=[
            {"role": "system", "content": brief_system_prompt},
            {"role": "user", "content": get_brief_prompt(cleaned_clusters, "")}
        ],
        temperature=0.0
    )
    
    # Generate full brief
    brief_response = call_llm(
        model="gemini-2.5-pro-preview-03-25",
        messages=[
            {"role": "system", "content": brief_system_prompt},
            {"role": "user", "content": get_brief_prompt(cleaned_clusters, outline_response[0])}
        ],
        temperature=0.0
    )
    
    # Generate title
    title_response = call_llm(
        model="gemini-2.0-flash",
        messages=[
            {"role": "user", "content": get_title_prompt(brief_response[0])}
        ],
        temperature=0.0
    )
    
    # Generate TL;DR
    tldr_response = call_llm(
        model="gemini-2.0-flash",
        messages=[
            {"role": "user", "content": get_tldr_prompt(brief_response[0])}
        ],
        temperature=0.0
    )
    
    return jsonify({
        "title": title_response[0],
        "content": brief_response[0],
        "tldr": tldr_response[0],
        "stories": cleaned_clusters
    })

@app.route('/api/publish', methods=['POST'])
def publish_report():
    """Publish the final report"""
    data = request.json
    report = {
        "title": data['title'],
        "content": data['content'],
        "totalArticles": len(data['events']),
        "totalSources": len(data['sources']),
        "usedArticles": len(data['used_articles']),
        "usedSources": len(data['used_sources']),
        "tldr": data['tldr'],
        "model_author": "gemini-2.5-pro-preview-03-25",
        "createdAt": datetime.now().isoformat(),
        "clustering_params": CLUSTERING_PARAMS
    }
    
    response = requests.post(
        "https://meridian-production.pmckelvy1.workers.dev/reports/report",
        json=report,
        headers={"Authorization": f"Bearer {os.environ.get('MERIDIAN_SECRET_KEY')}"}
    )
    
    return jsonify(response.json())

if __name__ == '__main__':
    app.run(debug=True) 