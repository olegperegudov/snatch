const GITHUB_REPO = "olegperegudov/snatch";
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

let currentTab = null;
let autoDl = true;
let autoStart = true;
let currentSettings = {};
let _allCompleted = [];

const $ = (s) => document.getElementById(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Storage: load toggles ---
chrome.storage.local.get(["autoDl", "autoStart"], (data) => {
  autoDl = data.autoDl !== false;
  autoStart = data.autoStart !== false; // default ON
  $("auto-dl").checked = autoDl;
  $("auto-start").checked = autoStart;
});

$("auto-dl").addEventListener("change", async (e) => {
  autoDl = e.target.checked;
  chrome.storage.local.set({ autoDl });
  autoDl ? await SnatchAPI.startQueue() : await SnatchAPI.stopQueue();
  loadQueue();
});

$("auto-start").addEventListener("change", (e) => {
  autoStart = e.target.checked;
  chrome.storage.local.set({ autoStart });
});

// --- Tab switching ---
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.add("hidden"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.remove("hidden");
    $("settings").classList.add("hidden");
  });
});

// --- Settings toggle ---
$("settings-btn").addEventListener("click", () => {
  const s = $("settings");
  const isHidden = s.classList.contains("hidden");
  if (isHidden) {
    $$(".panel").forEach((p) => p.classList.add("hidden"));
    s.classList.remove("hidden");
    loadSettings();
  } else {
    s.classList.add("hidden");
    const activeTab = document.querySelector(".tab.active");
    if (activeTab) $(`tab-${activeTab.dataset.tab}`).classList.remove("hidden");
  }
});

// --- Init ---
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  loadDetected();
  loadQueue();
  loadCompleted();
  loadSettings();
  checkDaemon();
  setInterval(() => { if (!document.hidden) { loadQueue(); loadCompleted(); } }, 2000);
}

// --- Detected ---
async function loadDetected() {
  if (!currentTab) return;
  const response = await chrome.runtime.sendMessage({ type: "get_videos", tabId: currentTab.id });
  const videos = response?.videos || [];
  const list = $("detected-list"), empty = $("detected-empty");

  if (!videos.length) { list.innerHTML = ""; empty.style.display = ""; return; }
  empty.style.display = "none";

  const spinSvg = `<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 11-6.2-8.6"/></svg>`;
  const title = currentTab.title || "";

  list.innerHTML = `
    <div class="detected-item">
      <div class="detected-info">
        <span class="detected-title" title="${esc(title)}">${esc(title)}</span>
      </div>
      <div class="detected-actions">${spinSvg}</div>
    </div>
  `;

  const variants = [];
  const results = await Promise.allSettled(videos.map((v) => SnatchAPI.probe({ url: v.url })));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      (r.value.variants || []).forEach((v) => {
        if (!variants.some((x) => x.resolution === v.resolution)) variants.push(v);
      });
    } else {
      variants.push({ url: videos[i].url, resolution: "unknown", type: videos[i].type, height: 0 });
    }
  });
  variants.sort((a, b) => (b.height || 0) - (a.height || 0));

  let picked = variants[0];
  let fallback = false;
  if (currentSettings.filter_resolution && currentSettings.preferred_resolution !== "best") {
    const h = parseInt(currentSettings.preferred_resolution);
    if (h) {
      const exact = variants.find((v) => v.height === h);
      if (exact) {
        picked = exact;
      } else {
        const lower = variants.filter((v) => v.height < h).sort((a, b) => b.height - a.height);
        picked = lower[0] || variants[0];
        fallback = true;
      }
    }
  }

  if (!picked) { list.innerHTML = ""; empty.style.display = ""; return; }

  list.innerHTML = `
    <div class="detected-item${fallback ? " fallback" : ""}">
      <div class="detected-info">
        <span class="tag${fallback ? " tag-warn" : ""}">${picked.resolution}</span>
        <span class="detected-title" title="${esc(title)}">${esc(title)}</span>
      </div>
      <div class="detected-actions">
        <button class="btn-force" title="Force (ignore history)">f</button>
        <button class="btn-dl">dl</button>
      </div>
    </div>
  `;

  list.querySelector(".btn-dl").addEventListener("click", (e) => doDownload(e.target, picked, false));
  list.querySelector(".btn-force").addEventListener("click", (e) => doDownload(e.target, picked, true));

  async function doDownload(btn, v, force) {
    const row = btn.closest(".detected-actions");
    try {
      const res = await SnatchAPI.download({
        url: v.url, page_url: currentTab.url,
        title: `${currentTab.title} [${v.resolution}]`,
        force, auto_start: autoDl,
      });
      row.innerHTML = res.reason === "already_downloaded"
        ? '<span class="dl-status done">done</span>'
        : '<span class="dl-status queued">queued</span>';
      loadQueue();
    } catch {
      row.innerHTML = '<span class="dl-status error">error</span>';
    }
  }
}

