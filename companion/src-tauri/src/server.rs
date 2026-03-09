use axum::{
    Router,
    extract::{Path as AxumPath, State},
    routing::{delete, get, post, put},
    Json,
};
use tower_http::cors::CorsLayer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::db::Db;
use crate::downloader;
use crate::queue::{DownloadQueue, Status};

pub struct AppState {
    pub queue: DownloadQueue,
    pub db: Arc<Db>,
    pub settings: Mutex<Settings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub download_dir: String,
    pub max_concurrent: usize,
    pub preferred_resolution: String,
    pub skip_downloaded: bool,
    pub filter_resolution: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let download_dir = dirs::download_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"))
            .to_string_lossy().to_string();
        Settings {
            download_dir,
            max_concurrent: 2,
            preferred_resolution: "best".to_string(),
            skip_downloaded: true,
            filter_resolution: false,
        }
    }
}

impl Settings {
    pub fn load(path: &std::path::Path) -> Self {
        if path.exists() {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(s) = serde_json::from_str(&text) {
                    return s;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self, path: &std::path::Path) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            std::fs::write(path, json).ok();
        }
    }
}

pub fn settings_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::env::current_exe().unwrap().parent().unwrap().to_path_buf())
        .join("Snatch");
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

pub fn db_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::env::current_exe().unwrap().parent().unwrap().to_path_buf())
        .join("Snatch");
    std::fs::create_dir_all(&dir).ok();
    dir.join("snatch.db")
}

pub async fn start_server(state: Arc<AppState>) {
    let app = Router::new()
        .route("/health", get(health))
        .route("/queue", get(get_queue))
        .route("/queue/{item_id}", delete(remove_item))
        .route("/completed", get(get_completed))
        .route("/settings", get(get_settings))
        .route("/settings", put(put_settings))
        .route("/download", post(add_download))
        .route("/probe", post(probe_url))
        .route("/pause", post(pause_download))
        .route("/retry", post(retry_download))
        .route("/start_queue", post(start_queue))
        .route("/stop_queue", post(stop_queue))
        .route("/reveal_file", post(reveal_file))
        .route("/history/check", post(check_history))
        .layer(CorsLayer::very_permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:9111").await
        .expect("Failed to bind to port 9111");
    axum::serve(listener, app).await.ok();
}

// --- Handlers ---

async fn health() -> Json<Value> {
    Json(json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
}

async fn get_queue(State(state): State<Arc<AppState>>) -> Json<Value> {
    let items = state.queue.get_all().await;
    Json(json!({"items": items}))
}

async fn remove_item(
    State(state): State<Arc<AppState>>,
    AxumPath(item_id): AxumPath<String>,
) -> Json<Value> {
    let ok = state.queue.remove(&item_id).await;
    if ok {
        state.db.delete(&item_id);
    }
    Json(json!({"ok": ok}))
}

async fn get_completed(State(state): State<Arc<AppState>>) -> Json<Value> {
    let items = state.db.get_completed(50);
    Json(json!({"items": items}))
}

async fn get_settings(State(state): State<Arc<AppState>>) -> Json<Settings> {
    let guard = state.settings.lock().await;
    let s: Settings = guard.clone();
    Json(s)
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(new_settings): Json<Settings>,
) -> Json<Value> {
    let mut settings = state.settings.lock().await;
    *settings = new_settings.clone();
    settings.save(&settings_path());
    if new_settings.max_concurrent > 0 {
        state.queue.update_max_concurrent(new_settings.max_concurrent).await;
    }
    Json(json!({"ok": true}))
}

#[derive(Deserialize)]
struct DownloadRequest {
    url: String,
    #[serde(default)]
    page_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    force: bool,
    #[serde(default = "default_true")]
    auto_start: bool,
}
fn default_true() -> bool { true }

async fn add_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DownloadRequest>,
) -> Json<Value> {
    let settings = state.settings.lock().await;
    let skip = settings.skip_downloaded;
    let download_dir = settings.download_dir.clone();
    let preferred_res = settings.preferred_resolution.clone();
    drop(settings);

    // Dedup check
    if !req.force && skip && !req.page_url.is_empty() && state.db.is_downloaded(&req.page_url) {
        state.db.mark_skipped(&req.page_url);
        return Json(json!({"ok": false, "reason": "already_downloaded"}));
    }

    let id = uuid::Uuid::new_v4().to_string();
    state.db.add(&id, &req.url, &req.page_url, &req.title);
    let item = state.queue.add(id.clone(), req.url, req.page_url, req.title).await;

    if req.auto_start {
        let queue_items = state.queue.items.clone();
        let db = state.db.clone();
        let sem = state.queue.semaphore.clone();
        let item_id = id.clone();
        tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            downloader::download(item_id, queue_items, db, download_dir, preferred_res).await;
        });
    } else {
        // Mark as paused
        let mut lock = state.queue.items.lock().await;
        if let Some(item) = lock.get_mut(&id) {
            item.status = Status::Paused;
        }
        state.db.update_status(&id, "paused");
    }

    Json(json!({"ok": true, "id": id}))
}

