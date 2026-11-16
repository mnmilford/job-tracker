"""SQLite storage. One file, WAL mode, schema created on startup."""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('active', 'closed', 'history')),
    found       TEXT NOT NULL DEFAULT '',
    company     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    comp        TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT '',
    next_step   TEXT NOT NULL DEFAULT '',
    lesson      TEXT NOT NULL DEFAULT '',
    folder      TEXT NOT NULL DEFAULT '',
    posting_url TEXT NOT NULL DEFAULT '',
    verdict     TEXT NOT NULL DEFAULT '',
    files       TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    date           TEXT NOT NULL,
    text           TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'timeline' CHECK (kind IN ('timeline', 'note', 'status')),
    source         TEXT NOT NULL DEFAULT 'app',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS events_app ON events (application_id, date);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_meta(conn, key, value) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
