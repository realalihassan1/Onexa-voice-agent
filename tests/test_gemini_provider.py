from __future__ import annotations

import json

import pytest

from providers.gemini import GeminiError, GeminiProvider


class FakeResponse:
    def __init__(self):
        self.lines = [
            b'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n',
            b"\n",
            b'data: {"candidates":[{"content":{"parts":[{"text":" there."}]}}]}\n',
            b"",
        ]
        self.closed = False

    def readline(self):
        return self.lines.pop(0)

    def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_gemini_streams_text_and_keeps_key_in_backend_header(monkeypatch):
    response = FakeResponse()
    request_capture = {}

    def fake_urlopen(request, _timeout, timeout):
        request_capture["request"] = request
        request_capture["timeout"] = timeout
        return response

    monkeypatch.setattr("providers.gemini.urllib.request.urlopen", fake_urlopen)
    provider = GeminiProvider(api_key="server-secret", model="gemini-3.8-flash")
    chunks = [
        chunk async for chunk in provider.stream([{"role": "user", "content": "Hi"}])
    ]
    request = request_capture["request"]
    payload = json.loads(request.data)
    assert chunks == ["Hello", " there."]
    assert request.get_header("X-goog-api-key") == "server-secret"
    assert "server-secret" not in request.full_url
    assert "gemini-3.8-flash:streamGenerateContent" in request.full_url
    assert payload["contents"][0]["parts"][0]["text"] == "Hi"
    assert response.closed


@pytest.mark.asyncio
async def test_gemini_provider_fails_without_key():
    provider = GeminiProvider(api_key="")
    with pytest.raises(GeminiError, match="GOOGLE_API_KEY"):
        _ = [
            chunk
            async for chunk in provider.stream([{"role": "user", "content": "Hi"}])
        ]
