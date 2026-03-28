use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use crate::queue::{DownloadItem, Status};
use crate::db::Db;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Remove characters invalid in Windows filenames
fn sanitize_filename(s: &str) -> String {
    let s: String = s.chars().map(|c| match c {
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
        _ => c,
    }).collect();
    s.trim().to_string()
}

/// Find yt-dlp binary: bundled sidecar first, then PATH
fn find_ytdlp() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().unwrap_or(Path::new("."));
        let sidecar = dir.join("yt-dlp.exe");
        if sidecar.exists() {
            return sidecar;
        }
        let sidecar = dir.join("yt-dlp");
        if sidecar.exists() {
            return sidecar;
        }
    }
    PathBuf::from("yt-dlp")
}

/// Build common yt-dlp arguments
fn build_base_args(
    format: &str,
    output_template: &str,
    force_overwrite: bool,
) -> Vec<String> {
    let mut args = vec![
        "--newline".to_string(),
        "--progress".to_string(),
        "--progress-template".to_string(),
        "%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s".to_string(),
        "-f".to_string(), format.to_string(),
        "--merge-output-format".to_string(), "mp4".to_string(),
        "-o".to_string(), output_template.to_string(),
        // Use Chrome cookies for authenticated streams
        "--cookies-from-browser".to_string(), "chrome".to_string(),
    ];
    if force_overwrite {
        args.push("--force-overwrite".to_string());
    }
    args
}

/// Run yt-dlp with given target URL, return (success, stderr_text)
async fn run_ytdlp(
    ytdlp: &Path,
    args: &[String],
    target_url: &str,
    referer: &str,
    item_id: &str,
    items: &Arc<Mutex<std::collections::HashMap<String, DownloadItem>>>,
    db: &Arc<Db>,
    download_dir: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ytdlp);
    cmd.args(args);
    if !referer.is_empty() {
        cmd.args(["--referer", referer]);
    }
    cmd.arg(target_url);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Err(if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp not found — reinstall Snatch or add yt-dlp to PATH".to_string()
            } else {
                format!("Failed to start yt-dlp: {e}")
            });
        }
    };

    // Read stderr in background
    let stderr_handle = {
        let stderr = child.stderr.take().unwrap();
        tokio::spawn(async move {
            let mut lines = Vec::new();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                lines.push(line);
            }
            lines
        })
    };

    // Parse progress from stdout
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // Check if cancelled/paused
            {
                let lock = items.lock().await;
                if let Some(item) = lock.get(item_id) {
                    if item.status == Status::Cancelled || item.status == Status::Paused {
                        child.kill().await.ok();
                        return Err("cancelled".to_string());
                    }
                }
            }

            let line = line.trim().to_string();

            // Parse progress line: "  45.2% 12.5MiB/s 00:23"
            if line.contains('%') {
                let parts: Vec<&str> = line.split_whitespace().collect();
                let mut lock = items.lock().await;
                if let Some(item) = lock.get_mut(item_id) {
                    if let Some(pct_str) = parts.first() {
                        if let Ok(pct) = pct_str.trim_end_matches('%').parse::<f64>() {
                            item.progress = pct;
                        }
                    }
                    if let Some(speed) = parts.get(1) {
                        item.speed = speed.to_string();
                    }
                    if let Some(eta) = parts.get(2) {
                        item.eta = eta.to_string();
                    }
                }
            }

            // Detect filename
            if line.starts_with("[download] Destination:") || line.starts_with("[Merger]") {
                let path_str = line.split(':').skip(1).collect::<Vec<_>>().join(":").trim().to_string();
                if let Some(fname) = Path::new(&path_str).file_name() {
                    let fname = fname.to_string_lossy().to_string();
                    let mut lock = items.lock().await;
                    if let Some(item) = lock.get_mut(item_id) {
                        item.filename = fname.clone();
                    }
                    db.update_metadata(item_id, Some(&fname), None, None, None, Some(download_dir));
                }
            }

            // Detect resolution
            if line.contains("x") && (line.contains("mp4") || line.contains("webm")) {
                if let Some(cap) = line.split_whitespace()
                    .find(|s| s.contains('x') && s.chars().all(|c| c.is_ascii_digit() || c == 'x'))
                {
                    let parts: Vec<&str> = cap.split('x').collect();
                    if parts.len() == 2 {
                        if let Ok(h) = parts[1].parse::<u32>() {
                            let res = format!("{h}p");
                            db.update_metadata(item_id, None, Some(&res), None, None, None);
                        }
                    }
                }
            }
        }
    }

    let stderr_lines = stderr_handle.await.unwrap_or_default();
    let stderr_text = stderr_lines.join("\n");

    let status = child.wait().await;
    match status {
        Ok(s) if s.success() => Ok(()),
        _ => Err(stderr_text),
    }
}

