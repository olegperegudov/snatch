import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import db
from download_queue import DownloadQueue, Status
from downloader import download

# --- Init DB ---
db.init()

# Migrate history.json on first run (idempotent)
history_json = Path(__file__).parent / "history.json"
if history_json.exists():
    count = db.migrate_from_json(str(history_json))
    if count > 0:
        history_json.rename(history_json.with_suffix(".json.bak"))
        print(f"Migrated {count} records from history.json -> snatch.db")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_methods=["*"],
    allow_headers=["*"],
)

SETTINGS_FILE = Path(__file__).parent / "settings.json"
DEFAULT_SETTINGS = {
    "download_dir": str(Path.home() / "Downloads"),
    "max_concurrent": 2,
    "preferred_resolution": "best",
    "skip_downloaded": True,
}


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_FILE.read_text())}
        except json.JSONDecodeError:
            pass
    return dict(DEFAULT_SETTINGS)


def save_settings(s: dict):
    SETTINGS_FILE.write_text(json.dumps(s, indent=2))


settings = load_settings()
queue = DownloadQueue(max_concurrent=settings["max_concurrent"])


# --- Startup: log recovered downloads ---
@app.on_event("startup")
async def startup():
    paused = [item for item in queue.items.values() if item.status.value == "paused"]
    if paused:
        print(f"Recovered {len(paused)} interrupted downloads (paused)")


class DownloadRequest(BaseModel):
    url: str
    page_url: str = ""
    title: str = ""
    force: bool = False
    auto_start: bool = True


@app.post("/download")
async def add_download(req: DownloadRequest):
    if not req.force and settings.get("skip_downloaded") and req.page_url and db.is_downloaded(req.page_url):
        db.mark_skipped(req.page_url)
        return {"ok": False, "reason": "already_downloaded"}
    item = queue.add(req.url, req.page_url, req.title)
    if req.auto_start:
        asyncio.create_task(_run_download(item.id))
    else:
        item.status = Status.PAUSED
        db.update_status(item.id, "paused")
    return {"ok": True, "id": item.id}


@app.post("/retry")
async def retry_download(req: dict):
    """Retry a paused/error download."""
    item_id = req.get("id", "")
    if item_id in queue.items:
        item = queue.items[item_id]
        if item.status.value in ("paused", "error"):
            item.status = Status.PENDING
            item.progress = 0.0
            item.error = ""
            db.update_status(item_id, "pending")
            asyncio.create_task(_run_download(item_id))
            return {"ok": True}
    return {"ok": False, "error": "item not found or not retryable"}


@app.post("/pause")
async def pause_download(req: dict):
    """Pause a pending/downloading item."""
    item_id = req.get("id", "")
    if item_id in queue.items:
        item = queue.items[item_id]
        if item.status.value in ("downloading", "pending"):
            if item.status.value == "downloading":
                item.status = Status.CANCELLED  # triggers DownloadCancelled in yt-dlp hook
            # Set paused — downloader.py checks this and won't override
            item.status = Status.PAUSED
            item.speed = ""
            item.eta = ""
            db.update_status(item_id, "paused")
            return {"ok": True}
    return {"ok": False, "error": "item not found or not pausable"}


@app.post("/start_queue")
async def start_queue():
    """Start all paused items (FIFO, respecting max_concurrent via semaphore)."""
    paused = [i for i in queue.items.values() if i.status == Status.PAUSED]
    paused.sort(key=lambda i: i.created_at)
    for item in paused:
        item.status = Status.PENDING
        item.progress = 0.0
        item.error = ""
        db.update_status(item.id, "pending")
        asyncio.create_task(_run_download(item.id))
    return {"ok": True, "started": len(paused)}


@app.post("/stop_queue")
async def stop_queue():
    """Pause all pending items (downloading items continue)."""
    count = 0
    for item in queue.items.values():
        if item.status == Status.PENDING:
            item.status = Status.PAUSED
            db.update_status(item.id, "paused")
            count += 1
    return {"ok": True, "paused": count}


