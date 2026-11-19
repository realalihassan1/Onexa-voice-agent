"""SQLite persistence boundary for ONEXAI conversations.

All SQL is isolated here so a future PostgreSQL/Supabase adapter can implement
the same repository operations without changing API or UI code.
"""

from __future__ import annotations

import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env.local")
DATABASE_PATH = Path(
    os.getenv("ONEXA_DATABASE_PATH", PROJECT_ROOT / "data" / "onexai.sqlite3")
)


@contextmanager
def connection() -> Iterator[sqlite3.Connection]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATABASE_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize() -> None:
    with connection() as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
        )
        migrations_dir = Path(__file__).resolve().parent / "migrations"
        for migration in sorted(migrations_dir.glob("*.sql")):
            version = int(migration.name.split("_", 1)[0])
            applied = db.execute(
                "SELECT 1 FROM schema_migrations WHERE version=?", (version,)
            ).fetchone()
            if not applied:
                db.executescript(migration.read_text(encoding="utf-8"))
                db.execute(
                    "INSERT INTO schema_migrations(version) VALUES (?)", (version,)
                )


def create_user(
    user_id: str, username: str, display_name: str, password_hash: str
) -> None:
    with connection() as db:
        db.execute(
            "INSERT INTO users(id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
            (user_id, username, display_name, password_hash),
        )


def user_by_username(username: str) -> sqlite3.Row | None:
    with connection() as db:
        return db.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()


def user_by_id(user_id: str) -> sqlite3.Row | None:
    with connection() as db:
        return db.execute(
            "SELECT id, username, display_name FROM users WHERE id = ?", (user_id,)
        ).fetchone()


def save_session(token_hash: str, user_id: str, expires_at: str) -> None:
    with connection() as db:
        db.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user_id, expires_at),
        )


def session_user(token_hash: str) -> sqlite3.Row | None:
    with connection() as db:
        return db.execute(
            "SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            (token_hash,),
        ).fetchone()


def delete_session(token_hash: str) -> None:
    with connection() as db:
        db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))


def create_conversation(
    owner_id: str, kind: str, title: str = "New conversation"
) -> sqlite3.Row:
    import uuid

    conversation_id = str(uuid.uuid4())
    with connection() as db:
        db.execute(
            "INSERT INTO conversations(id, owner_id, title, type) VALUES (?, ?, ?, ?)",
            (conversation_id, owner_id, title[:100], kind),
        )
        return db.execute(
            "SELECT * FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()


def conversation(owner_id: str, conversation_id: str) -> sqlite3.Row | None:
    with connection() as db:
        return db.execute(
            "SELECT * FROM conversations WHERE id=? AND owner_id=?",
            (conversation_id, owner_id),
        ).fetchone()


def list_conversations(
    owner_id: str, limit: int, offset: int, query: str = ""
) -> list[sqlite3.Row]:
    with connection() as db:
        return db.execute(
            "SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count "
            "FROM conversations c WHERE c.owner_id=? AND (?='' OR c.title LIKE ? OR EXISTS "
            "(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ?)) "
            "ORDER BY c.updated_at DESC LIMIT ? OFFSET ?",
            (owner_id, query, f"%{query}%", f"%{query}%", limit, offset),
        ).fetchall()


def list_messages(owner_id: str, conversation_id: str) -> list[sqlite3.Row]:
    with connection() as db:
        return db.execute(
            "SELECT id, conversation_id, sequence, role, content, source, metadata_json, created_at "
            "FROM messages WHERE owner_id=? AND conversation_id=? ORDER BY sequence",
            (owner_id, conversation_id),
        ).fetchall()


def list_voice_sessions(owner_id: str, conversation_id: str) -> list[sqlite3.Row]:
    with connection() as db:
        return db.execute(
            "SELECT id, livekit_room_name, status, created_at, ended_at FROM voice_sessions "
            "WHERE owner_id=? AND conversation_id=? ORDER BY created_at",
            (owner_id, conversation_id),
        ).fetchall()


def append_message(
    owner_id: str,
    conversation_id: str,
    role: str,
    content: str,
    source: str,
    metadata_json: str = "{}",
) -> sqlite3.Row:
    import uuid

    with connection() as db:
        owned = db.execute(
            "SELECT id,title FROM conversations WHERE id=? AND owner_id=?",
            (conversation_id, owner_id),
        ).fetchone()
        if not owned:
            raise LookupError("Conversation not found")
        sequence = db.execute(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?",
            (conversation_id,),
        ).fetchone()[0]
        message_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO messages(id,conversation_id,owner_id,sequence,role,content,source,metadata_json) VALUES(?,?,?,?,?,?,?,?)",
            (
                message_id,
                conversation_id,
                owner_id,
                sequence,
                role,
                content,
                source,
                metadata_json,
            ),
        )
        if owned["title"] == "New conversation" and role == "user":
            db.execute(
                "UPDATE conversations SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                (content.strip()[:80] or "New conversation", conversation_id),
            )
        else:
            db.execute(
                "UPDATE conversations SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                (conversation_id,),
            )
        return db.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()


