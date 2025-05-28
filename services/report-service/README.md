# Report Generation Service

A light python api to generate reports. Does what the jupyter notebook does.

## Build

```
docker buildx build -t <username>/report-service .
docker push <username>/report-service:latest
```

## Run

edit the docker compose to use your <username>

```
docker-compose up -d
```

## Text to speech

This uses the google text-to-speech client https://cloud.google.com/python/docs/reference/texttospeech/latest/google.cloud.texttospeech_v1.services.text_to_speech.TextToSpeechAsyncClient

0. Setup a google cloud account and a project with billing
1. Enable the text-to-speech api
2. Setup a service account in gcloud https://cloud.google.com/iam/docs/service-accounts-create#creating
3. Setup authorization https://googleapis.dev/python/google-api-core/latest/auth.html#overview using `GOOGLE_APPLICATION_CREDENTIALS`
