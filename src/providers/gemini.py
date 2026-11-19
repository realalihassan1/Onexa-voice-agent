"""Google Gemini Developer API streaming adapter using its documented SSE REST API."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections.abc import AsyncIterator


class GeminiError(RuntimeError):
    pass


class GeminiProvider:
    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key or os.getenv("GOOGLE_API_KEY", "")
        self.model = model or os.getenv("GEMINI_MODEL", "gemini-3.8-flash")

    async def stream(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        if not self.api_key:
            raise GeminiError(
                "Chat is not configured: add GOOGLE_API_KEY to the backend .env.local file."
            )
        turns: list[dict[str, str]] = []
        for item in messages:
            text = item["content"].strip()
            if not text:
                continue
            role = "model" if item["role"] == "assistant" else "user"
            if role == "model" and not turns:
                continue
            if turns and turns[-1]["role"] == role:
                turns[-1]["content"] += f"\n{text}"
            else:
                turns.append({"role": role, "content": text})
        contents = [
            {"role": turn["role"], "parts": [{"text": turn["content"]}]}
            for turn in turns
        ]
        payload = json.dumps(
            {
                "systemInstruction": {
                    "parts": [
                        {
                            "text": "You are ONEXAI, a concise and practical personal intelligence assistant for Ali and Hamza. Keep ordinary replies natural and brief. Protect private information and do not claim to perform actions that are not available."
                        }
                    ]
                },
                "contents": contents,
                "generationConfig": {"maxOutputTokens": 2048},
            }
        ).encode()
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:streamGenerateContent?alt=sse"
        request = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.api_key,
            },
            method="POST",
        )

        try:
            response = await asyncio.to_thread(
                urllib.request.urlopen, request, None, 45
            )
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(body).get("error", {}).get("message", "")
            except json.JSONDecodeError:
                detail = ""
            if error.code == 429:
                raise GeminiError(
                    "Gemini is rate limited. Please wait a moment and retry."
                ) from error
            raise GeminiError(
                detail or f"Gemini returned HTTP {error.code}."
            ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise GeminiError(
                "Could not reach Gemini. Check the network and try again."
            ) from error

        try:
            while True:
                line = await asyncio.to_thread(response.readline)
                if not line:
                    break
                if not line.startswith(b"data:"):
                    continue
                try:
                    chunk = json.loads(line[5:].strip())
                    text = "".join(
                        part.get("text", "")
                        for candidate in chunk.get("candidates", [])
                        for part in candidate.get("content", {}).get("parts", [])
                    )
                except (json.JSONDecodeError, AttributeError, TypeError):
                    continue
                if text:
                    yield text
        finally:
            await asyncio.to_thread(response.close)
