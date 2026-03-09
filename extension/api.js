/**
 * Snatch API — communication abstraction layer.
 *
 * Tries Native Messaging first (com.snatch.companion).
 * Falls back to HTTP (localhost:9111) if native host is unavailable.
 *
 * Usage (from background.js or popup.js):
 *   const result = await SnatchAPI.download({url, page_url, title});
 *   const queue  = await SnatchAPI.queue();
 */

const SnatchAPI = (() => {
  const NATIVE_HOST = "com.snatch.companion";
  const HTTP_BASE = "http://127.0.0.1:9111";

  let _port = null;           // Native messaging port (persistent)
  let _mode = null;           // "native" | "http" | null (not yet determined)
  let _pendingRequests = {};  // id -> {resolve, reject, timer}
  let _nextId = 1;
  let _onQueueUpdate = null;  // callback for push updates from native host

  // --- Native Messaging ---

  function _connectNative() {
    if (_port) return _port;
    try {
      _port = chrome.runtime.connectNative(NATIVE_HOST);

      _port.onMessage.addListener((msg) => {
        // Push update (no request id)
        if (msg.id === null && msg.push === "queue_update") {
          if (_onQueueUpdate) _onQueueUpdate(msg.data);
          return;
        }
        // Response to a request
        const pending = _pendingRequests[msg.id];
        if (pending) {
          clearTimeout(pending.timer);
          delete _pendingRequests[msg.id];
          if (msg.ok) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error || "native host error"));
          }
        }
      });

      _port.onDisconnect.addListener(() => {
        _port = null;
        // If we were in native mode, switch to http
        if (_mode === "native") {
          console.log("[Snatch] Native host disconnected, falling back to HTTP");
          _mode = "http";
        }
        // Reject all pending requests
        for (const id in _pendingRequests) {
          clearTimeout(_pendingRequests[id].timer);
          _pendingRequests[id].reject(new Error("native host disconnected"));
        }
        _pendingRequests = {};
      });

      return _port;
    } catch (e) {
      _port = null;
      return null;
    }
  }

  function _sendNative(action, data) {
    return new Promise((resolve, reject) => {
      const port = _connectNative();
      if (!port) {
        reject(new Error("native host not available"));
        return;
      }
      const id = _nextId++;
      const timer = setTimeout(() => {
        delete _pendingRequests[id];
        reject(new Error("native host timeout"));
      }, 30000);

      _pendingRequests[id] = { resolve, reject, timer };
      port.postMessage({ id, action, data: data || null });
    });
  }

  // --- HTTP fallback ---

  async function _sendHttp(method, path, data) {
    const opts = { method, headers: {} };
    if (data !== undefined && (method === "POST" || method === "PUT")) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(data);
    }
    const res = await fetch(`${HTTP_BASE}${path}`, opts);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // --- Auto-detect mode ---

  async function _detectMode() {
    if (_mode) return _mode;

    // Try native messaging first
    try {
      const result = await Promise.race([
        _sendNative("health"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      if (result && result.status === "ok") {
        _mode = "native";
        console.log("[Snatch] Using Native Messaging");
        return _mode;
      }
    } catch {
      // Native failed, disconnect cleanly
      if (_port) {
        try { _port.disconnect(); } catch {}
        _port = null;
      }
    }

    // Fall back to HTTP
    _mode = "http";
    console.log("[Snatch] Using HTTP (localhost:9111)");
    return _mode;
  }

  // --- Unified request dispatcher ---

  const HTTP_ROUTES = {
    health:       ["GET",    "/health"],
    queue:        ["GET",    "/queue"],
    completed:    ["GET",    "/completed"],
    get_settings: ["GET",    "/settings"],
    put_settings: ["PUT",    "/settings"],
    download:     ["POST",   "/download"],
    probe:        ["POST",   "/probe"],
    cancel:       ["DELETE", "/queue/"],  // + item id
    reveal_file:  ["POST",   "/reveal_file"],
    history_check:["POST",   "/history/check"],
    retry:        ["POST",   "/retry"],
    pause:        ["POST",   "/pause"],
    start_queue:  ["POST",   "/start_queue"],
    stop_queue:   ["POST",   "/stop_queue"],
  };

  async function request(action, data) {
    const mode = await _detectMode();

    if (mode === "native") {
      try {
        return await _sendNative(action, data);
      } catch {
        // Native failed mid-session, fall back to HTTP
        _mode = "http";
        console.log("[Snatch] Native failed, switching to HTTP");
      }
    }

    // HTTP mode
    const route = HTTP_ROUTES[action];
    if (!route) throw new Error(`unknown action: ${action}`);
    let [method, path] = route;
    if (action === "cancel") {
      path = `/queue/${(data || {}).id}`;
      data = undefined;
    }
    return _sendHttp(method, path, data);
  }

  // --- Public API ---

  return {
    /** Detect and return current mode: "native" or "http" */
    async detectMode() { return _detectMode(); },

    /** Get current mode without re-detecting */
    getMode() { return _mode; },

    /** Force a specific mode ("native" or "http") */
    setMode(mode) { _mode = mode; },

    /** Register callback for push queue updates (native mode only) */
    onQueueUpdate(cb) { _onQueueUpdate = cb; },

    // --- Daemon endpoints ---

    health()              { return request("health"); },
    queue()               { return request("queue"); },
    completed()           { return request("completed"); },
    getSettings()         { return request("get_settings"); },
    putSettings(data)     { return request("put_settings", data); },
    download(data)        { return request("download", data); },
    probe(data)           { return request("probe", data); },
    cancel(id)            { return request("cancel", { id }); },
    revealFile(filename)  { return request("reveal_file", { filename }); },
    historyCheck(url)     { return request("history_check", { url }); },
    retry(id)             { return request("retry", { id }); },
    pause(id)             { return request("pause", { id }); },
    startQueue()          { return request("start_queue"); },
    stopQueue()           { return request("stop_queue"); },
  };
})();