#[derive(Deserialize)]
struct IdRequest {
    #[serde(default)]
    id: String,
}

async fn retry_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<IdRequest>,
) -> Json<Value> {
    let settings = state.settings.lock().await;
    let download_dir = settings.download_dir.clone();
    let preferred_res = settings.preferred_resolution.clone();
    drop(settings);

    let mut lock = state.queue.items.lock().await;
    if let Some(item) = lock.get_mut(&req.id) {
        if item.status == Status::Paused || item.status == Status::Error {
            item.status = Status::Pending;
            item.progress = 0.0;
            item.error.clear();
            state.db.update_status(&req.id, "pending");

            let queue_items = state.queue.items.clone();
            let db = state.db.clone();
            let sem = state.queue.semaphore.clone();
            let item_id = req.id.clone();
            drop(lock);
            tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                downloader::download(item_id, queue_items, db, download_dir, preferred_res).await;
            });
            return Json(json!({"ok": true}));
        }
    }
    Json(json!({"ok": false, "error": "item not found or not retryable"}))
}

async fn pause_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<IdRequest>,
) -> Json<Value> {
    let mut lock = state.queue.items.lock().await;
    if let Some(item) = lock.get_mut(&req.id) {
        if item.status == Status::Downloading || item.status == Status::Pending {
            item.status = Status::Paused;
            item.speed.clear();
            item.eta.clear();
            state.db.update_status(&req.id, "paused");
            return Json(json!({"ok": true}));
        }
    }
    Json(json!({"ok": false, "error": "item not found or not pausable"}))
}

async fn start_queue(State(state): State<Arc<AppState>>) -> Json<Value> {
    let settings = state.settings.lock().await;
    let download_dir = settings.download_dir.clone();
    let preferred_res = settings.preferred_resolution.clone();
    drop(settings);

    let mut lock = state.queue.items.lock().await;
    let mut paused: Vec<String> = lock.iter()
        .filter(|(_, i)| i.status == Status::Paused)
        .map(|(id, i)| (id.clone(), i.created_at))
        .collect::<Vec<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .into_iter()
        .map(|(id, _)| id)
        .collect();

    // Sort by created_at (FIFO)
    paused.sort_by(|a, b| {
        let a_time = lock.get(a).map(|i| i.created_at).unwrap_or(0.0);
        let b_time = lock.get(b).map(|i| i.created_at).unwrap_or(0.0);
        a_time.partial_cmp(&b_time).unwrap()
    });

    let count = paused.len();
    for id in &paused {
        if let Some(item) = lock.get_mut(id) {
            item.status = Status::Pending;
            item.progress = 0.0;
            item.error.clear();
            state.db.update_status(id, "pending");
        }
    }
    drop(lock);

    for id in paused {
        let queue_items = state.queue.items.clone();
        let db = state.db.clone();
        let sem = state.queue.semaphore.clone();
        let dl_dir = download_dir.clone();
        let pref = preferred_res.clone();
        tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            downloader::download(id, queue_items, db, dl_dir, pref).await;
        });
    }

    Json(json!({"ok": true, "started": count}))
}

