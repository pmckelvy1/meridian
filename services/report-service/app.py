import os
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from flask import Flask, jsonify, request
from datetime import datetime, timedelta
from dotenv import load_dotenv
from src.events import get_events
from src.llm import call_llm
import pandas as pd
import torch
import torch.nn.functional as F
import numpy as np
from transformers import AutoTokenizer, AutoModel
from tqdm import tqdm
import hdbscan
import umap
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Any, Tuple, Optional
from pydantic import BaseModel, Field
import requests
import uuid
import boto3
from src.helpers import process_story, get_brief_prompt, get_title_prompt, get_tldr_prompt, brief_system_prompt, average_pool
import pytz
import nltk
from nltk.tokenize import sent_tokenize
import asyncio
from google.cloud import texttospeech_v1

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
DEFAULT_CYCLE_DURATION = 8

# TTS Functions
def chunk_text_by_sentences(text: str, max_chars: int = 5000) -> list:
    """
    Split text into chunks of <= max_chars, breaking at sentence boundaries.
    """
    sentences = sent_tokenize(text)
    chunks = []
    current_chunk = ''
    for sentence in sentences:
        if len(current_chunk) + len(sentence) + 1 > max_chars:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence
        else:
            if current_chunk:
                current_chunk += ' '
            current_chunk += sentence
    if current_chunk:
        chunks.append(current_chunk.strip())
    return chunks

async def generate_speech_google(text: str, voice_id: Optional[str] = None, language_code: Optional[str] = None) -> bytes:
    """
    Generate speech from text using Google Cloud Text-to-Speech API.
    Handles chunking if text exceeds 5000 characters.
    Args:
        text: The text to convert to speech
        voice_id: Optional voice name (e.g., 'en-US-Wavenet-D').
        language_code: Optional language code (e.g., 'en-US').
    Returns:
        bytes: The generated audio data (MP3)
    """
    client = texttospeech_v1.TextToSpeechAsyncClient()
    # Defaults
    if not language_code:
        language_code = "en-US"
    if not voice_id:
        voice_id = "en-US-Wavenet-D"
    
    text_chunks = chunk_text_by_sentences(text, max_chars=5000)
    audio_data = b""
    for chunk in text_chunks:
        synthesis_input = texttospeech_v1.SynthesisInput(text=chunk)
        voice = texttospeech_v1.VoiceSelectionParams(
            language_code=language_code,
            name=voice_id
        )
        audio_config = texttospeech_v1.AudioConfig(
            audio_encoding=texttospeech_v1.AudioEncoding.MP3
        )
        request = texttospeech_v1.SynthesizeSpeechRequest(
            input=synthesis_input,
            voice=voice,
            audio_config=audio_config
        )
        response = await client.synthesize_speech(request=request)
        audio_data += response.audio_content
    return audio_data

def upload_to_r2(audio_data: bytes, filename: Optional[str] = None) -> str:
    """
    Upload audio data to Cloudflare R2.
    
    Args:
        audio_data: The audio data to upload
        filename: Optional filename. If not provided, generates a UUID.
    
    Returns:
        str: The URL of the uploaded file
    """
    cloudflare_account_id = os.getenv("CLOUDFLARE_BUCKET_ACCOUNT")
    cloudflare_access_key_id = os.getenv("CLOUDFLARE_ACCESS_KEY_ID")
    cloudflare_secret_access_key = os.getenv("CLOUDFLARE_SECRET_ACCESS_KEY")
    cloudflare_r2_bucket = os.getenv("CLOUDFLARE_R2_BUCKET")
    
    if not all([
        cloudflare_account_id,
        cloudflare_access_key_id,
        cloudflare_secret_access_key,
        cloudflare_r2_bucket
    ]):
        raise ValueError("Cloudflare R2 credentials not configured")
    
    # Generate filename if not provided
    if not filename:
        filename = f"{uuid.uuid4()}.mp3"
    
    # Initialize R2 client
    s3 = boto3.client(
        's3',
        endpoint_url=f'https://{cloudflare_account_id}.eu.r2.cloudflarestorage.com/meridian-reports-prod',
        aws_access_key_id=cloudflare_access_key_id,
        aws_secret_access_key=cloudflare_secret_access_key
    )
    
    # Upload to R2
    s3.put_object(
        Bucket=cloudflare_r2_bucket,
        Key=filename,
        Body=audio_data,
        ContentType='audio/mpeg'
    )
    
    # Return the public URL
    return f"https://{cloudflare_r2_bucket}.r2.dev/{filename}"

def get_cycle_boundaries(dt: datetime, cycle_duration: int = DEFAULT_CYCLE_DURATION) -> Tuple[datetime, datetime]:
    """Get the start and end times of the cycle that ended before the given datetime.
    
    Args:
        dt: The datetime to get cycle boundaries for
        cycle_duration: The duration of the cycle in hours (defaults to 8 hours)
    """
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
    
    # Set cycle start time (cycle_duration hours before end)
    cycle_start = cycle_end - timedelta(hours=cycle_duration)
    
    return cycle_start, cycle_end

