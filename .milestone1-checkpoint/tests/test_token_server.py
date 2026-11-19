import base64
import json
import time

import pytest
from fastapi import HTTPException

from token_server import TokenRequest, get_token


def decode_payload(token: str) -> dict:
    encoded = token.split(".")[1]
    encoded += "=" * (-len(encoded) % 4)
    return json.loads(base64.urlsafe_b64decode(encoded))


@pytest.mark.asyncio
async def test_token_dispatches_to_onexa_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "devsecret123456789012345678901234")
    monkeypatch.setenv("LIVEKIT_AGENT_DEPLOYMENT", "onexa-dev")

    now = time.time()
    response = await get_token(TokenRequest(participant_name="Ali Hassan"))
    claims = decode_payload(response["participant_token"])

    assert response["server_url"] == "wss://example.livekit.cloud"
    assert claims["name"] == "Ali Hassan"
    assert claims["video"]["roomJoin"] is True
    assert claims["video"]["room"].startswith("onexa-")
    assert response["room_name"] == claims["video"]["room"]
    assert claims["roomConfig"]["agents"][0]["agentName"] == "my-agent"
    assert claims["roomConfig"]["agents"][0]["deployment"] == "onexa-dev"
    assert response["agent_deployment"] == "onexa-dev"
    assert "LIVEKIT_API_SECRET" not in response
    assert 3598 <= claims["exp"] - now <= 3600


@pytest.mark.asyncio
async def test_token_server_rejects_unknown_display_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "devsecret123456789012345678901234")
    monkeypatch.setenv("LIVEKIT_AGENT_DEPLOYMENT", "onexa-dev")

    with pytest.raises(HTTPException) as error:
        await get_token(TokenRequest(participant_name="Guest"))

    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_token_service_fails_cleanly_without_livekit_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LIVEKIT_URL", raising=False)
    monkeypatch.delenv("LIVEKIT_API_KEY", raising=False)
    monkeypatch.delenv("LIVEKIT_API_SECRET", raising=False)
    monkeypatch.setenv("LIVEKIT_AGENT_DEPLOYMENT", "onexa-dev")

    with pytest.raises(HTTPException) as error:
        await get_token(TokenRequest(participant_name="Hamza"))

    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_token_service_requires_explicit_agent_deployment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "devsecret123456789012345678901234")
    monkeypatch.delenv("LIVEKIT_AGENT_DEPLOYMENT", raising=False)

    with pytest.raises(HTTPException) as error:
        await get_token(TokenRequest(participant_name="Ali Hassan"))

    assert error.value.status_code == 503
    assert "LIVEKIT_AGENT_DEPLOYMENT" in error.value.detail
