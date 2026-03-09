#!/usr/bin/env python3
"""
Snatch Native Messaging Host — bridge between Chrome extension and HTTP daemon.

Chrome starts this process and communicates via stdin/stdout using
length-prefixed JSON messages (4-byte uint32 LE + UTF-8 JSON).

This bridge forwards requests to the Snatch daemon HTTP API (localhost:9111)
and returns responses back to Chrome.

Protocol:
  Request:  {"id": 1, "action": "download", "data": {...}}
  Response: {"id": 1, "ok": true, "data": {...}}
"""

import json
import struct
import sys
import urllib.request
import urllib.error
import threading
import time

DAEMON_URL = "http://127.0.0.1:9111"

# --- stdio helpers (Chrome Native Messaging protocol) ---

def read_message():
    """Read a single length-prefixed JSON message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length == 0 or length > 1024 * 1024:  # max 1MB per Chrome spec
        return None
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(msg):
    """Write a length-prefixed JSON message to stdout."""
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# --- HTTP proxy to daemon ---

# Map action names to HTTP method + path
ROUTES = {
    "health":       ("GET",    "/health"),
    "queue":        ("GET",    "/queue"),
    "completed":    ("GET",    "/completed"),
    "get_settings": ("GET",    "/settings"),
    "put_settings": ("PUT",    "/settings"),
    "download":     ("POST",   "/download"),
    "probe":        ("POST",   "/probe"),
    "cancel":       ("DELETE", None),       # path built dynamically
    "reveal_file":  ("POST",   "/reveal_file"),
    "history_check":("POST",   "/history/check"),
    "retry":        ("POST",   "/retry"),
    "pause":        ("POST",   "/pause"),
    "start_queue":  ("POST",   "/start_queue"),
    "stop_queue":   ("POST",   "/stop_queue"),
}


def proxy_to_daemon(action, data=None):
    """Forward a request to the daemon HTTP API and return the response."""
    route = ROUTES.get(action)
    if not route:
        return {"ok": False, "error": f"unknown action: {action}"}

    method, path = route

    # Dynamic path for cancel (DELETE /queue/{id})
    if action == "cancel":
        item_id = (data or {}).get("id", "")
        path = f"/queue/{item_id}"
        data = None  # no body for DELETE

    url = f"{DAEMON_URL}{path}"

    try:
        body = None
        headers = {}
        if data is not None and method in ("POST", "PUT"):
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_data = resp.read().decode("utf-8")
            if resp_data:
                return {"ok": True, "data": json.loads(resp_data)}
            return {"ok": True, "data": None}

    except urllib.error.URLError as e:
        return {"ok": False, "error": f"daemon unreachable: {e.reason}"}
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# --- Queue polling (push updates to extension) ---

def poll_queue(interval=2.0):
    """Periodically poll daemon queue and push updates to extension."""
    while True:
        time.sleep(interval)
        try:
            result = proxy_to_daemon("queue")
            if result.get("ok"):
                send_message({"id": None, "push": "queue_update", "data": result["data"]})
        except (BrokenPipeError, OSError):
            break  # Extension disconnected
        except Exception:
            pass  # Silently skip poll errors


# --- Main loop ---

def main():
    # Start queue polling in background thread
    poller = threading.Thread(target=poll_queue, daemon=True)
    poller.start()

    while True:
        msg = read_message()
        if msg is None:
            break  # stdin closed = Chrome disconnected

        msg_id = msg.get("id")
        action = msg.get("action", "")
        data = msg.get("data")

        result = proxy_to_daemon(action, data)
        result["id"] = msg_id
        send_message(result)


if __name__ == "__main__":
    main()
