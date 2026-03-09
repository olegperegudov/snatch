"""
Snatch download database — SQLite storage for all downloads.

Replaces both history.json and queue_state.json with a single source of truth.
Every download attempt is tracked: pending → downloading → done/error/cancelled.
On crash recovery, 'downloading' items become 'paused' and can be retried.
"""

import hashlib
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlparse

DB_PATH = Path(__file__).parent / "snatch.db"

# --- Schema ---

SCHEMA = """
CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY,
    page_url TEXT NOT NULL,
    page_url_hash TEXT NOT NULL,
    video_url TEXT,
    title TEXT,
    filename TEXT,
    download_dir TEXT,
    domain TEXT,
    resolution TEXT,
    filesize_bytes INTEGER,
    duration TEXT,
    format TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at REAL,
    completed_at REAL,
    last_skipped REAL
);

CREATE INDEX IF NOT EXISTS idx_page_url_hash ON downloads(page_url_hash);
CREATE INDEX IF NOT EXISTS idx_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_created_at ON downloads(created_at);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init():
    """Create tables if they don't exist."""
    with _connect() as conn:
        conn.executescript(SCHEMA)
        # Migration: add download_dir column if missing
        cols = {r[1] for r in conn.execute("PRAGMA table_info(downloads)").fetchall()}
        if "download_dir" not in cols:
            conn.execute("ALTER TABLE downloads ADD COLUMN download_dir TEXT")


def url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def domain_from_url(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


# --- CRUD ---

def add(id: str, video_url: str, page_url: str = "", title: str = "") -> dict:
    """Insert a new download record with status='pending'."""
    now = time.time()
    row = {
        "id": id,
        "page_url": page_url,
        "page_url_hash": url_hash(page_url) if page_url else "",
        "video_url": video_url,
        "title": title,
        "domain": domain_from_url(page_url),
        "status": "pending",
        "created_at": now,
    }
    with _connect() as conn:
        conn.execute(
            """INSERT INTO downloads (id, page_url, page_url_hash, video_url, title, domain, status, created_at)
               VALUES (:id, :page_url, :page_url_hash, :video_url, :title, :domain, :status, :created_at)""",
            row,
        )
    return row


def update_status(id: str, status: str, **extra):
    """Update status and optional extra fields (error, filename, etc.)."""
    fields = ["status = ?"]
    values = [status]
    if status == "done":
        fields.append("completed_at = ?")
        values.append(time.time())
    for k, v in extra.items():
        fields.append(f"{k} = ?")
        values.append(v)
    values.append(id)
    with _connect() as conn:
        conn.execute(f"UPDATE downloads SET {', '.join(fields)} WHERE id = ?", values)


def update_metadata(id: str, **kwargs):
    """Update metadata fields (resolution, filesize_bytes, duration, format, filename)."""
    if not kwargs:
        return
    fields = [f"{k} = ?" for k in kwargs]
    values = list(kwargs.values()) + [id]
    with _connect() as conn:
        conn.execute(f"UPDATE downloads SET {', '.join(fields)} WHERE id = ?", values)


def is_downloaded(page_url: str) -> bool:
    """Check if a page_url was already successfully downloaded."""
    h = url_hash(page_url)
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM downloads WHERE page_url_hash = ? AND status = 'done' LIMIT 1", (h,)
        ).fetchone()
    return row is not None


def mark_skipped(page_url: str):
    """Update last_skipped timestamp on existing done entry."""
    h = url_hash(page_url)
    with _connect() as conn:
        conn.execute(
            "UPDATE downloads SET last_skipped = ? WHERE page_url_hash = ? AND status = 'done'",
            (time.time(), h),
        )


def get_completed(limit: int = 50) -> list[dict]:
    """Get last N completed downloads, newest first."""
    with _connect() as conn:
        rows = conn.execute(
            """SELECT * FROM downloads WHERE status = 'done'
               ORDER BY completed_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_by_status(*statuses: str) -> list[dict]:
    """Get all downloads with given status(es)."""
    placeholders = ", ".join("?" for _ in statuses)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM downloads WHERE status IN ({placeholders}) ORDER BY created_at",
            statuses,
        ).fetchall()
    return [dict(r) for r in rows]


def get_incomplete() -> list[dict]:
    """Get downloads that were interrupted (for crash recovery)."""
    return get_by_status("pending", "downloading")


def search(query: str, limit: int = 50) -> list[dict]:
    """Simple LIKE search across title, filename, page_url, domain."""
    pattern = f"%{query}%"
    with _connect() as conn:
        rows = conn.execute(
            """SELECT * FROM downloads WHERE status = 'done'
               AND (title LIKE ? OR filename LIKE ? OR page_url LIKE ? OR domain LIKE ?)
               ORDER BY completed_at DESC LIMIT ?""",
            (pattern, pattern, pattern, pattern, limit),
        ).fetchall()
    return [dict(r) for r in rows]



def recover_interrupted():
    """On daemon startup: mark 'downloading' items as 'paused' so user can retry."""
    with _connect() as conn:
        conn.execute("UPDATE downloads SET status = 'paused' WHERE status = 'downloading'")


def delete(id: str):
    """Remove a download record entirely."""
    with _connect() as conn:
        conn.execute("DELETE FROM downloads WHERE id = ?", (id,))


# --- Migration ---

def migrate_from_json(history_path: str) -> int:
    """Import history.json into SQLite. Returns number of imported records."""
    import json
    path = Path(history_path)
    if not path.exists():
        return 0

    data = json.loads(path.read_text())
    if not data:
        return 0

    init()
    count = 0
    with _connect() as conn:
        for entry in data:
            # Skip if already migrated (check by page_url_hash)
            existing = conn.execute(
                "SELECT 1 FROM downloads WHERE page_url_hash = ? AND status = 'done' LIMIT 1",
                (entry.get("hash", ""),),
            ).fetchone()
            if existing:
                continue

            conn.execute(
                """INSERT INTO downloads
                   (id, page_url, page_url_hash, title, filename, resolution, status, completed_at, last_skipped, domain)
                   VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?)""",
                (
                    entry.get("hash", ""),  # use hash as id for migrated records
                    entry.get("page_url", ""),
                    entry.get("hash", ""),
                    entry.get("title", ""),
                    entry.get("filename", ""),
                    entry.get("resolution", ""),
                    entry.get("completed_at"),
                    entry.get("last_skipped"),
                    domain_from_url(entry.get("page_url", "")),
                ),
            )
            count += 1

    return count
