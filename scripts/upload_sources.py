#!/usr/bin/env python3

import json
import requests
import sys
from typing import List, Dict
import os
import csv
from urllib.parse import urlparse
from dotenv import load_dotenv

load_dotenv()


def upload_source(worker_url: str, source: Dict) -> bool:
    """Upload a single source to the worker."""
    try:
        response = requests.post(
            f"{worker_url}/sources",
            json=source,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ.get('API_TOKEN')}"
            }
        )
        response.raise_for_status()
        print(f"Successfully uploaded source: {source['name']}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Error uploading source {source['name']}: {str(e)}")
        return False


def load_sources_from_csv(csv_path: str) -> List[Dict]:
    """Load sources from CSV file and convert to source objects."""
    sources = []
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            source = {
                'name': row['name'],
                'url': row['url'],
                'category': row['category'],
                'scrape_frequency': int(row['scrape_frequency']),
                'paywall': row['paywall'].lower() == 'true'
            }
            sources.append(source)
    return sources


def main():
    # Get worker URL from environment variable or use default
    worker_url = "https://meridian-backend-production.pmckelvy1.workers.dev"

    # Load sources from CSV file
    sources = load_sources_from_csv('sources.csv')

    # Upload each source
    success_count = 0
    for source in sources:
        if upload_source(worker_url, source):
            success_count += 1

    print(
        f"\nUpload complete: {success_count}/{len(sources)} sources uploaded successfully")


if __name__ == "__main__":
    main()
