import asyncio
import functools
import re
import shutil
import tempfile
from pathlib import Path

import yt_dlp

from download_queue import DownloadQueue, DownloadItem, Status


def _strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s).strip()


def _make_progress_hook(item: DownloadItem, queue: DownloadQueue):
    def hook(d):
        if item.status == Status.CANCELLED:
            raise yt_dlp.utils.DownloadCancelled("Cancelled by user")
        if d["status"] == "downloading":
            item.status = Status.DOWNLOADING
            pct = _strip_ansi(d.get("_percent_str", "0%")).rstrip("%")
            try:
                item.progress = float(pct)
            except ValueError:
                item.progress = 0.0
            item.speed = _strip_ansi(d.get("_speed_str", ""))
            item.eta = _strip_ansi(d.get("_eta_str", ""))
            item.filesize = _strip_ansi(d.get("_total_bytes_str", "") or d.get("_total_bytes_estimate_str", ""))
            if d.get("filename"):
                item.filename = Path(d["filename"]).name
        elif d["status"] == "finished":
            item.progress = 100.0
            if d.get("filename"):
                item.filename = Path(d["filename"]).name
    return hook


def _build_format(resolution: str) -> str:
    if resolution == "best":
        return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
    height = resolution.rstrip("p")
    return f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={height}]/best"


def _sanitize_filename(name: str) -> str:
    # Remove characters not allowed in filenames
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    return name.strip().rstrip('.')[:200]


def _download_sync(item: DownloadItem, queue: DownloadQueue,
                   download_dir: str, resolution: str):
    # Use item title as filename if available, otherwise let yt-dlp decide
    if item.title and item.title != item.url:
        filename = _sanitize_filename(item.title) + ".%(ext)s"
    else:
        filename = "%(title)s.%(ext)s"

    # Download to temp dir first, move final file to download_dir
    # This prevents temp/partial files from cluttering the download folder
    tmpdir = tempfile.mkdtemp(prefix="snatch_")
    try:
        opts = {
            "outtmpl": str(Path(tmpdir) / filename),
            "format": _build_format(resolution),
            "merge_output_format": "mp4",
            "progress_hooks": [_make_progress_hook(item, queue)],
            "quiet": True,
            "no_warnings": True,
            "concurrent_fragment_downloads": 8,
            "buffersize": 1024 * 1024,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([item.url])

        # Move final file(s) to download_dir
        for f in Path(tmpdir).iterdir():
            dest = Path(download_dir) / f.name
            shutil.move(str(f), str(dest))
            item.filename = f.name
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def download(item: DownloadItem, queue: DownloadQueue,
                   download_dir: str, resolution: str):
    item.status = Status.DOWNLOADING
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(
            None,
            functools.partial(_download_sync, item, queue, download_dir, resolution),
        )
        if item.status != Status.CANCELLED:
            item.status = Status.DONE
            item.progress = 100.0
    except yt_dlp.utils.DownloadCancelled:
        item.status = Status.CANCELLED
    except Exception as e:
        item.status = Status.ERROR
        item.error = str(e)[:200]
    finally:
        queue._save_state()
