#!/usr/bin/env python3

import json
import requests
import sys
from typing import List, Dict
import os
from urllib.parse import urlparse


def load_rss_sources(file_path: str) -> List[str]:
    """Load RSS URLs from a JSON file."""
    try:
        with open(file_path, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: File {file_path} not found")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"Error: {file_path} is not valid JSON")
        sys.exit(1)


def generate_source_from_url(url: str) -> Dict:
    """Generate a source object from a URL."""
    parsed_url = urlparse(url)
    path_parts = parsed_url.path.strip('/').split('/')

    # Extract name from the last part of the URL path
    name = "Investing.com " + \
        path_parts[-1].replace('.rss', '').replace('_', ' ').title()

    # Determine category based on URL path
    category = 'news'  # default category
    if 'forex' in url.lower():
        category = 'forex'
    elif 'stock' in url.lower():
        category = 'stocks'
    elif 'commodities' in url.lower():
        category = 'commodities'
    elif 'bonds' in url.lower():
        category = 'bonds'
    elif 'market_overview' in url.lower():
        category = 'market'

    return {
        "name": name,
        "url": url,
        "category": category
    }


def upload_source(worker_url: str, source: Dict) -> bool:
    """Upload a single source to the worker."""
    try:
        response = requests.post(
            f"{worker_url}/sources",
            json=source,
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        print(f"Successfully uploaded source: {source['name']}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Error uploading source {source['name']}: {str(e)}")
        return False


def main():
    # Get worker URL from environment variable or use default
    worker_url = "https://meridian-backend-production.pmckelvy1.workers.dev"

    # Load RSS URLs from file
    urls = load_rss_sources('rss.json')

    # Convert URLs to source objects
    sources = [generate_source_from_url(url) for url in urls]

    # Upload each source
    success_count = 0
    for source in sources:
        if upload_source(worker_url, source):
            success_count += 1

    print(
        f"\nUpload complete: {success_count}/{len(sources)} sources uploaded successfully")


if __name__ == "__main__":
    main()
