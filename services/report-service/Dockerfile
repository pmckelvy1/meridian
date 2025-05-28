# syntax=docker/dockerfile:1

FROM python:3.12-bookworm

WORKDIR /

COPY requirements.txt requirements.txt
RUN pip3 install -r requirements.txt
RUN python -m nltk.downloader punkt

COPY . .

CMD [ "python3", "-m" , "flask", "run", "--host=0.0.0.0"]