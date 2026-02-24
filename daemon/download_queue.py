import asyncio
import json
import time
import uuid
from pathlib import Path
from dataclasses import dataclass, field, asdict
from enum import Enum


class Status(str, Enum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class DownloadItem:
    id: str
    url: str
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
        self._state_file = Path(__file__).parent / "queue_state.json"
        self._load_state()

    def add(self, url: str, page_url: str = "", title: str = "") -> DownloadItem:
        item = DownloadItem(
            id=uuid.uuid4().hex[:8],
            url=url,
            page_url=page_url,
            title=title or url.split("/")[-1][:60],
        )
        self.items[item.id] = item
        self._save_state()
        return item

    def remove(self, item_id: str) -> bool:
        if item_id in self.items:
            item = self.items[item_id]
            if item.status == Status.DOWNLOADING:
                item.status = Status.CANCELLED
            else:
                del self.items[item_id]
            self._save_state()
            return True
        return False

    def get_all(self) -> list[dict]:
        return [item.to_dict() for item in self.items.values()]

    def update_max_concurrent(self, n: int):
        self.max_concurrent = n
        self._semaphore = asyncio.Semaphore(n)

    def _save_state(self):
        data = {k: v.to_dict() for k, v in self.items.items()
                if v.status in (Status.PENDING, Status.DOWNLOADING)}
        self._state_file.write_text(json.dumps(data, indent=2))

    def _load_state(self):
        if self._state_file.exists():
            try:
                data = json.loads(self._state_file.read_text())
                for k, v in data.items():
                    v["status"] = Status.PENDING  # restart pending on load
                    self.items[k] = DownloadItem(**{
                        key: val for key, val in v.items()
                        if key in DownloadItem.__dataclass_fields__
                    })
            except (json.JSONDecodeError, TypeError):
                pass