def get_events_for_cycle(cycle_start: datetime, cycle_end: datetime) -> Tuple[List[Any], List[Any]]:
    """Get events that occurred within the specified cycle."""
    sources, events = get_events(start_date=cycle_start.isoformat(), end_date=cycle_end.isoformat())
    # Filter events to only include those within the cycle
    cycle_events = [
        event for event in events
        if cycle_start <= event.publishDate <= cycle_end
    ]
    
    return sources, cycle_events

def get_events_for_date(date: datetime) -> Tuple[List[Any], List[Any]]:
    """Get events that occurred on the specified date."""
    sources, events = get_events(date=date.isoformat())
    return sources, events

@app.route('/api/generate-report', methods=['GET'])
def generate_report():
    """Generate a complete report from events for a given datetime"""
    date_str = request.args.get('date')
    if not date_str:
        return jsonify({"error": "Date parameter is required"}), 400
    
    try:
        # Parse the date (without time)
        dt = datetime.strptime(date_str, "%Y-%m-%d").date()
        print(f"Generating report for {dt}")
        
        # Get cycle duration from query parameter, default to 8 hours
        # cycle_duration = request.args.get('cycle_duration', default=DEFAULT_CYCLE_DURATION, type=int)
        
        # # Get cycle boundaries
        # cycle_start, cycle_end = get_cycle_boundaries(dt, cycle_duration)
        # # Check if a report already exists for this cycle
        # # Add this back later with the /cycle endpoint
        # response = requests.get(
        #     f"https://meridian-production.pmckelvy1.workers.dev/reports/cycle",
        #     params={
        #         "cycle_start": cycle_start.isoformat(),
        #         "cycle_end": cycle_end.isoformat()
        #     },
        #     headers={"Authorization": f"Bearer {os.environ.get('MERIDIAN_SECRET_KEY')}"}
        # )
        
        # if response.status_code == 200:
        #     return jsonify(response.json())
        
        # Step 1: Fetch and process events for this cycle
        # sources, events = get_events_for_cycle(cycle_start, cycle_end)
        sources, events = get_events_for_date(dt)
        
        # Check if there are any events
        print(f"Found {len(events)} events for the specified time period")
        # if not events:
        #     return jsonify({
        #         "error": "No events found for the specified time period",
        #         "cycle_start": cycle_start.isoformat(),
        #         "cycle_end": cycle_end.isoformat()
        #     }), 404

        # Process events into DataFrame
        articles_df = pd.DataFrame([{
            "id": event.id,
            "sourceId": event.sourceId,
            "url": event.url,
            "title": event.title,
            "publishDate": event.publishDate,
            "contentFileKey": event.contentFileKey,
            "primary_location": event.primary_location,
            "completeness": event.completeness,
            "content_quality": event.content_quality,
            "event_summary_points": event.event_summary_points,
            "thematic_keywords": event.thematic_keywords,
            "topic_tags": event.topic_tags,
            "key_entities": event.key_entities,
            "content_focus": event.content_focus,
            "embedding": event.embedding
        } for event in events])
        
        # Clean up summaries
        articles_df["summary"] = (
            articles_df["event_summary_points"]
            .apply(lambda x: " ".join(x) if x else "")
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

        print(title_response[0])
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
            "clustering_params": CLUSTERING_PARAMS
        }
        
        # Publish report
        response = requests.post(
            "https://meridian-backend-production.pmckelvy1.workers.dev/reports/report",
            json=report,
            headers={"Authorization": f"Bearer {os.environ.get('API_TOKEN')}"}
        )
        
        return jsonify({
            "report": report,
            "publish_response": response.json()
        })
        
    except ValueError as e:
        return jsonify({"error": f"Error:{str(e)}"}), 400
    except Exception as e:
        return jsonify({"error": f"An error occurred: {str(e)}"}), 500

@app.route('/api/tts', methods=['POST'])
def text_to_speech():
    """
    Converts text to speech using Google Cloud TTS and stores the audio in Cloudflare R2.
    """
    try:
        data = request.get_json()
        if not data or 'text' not in data:
            return jsonify({"error": "Text field is required"}), 400
        text = data['text']
        voice_id = data.get('voice_id')
        language_code = data.get('language_code')
        filename = data.get('filename')

        # Generate speech (run async in sync context)
        audio_data = asyncio.run(generate_speech_google(
            text=text,
            voice_id=voice_id,
            language_code=language_code
        ))

        # Upload to R2
        audio_url = upload_to_r2(
            audio_data=audio_data,
            filename=filename
        )
        filename = audio_url.split("/")[-1]
        return jsonify({
            "audio_url": audio_url,
            "filename": filename
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(f"ERROR during text-to-speech conversion: {e}")
        return jsonify({"error": f"Internal server error during text-to-speech conversion: {str(e)}"}), 500

if __name__ == '__main__':
    app.run(debug=True) 