def upsert_voice_transcript(
    owner_id: str, conversation_id: str, segment_id: str, role: str, content: str
) -> sqlite3.Row:
    import json
    import uuid

    metadata_json = json.dumps({"segment_id": segment_id})
    with connection() as db:
        owned = db.execute(
            "SELECT id,title FROM conversations WHERE id=? AND owner_id=?",
            (conversation_id, owner_id),
        ).fetchone()
        if not owned:
            raise LookupError("Conversation not found")
        candidates = db.execute(
            "SELECT id,metadata_json FROM messages WHERE owner_id=? AND conversation_id=? AND source='voice'",
            (owner_id, conversation_id),
        ).fetchall()
        existing_id = next(
            (
                row["id"]
                for row in candidates
                if json.loads(row["metadata_json"]).get("segment_id") == segment_id
            ),
            None,
        )
        if existing_id:
            db.execute(
                "UPDATE messages SET content=?, role=? WHERE id=?",
                (content, role, existing_id),
            )
            message_id = existing_id
        else:
            sequence = db.execute(
                "SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?",
                (conversation_id,),
            ).fetchone()[0]
            message_id = str(uuid.uuid4())
            db.execute(
                "INSERT INTO messages(id,conversation_id,owner_id,sequence,role,content,source,metadata_json) VALUES(?,?,?,?,?,?,?,?)",
                (
                    message_id,
                    conversation_id,
                    owner_id,
                    sequence,
                    role,
                    content,
                    "voice",
                    metadata_json,
                ),
            )
        if (
            owned["title"] in {"New conversation", "Voice conversation"}
            and role == "user"
        ):
            db.execute(
                "UPDATE conversations SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                (content.strip()[:80] or "Voice conversation", conversation_id),
            )
        else:
            db.execute(
                "UPDATE conversations SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                (conversation_id,),
            )
        return db.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()


def delete_conversation(owner_id: str, conversation_id: str) -> bool:
    with connection() as db:
        cursor = db.execute(
            "DELETE FROM conversations WHERE id=? AND owner_id=?",
            (conversation_id, owner_id),
        )
        return cursor.rowcount > 0


def set_conversation_status(owner_id: str, conversation_id: str, status: str) -> bool:
    with connection() as db:
        cursor = db.execute(
            "UPDATE conversations SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=?",
            (status, conversation_id, owner_id),
        )
        if status == "closed":
            db.execute(
                "UPDATE voice_sessions SET status='closed', ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                "WHERE conversation_id=? AND owner_id=? AND status IN ('created','connected')",
                (conversation_id, owner_id),
            )
        return cursor.rowcount > 0


def create_voice_session(
    owner_id: str, conversation_id: str, room_name: str
) -> sqlite3.Row:
    import uuid

    session_id = str(uuid.uuid4())
    with connection() as db:
        owned = db.execute(
            "SELECT 1 FROM conversations WHERE id=? AND owner_id=?",
            (conversation_id, owner_id),
        ).fetchone()
        if not owned:
            raise LookupError("Conversation not found")
        db.execute(
            "INSERT INTO voice_sessions(id,conversation_id,owner_id,livekit_room_name) VALUES(?,?,?,?)",
            (session_id, conversation_id, owner_id, room_name),
        )
        return db.execute(
            "SELECT * FROM voice_sessions WHERE id=?", (session_id,)
        ).fetchone()


def set_voice_session_status(owner_id: str, session_id: str, status: str) -> bool:
    with connection() as db:
        cursor = db.execute(
            "UPDATE voice_sessions SET status=?, ended_at=CASE WHEN ?='closed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE ended_at END "
            "WHERE id=? AND owner_id=? AND ((?='connected' AND status='created') "
            "OR (?='closed' AND status IN ('created','connected')) OR (?='failed' AND status='created'))",
            (status, status, session_id, owner_id, status, status, status),
        )
        return cursor.rowcount > 0
