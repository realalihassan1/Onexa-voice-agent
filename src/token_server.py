"""Local development token endpoint for the ONEXA browser client.

This endpoint is intentionally bound to localhost. Add real user authentication
before exposing it on a network or deploying it publicly.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

import uvicorn
from dotenv import load_dotenv
from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from livekit.api import RoomAgentDispatch, RoomConfiguration
from pydantic import BaseModel, Field

import database
from providers.gemini import GeminiError, GeminiProvider
from security import hash_password, new_session_token, token_digest, verify_password

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env.local")
logger = logging.getLogger("onexa.token_server")
AGENT_NAME = "my-agent"
SESSION_COOKIE = "onexai_session"
SESSION_DAYS = 14
_DUMMY_PASSWORD_HASH = hash_password("not-a-real-account-password")
database.initialize()

app = FastAPI(title="ONEXA local token service", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_methods=["DELETE", "POST", "GET"],
    allow_headers=["Content-Type"],
    allow_credentials=True,
)


class TokenRequest(BaseModel):
    conversation_id: str | None = None


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=30)
    password: str = Field(min_length=1, max_length=256)


class ConversationRequest(BaseModel):
    type: str = Field(pattern="^(chat|voice)$")
    title: str = Field(default="New conversation", max_length=100)


class MessageRequest(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=20000)
    source: str = Field(default="voice", pattern="^(chat|voice)$")
    metadata: dict = Field(default_factory=dict)
    segment_id: str | None = Field(default=None, max_length=200)


class ChatRequest(BaseModel):
    conversation_id: str
    content: str = Field(min_length=1, max_length=20000)


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


def current_user(
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    if not session_cookie:
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    user = database.session_user(token_digest(session_cookie))
    if not user:
        raise HTTPException(
            status_code=401, detail="Your session expired. Sign in again."
        )
    return dict(user)


AuthenticatedUser = Annotated[dict, Depends(current_user)]


@app.post("/api/auth/login")
async def login(body: LoginRequest, response: Response) -> dict:
    username = body.username.strip().lower()
    user = database.user_by_username(username)
    # Do the same cost for unknown usernames to reduce account enumeration timing.
    password_hash = user["password_hash"] if user else _DUMMY_PASSWORD_HASH
    valid = verify_password(body.password, password_hash)
    if not user or not valid:
        raise HTTPException(status_code=401, detail="Incorrect username or password.")
    token = new_session_token()
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    database.save_session(
        token_digest(token), user["id"], expires.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "false").lower() == "true",
        samesite="strict",
        path="/",
    )
    return {
        "user": {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
        }
    }


@app.get("/api/auth/me")
async def me(user: AuthenticatedUser) -> dict:
    return {"user": user}


@app.post("/api/auth/logout")
async def logout(
    response: Response,
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    if session_cookie:
        database.delete_session(token_digest(session_cookie))
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="strict")
    return {"ok": True}


@app.get("/api/conversations")
async def get_conversations(
    user: AuthenticatedUser,
    limit: int = Query(default=10, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    q: str = Query(default="", max_length=200),
) -> dict:
    rows = database.list_conversations(user["id"], limit, offset, q.strip())
    return {
        "conversations": [dict(row) for row in rows],
        "limit": limit,
        "offset": offset,
    }


@app.post("/api/conversations", status_code=201)
async def new_conversation(body: ConversationRequest, user: AuthenticatedUser) -> dict:
    row = database.create_conversation(user["id"], body.type, body.title)
    return {"conversation": dict(row)}


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, user: AuthenticatedUser) -> dict:
    row = database.conversation(user["id"], conversation_id)
    if not row:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    messages = [
        dict(message) for message in database.list_messages(user["id"], conversation_id)
    ]
    for message in messages:
        message["metadata"] = json.loads(message.pop("metadata_json"))
    voice_sessions = [
        dict(session)
        for session in database.list_voice_sessions(user["id"], conversation_id)
    ]
    return {
        "conversation": dict(row),
        "messages": messages,
        "voice_sessions": voice_sessions,
    }


@app.delete("/api/conversations/{conversation_id}", status_code=204)
async def remove_conversation(
    conversation_id: str, user: AuthenticatedUser
) -> Response:
    if not database.delete_conversation(user["id"], conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return Response(status_code=204)


@app.post("/api/conversations/{conversation_id}/close")
async def close_conversation(conversation_id: str, user: AuthenticatedUser) -> dict:
    if not database.set_conversation_status(user["id"], conversation_id, "closed"):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"ok": True}


@app.post("/api/voice-sessions/{session_id}/connected")
async def mark_voice_connected(session_id: str, user: AuthenticatedUser) -> dict:
    if not database.set_voice_session_status(user["id"], session_id, "connected"):
        raise HTTPException(status_code=404, detail="Voice session not found.")
    return {"ok": True}


@app.post("/api/voice-sessions/{session_id}/failed")
async def mark_voice_failed(session_id: str, user: AuthenticatedUser) -> dict:
    if not database.set_voice_session_status(user["id"], session_id, "failed"):
        raise HTTPException(status_code=404, detail="Voice session not found.")
    return {"ok": True}


@app.post("/api/voice-sessions/{session_id}/close")
async def close_voice_session(session_id: str, user: AuthenticatedUser) -> dict:
    if not database.set_voice_session_status(user["id"], session_id, "closed"):
        raise HTTPException(status_code=404, detail="Voice session not found.")
    return {"ok": True}


@app.post("/api/conversations/{conversation_id}/messages", status_code=201)
async def save_message(
    conversation_id: str, body: MessageRequest, user: AuthenticatedUser
) -> dict:
    try:
        if body.source == "voice" and body.segment_id:
            row = database.upsert_voice_transcript(
                user["id"], conversation_id, body.segment_id, body.role, body.content
            )
        else:
            row = database.append_message(
                user["id"],
                conversation_id,
                body.role,
                body.content,
                body.source,
                json.dumps(body.metadata),
            )
    except LookupError as error:
        raise HTTPException(
            status_code=404, detail="Conversation not found."
        ) from error
    return {"message": dict(row)}


@app.post("/api/chat/stream")
async def stream_chat(body: ChatRequest, user: AuthenticatedUser) -> Response:
    if not database.conversation(user["id"], body.conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    history = database.list_messages(user["id"], body.conversation_id)
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Add GOOGLE_API_KEY to the backend .env.local file to enable chat.",
        )
    database.append_message(
        user["id"], body.conversation_id, "user", body.content.strip(), "chat"
    )
    context = [
        {"role": row["role"], "content": row["content"]} for row in history[-50:]
    ]
    context.append({"role": "user", "content": body.content.strip()})
    provider = GeminiProvider()

    async def events() -> AsyncIterator[str]:
        chunks: list[str] = []
        try:
            async for chunk in provider.stream(context):
                chunks.append(chunk)
                yield f"data: {json.dumps({'text': chunk}, ensure_ascii=False)}\n\n"
            if chunks:
                database.append_message(
                    user["id"],
                    body.conversation_id,
                    "assistant",
                    "".join(chunks),
                    "chat",
                )
            yield "event: done\ndata: {}\n\n"
        except GeminiError as error:
            logger.warning(
                "Gemini chat failed for user=%s conversation=%s: %s",
                user["id"],
                body.conversation_id,
                error,
            )
            yield f"event: error\ndata: {json.dumps({'detail': str(error)})}\n\n"

    from starlette.responses import StreamingResponse

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/getToken", status_code=201)
async def get_token(body: TokenRequest, user: AuthenticatedUser) -> dict[str, str]:
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

    display_name = user["display_name"]

    # One private room per call prevents unrelated browser sessions from joining
    # the same conversation. The frontend cannot choose the room or agent.
    room_name = f"onexa-{uuid.uuid4().hex[:16]}"
    if body and body.conversation_id:
        voice_conversation = database.conversation(user["id"], body.conversation_id)
        if not voice_conversation:
            raise HTTPException(status_code=404, detail="Conversation not found.")
    else:
        voice_conversation = database.create_conversation(
            user["id"], "voice", "Voice conversation"
        )
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

    voice_session = database.create_voice_session(
        user["id"], voice_conversation["id"], room_name
    )

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
        "conversation_id": voice_conversation["id"],
        "voice_session_id": voice_session["id"],
    }


if __name__ == "__main__":
    uvicorn.run("token_server:app", host="127.0.0.1", port=3000, reload=False)
