import requests
from datetime import datetime
import json

BASE_URL = "http://localhost:5000"

def main():
    # 1. Process events (fetch, process and cluster)
    print("Processing events...")
    today = datetime.now().strftime("%Y-%m-%d")
    # today = "2025-04-19"
    response = requests.get(f"{BASE_URL}/api/process-events", params={"date": today})
    processed_data = response.json()
    
    # 2. Generate brief
    print("Generating brief...")
    response = requests.post(
        f"{BASE_URL}/api/generate-brief",
        json={
            "clusters": processed_data["clusters"],
            "events": processed_data["events"]
        }
    )
    brief_data = response.json()
    
    # 3. Publish report
    print("Publishing report...")
    response = requests.post(
        f"{BASE_URL}/api/publish",
        json={
            "title": brief_data["title"],
            "content": brief_data["content"],
            "tldr": brief_data["tldr"],
            "events": processed_data["events"],
            "sources": processed_data["sources"],
            "used_articles": [],  # You'll need to track which articles were used
            "used_sources": []    # You'll need to track which sources were used
        }
    )
    
    print("\nFinal Report:")
    print(json.dumps(response.json(), indent=2))

if __name__ == "__main__":
    main()
