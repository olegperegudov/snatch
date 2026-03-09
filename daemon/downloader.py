import asyncio
import functools
import re
import shutil
import tempfile
from pathlib import Path

import yt_dlp

import db
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
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    return name.strip().rstrip('.')[:200]


def _extract_metadata(item: DownloadItem, download_dir: str):
    """Save file metadata to DB after download."""
    meta = {"download_dir": download_dir}
    if item.filename:
        filepath = Path(download_dir) / item.filename
        if filepath.exists():
            meta["filesize_bytes"] = filepath.stat().st_size
        ext = filepath.suffix.lstrip(".")
        if ext:
            meta["format"] = ext
    res_match = re.search(r"\[(\d+p)\]", item.title or "")
    if res_match:
        meta["resolution"] = res_match.group(1)
    db.update_metadata(item.id, **meta)


def _download_sync(item: DownloadItem, queue: DownloadQueue,
                   download_dir: str, resolution: str):
    if item.title and item.title != item.url:
        filename = _sanitize_filename(item.title) + ".%(ext)s"
    else:
        filename = "%(title)s.%(ext)s"

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

        for f in Path(tmpdir).iterdir():
            dest = Path(download_dir) / f.name
            shutil.move(str(f), str(dest))
            item.filename = f.name
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def download(item: DownloadItem, queue: DownloadQueue,
                   download_dir: str, resolution: str):
    queue.mark_downloading(item)
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(
            None,
            functools.partial(_download_sync, item, queue, download_dir, resolution),
        )
        if item.status not in (Status.CANCELLED, Status.PAUSED):
            queue.mark_done(item)
            _extract_metadata(item, download_dir)
    except yt_dlp.utils.DownloadCancelled:
        # Don't override PAUSED — pause sets CANCELLED to stop yt-dlp, then PAUSED
        if item.status != Status.PAUSED:
            queue.mark_cancelled(item)
    except Exception as e:
        if item.status != Status.PAUSED:
            queue.mark_error(item, str(e)[:200])
