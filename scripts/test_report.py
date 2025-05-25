import datetime
import requests

date = datetime.datetime.now()

response = requests.get(f"http://ml.notawebsite.net:5000/api/generate-report?date={date}")
print(response.json())
