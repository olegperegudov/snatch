use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA: &str = r#"
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
"#;

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadRow {
    pub id: String,
    pub page_url: String,
    pub page_url_hash: String,
    pub video_url: Option<String>,
    pub title: Option<String>,
    pub filename: Option<String>,
    pub download_dir: Option<String>,
    pub domain: Option<String>,
    pub resolution: Option<String>,
    pub filesize_bytes: Option<i64>,
    pub duration: Option<String>,
    pub format: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: Option<f64>,
    pub completed_at: Option<f64>,
    pub last_skipped: Option<f64>,
}

impl Db {
    pub fn new(path: &PathBuf) -> Self {
        let conn = Connection::open(path).expect("Failed to open database");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .expect("Failed to set pragmas");
        conn.execute_batch(SCHEMA).expect("Failed to create schema");
        Db { conn: Mutex::new(conn) }
    }

    fn now() -> f64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64()
    }

    pub fn url_hash(url: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        format!("{:.12x}", hasher.finalize()).chars().take(12).collect()
    }

    fn domain_from_url(url: &str) -> String {
        url::Url::parse(url).ok()
            .and_then(|u| u.host_str().map(String::from))
            .unwrap_or_default()
    }

    pub fn add(&self, id: &str, video_url: &str, page_url: &str, title: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO downloads (id, page_url, page_url_hash, video_url, title, domain, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
            params![
                id,
                page_url,
                Self::url_hash(page_url),
                video_url,
                title,
                Self::domain_from_url(page_url),
                Self::now(),
            ],
        ).expect("Failed to insert download");
    }

    pub fn update_status(&self, id: &str, status: &str) {
        let conn = self.conn.lock().unwrap();
        if status == "done" {
            conn.execute(
                "UPDATE downloads SET status = ?1, completed_at = ?2 WHERE id = ?3",
                params![status, Self::now(), id],
            ).ok();
        } else {
            conn.execute(
                "UPDATE downloads SET status = ?1 WHERE id = ?2",
                params![status, id],
            ).ok();
        }
    }

    pub fn update_status_with_error(&self, id: &str, status: &str, error: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET status = ?1, error = ?2 WHERE id = ?3",
            params![status, error, id],
        ).ok();
    }

    pub fn update_metadata(&self, id: &str, filename: Option<&str>, resolution: Option<&str>,
                           filesize: Option<i64>, format: Option<&str>, download_dir: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET filename = COALESCE(?1, filename),
             resolution = COALESCE(?2, resolution),
             filesize_bytes = COALESCE(?3, filesize_bytes),
             format = COALESCE(?4, format),
             download_dir = COALESCE(?5, download_dir)
             WHERE id = ?6",
            params![filename, resolution, filesize, format, download_dir, id],
        ).ok();
    }

    pub fn is_downloaded(&self, page_url: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let h = Self::url_hash(page_url);
        conn.query_row(
            "SELECT 1 FROM downloads WHERE page_url_hash = ?1 AND status = 'done' LIMIT 1",
            params![h],
            |_| Ok(()),
        ).is_ok()
    }

    pub fn mark_skipped(&self, page_url: &str) {
        let conn = self.conn.lock().unwrap();
        let h = Self::url_hash(page_url);
        conn.execute(
            "UPDATE downloads SET last_skipped = ?1 WHERE page_url_hash = ?2 AND status = 'done'",
            params![Self::now(), h],
        ).ok();
    }

    pub fn get_completed(&self, limit: i64) -> Vec<DownloadRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT * FROM downloads WHERE status = 'done' ORDER BY completed_at DESC LIMIT ?1"
        ).unwrap();
        Self::query_rows(&mut stmt, params![limit])
    }

    pub fn get_by_status(&self, statuses: &[&str]) -> Vec<DownloadRow> {
        let conn = self.conn.lock().unwrap();
        let placeholders: Vec<String> = (1..=statuses.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT * FROM downloads WHERE status IN ({}) ORDER BY created_at",
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let params: Vec<&dyn rusqlite::types::ToSql> = statuses.iter()
            .map(|s| s as &dyn rusqlite::types::ToSql).collect();
        Self::query_rows_dyn(&mut stmt, params.as_slice())
    }

    pub fn recover_interrupted(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE downloads SET status = 'paused' WHERE status IN ('downloading', 'pending')", []).ok();
    }

    pub fn search(&self, query: &str, limit: i64) -> Vec<DownloadRow> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{query}%");
        let mut stmt = conn.prepare(
            "SELECT * FROM downloads WHERE status = 'done'
             AND (title LIKE ?1 OR filename LIKE ?1 OR page_url LIKE ?1 OR domain LIKE ?1)
             ORDER BY completed_at DESC LIMIT ?2"
        ).unwrap();
        Self::query_rows(&mut stmt, params![pattern, limit])
    }

    pub fn delete(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![id]).ok();
    }

    fn query_rows(stmt: &mut rusqlite::Statement, params: impl rusqlite::Params) -> Vec<DownloadRow> {
        stmt.query_map(params, |row| {
            Ok(DownloadRow {
                id: row.get(0)?,
                page_url: row.get(1)?,
                page_url_hash: row.get(2)?,
                video_url: row.get(3)?,
                title: row.get(4)?,
                filename: row.get(5)?,
                download_dir: row.get(6)?,
                domain: row.get(7)?,
                resolution: row.get(8)?,
                filesize_bytes: row.get(9)?,
                duration: row.get(10)?,
                format: row.get(11)?,
                status: row.get(12)?,
                error: row.get(13)?,
                created_at: row.get(14)?,
                completed_at: row.get(15)?,
                last_skipped: row.get(16)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    fn query_rows_dyn(stmt: &mut rusqlite::Statement, params: &[&dyn rusqlite::types::ToSql]) -> Vec<DownloadRow> {
        stmt.query_map(params, |row| {
            Ok(DownloadRow {
                id: row.get(0)?,
                page_url: row.get(1)?,
                page_url_hash: row.get(2)?,
                video_url: row.get(3)?,
                title: row.get(4)?,
                filename: row.get(5)?,
                download_dir: row.get(6)?,
                domain: row.get(7)?,
                resolution: row.get(8)?,
                filesize_bytes: row.get(9)?,
                duration: row.get(10)?,
                format: row.get(11)?,
                status: row.get(12)?,
                error: row.get(13)?,
                created_at: row.get(14)?,
                completed_at: row.get(15)?,
                last_skipped: row.get(16)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }
}
