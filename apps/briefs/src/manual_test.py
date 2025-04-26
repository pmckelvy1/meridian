import requests
from datetime import datetime
import json

BASE_URL = "http://localhost:5000"

def main():
    # Generate complete report for today
    print("Generating report...")
    # today = datetime.now().isoformat()
    today = "2025-04-24T12:00:00"
    response = requests.get(f"{BASE_URL}/api/generate-report", params={"date": today})
    report_data = response.json()
    
    print("\nFinal Report:")
    print(json.dumps(report_data, indent=2))

if __name__ == "__main__":
    main()
