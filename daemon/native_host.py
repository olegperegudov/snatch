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
import os
import subprocess
import urllib.request
import urllib.error
import threading
import time
import logging
from logging.handlers import RotatingFileHandler

DAEMON_URL = "http://127.0.0.1:9111"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SCRIPT_DIR, "native_host.log")

# --- Logging setup ---

log = logging.getLogger("snatch_native")
log.setLevel(logging.DEBUG)
_handler = RotatingFileHandler(LOG_PATH, maxBytes=512 * 1024, backupCount=2)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S"))
log.addHandler(_handler)

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
    "shutdown":     ("POST",   "/shutdown"),
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


# --- Companion app discovery & launch (WSL2 <-> Windows) ---

def _find_companion_exe():
    """Find Snatch.exe in %LOCALAPPDATA% (Windows side)."""
    try:
        r = subprocess.run(
            ["cmd.exe", "/c", "echo", "%LOCALAPPDATA%"],
            capture_output=True, text=True, timeout=5,
        )
        localappdata = r.stdout.strip().replace("\r", "")
        if not localappdata or "%" in localappdata:
            log.warning("Could not resolve %%LOCALAPPDATA%%: %r", localappdata)
            return None
        win_path = f"{localappdata}\\Snatch\\snatch-companion.exe"
        # Convert to WSL path to check existence
        r2 = subprocess.run(
            ["wslpath", "-u", win_path],
            capture_output=True, text=True, timeout=5,
        )
        wsl_path = r2.stdout.strip()
        exists = os.path.isfile(wsl_path)
        log.info("Companion exe: %s (wsl: %s, exists: %s)", win_path, wsl_path, exists)
        if exists:
            return win_path
    except Exception as e:
        log.error("_find_companion_exe failed: %s", e)
    return None


def handle_launch_companion():
    """Find and launch the Snatch companion app."""
    log.info("launch_companion requested")
    exe = _find_companion_exe()
    if not exe:
        log.error("launch_companion: snatch-companion.exe not found")
        return {"ok": False, "error": "snatch-companion.exe not found"}
    try:
        log.info("Launching: cmd.exe /c start \"\" \"%s\"", exe)
        subprocess.Popen(
            ["cmd.exe", "/c", "start", "", exe],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log.info("launch_companion: started successfully")
        return {"ok": True, "data": {"launched": True, "path": exe}}
    except Exception as e:
        log.error("launch_companion failed: %s", e)
        return {"ok": False, "error": str(e)[:200]}


def handle_check_installed():
    """Check if the companion app is installed."""
    exe = _find_companion_exe()
    return {"ok": True, "data": {"installed": exe is not None, "path": exe}}


def handle_get_logs(data):
    """Return last N lines of the native host log."""
    lines = (data or {}).get("lines", 100)
    try:
        with open(LOG_PATH, "r") as f:
            all_lines = f.readlines()
        tail = all_lines[-lines:]
        return {"ok": True, "data": {"lines": [l.rstrip() for l in tail], "path": LOG_PATH}}
    except FileNotFoundError:
        return {"ok": True, "data": {"lines": [], "path": LOG_PATH}}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# --- Main loop ---

def main():
    log.info("=== Native host started (pid %d) ===", os.getpid())

    # Start queue polling in background thread
    poller = threading.Thread(target=poll_queue, daemon=True)
    poller.start()

    while True:
        msg = read_message()
        if msg is None:
            log.info("stdin closed, exiting")
            break  # stdin closed = Chrome disconnected

        msg_id = msg.get("id")
        action = msg.get("action", "")
        data = msg.get("data")

        log.debug("action=%s id=%s", action, msg_id)

        # Local actions (handled by native host, not proxied to daemon)
        if action == "ping":
            result = {"ok": True, "data": {"pong": True}}
        elif action == "launch_companion":
            result = handle_launch_companion()
        elif action == "check_installed":
            result = handle_check_installed()
        elif action == "get_logs":
            result = handle_get_logs(data)
        else:
            result = proxy_to_daemon(action, data)

        if not result.get("ok"):
            log.warning("action=%s error: %s", action, result.get("error", ""))

        result["id"] = msg_id
        send_message(result)

    log.info("=== Native host exiting ===")


if __name__ == "__main__":
    main()
