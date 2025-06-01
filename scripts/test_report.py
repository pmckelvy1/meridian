import datetime
import requests
import argparse

parser = argparse.ArgumentParser(description="Generate test report.")
parser.add_argument('--local', action='store_true', help='Use localhost as the URL')
args = parser.parse_args()

URL = "localhost" if args.local else "ml.notawebsite.net"
# URL = "localhost"

# current date without milliseconds
date = datetime.datetime.now().strftime("%Y-%m-%d")

response = requests.get(f"http://{URL}:5000/api/generate-report?date={date}")
print(response.status_code)
print(response.json())
