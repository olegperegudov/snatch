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
  let _installState = null;   // "running" | "installed" | "not_installed" | null

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
        const lastErr = chrome.runtime.lastError;
        const errMsg = lastErr ? lastErr.message : "native host disconnected";
        _port = null;
        // If we were in native mode, switch to http
        if (_mode === "native") {
          console.log("[Snatch] Native host disconnected, falling back to HTTP");
          _mode = "http";
        }
        // Reject all pending requests with the actual Chrome error
        for (const id in _pendingRequests) {
          clearTimeout(_pendingRequests[id].timer);
          _pendingRequests[id].reject(new Error(errMsg));
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
    check_update: ["GET",    "/check-update"],
    do_update:    ["POST",   "/update"],
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

  // --- Install state detection ---

  async function _detectInstallState() {
    // Step 1: Quick HTTP health check (~100ms if connection refused, ~200ms if running)
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${HTTP_BASE}/health`, { signal: controller.signal });
      clearTimeout(tid);
      const data = await res.json();
      if (data && data.status === "ok") {
        _installState = "running";
        if (!_mode) _mode = "http";
        return { state: "running", mode: _mode, health: data };
      }
    } catch {}

    // Step 2: HTTP failed → companion not running.
    // Try native messaging "ping" to check if native host is registered (= installed).
    // This requires WSL+Python startup (~2-3s) but only runs when daemon is offline.
    try {
      const port = _connectNative();
      if (port) {
        const result = await Promise.race([
          _sendNative("ping"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
        ]);
        // ping succeeded → native host works → companion installed but not running
        if (_port) { try { _port.disconnect(); } catch {} _port = null; }
        _installState = "installed";
        return { state: "installed", mode: null };
      }
    } catch (e) {
      if (_port) { try { _port.disconnect(); } catch {} _port = null; }
      const err = e.message || "";
      // Native host existed but something else went wrong → still installed
      if (!err.includes("not found") && !err.includes("not available")) {
        _installState = "installed";
        return { state: "installed", mode: null };
      }
    }

    // Step 3: Neither HTTP nor native works
    _installState = "not_installed";
    return { state: "not_installed", mode: null };
  }

  // --- Public API ---

  return {
    /** Detect and return current mode: "native" or "http" */
    async detectMode() { return _detectMode(); },

    /** Get current mode without re-detecting */
    getMode() { return _mode; },

    /** Get cached install state */
    getInstallState() { return _installState; },

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
    checkUpdate()         { return request("check_update"); },
    update()              { return request("do_update"); },

    /** Detect install state: "running" | "installed" | "not_installed" */
    detectInstallState()  { return _detectInstallState(); },

    /** Launch companion app via native host bridge */
    launchCompanion()     { return _sendNative("launch_companion"); },

    /** Get native host logs (last N lines) */
    getLogs(lines)        { return _sendNative("get_logs", { lines: lines || 100 }); },
  };
})();
