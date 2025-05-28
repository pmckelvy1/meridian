#!/usr/bin/env python3

import requests
import json
import webbrowser
from typing import Optional, Dict, Any
import argparse
from rich.console import Console
from rich.panel import Panel
from rich import print as rprint

console = Console()

def test_tts(
    text: str,
    base_url: str = "http://localhost:5000",
    voice_id: Optional[str] = None,
    filename: Optional[str] = None,
    open_browser: bool = False
) -> Dict[str, Any]:
    """
    Test the TTS endpoint with the given parameters.
    
    Args:
        text: The text to convert to speech
        base_url: The base URL of the API
        voice_id: Optional voice ID to use
        filename: Optional filename for the audio file
        open_browser: Whether to open the audio URL in browser
    
    Returns:
        Dict containing the response from the API
    """
    # Prepare the request payload
    payload = {"text": text}
    if voice_id:
        payload["voice_id"] = voice_id
    if filename:
        payload["filename"] = filename
    
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
        
        # Open the audio URL in browser if requested
        if open_browser and result.get('audio_url'):
            webbrowser.open(result['audio_url'])
        
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

def fetch_last_report(base_url: str, api_token: str):
    """
    Fetch the latest report from the /last-report endpoint.
    """
    try:
        response = requests.get(
            f"https://meridian-backend-production.pmckelvy1.workers.dev/reports/last-report",
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
    parser.add_argument("--text", help="Text to convert to speech")
    parser.add_argument("--url", default="http://localhost:5000", help="Base URL of the API")
    parser.add_argument("--voice", help="Voice ID to use")
    parser.add_argument("--filename", help="Filename for the audio file")
    parser.add_argument("--open", action="store_true", help="Open the audio URL in browser")
    parser.add_argument("--token", help="API token for authorization (defaults to .dev.vars value if available)")
    args = parser.parse_args()

    api_token = args.token
    if not api_token:
        # Try to load from .dev.vars
        import os
        dev_vars_path = os.path.join(os.path.dirname(__file__), "..", "apps", "backend", ".dev.vars")
        try:
            with open(dev_vars_path) as f:
                for line in f:
                    if line.startswith("API_TOKEN="):
                        api_token = line.strip().split("=", 1)[1]
                        break
        except Exception:
            pass
    if not api_token:
        console.print(Panel("[red]API token is required. Provide with --token or in .dev.vars[/red]", title="Missing Token"))
        return

    # If no text provided, fetch last report and use its content
    if args.text:
        text = args.text
    else:
        report = fetch_last_report(args.url, api_token)
        if not report or 'content' not in report:
            console.print(Panel("[red]Failed to fetch report or missing 'content' field.[/red]", title="No Report Content"))
            return
        text = report['content']

    # Run the test
    test_tts(
        text=text,
        base_url=args.url,
        voice_id=args.voice,
        filename=args.filename,
        open_browser=args.open
    )

if __name__ == "__main__":
    main() 