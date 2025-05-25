import datetime
import requests

# current date without milliseconds
# will use datetime.fromisoformat(date_str)
date = datetime.datetime.now().isoformat()

response = requests.get(f"http://ml.notawebsite.net:5000/api/generate-report?date={date}")
print(response.status_code)
print(response.json())
