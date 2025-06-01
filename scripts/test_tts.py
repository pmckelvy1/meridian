#!/usr/bin/env python3

import requests
import json
import webbrowser
from typing import Optional, Dict, Any
import argparse
from rich.console import Console
from rich.panel import Panel
from rich import print as rprint
from dotenv import load_dotenv
import os

console = Console()

def test_tts(
    text: str,
    base_url: str = "http://ml.notawebsite.net:5000"
) -> Dict[str, Any]:
    """
    Test the TTS endpoint with the given parameters.
    
    Args:
        text: The text to convert to speech
        base_url: The base URL of the API
        voice_id: Optional voice ID to use
        filename: Optional filename for the audio file
    
    Returns:
        Dict containing the response from the API
    """
    # Prepare the request payload
    payload = {"text": text}
    
    # Make the request
    try:
        response = requests.post(
            f"{base_url}/api/tts",
            json=payload,
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        
        result = response.json()
        
        # Print the result in a nice format
        console.print(Panel(
            f"[green]Success![/green]\n"
            f"Audio URL: [blue]{result['audio_url']}[/blue]\n"
            f"Filename: {result['filename']}",
            title="TTS Response"
        ))
        
        return result
        
    except requests.exceptions.RequestException as e:
        console.print(Panel(
            f"[red]Error:[/red] {str(e)}",
            title="Request Failed"
        ))
        if hasattr(e.response, 'text'):
            try:
                error_details = json.loads(e.response.text)
                console.print(Panel(
                    json.dumps(error_details, indent=2),
                    title="Error Details"
                ))
            except:
                console.print(e.response.text)
        return None

def fetch_last_report(api_token: str):
    """
    Fetch the latest report from the /last-report endpoint.
    """
    try:
        response = requests.get(
            "https://meridian-backend-production.pmckelvy1.workers.dev/reports/last-report",
            headers={"Authorization": f"Bearer {api_token}"}
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        console.print(Panel(
            f"[red]Error fetching last report:[/red] {str(e)}",
            title="Fetch Last Report Failed"
        ))
        if hasattr(e.response, 'text'):
            try:
                error_details = json.loads(e.response.text)
                console.print(Panel(
                    json.dumps(error_details, indent=2),
                    title="Error Details"
                ))
            except:
                console.print(e.response.text)
        return None

def main():
    parser = argparse.ArgumentParser(description="Test the TTS endpoint")
    parser.add_argument("--local", action="store_true", help="Use localhost as the base URL (overrides remote)")
    args = parser.parse_args()

    # Load API token from .env using python-dotenv
    load_dotenv()
    api_token = os.getenv("API_TOKEN")
    if not api_token:
        console.print(Panel("[red]API token is required. Provide API_TOKEN in .env[/red]", title="Missing Token"))
        return

    # Always fetch last report and use its content
    base_url = "http://localhost:5000" if args.local else "http://ml.notawebsite.net:5000"
    report = fetch_last_report(api_token)
    if not report or 'content' not in report:
        console.print(Panel("[red]Failed to fetch report or missing 'content' field.[/red]", title="No Report Content"))
        return
    text = report['content']

    # Run the test
    test_tts(
        text=text,
        base_url=base_url
    )

if __name__ == "__main__":
    main() 