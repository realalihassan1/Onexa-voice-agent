"""Local development token endpoint for the ONEXA browser client.

This endpoint is intentionally bound to localhost. Add real user authentication
before exposing it on a network or deploying it publicly.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from livekit.api import RoomAgentDispatch, RoomConfiguration
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env.local")
logger = logging.getLogger("onexa.token_server")
AGENT_NAME = "my-agent"

app = FastAPI(title="ONEXA local token service", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


class TokenRequest(BaseModel):
    participant_name: str = Field(min_length=1, max_length=60)


@app.get("/health")
async def health() -> dict[str, str]:
    server_url = os.getenv("LIVEKIT_URL", "")
    deployment = os.getenv("LIVEKIT_AGENT_DEPLOYMENT", "").strip()
    credentials_configured = all(
        (
            server_url,
            os.getenv("LIVEKIT_API_KEY"),
            os.getenv("LIVEKIT_API_SECRET"),
            deployment,
        )
    )
    return {
        "status": "ok" if credentials_configured else "needs_config",
        "service": "onexa-token-service",
        "livekit_host": urlsplit(server_url).hostname or "",
        "agent_name": AGENT_NAME,
        "agent_deployment": deployment,
    }


@app.post("/getToken", status_code=201)
async def get_token(body: TokenRequest) -> dict[str, str]:
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")
    server_url = os.getenv("LIVEKIT_URL")
    deployment = os.getenv("LIVEKIT_AGENT_DEPLOYMENT", "").strip()
    if not all((api_key, api_secret, server_url)):
        raise HTTPException(
            status_code=503,
            detail="LiveKit is not configured. Check LIVEKIT_URL and API credentials in .env.local.",
        )
    if not deployment:
        raise HTTPException(
            status_code=503,
            detail=(
                "LIVEKIT_AGENT_DEPLOYMENT is missing. Set it in .env.local and "
                "start the worker with the same --deployment value."
            ),
        )

    display_name = body.participant_name.strip()
    if display_name not in {"Ali Hassan", "Hamza"}:
        raise HTTPException(
            status_code=422, detail="Choose Ali Hassan or Hamza to continue."
        )

    # One private room per call prevents unrelated browser sessions from joining
    # the same conversation. The frontend cannot choose the room or agent.
    room_name = f"onexa-{uuid.uuid4().hex[:16]}"
    try:
        token = (
            api.AccessToken(api_key, api_secret)
            .with_ttl(timedelta(hours=1))
            .with_identity(
                f"{display_name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:8]}"
            )
            .with_name(display_name)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .with_room_config(
                RoomConfiguration(
                    agents=[
                        RoomAgentDispatch(
                            agent_name=AGENT_NAME,
                            deployment=deployment,
                        )
                    ]
                )
            )
        )
        participant_token = token.to_jwt()
    except Exception as error:
        logger.exception("Failed to create a LiveKit participant token")
        raise HTTPException(
            status_code=500,
            detail="LiveKit token generation failed. Check server logs.",
        ) from error

    logger.info(
        "Issued room token: room=%s agent=%s deployment=%s participant=%s",
        room_name,
        AGENT_NAME,
        deployment,
        display_name,
    )
    return {
        "server_url": server_url,
        "room_name": room_name,
        "participant_token": participant_token,
        "agent_name": AGENT_NAME,
        "agent_deployment": deployment,
    }


if __name__ == "__main__":
    uvicorn.run("token_server:app", host="127.0.0.1", port=3000, reload=False)
