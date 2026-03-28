const API = "http://127.0.0.1:9111";
const GITHUB_REPO = "olegperegudov/snatch";

const $ = (id) => document.getElementById(id);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Tauri window controls ---
async function setupWindowControls() {
  if (!window.__TAURI__) return;
  const win = window.__TAURI__.window.getCurrentWindow();
  $("win-min").addEventListener("click", () => win.minimize());
  $("win-close").addEventListener("click", () => win.hide());
}

// --- API helpers ---
async function api(method, path, data) {
  const opts = { method, headers: {} };
  if (data !== undefined && (method === "POST" || method === "PUT")) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- State ---
let showSettings = false;
let showDownloaded = false;
let currentSettings = {};
let _allCompleted = [];
let _searchTimer = null;

// --- Init ---
let serverReady = false;

async function init() {
  setupWindowControls();

  // Fast startup health checks — retry quickly until server is ready
  for (let i = 0; i < 20; i++) {
    const ok = await checkHealth();
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (serverReady) {
    await loadSettings();
    loadQueue();
    loadCompleted();
  }

  // Poll queue every 2s
  setInterval(() => {
    if (!showSettings && serverReady) {
      loadQueue();
      if (!$("search-input").value.trim()) loadCompleted();
    }
  }, 2000);

  // Health check every 10s
  setInterval(checkHealth, 10000);
}

// --- Health ---
async function checkHealth() {
  const detail = $("status-detail");
  try {
    const d = await api("GET", "/health");
    if (d?.status === "ok") {
      serverReady = true;
      detail.textContent = `listening on :9111`;
      detail.className = "";
      $("version-label").textContent = `v${d.version || "?"}`;
      // Load data if this is recovery from a failed state
      if (!$("queue-list").innerHTML) {
        loadSettings();
        loadQueue();
        loadCompleted();
      }
      return true;
    }
  } catch {
    serverReady = false;
    detail.textContent = "server starting\u2026";
    detail.className = "error";
  }
  return false;
}

// --- Queue ---
async function loadQueue() {
  try {
    const data = await api("GET", "/queue");
    renderQueue((data && data.items) || []);
  } catch {
    renderQueue([]);
  }
}

function renderQueue(items) {
  const list = $("queue-list");
  const empty = $("queue-empty");
  const icon = $("status-icon");
  const detail = $("status-detail");

  const active = items.filter((i) => i.status !== "done" && i.status !== "cancelled");
  const downloading = items.filter((i) => i.status === "downloading");

  // Update icon animation
  if (downloading.length > 0) {
    icon.className = "downloading";
    detail.textContent = `downloading ${downloading.length}/${active.length}`;
    detail.className = "";
  } else if (active.length > 0) {
    icon.className = "";
    detail.textContent = `${active.length} queued`;
    detail.className = "";
  } else {
    icon.className = "";
  }

  if (!active.length) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = [...active].reverse().map((item) => {
    const title = item.title || item.filename || item.url;
    const info = [];
    if (item.status === "downloading") {
      if (item.speed) info.push(item.speed);
      if (item.eta) info.push(`eta ${item.eta}`);
    }
    if (item.status === "paused") info.push("paused");
    if (item.status === "pending") info.push("queued");
    if (item.status === "error") info.push(item.error || "error");

    const isActive = item.status === "downloading" || item.status === "pending";
    const buttons = isActive
      ? `<button class="q-btn pause" data-id="${item.id}" title="Pause">&#9646;&#9646;</button>`
      : `<button class="q-btn start" data-id="${item.id}" title="Start">&#9654;</button>`;

    return `
      <div class="q-item ${item.status}">
        <div class="q-header">
          <span class="q-title" ${item.page_url ? `data-url="${esc(item.page_url)}"` : ""} title="${esc(title)}">${esc(title)}</span>
          <span class="q-buttons">
            ${buttons}
            <button class="q-btn cancel" data-id="${item.id}" title="Remove">&#10005;</button>
          </span>
        </div>
        ${item.status === "downloading" ? `<div class="progress"><div class="progress-fill" style="width:${item.progress || 0}%"></div></div>` : ""}
        <div class="q-info">
          <span>${Math.round(item.progress || 0)}%</span>
          ${info.map((i) => `<span>${esc(i)}</span>`).join("")}
        </div>
      </div>
    `;
  }).join("");

  // Event listeners
  list.querySelectorAll(".q-btn.start").forEach((b) =>
    b.addEventListener("click", async () => { await api("POST", "/retry", { id: b.dataset.id }); loadQueue(); }));
  list.querySelectorAll(".q-btn.pause").forEach((b) =>
    b.addEventListener("click", async () => { await api("POST", "/pause", { id: b.dataset.id }); loadQueue(); }));
  list.querySelectorAll(".q-btn.cancel").forEach((b) =>
    b.addEventListener("click", async () => { await api("DELETE", `/queue/${b.dataset.id}`); loadQueue(); }));
  list.querySelectorAll(".q-title[data-url]").forEach((el) =>
    el.addEventListener("click", () => {
      if (window.__TAURI__) {
        window.__TAURI__.opener.openUrl(el.dataset.url);
      } else {
        window.open(el.dataset.url, "_blank");
      }
    }));
}

// --- Show downloaded toggle ---
$("show-downloaded").addEventListener("change", (e) => {
  showDownloaded = e.target.checked;
  updateCompletedVisibility();
});

// --- Completed ---
async function loadCompleted() {
  try {
    _allCompleted = ((await api("GET", "/completed")) || {}).items || [];
  } catch {
    _allCompleted = [];
  }
  renderCompleted(_allCompleted, false);
}

async function searchCompleted(query) {
  try {
    const data = await api("POST", "/search", { query, limit: 100 });
    _allCompleted = (data && data.items) || [];
  } catch {
    _allCompleted = [];
  }
  // When searching, always show results regardless of toggle
  renderCompleted(_allCompleted, true);
}

function updateCompletedVisibility() {
  const q = $("search-input").value.trim();
  if (showDownloaded || q.length >= 2) {
    renderCompleted(_allCompleted, q.length >= 2);
  } else {
    $("completed-list").style.display = "none";
    $("completed-empty").style.display = "none";
  }
}

function renderCompleted(items, forceShow) {
  const list = $("completed-list");
  const empty = $("completed-empty");

  if (!showDownloaded && !forceShow) {
    list.style.display = "none";
    empty.style.display = "none";
    return;
  }
  list.style.display = "";

  if (!items.length) {
    list.innerHTML = "";
    empty.style.display = "";
    empty.textContent = $("search-input").value.trim() ? "no results" : "no downloads yet";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = items.map((item) => {
    const title = item.title || item.filename || "untitled";
    const skipped = item.last_skipped && item.last_skipped > (item.completed_at || 0);
    return `
      <div class="c-item${skipped ? " skipped" : ""}" ${item.page_url ? `data-url="${esc(item.page_url)}"` : ""} title="${esc(title)}">
        ${item.resolution ? `<span class="c-tag">${esc(item.resolution)}</span>` : ""}
        <span class="c-title">${esc(title)}</span>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".c-item[data-url]").forEach((el) =>
    el.addEventListener("click", () => {
      if (window.__TAURI__) {
        window.__TAURI__.opener.openUrl(el.dataset.url);
      } else {
        window.open(el.dataset.url, "_blank");
      }
    }));
}

// --- Search ---
$("search-input").addEventListener("input", (e) => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    if (q.length >= 2) {
      searchCompleted(q);
    } else if (q.length === 0) {
      loadCompleted();
      updateCompletedVisibility();
    }
  }, 300);
});

// --- Open folder ---
$("open-folder-btn").addEventListener("click", () => api("POST", "/reveal_file", { filename: "" }));

// --- Settings toggle ---
$("settings-btn").addEventListener("click", () => {
  showSettings = !showSettings;
  $("settings-panel").style.display = showSettings ? "" : "none";
  $("downloads-panel").style.display = showSettings ? "none" : "";
  const controlsBar = $("search-input").closest(".controls-bar");
  if (controlsBar) controlsBar.style.display = showSettings ? "none" : "";
  if (showSettings) loadSettings();
});

// --- Settings ---
async function loadSettings() {
  try {
    currentSettings = await api("GET", "/settings");
    $("s-resolution").value = currentSettings.preferred_resolution || "720p";
    $("s-download-dir").value = currentSettings.download_dir || "";
    $("s-max-concurrent").value = currentSettings.max_concurrent || 2;
    $("s-filter-res").checked = currentSettings.filter_resolution || false;
    $("s-skip-downloaded").checked = currentSettings.skip_downloaded !== false;
  } catch {}
}

$("s-save").addEventListener("click", async () => {
  const settings = {
    preferred_resolution: $("s-resolution").value,
    download_dir: $("s-download-dir").value.trim(),
    max_concurrent: parseInt($("s-max-concurrent").value) || 2,
    filter_resolution: $("s-filter-res").checked,
    skip_downloaded: $("s-skip-downloaded").checked,
  };
  try {
    await api("PUT", "/settings", settings);
    currentSettings = settings;
    const btn = $("s-save");
    btn.classList.remove("saved");
    void btn.offsetWidth;
    btn.classList.add("saved");
  } catch {}
});

// Enter to save
$("settings-panel").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input")) {
    e.preventDefault();
    $("s-save").click();
  }
});

// --- Update ---
$("update-btn").addEventListener("click", async () => {
  const btn = $("update-btn");

  // If Tauri updater is available, use it
  if (window.__TAURI__?.updater) {
    btn.textContent = "checking...";
    btn.disabled = true;
    try {
      const update = await window.__TAURI__.updater.check();
      if (update) {
        btn.textContent = `updating to ${update.version}...`;
        await update.downloadAndInstall();
        const { relaunch } = window.__TAURI__.process;
        await relaunch();
      } else {
        btn.textContent = "up to date";
        setTimeout(() => { btn.textContent = "check update"; btn.disabled = false; }, 2000);
      }
    } catch (e) {
      btn.textContent = "update failed";
      setTimeout(() => { btn.textContent = "check update"; btn.disabled = false; }, 2000);
    }
    return;
  }

  // Fallback: use HTTP API
  btn.textContent = "checking...";
  btn.disabled = true;
  try {
    const data = await api("GET", "/check-update");
    if (data?.update_available) {
      btn.textContent = `update to v${data.latest}...`;
      const res = await api("POST", "/update");
      if (res?.ok) {
        btn.textContent = `installing v${res.version}...`;
      } else {
        btn.textContent = res?.error || "update failed";
        setTimeout(() => { btn.textContent = "check update"; btn.disabled = false; }, 3000);
      }
    } else {
      btn.textContent = "up to date";
      setTimeout(() => { btn.textContent = "check update"; btn.disabled = false; }, 2000);
    }
  } catch {
    btn.textContent = "update failed";
    setTimeout(() => { btn.textContent = "check update"; btn.disabled = false; }, 2000);
  }
});

// Silent update check on startup
async function silentUpdateCheck() {
  try {
    if (window.__TAURI__?.updater) {
      const update = await window.__TAURI__.updater.check();
      if (update) {
        $("update-btn").textContent = `update to ${update.version}`;
        $("update-btn").classList.add("update-available");
        $("settings-btn").classList.add("update-available");
      }
    } else {
      const data = await api("GET", "/check-update");
      if (data?.update_available) {
        $("update-btn").textContent = `update to v${data.latest}`;
        $("update-btn").classList.add("update-available");
        $("settings-btn").classList.add("update-available");
      }
    }
  } catch {}
}

// Start
init();
setTimeout(silentUpdateCheck, 5000);
