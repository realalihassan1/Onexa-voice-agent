CREATE TABLE voice_sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    livekit_room_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','connected','closed','failed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ended_at TEXT,
    FOREIGN KEY(conversation_id, owner_id) REFERENCES conversations(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX voice_sessions_conversation_idx ON voice_sessions(conversation_id, created_at);
