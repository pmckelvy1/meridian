import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

client = OpenAI(
    api_key=os.environ.get("GOOGLE_API_KEY"),
    base_url="https://generativelanguage.googleapis.com/v1beta/models/",
    default_headers={"x-goog-api-key": os.environ.get("GOOGLE_API_KEY")}
)


def call_llm(model: str, messages: list[dict], temperature: float = 0):

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        n=1,
        temperature=temperature,
    )

    return response.choices[0].message.content, (
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
    )

    # return {
    #     "answer": response.choices[0].message.content,
    #     "usage": {
    #         "input_tokens": response.usage.prompt_tokens,
    #         "output_tokens": response.usage.completion_tokens,
    #     },
    # }
