use axum::{
    Router,
    extract::{Path as AxumPath, State, Request},
    middleware::Next,
    response::Response,
    routing::{delete, get, post, put},
    Json,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use http::HeaderValue;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;

use crate::db::Db;
use crate::downloader;
use crate::queue::{DownloadQueue, Status};

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

pub struct AppState {
    pub queue: DownloadQueue,
    pub db: Arc<Db>,
    pub settings: Mutex<Settings>,
    pub last_request: Arc<AtomicU64>,
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

async fn track_activity(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    state.last_request.store(now_secs(), Ordering::Relaxed);
    next.run(req).await
}

pub async fn start_server(state: Arc<AppState>) {
    // Idle shutdown: exit after 10 min with no requests and no active downloads
    let idle_state = state.clone();
    tokio::spawn(async move {
        const IDLE_TIMEOUT: u64 = 600; // 10 minutes
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let last = idle_state.last_request.load(Ordering::Relaxed);
            let elapsed = now_secs().saturating_sub(last);
            if elapsed > IDLE_TIMEOUT {
                let items = idle_state.queue.items.lock().await;
                let has_active = items.values().any(|i|
                    i.status == Status::Downloading || i.status == Status::Pending
                );
                if !has_active {
                    eprintln!("[Snatch] Idle timeout ({IDLE_TIMEOUT}s), shutting down");
                    std::process::exit(0);
                }
            }
        }
    });

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
        .route("/check-update", get(check_update))
        .route("/update", post(do_update))
        .route("/shutdown", post(shutdown_server))
        .layer(axum::middleware::from_fn_with_state(state.clone(), track_activity))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
                    origin.as_bytes().starts_with(b"chrome-extension://")
                }))
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any)
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:9111").await
        .expect("Failed to bind to port 9111");
    eprintln!("[Snatch] HTTP server listening on :9111");
    axum::serve(listener, app).await.ok();
}

// --- Handlers ---

async fn health() -> Json<Value> {
    Json(json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
}

async fn shutdown_server() -> Json<Value> {
    eprintln!("[Snatch] Shutdown requested");
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        std::process::exit(0);
    });
    Json(json!({"ok": true}))
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
        let force = req.force;
        tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            downloader::download(item_id, queue_items, db, download_dir, preferred_res, force).await;
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
                downloader::download(item_id, queue_items, db, download_dir, preferred_res, false).await;
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
            downloader::download(id, queue_items, db, dl_dir, pref, false).await;
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

// --- Auto-update ---

const GITHUB_REPO: &str = "olegperegudov/snatch";

fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.').filter_map(|p| p.parse().ok()).collect()
    };
    let l = parse(latest);
    let c = parse(current);
    for i in 0..3 {
        let lv = l.get(i).unwrap_or(&0);
        let cv = c.get(i).unwrap_or(&0);
        if lv > cv { return true; }
        if lv < cv { return false; }
    }
    false
}

async fn fetch_latest_release() -> Result<(String, String), String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let client = reqwest::Client::new();
    let resp = client.get(&url)
        .header("User-Agent", "Snatch-Companion")
        .send().await
        .map_err(|e| format!("GitHub API error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let text = resp.text().await
        .map_err(|e| format!("Read error: {e}"))?;
    let json: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Parse error: {e}"))?;

    let tag = json["tag_name"].as_str()
        .ok_or("No tag_name in release")?;
    let version = tag.strip_prefix('v').unwrap_or(tag).to_string();

    let download_url = json["assets"].as_array()
        .and_then(|assets| assets.iter().find(|a| {
            a["name"].as_str().map(|n| n.ends_with("-setup.exe")).unwrap_or(false)
        }))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or("No installer asset found in release")?
        .to_string();

    Ok((version, download_url))
}

async fn check_update() -> Json<Value> {
    let current = env!("CARGO_PKG_VERSION");
    match fetch_latest_release().await {
        Ok((version, download_url)) => {
            Json(json!({
                "current": current,
                "latest": version,
                "update_available": version_newer(&version, current),
                "download_url": download_url,
            }))
        }
        Err(e) => Json(json!({
            "current": current,
            "error": e,
        }))
    }
}

async fn do_update() -> Json<Value> {
    let current = env!("CARGO_PKG_VERSION");
    eprintln!("[Snatch] Update check: current={current}");

    let (version, download_url) = match fetch_latest_release().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Snatch] Update error: {e}");
            return Json(json!({"ok": false, "error": e}));
        }
    };

    if !version_newer(&version, current) {
        eprintln!("[Snatch] Already up to date ({current} >= {version})");
        return Json(json!({"ok": false, "error": "Already up to date"}));
    }

    eprintln!("[Snatch] Downloading v{version} from {download_url}");
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join(format!("Snatch_{version}_x64-setup.exe"));

    let response = match reqwest::get(&download_url).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Snatch] Download failed: {e}");
            return Json(json!({"ok": false, "error": format!("Download failed: {e}")}));
        }
    };

    let bytes = match response.bytes().await {
        Ok(b) => {
            eprintln!("[Snatch] Downloaded {} bytes", b.len());
            b
        }
        Err(e) => {
            eprintln!("[Snatch] Download read failed: {e}");
            return Json(json!({"ok": false, "error": format!("Download failed: {e}")}));
        }
    };

    if let Err(e) = std::fs::write(&installer_path, &bytes) {
        eprintln!("[Snatch] Save failed: {e}");
        return Json(json!({"ok": false, "error": format!("Save failed: {e}")}));
    }
    eprintln!("[Snatch] Saved installer to {}", installer_path.display());

    // Launch installer silently and exit
    #[cfg(target_os = "windows")]
    {
        use std::process::Command as StdCommand;
        eprintln!("[Snatch] Launching installer /S...");
        match StdCommand::new(&installer_path).arg("/S").spawn() {
            Ok(_) => {
                eprintln!("[Snatch] Installer launched, exiting in 500ms");
                tokio::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    std::process::exit(0);
                });
                Json(json!({"ok": true, "version": version}))
            }
            Err(e) => {
                eprintln!("[Snatch] Failed to launch installer: {e}");
                Json(json!({"ok": false, "error": format!("Failed to launch installer: {e}")}))
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Json(json!({"ok": false, "error": "Auto-update only supported on Windows"}))
    }
}
