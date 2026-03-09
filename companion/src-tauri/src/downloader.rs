use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use crate::queue::{DownloadItem, Status};
use crate::db::Db;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Find yt-dlp binary: bundled sidecar first, then PATH
fn find_ytdlp() -> PathBuf {
    // Check next to our executable (Tauri sidecar)
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().unwrap_or(Path::new("."));
        let sidecar = dir.join("yt-dlp.exe");
        if sidecar.exists() {
            return sidecar;
        }
        // Also check without .exe (linux/mac)
        let sidecar = dir.join("yt-dlp");
        if sidecar.exists() {
            return sidecar;
        }
    }
    // Fallback to PATH
    PathBuf::from("yt-dlp")
}

pub async fn download(
    item_id: String,
    items: Arc<Mutex<std::collections::HashMap<String, DownloadItem>>>,
    db: Arc<Db>,
    download_dir: String,
    preferred_resolution: String,
) {
    let url = {
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
        item.url.clone()
    };

    let ytdlp = find_ytdlp();
    let dir = PathBuf::from(&download_dir);
    std::fs::create_dir_all(&dir).ok();

    // Build format string
    let format = match preferred_resolution.as_str() {
        "best" | "" => "bestvideo+bestaudio/best".to_string(),
        res => {
            let h = res.replace("p", "");
            format!("bestvideo[height<={h}]+bestaudio/best[height<={h}]/best")
        }
    };

    let output_template = dir.join("%(title)s [%(height)sp].%(ext)s");

    let mut cmd = Command::new(&ytdlp);
    cmd.args([
        "--no-warnings",
        "--newline",
        "--progress",
        "--progress-template", "%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
        "-f", &format,
        "--merge-output-format", "mp4",
        "-o", output_template.to_str().unwrap_or("%(title)s.%(ext)s"),
        "--concurrent-fragments", "8",
        "--buffer-size", "1M",
        &url,
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // On Windows, hide the console window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut lock = items.lock().await;
            if let Some(item) = lock.get_mut(&item_id) {
                item.status = Status::Error;
                item.error = format!("Failed to start yt-dlp: {e}");
                db.update_status_with_error(&item_id, "error", &item.error);
            }
            return;
        }
    };

    // Parse progress from stdout
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // Check if cancelled/paused
            {
                let lock = items.lock().await;
                if let Some(item) = lock.get(&item_id) {
                    if item.status == Status::Cancelled || item.status == Status::Paused {
                        child.kill().await.ok();
                        return;
                    }
                }
            }

            let line = line.trim().to_string();

            // Parse progress line: "  45.2% 12.5MiB/s 00:23"
            if line.contains('%') {
                let parts: Vec<&str> = line.split_whitespace().collect();
                let mut lock = items.lock().await;
                if let Some(item) = lock.get_mut(&item_id) {
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

            // Detect filename from [download] or [Merger] lines
            if line.starts_with("[download] Destination:") || line.starts_with("[Merger]") {
                let path_str = line.split(':').skip(1).collect::<Vec<_>>().join(":").trim().to_string();
                if let Some(fname) = Path::new(&path_str).file_name() {
                    let fname = fname.to_string_lossy().to_string();
                    let mut lock = items.lock().await;
                    if let Some(item) = lock.get_mut(&item_id) {
                        item.filename = fname.clone();
                    }
                    db.update_metadata(&item_id, Some(&fname), None, None, None, Some(&download_dir));
                }
            }

            // Detect resolution from format info
            if line.contains("x") && (line.contains("mp4") || line.contains("webm")) {
                if let Some(cap) = line.split_whitespace()
                    .find(|s| s.contains('x') && s.chars().all(|c| c.is_ascii_digit() || c == 'x'))
                {
                    let parts: Vec<&str> = cap.split('x').collect();
                    if parts.len() == 2 {
                        if let Ok(h) = parts[1].parse::<u32>() {
                            let res = format!("{h}p");
                            db.update_metadata(&item_id, None, Some(&res), None, None, None);
                        }
                    }
                }
            }
        }
    }

    // Capture stderr for error reporting
    let stderr_text = if let Some(stderr) = child.stderr.take() {
        let mut lines = Vec::new();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            lines.push(line);
        }
        lines.join("\n")
    } else {
        String::new()
    };

    let status = child.wait().await;
    let mut lock = items.lock().await;
    if let Some(item) = lock.get_mut(&item_id) {
        // Don't override if paused/cancelled while downloading
        if item.status == Status::Paused || item.status == Status::Cancelled {
            return;
        }
        match status {
            Ok(s) if s.success() => {
                item.status = Status::Done;
                item.progress = 100.0;
                item.speed.clear();
                item.eta.clear();
                db.update_status(&item_id, "done");
            }
            _ => {
                item.status = Status::Error;
                // Use last non-empty stderr line as error, fall back to generic message
                let last_line = stderr_text.lines().rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("yt-dlp exited with error");
                item.error = last_line.to_string();
                db.update_status_with_error(&item_id, "error", &item.error);
            }
        }
    }
}
