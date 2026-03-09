const API = "http://127.0.0.1:9111";
let _allCompleted = [];

const $ = (s) => document.getElementById(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Tab switching ---
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.remove("hidden");
  });
});

// --- API helper ---
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined && (method === "POST" || method === "PUT")) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --- Health check ---
async function checkHealth() {
  const dot = $("status-dot");
  try {
    await api("GET", "/health");
    dot.className = "dot online";
  } catch {
    dot.className = "dot offline";
  }
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
  const list = $("queue-list"), empty = $("queue-empty");
  const active = items.filter((i) => i.status !== "done" && i.status !== "cancelled");

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
          <span class="q-title" title="${esc(title)}">${esc(title)}</span>
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

  list.querySelectorAll(".q-btn.start").forEach((b) =>
    b.addEventListener("click", async () => { await api("POST", "/retry", { id: b.dataset.id }); loadQueue(); }));
  list.querySelectorAll(".q-btn.pause").forEach((b) =>
    b.addEventListener("click", async () => { await api("POST", "/pause", { id: b.dataset.id }); loadQueue(); }));
  list.querySelectorAll(".q-btn.cancel").forEach((b) =>
    b.addEventListener("click", async () => { await api("DELETE", `/queue/${b.dataset.id}`); loadQueue(); }));
}

// --- Completed ---
$("open-folder-btn").addEventListener("click", () => api("POST", "/reveal_file", { filename: "" }));

$("completed-search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  renderCompleted(q ? _allCompleted.filter((item) =>
    `${item.title} ${item.filename} ${item.page_url}`.toLowerCase().includes(q)
  ) : _allCompleted);
});

async function loadCompleted() {
  try {
    _allCompleted = ((await api("GET", "/completed")) || {}).items || [];
  } catch {
    _allCompleted = [];
  }
  const q = $("completed-search").value.toLowerCase();
  renderCompleted(q ? _allCompleted.filter((item) =>
    `${item.title} ${item.filename} ${item.page_url}`.toLowerCase().includes(q)
  ) : _allCompleted);
}

function renderCompleted(items) {
  const list = $("completed-list"), empty = $("completed-empty");
  if (!items.length) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = items.map((item) => {
    const title = item.title || item.filename || "untitled";
    return `
      <div class="c-item" title="${esc(title)}">
        ${item.resolution ? `<span class="tag">${esc(item.resolution)}</span>` : ""}
        <span class="c-title">${esc(title)}</span>
      </div>
    `;
  }).join("");
}

// --- Settings ---
async function loadSettings() {
  try {
    const s = await api("GET", "/settings");
    $("s-resolution").value = s.preferred_resolution || "best";
    $("s-download-dir").value = s.download_dir || "";
    $("s-max-concurrent").value = s.max_concurrent || 2;
    $("s-filter-res").checked = s.filter_resolution || false;
    $("s-skip-downloaded").checked = s.skip_downloaded !== false;
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
    $("s-status").textContent = "Saved!";
    $("s-status").style.color = "";
    setTimeout(() => ($("s-status").textContent = ""), 2000);
  } catch {
    $("s-status").textContent = "Failed";
    $("s-status").style.color = "var(--fail)";
    setTimeout(() => { $("s-status").textContent = ""; $("s-status").style.color = ""; }, 3000);
  }
});

// --- Log ---
function log(msg, type = "") {
  const entries = $("log-entries");
  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const el = document.createElement("div");
  el.className = "log-entry";
  el.innerHTML = `<span class="log-ts">${now}</span><span class="log-msg ${type}">${esc(msg)}</span>`;
  entries.prepend(el);
  // Keep max 50 entries
  while (entries.children.length > 50) entries.lastChild.remove();
}

// --- Init ---
async function init() {
  checkHealth();
  loadQueue();
  loadCompleted();
  loadSettings();
  log("companion started");

  // Poll every 2s
  setInterval(() => {
    if (!document.hidden) {
      checkHealth();
      loadQueue();
      loadCompleted();
    }
  }, 2000);
}

init();
