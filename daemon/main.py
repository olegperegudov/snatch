import asyncio
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from download_queue import DownloadQueue
from downloader import download

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # chrome-extension:// origins
    allow_methods=["*"],
    allow_headers=["*"],
)

SETTINGS_FILE = Path(__file__).parent / "settings.json"
HISTORY_FILE = Path(__file__).parent / "history.json"
DEFAULT_SETTINGS = {
    "download_dir": "/mnt/c/Users/olegp/Downloads/_old",
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


def save_settings(settings: dict):
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))


settings = load_settings()
queue = DownloadQueue(max_concurrent=settings["max_concurrent"])


# --- History (completed downloads) ---
def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def load_history() -> list[dict]:
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text())
        except (json.JSONDecodeError, TypeError):
            pass
    return []


def save_history(history: list[dict]):
    HISTORY_FILE.write_text(json.dumps(history, indent=2))


def is_in_history(page_url: str) -> bool:
    h = _url_hash(page_url)
    return any(item["hash"] == h for item in load_history())


def add_to_history(item):
    history = load_history()
    entry = {
        "hash": _url_hash(item.page_url),
        "page_url": item.page_url,
        "title": item.title,
        "filename": item.filename,
        "resolution": "",
        "completed_at": time.time(),
    }
    # Extract resolution from title like "Video Name [720p]"
    res_match = re.search(r"\[(\d+p)\]", item.title or "")
    if res_match:
        entry["resolution"] = res_match.group(1)
    history.append(entry)
    save_history(history)


class UrlRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    page_url: str = ""
    title: str = ""


@app.post("/download")
async def add_download(req: DownloadRequest):
    # Check history if skip_downloaded is enabled
    if settings.get("skip_downloaded") and req.page_url and is_in_history(req.page_url):
        return {"ok": False, "reason": "already_downloaded"}
    item = queue.add(req.url, req.page_url, req.title)
    asyncio.create_task(_run_download(item.id))
    return {"ok": True, "id": item.id}


async def _run_download(item_id: str):
    async with queue._semaphore:
        item = queue.items.get(item_id)
        if not item:
            return
        await download(item, queue, settings["download_dir"], settings["preferred_resolution"])
        if item.status.value == "done":
            add_to_history(item)


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
    history = load_history()
    # Return last 50, newest first
    return {"items": list(reversed(history[-50:]))}


@app.post("/history/check")
async def check_history(req: UrlRequest):
    """Check if a page URL was already downloaded."""
    return {"downloaded": is_in_history(req.url)}


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
    """Reveal a completed file by filename."""
    filename = req.get("filename", "")
    if not filename:
        return {"ok": False, "error": "no filename"}
    filepath = Path(settings["download_dir"]) / filename
    if not filepath.exists():
        return {"ok": False, "error": "file missing on disk"}
    _reveal_in_explorer(filepath)
    return {"ok": True}


def _reveal_in_explorer(filepath: Path):
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(filepath)])
    else:
        try:
            win_path = subprocess.check_output(["wslpath", "-w", str(filepath)], text=True).strip()
            # explorer.exe needs the whole /select,"path" as one argument
            subprocess.Popen(f'explorer.exe /select,"{win_path}"', shell=True)
        except FileNotFoundError:
            subprocess.Popen(["xdg-open", str(filepath.parent)])


class ProbeRequest(BaseModel):
    url: str


@app.post("/probe")
async def probe_url(req: ProbeRequest):
    """Fetch m3u8/mpd and extract available resolutions."""
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

    # Try parsing HLS master playlist from fetched content
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

    # Fallback: parse resolutions from URL itself (e.g. multi=WxH:label,... pattern)
    if not variants:
        variants = _parse_url_resolutions(url)

    if not variants:
        variants.append({"url": url, "resolution": "unknown", "height": 0, "type": "HLS"})

    # Sort by height descending
    variants.sort(key=lambda v: v["height"], reverse=True)
    return {"variants": variants}


def _parse_url_resolutions(url: str) -> list[dict]:
    """Extract resolution variants from URL patterns (CDN-encoded resolutions)."""
    variants = []

    # Pattern: multi=WxH:label,WxH:label,... (xHamster CDN style)
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

    # Generic: look for resolution patterns in URL
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
    uvicorn.run(app, host="127.0.0.1", port=9111)