// --- Queue ---
async function loadQueue() {
  try {
    const data = await SnatchAPI.queue();
    renderQueue((data && data.items) || []);
  } catch { renderQueue([]); }
}

function renderQueue(items) {
  const list = $("queue-list"), empty = $("queue-empty");
  const active = items.filter((i) => i.status !== "done" && i.status !== "cancelled");

  if (!active.length) { list.innerHTML = ""; empty.style.display = ""; return; }
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

  list.querySelectorAll(".q-title[data-url]").forEach((el) =>
    el.addEventListener("click", () => chrome.tabs.create({ url: el.dataset.url })));
  list.querySelectorAll(".q-btn.start").forEach((b) =>
    b.addEventListener("click", async () => { await SnatchAPI.retry(b.dataset.id); loadQueue(); }));
  list.querySelectorAll(".q-btn.pause").forEach((b) =>
    b.addEventListener("click", async () => { await SnatchAPI.pause(b.dataset.id); loadQueue(); }));
  list.querySelectorAll(".q-btn.cancel").forEach((b) =>
    b.addEventListener("click", async () => { await SnatchAPI.cancel(b.dataset.id); loadQueue(); }));
}

// --- Completed ---
$("open-folder-btn").addEventListener("click", () => SnatchAPI.revealFile(""));

$("completed-search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  renderCompleted(q ? _allCompleted.filter((item) =>
    `${item.title} ${item.filename} ${item.page_url}`.toLowerCase().includes(q)
  ) : _allCompleted);
});

async function loadCompleted() {
  let offline = false;
  try { _allCompleted = ((await SnatchAPI.completed()) || {}).items || []; }
  catch { _allCompleted = []; offline = true; }
  const empty = $("completed-empty");
  if (offline) {
    empty.textContent = "Companion offline";
    empty.style.display = "";
    $("completed-list").innerHTML = "";
    return;
  }
  empty.textContent = "Empty";
  const q = $("completed-search").value.toLowerCase();
  renderCompleted(q ? _allCompleted.filter((item) =>
    `${item.title} ${item.filename} ${item.page_url}`.toLowerCase().includes(q)
  ) : _allCompleted);
}