async fn stop_queue(State(state): State<Arc<AppState>>) -> Json<Value> {
    let mut lock = state.queue.items.lock().await;
    let mut count = 0;
    for item in lock.values_mut() {
        if item.status == Status::Pending {
            item.status = Status::Paused;
            state.db.update_status(&item.id, "paused");
            count += 1;
        }
    }
    Json(json!({"ok": true, "paused": count}))
}

#[derive(Deserialize)]
struct RevealRequest {
    #[serde(default)]
    filename: String,
}

async fn reveal_file(
    State(state): State<Arc<AppState>>,
    Json(_req): Json<RevealRequest>,
) -> Json<Value> {
    let settings = state.settings.lock().await;
    let dir = settings.download_dir.clone();
    drop(settings);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&dir).spawn().ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open").arg(&dir).spawn().ok();
    }

    Json(json!({"ok": true}))
}

#[derive(Deserialize)]
struct HistoryCheckRequest {
    #[serde(default)]
    url: String,
}

async fn check_history(
    State(state): State<Arc<AppState>>,
    Json(req): Json<HistoryCheckRequest>,
) -> Json<Value> {
    let downloaded = state.db.is_downloaded(&req.url);
    Json(json!({"downloaded": downloaded}))
}

#[derive(Deserialize)]
struct ProbeRequest {
    url: String,
}

async fn probe_url(Json(req): Json<ProbeRequest>) -> Json<Value> {
    let url = &req.url;
    let mut variants: Vec<Value> = Vec::new();

    // Fetch the URL content for m3u8 parsing
    if url.contains(".m3u8") {
        if let Ok(resp) = reqwest::get(url).await {
            if let Ok(text) = resp.text().await {
                let mut height: u32 = 0;
                let mut bandwidth: u64 = 0;
                for line in text.lines() {
                    let line = line.trim();
                    if line.starts_with("#EXT-X-STREAM-INF") {
                        // Parse RESOLUTION=WxH
                        if let Some(res) = line.split("RESOLUTION=").nth(1) {
                            if let Some(dim) = res.split(',').next().or(Some(res)) {
                                let parts: Vec<&str> = dim.split('x').collect();
                                if parts.len() == 2 {
                                    height = parts[1].parse().unwrap_or(0);
                                }
                            }
                        }
                        // Parse BANDWIDTH=N
                        if let Some(bw) = line.split("BANDWIDTH=").nth(1) {
                            bandwidth = bw.split(',').next().unwrap_or("0").parse().unwrap_or(0);
                        }
                    } else if !line.is_empty() && !line.starts_with('#') && height > 0 {
                        let stream_url = if line.starts_with("http") {
                            line.to_string()
                        } else {
                            // Resolve relative URL
                            let base = url.rfind('/').map(|i| &url[..=i]).unwrap_or(url);
                            format!("{base}{line}")
                        };
                        variants.push(json!({
                            "url": stream_url,
                            "resolution": format!("{height}p"),
                            "height": height,
                            "bandwidth": bandwidth,
                            "type": "HLS",
                        }));
                        height = 0;
                        bandwidth = 0;
                    }
                }
            }
        }
    }

    // Fallback: parse resolution from URL
    if variants.is_empty() {
        let re = regex_lite::Regex::new(r"(\d{3,4})p").unwrap();
        for cap in re.captures_iter(url) {
            if let Ok(h) = cap[1].parse::<u32>() {
                if (144..=4320).contains(&h) && !variants.iter().any(|v| v["height"] == h) {
                    variants.push(json!({
                        "url": url,
                        "resolution": format!("{h}p"),
                        "height": h,
                        "bandwidth": 0,
                        "type": "HLS",
                    }));
                }
            }
        }
    }

    if variants.is_empty() {
        variants.push(json!({
            "url": url,
            "resolution": "unknown",
            "height": 0,
            "type": "HLS",
        }));
    }

    variants.sort_by(|a, b| b["height"].as_u64().cmp(&a["height"].as_u64()));
    Json(json!({"variants": variants}))
}
