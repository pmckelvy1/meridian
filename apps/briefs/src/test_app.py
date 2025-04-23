import requests
import pytest
from datetime import datetime

BASE_URL = "http://localhost:5000"

def test_process_events():
    # Test event processing endpoint
    today = datetime.now().strftime("%Y-%m-%d")
    response = requests.get(f"{BASE_URL}/api/process-events", params={"date": today})
    assert response.status_code == 200
    
    data = response.json()
    assert "sources" in data
    assert "events" in data
    assert "clusters" in data
    assert "cluster_labels" in data
    
    return data

def test_generate_brief(processed_data):
    # Test brief generation endpoint
    response = requests.post(
        f"{BASE_URL}/api/generate-brief",
        json={
            "clusters": processed_data["clusters"],
            "events": processed_data["events"]
        }
    )
    assert response.status_code == 200
    
    data = response.json()
    assert "title" in data
    assert "content" in data
    assert "tldr" in data
    assert "stories" in data
    
    return data

def test_publish_report(brief_data, processed_data):
    # Test publish endpoint
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
    assert response.status_code == 200
    
    return response.json()

def test_full_workflow():
    # Test the entire workflow
    processed_data = test_process_events()
    brief_data = test_generate_brief(processed_data)
    published_data = test_publish_report(brief_data, processed_data)
    
    return published_data

if __name__ == "__main__":
    pytest.main([__file__])