/// Make error messages human-readable
fn humanize_error(stderr_text: &str) -> String {
    let lower = stderr_text.to_lowercase();
    if lower.contains("ffprobe") || lower.contains("ffmpeg not found") || lower.contains("ffmpeg is not installed") {
        "ffmpeg not installed — needed to merge video+audio".to_string()
    } else if lower.contains("412") || lower.contains("precondition") {
        "stream rejected request (412) — retried with page URL".to_string()
    } else if lower.contains("403") || lower.contains("forbidden") {
        "access denied (403) — stream may require authentication".to_string()
    } else if lower.contains("404") || lower.contains("not found") {
        "stream not found (404) — link may have expired".to_string()
    } else if lower.contains("unable to extract") || lower.contains("unsupported url") {
        "unsupported stream format".to_string()
    } else {
        stderr_text.lines().rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("yt-dlp exited with error")
            .to_string()
    }
}

pub async fn download(
    item_id: String,
    items: Arc<Mutex<std::collections::HashMap<String, DownloadItem>>>,
    db: Arc<Db>,
    download_dir: String,
    preferred_resolution: String,
    force_overwrite: bool,
) {
    let (url, title, page_url) = {
        let mut lock = items.lock().await;
        let item = match lock.get_mut(&item_id) {
            Some(i) => i,
            None => return,
        };
        if item.status != Status::Pending {
            return;
        }
        item.status = Status::Downloading;
        db.update_status(&item_id, "downloading");
        (item.url.clone(), item.title.clone(), item.page_url.clone())
    };

    let ytdlp = find_ytdlp();
    let dir = PathBuf::from(&download_dir);
    std::fs::create_dir_all(&dir).ok();

    let format = match preferred_resolution.as_str() {
        "best" | "" => "bestvideo+bestaudio/best".to_string(),
        res => {
            let h = res.replace("p", "");
            format!("bestvideo[height<={h}]+bestaudio/best[height<={h}]/best")
        }
    };

    let sanitized = sanitize_filename(&title);
    let output_template = if sanitized.is_empty() {
        dir.join("%(title)s [%(height)sp].%(ext)s")
    } else {
        dir.join(format!("{sanitized}.%(ext)s"))
    };

    let base_args = build_base_args(
        &format,
        output_template.to_str().unwrap_or("%(title)s.%(ext)s"),
        force_overwrite,
    );

    // Strategy: try page URL first (yt-dlp extractors handle auth/cookies),
    // fall back to raw stream URL with referer if that fails.
    let has_page_url = !page_url.is_empty() && page_url.starts_with("http");
    let has_stream_url = !url.is_empty() && url.starts_with("http");

    let result = if has_page_url {
        // Attempt 1: page URL (yt-dlp uses its extractors — handles auth, cookies, etc.)
        eprintln!("[Snatch] Trying page URL: {page_url}");
        let r = run_ytdlp(&ytdlp, &base_args, &page_url, "", &item_id, &items, &db, &download_dir).await;
        match r {
            Ok(()) => Ok(()),
            Err(ref e) if e == "cancelled" => Err("cancelled".to_string()),
            Err(ref first_err) if has_stream_url => {
                // Attempt 2: raw stream URL with referer (for sites without yt-dlp extractors)
                eprintln!("[Snatch] Page URL failed, trying stream URL: {url}");
                // Reset progress for retry
                {
                    let mut lock = items.lock().await;
                    if let Some(item) = lock.get_mut(&item_id) {
                        item.progress = 0.0;
                        item.speed.clear();
                        item.eta.clear();
                    }
                }
                let r2 = run_ytdlp(&ytdlp, &base_args, &url, &page_url, &item_id, &items, &db, &download_dir).await;
                match r2 {
                    Ok(()) => Ok(()),
                    Err(second_err) => {
                        // Use the more informative error
                        let err = if second_err.len() > first_err.len() { second_err } else { first_err.clone() };
                        Err(err)
                    }
                }
            }
            Err(e) => Err(e),
        }
    } else if has_stream_url {
        // No page URL, use stream URL directly
        eprintln!("[Snatch] Using stream URL: {url}");
        run_ytdlp(&ytdlp, &base_args, &url, &page_url, &item_id, &items, &db, &download_dir).await
    } else {
        Err("no valid URL to download".to_string())
    };

    // Update final status
    let mut lock = items.lock().await;
    if let Some(item) = lock.get_mut(&item_id) {
        if item.status == Status::Paused || item.status == Status::Cancelled {
            return;
        }
        match result {
            Ok(()) => {
                item.status = Status::Done;
                item.progress = 100.0;
                item.speed.clear();
                item.eta.clear();
                db.update_status(&item_id, "done");
            }
            Err(ref e) if e == "cancelled" => {}
            Err(ref stderr_text) => {
                item.status = Status::Error;
                item.error = humanize_error(stderr_text);
                db.update_status_with_error(&item_id, "error", &item.error);
            }
        }
    }
}
