import asyncio
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum

import db


class Status(str, Enum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"
    PAUSED = "paused"


@dataclass
class DownloadItem:
    id: str
    url: str              # video_url (the actual stream)
    page_url: str = ""
    title: str = ""
    filename: str = ""
    status: Status = Status.PENDING
    progress: float = 0.0
    speed: str = ""
    eta: str = ""
    filesize: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.time)

    def to_dict(self):
        d = asdict(self)
        d["status"] = self.status.value
        return d


class DownloadQueue:
    def __init__(self, max_concurrent: int = 2):
        self.items: dict[str, DownloadItem] = {}
        self.max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._load_interrupted()

    def add(self, url: str, page_url: str = "", title: str = "") -> DownloadItem:
        item = DownloadItem(
            id=uuid.uuid4().hex[:8],
            url=url,
            page_url=page_url,
            title=title or url.split("/")[-1][:60],
        )
        self.items[item.id] = item
        db.add(item.id, video_url=url, page_url=page_url, title=title)
        return item

    def remove(self, item_id: str) -> bool:
        if item_id in self.items:
            item = self.items[item_id]
            if item.status == Status.DOWNLOADING:
                item.status = Status.CANCELLED
                db.update_status(item_id, "cancelled")
            else:
                del self.items[item_id]
                db.update_status(item_id, "cancelled")
            return True
        return False

    def get_all(self) -> list[dict]:
        return [item.to_dict() for item in self.items.values()]

    def update_max_concurrent(self, n: int):
        self.max_concurrent = n
        self._semaphore = asyncio.Semaphore(n)

    def mark_done(self, item: DownloadItem):
        """Mark item as done in memory and DB."""
        item.status = Status.DONE
        item.progress = 100.0
        extra = {}
        if item.filename:
            extra["filename"] = item.filename
        db.update_status(item.id, "done", **extra)

    def mark_error(self, item: DownloadItem, error: str):
        """Mark item as error in memory and DB."""
        item.status = Status.ERROR
        item.error = error
        db.update_status(item.id, "error", error=error)

    def mark_cancelled(self, item: DownloadItem):
        item.status = Status.CANCELLED
        db.update_status(item.id, "cancelled")

    def mark_downloading(self, item: DownloadItem):
        item.status = Status.DOWNLOADING
        db.update_status(item.id, "downloading")

    def _load_interrupted(self):
        """On startup: recover interrupted downloads from DB."""
        db.recover_interrupted()  # downloading → paused
        for row in db.get_by_status("pending", "paused"):
            if row["id"] not in self.items and row.get("video_url"):
                item = DownloadItem(
                    id=row["id"],
                    url=row["video_url"],
                    page_url=row.get("page_url", ""),
                    title=row.get("title", ""),
                    filename=row.get("filename", ""),
                    status=Status.PAUSED,
                    created_at=row.get("created_at", time.time()),
                )
                self.items[item.id] = item