async def _run_download(item_id: str):
    async with queue._semaphore:
        item = queue.items.get(item_id)
        if not item:
            return
        # Skip if paused/cancelled while waiting for semaphore
        if item.status.value not in ("pending",):
            return
        await download(item, queue, settings["download_dir"], settings["preferred_resolution"])


@app.get("/queue")
async def get_queue():
    return {"items": queue.get_all()}


@app.delete("/queue/{item_id}")
async def remove_item(item_id: str):
    ok = queue.remove(item_id)
    return {"ok": ok}


@app.get("/settings")
async def get_settings():
    return settings


@app.put("/settings")
async def update_settings(new_settings: dict):
    settings.update(new_settings)
    save_settings(settings)
    if "max_concurrent" in new_settings:
        queue.update_max_concurrent(new_settings["max_concurrent"])
    return {"ok": True}


@app.get("/completed")
async def get_completed():
    return {"items": db.get_completed(limit=50)}


@app.post("/history/check")
async def check_history(req: dict):
    url = req.get("url", "")
    return {"downloaded": db.is_downloaded(url)}


@app.post("/reveal/{item_id}")
async def reveal_file(item_id: str):
    item = queue.items.get(item_id)
    if not item or not item.filename:
        return {"ok": False, "error": "file not found"}
    filepath = Path(settings["download_dir"]) / item.filename
    if not filepath.exists():
        return {"ok": False, "error": "file missing on disk"}
    _reveal_in_explorer(filepath)
    return {"ok": True}


@app.post("/reveal_file")
async def reveal_by_filename(req: dict):
    _open_folder(Path(settings["download_dir"]))
    return {"ok": True}


def _open_folder(folder: Path):
    if sys.platform == "win32":
        subprocess.Popen(["explorer", str(folder)])
    else:
        try:
            win_path = subprocess.check_output(["wslpath", "-w", str(folder)], text=True).strip()
            subprocess.Popen(["explorer.exe", win_path])
        except FileNotFoundError:
            subprocess.Popen(["xdg-open", str(folder)])


class ProbeRequest(BaseModel):
    url: str


@app.post("/probe")
async def probe_url(req: ProbeRequest):
    url = req.url
    text = ""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                text = resp.text
    except Exception:
        pass

    variants = []

    if text and ".m3u8" in url:
        height = 0
        bandwidth = 0
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("#EXT-X-STREAM-INF"):
                res_match = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
                bw_match = re.search(r"BANDWIDTH=(\d+)", line)
                height = int(res_match.group(2)) if res_match else 0
                bandwidth = int(bw_match.group(1)) if bw_match else 0
            elif line and not line.startswith("#") and height:
                stream_url = line if line.startswith("http") else urljoin(url, line)
                variants.append({
                    "url": stream_url,
                    "resolution": f"{height}p",
                    "height": height,
                    "bandwidth": bandwidth,
                    "type": "HLS",
                })
                height = 0
                bandwidth = 0

    if not variants:
        variants = _parse_url_resolutions(url)

    if not variants:
        variants.append({"url": url, "resolution": "unknown", "height": 0, "type": "HLS"})

    variants.sort(key=lambda v: v["height"], reverse=True)
    return {"variants": variants}


def _parse_url_resolutions(url: str) -> list[dict]:
    variants = []

    multi_match = re.search(r"multi=([^/]+)", url)
    if multi_match:
        for part in multi_match.group(1).split(","):
            m = re.match(r"(\d+)x(\d+):(\d+p)", part)
            if m:
                height = int(m.group(2))
                variants.append({
                    "url": url,
                    "resolution": f"{height}p",
                    "height": height,
                    "bandwidth": 0,
                    "type": "HLS",
                })
        return variants

    for m in re.finditer(r"(\d{3,4})p", url):
        height = int(m.group(1))
        if 144 <= height <= 4320:
            if not any(v["height"] == height for v in variants):
                variants.append({
                    "url": url,
                    "resolution": f"{height}p",
                    "height": height,
                    "bandwidth": 0,
                    "type": "HLS",
                })

    return variants


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=9111, access_log=False)
