from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response

import database
import token_server
from security import hash_password, new_session_token, token_digest, verify_password
from token_server import ChatRequest, LoginRequest, MessageRequest


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "test.sqlite3")
    database.initialize()
    database.create_user("ali-id", "ali", "Ali", hash_password("ali-password-long"))
    database.create_user(
        "hamza-id", "hamza", "Hamza", hash_password("hamza-password-long")
    )


def _session(user_id: str) -> str:
    token = new_session_token()
    database.save_session(
        token_digest(token),
        user_id,
        (datetime.now(timezone.utc) + timedelta(days=1)).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        ),
    )
    return token


def test_passwords_are_salted_and_verified():
    first = hash_password("a secure long password")
    second = hash_password("a secure long password")
    assert first != second
    assert verify_password("a secure long password", first)
    assert not verify_password("wrong password", first)


@pytest.mark.asyncio
async def test_login_sets_server_verified_http_only_session():
    response = Response()
    result = await token_server.login(
        LoginRequest(username="ALI", password="ali-password-long"), response
    )
    cookie = response.headers["set-cookie"]
    token = cookie.split("=", 1)[1].split(";", 1)[0]
    assert "httponly" in cookie.lower()
    assert result["user"]["id"] == "ali-id"
    assert token_server.current_user(token)["id"] == "ali-id"
    assert database.session_user(token_digest(token))["username"] == "ali"


@pytest.mark.asyncio
async def test_login_rejects_wrong_password():
    with pytest.raises(HTTPException) as error:
        await token_server.login(
            LoginRequest(username="ali", password="wrong-password-long"), Response()
        )
    assert error.value.status_code == 401


def test_conversations_and_messages_are_owner_scoped_and_persistent():
    ali_conversation = database.create_conversation("ali-id", "voice")
    hamza_conversation = database.create_conversation("hamza-id", "chat")
    voice_session = database.create_voice_session(
        "ali-id", ali_conversation["id"], "onexa-test-room"
    )
    assert voice_session["conversation_id"] == ali_conversation["id"]
    assert database.set_voice_session_status("ali-id", voice_session["id"], "connected")
    database.upsert_voice_transcript(
        "ali-id", ali_conversation["id"], "segment-1", "user", "Let's review Q3."
    )
    database.upsert_voice_transcript(
        "ali-id", ali_conversation["id"], "segment-1", "user", "Let's review Q3 goals."
    )
    database.append_message(
        "ali-id", ali_conversation["id"], "assistant", "Sure, let's start.", "voice"
    )
    assert database.conversation("hamza-id", ali_conversation["id"]) is None
    assert database.conversation("ali-id", hamza_conversation["id"]) is None
    messages = database.list_messages("ali-id", ali_conversation["id"])
    assert [message["sequence"] for message in messages] == [1, 2]
    assert messages[0]["content"] == "Let's review Q3 goals."
    assert json.loads(messages[0]["metadata_json"])["segment_id"] == "segment-1"
    assert len(database.list_messages("hamza-id", ali_conversation["id"])) == 0
    assert database.set_conversation_status("ali-id", ali_conversation["id"], "closed")
    assert (
        database.set_voice_session_status("ali-id", voice_session["id"], "connected")
        is False
    )


def test_voice_session_failure_state_and_owner_check():
    conversation = database.create_conversation("ali-id", "voice")
    session = database.create_voice_session("ali-id", conversation["id"], "failed-room")
    assert (
        database.set_voice_session_status("hamza-id", session["id"], "failed") is False
    )
    assert database.set_voice_session_status("ali-id", session["id"], "failed") is True
    assert (
        database.set_voice_session_status("ali-id", session["id"], "connected") is False
    )


@pytest.mark.asyncio
async def test_chat_stream_saves_user_and_assistant_to_owned_conversation(monkeypatch):
    conversation = database.create_conversation("ali-id", "chat")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")

    class FakeGemini:
        def __init__(self):
            pass

        async def stream(self, messages):
            assert messages[-1] == {"role": "user", "content": "Hello ONEXAI"}
            yield "Hello"
            yield " Ali"

    monkeypatch.setattr(token_server, "GeminiProvider", FakeGemini)
    response = await token_server.stream_chat(
        ChatRequest(conversation_id=conversation["id"], content="Hello ONEXAI"),
        {"id": "ali-id"},
    )
    chunks = [chunk async for chunk in response.body_iterator]
    assert '"text": "Hello"' in "".join(chunks)
    messages = database.list_messages("ali-id", conversation["id"])
    assert [(row["role"], row["content"]) for row in messages] == [
        ("user", "Hello ONEXAI"),
        ("assistant", "Hello Ali"),
    ]


@pytest.mark.asyncio
async def test_chat_rejects_another_users_conversation():
    conversation = database.create_conversation("hamza-id", "chat")
    with pytest.raises(HTTPException) as error:
        await token_server.stream_chat(
            ChatRequest(conversation_id=conversation["id"], content="peek"),
            {"id": "ali-id"},
        )
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_voice_transcript_endpoint_requires_auth_and_upserts_segment():
    conversation = database.create_conversation("ali-id", "voice")
    with pytest.raises(HTTPException) as error:
        token_server.current_user(None)
    assert error.value.status_code == 401
    first = await token_server.save_message(
        conversation["id"],
        MessageRequest(
            role="user", content="Hello", source="voice", segment_id="live-seg"
        ),
        {"id": "ali-id"},
    )
    await token_server.save_message(
        conversation["id"],
        MessageRequest(
            role="user", content="Hello ONEXAI", source="voice", segment_id="live-seg"
        ),
        {"id": "ali-id"},
    )
    assert first["message"]["sequence"] == 1
    messages = database.list_messages("ali-id", conversation["id"])
    assert len(messages) == 1 and messages[0]["content"] == "Hello ONEXAI"


def test_history_pagination_and_search_are_owner_scoped():
    for index in range(12):
        conversation = database.create_conversation(
            "ali-id", "chat", f"Project {index}"
        )
        database.append_message(
            "ali-id", conversation["id"], "user", f"Need note {index}", "chat"
        )
    database.create_conversation("hamza-id", "chat", "Private Hamza planning")
    first_page = database.list_conversations("ali-id", 10, 0)
    older = database.list_conversations("ali-id", 10, 10)
    search = database.list_conversations("ali-id", 10, 0, "Project 2")
    assert len(first_page) == 10 and len(older) == 2
    assert all(row["owner_id"] == "ali-id" for row in first_page + older)
    assert [row["title"] for row in search] == ["Project 2"]