function renderCompleted(items) {
  const list = $("completed-list"), empty = $("completed-empty");
  if (!items.length) { list.innerHTML = ""; empty.style.display = ""; return; }
  empty.style.display = "none";

  list.innerHTML = items.map((item) => {
    const title = item.title || item.filename || "untitled";
    const skipped = item.last_skipped && item.last_skipped > (item.completed_at || 0);
    return `
      <div class="c-item${skipped ? " skipped" : ""}" ${item.page_url ? `data-url="${esc(item.page_url)}"` : ""} title="${esc(title)}">
        ${item.resolution ? `<span class="tag">${esc(item.resolution)}</span>` : ""}
        <span class="c-title">${esc(title)}</span>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".c-item[data-url]").forEach((el) =>
    el.addEventListener("click", () => chrome.tabs.create({ url: el.dataset.url })));
}

// --- Settings ---
async function loadSettings() {
  try {
    currentSettings = await SnatchAPI.getSettings();
    $("s-resolution").value = currentSettings.preferred_resolution || "720p";
    $("s-download-dir").value = currentSettings.download_dir || "";
    $("s-max-concurrent").value = currentSettings.max_concurrent || 2;
    $("s-filter-res").checked = currentSettings.filter_resolution || false;
    $("s-skip-downloaded").checked = currentSettings.skip_downloaded !== false;
  } catch {}
}

$("settings").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input")) {
    e.preventDefault();
    $("s-save").click();
  }
});

$("s-save").addEventListener("click", async () => {
  const dir = $("s-download-dir").value.trim();
  const settings = {
    preferred_resolution: $("s-resolution").value,
    download_dir: dir,
    max_concurrent: parseInt($("s-max-concurrent").value) || 2,
    filter_resolution: $("s-filter-res").checked,
    skip_downloaded: $("s-skip-downloaded").checked,
  };
  try {
    await SnatchAPI.putSettings(settings);
    currentSettings = settings;
    if (dir) addToDirHistory(dir);
    const btn = $("s-save");
    btn.classList.remove("saved");
    void btn.offsetWidth;
    btn.classList.add("saved");
  } catch {}
});

// --- Dir history ---
async function getDirHistory() {
  return (await chrome.storage.local.get("dirHistory")).dirHistory || [];
}

async function addToDirHistory(dir) {
  const h = await getDirHistory();
  await chrome.storage.local.set({ dirHistory: [dir, ...h.filter((d) => d !== dir)].slice(0, 10) });
}

async function renderDirHistory() {
  const dd = $("dir-history"), history = await getDirHistory();
  if (!history.length) { dd.classList.add("hidden"); return; }
  dd.innerHTML = history.map((d) => `
    <div class="dir-history-item">
      <span class="dir-history-path" title="${esc(d)}">${esc(d)}</span>
      <button class="dir-history-remove" data-dir="${esc(d)}">&#10005;</button>
    </div>
  `).join("");
  dd.classList.remove("hidden");

  dd.querySelectorAll(".dir-history-path").forEach((el) =>
    el.addEventListener("click", () => { $("s-download-dir").value = el.title; dd.classList.add("hidden"); }));
  dd.querySelectorAll(".dir-history-remove").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const h = await getDirHistory();
      await chrome.storage.local.set({ dirHistory: h.filter((d) => d !== b.dataset.dir) });
      renderDirHistory();
    }));
}

const dirInput = $("s-download-dir");
dirInput.addEventListener("focus", renderDirHistory);
dirInput.addEventListener("click", renderDirHistory);
dirInput.addEventListener("blur", () => {});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dir-wrapper")) $("dir-history").classList.add("hidden");
});

// --- Gear icon state helpers ---
function setGear(state, title) {
  const gear = $("settings-btn");
  gear.className = state || ""; // "", "online", "starting", "update-available"
  gear.title = title || "";
}

// --- Poll until companion comes online ---
async function pollUntilOnline(maxAttempts = 8, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await SnatchAPI.health();
      if (res?.status === "ok") {
        setGear("online", "Companion online");
        $("starting-msg").classList.add("hidden");
        updateCompanionSection({ state: "running", health: res });
        silentUpdateCheck();
        return true;
      }
    } catch {}
  }
  return false;
}

// --- Main daemon check (runs once on popup open) ---
async function checkDaemon() {
  const result = await SnatchAPI.detectInstallState();

  if (result.state === "running") {
    setGear("online", "Companion online");
    updateCompanionSection(result);
    silentUpdateCheck();
    return;
  }

  if (result.state === "installed" && autoStart) {
    // Auto-start: blink green, show message, launch
    setGear("starting", "Starting companion...");
    $("starting-msg").classList.remove("hidden");
    try {
      await SnatchAPI.launchCompanion();
      const ok = await pollUntilOnline();
      if (!ok) {
        setGear("", "Companion offline");
        $("starting-msg").textContent = "Could not start — open settings";
        updateCompanionSection(result);
      }
    } catch {
      setGear("", "Companion offline");
      $("starting-msg").textContent = "Could not start — open settings";
      updateCompanionSection(result);
    }
    return;
  }

  // Installed but auto-start off, or not installed
  setGear("", result.state === "installed" ? "Companion not running" : "Companion not installed");
  updateCompanionSection(result);
}

// --- Update companion section in settings ---
function updateCompanionSection(result) {
  const statusEl = $("companion-status");
  const updateEl = $("companion-update");
  const launchStopBtn = $("launch-stop-btn");

  if (result.state === "running") {
    const ver = result.health?.version || "?";
    statusEl.innerHTML = `Companion <a href="https://github.com/${GITHUB_REPO}/releases/tag/v${ver}" target="_blank">v${ver}</a>`;
    launchStopBtn.textContent = "Stop";
    launchStopBtn.className = "companion-btn danger";
    launchStopBtn.disabled = false;
  } else if (result.state === "installed") {
    statusEl.textContent = "Companion not running";
    updateEl.textContent = "";
    launchStopBtn.textContent = "Launch";
    launchStopBtn.className = "companion-btn ok";
    launchStopBtn.disabled = false;
  } else {
    statusEl.textContent = "Companion not installed";
    updateEl.textContent = "";
    launchStopBtn.textContent = "Launch";
    launchStopBtn.className = "companion-btn ok";
    launchStopBtn.disabled = true;
  }
}

// --- Launch / Stop button ---
$("launch-stop-btn").addEventListener("click", async () => {
  const btn = $("launch-stop-btn");
  if (btn.textContent === "Stop") {
    btn.disabled = true;
    btn.textContent = "Stopping...";
    try { await SnatchAPI.shutdown(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    setGear("", "Companion offline");
    updateCompanionSection({ state: "installed" });
    btn.disabled = false;
  } else {
    btn.disabled = true;
    btn.textContent = "Starting...";
    setGear("starting", "Starting companion...");
    $("starting-msg").classList.remove("hidden");
    try {
      await SnatchAPI.launchCompanion();
      const ok = await pollUntilOnline();
      if (!ok) {
        setGear("", "Companion offline");
        $("starting-msg").textContent = "Could not start";
        updateCompanionSection({ state: "installed" });
      }
    } catch {
      setGear("", "Companion offline");
      $("starting-msg").textContent = "Could not launch";
      updateCompanionSection({ state: "installed" });
    }
    btn.disabled = false;
  }
});

// --- Silent update check ---
async function silentUpdateCheck() {
  try {
    const upd = await SnatchAPI.checkUpdate();
    if (upd?.update_available) {
      setGear("update-available", `Update available: v${upd.latest}`);
      const updateEl = $("companion-update");
      updateEl.textContent = `update to v${upd.latest}`;
      updateEl.className = "companion-update available";
      updateEl.onclick = doUpdate;
    } else {
      $("companion-update").textContent = "up to date";
    }
  } catch {}
}

async function doUpdate() {
  const updateEl = $("companion-update");
  updateEl.textContent = "updating...";
  updateEl.onclick = null;
  try {
    const res = await SnatchAPI.update();
    if (res?.ok) {
      updateEl.textContent = `installing v${res.version}...`;
      setGear("starting", "Updating companion...");
      // Wait for installer to finish, then relaunch
      let launched = false;
      setTimeout(async function poll() {
        // Try health first (maybe installer auto-started it)
        try {
          const h = await SnatchAPI.health();
          setGear("online", "Companion online");
          $("companion-update").textContent = "up to date";
          $("companion-update").className = "companion-update";
          updateCompanionSection({ state: "running", health: h });
          return;
        } catch {}
        // Not running — try to launch via native host
        if (!launched) {
          launched = true;
          try { await SnatchAPI.launchCompanion(); } catch {}
        }
        // Keep polling
        setTimeout(poll, 2000);
      }, 5000); // 5s wait for installer to finish
    } else {
      updateEl.textContent = "update failed";
    }
  } catch {
    updateEl.textContent = "update failed";
  }
}

// --- Logs viewer ---
$("logs-btn").addEventListener("click", async () => {
  const panel = $("logs-panel");
  const content = $("logs-content");
  const btn = $("logs-btn");

  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    btn.textContent = "Logs";
    return;
  }

  btn.disabled = true;
  btn.textContent = "loading...";
  try {
    const res = await SnatchAPI.getLogs(80);
    const lines = res?.lines || [];
    content.textContent = lines.length ? lines.join("\n") : "(empty log)";
    panel.classList.remove("hidden");
    panel.scrollTop = panel.scrollHeight;
    btn.textContent = "Hide logs";
  } catch {
    content.textContent = "(could not fetch logs — native host offline)";
    panel.classList.remove("hidden");
    btn.textContent = "Hide logs";
  }
  btn.disabled = false;
});

init();
