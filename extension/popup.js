let currentTab = null;
let autoDl = true;
let currentSettings = {};
let _allCompleted = [];

const $ = (s) => document.getElementById(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Auto-download toggle ---
chrome.storage.local.get("autoDl", (data) => {
  autoDl = data.autoDl !== false;
  $("auto-dl").checked = autoDl;
});

$("auto-dl").addEventListener("change", async (e) => {
  autoDl = e.target.checked;
  chrome.storage.local.set({ autoDl });
  autoDl ? await SnatchAPI.startQueue() : await SnatchAPI.stopQueue();
  loadQueue();
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
  $$(".panel").forEach((p) => p.classList.toggle("hidden", isHidden));
  s.classList.toggle("hidden", !isHidden);
  if (isHidden) loadSettings();
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

  // Single "probing" row
  list.innerHTML = `
    <div class="detected-item">
      <div class="detected-info">
        <span class="detected-title" title="${esc(title)}">${esc(title)}</span>
      </div>
      <div class="detected-actions">${spinSvg}</div>
    </div>
  `;

  // Probe all in parallel, dedupe by resolution
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

  // Pick best match: exact resolution or next best (fallback = yellow)
  let picked = variants[0]; // default: best available
  let fallback = false;
  if (currentSettings.filter_resolution && currentSettings.preferred_resolution !== "best") {
    const h = parseInt(currentSettings.preferred_resolution);
    if (h) {
      const exact = variants.find((v) => v.height === h);
      if (exact) {
        picked = exact;
      } else {
        // Next lower resolution
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
    empty.textContent = "Daemon offline — start it to see downloads";
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
    $("s-resolution").value = currentSettings.preferred_resolution || "best";
    $("s-download-dir").value = currentSettings.download_dir || "";
    $("s-max-concurrent").value = currentSettings.max_concurrent || 2;
    $("s-filter-res").checked = currentSettings.filter_resolution || false;
    $("s-skip-downloaded").checked = currentSettings.skip_downloaded !== false;
  } catch {}
}

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
    $("s-status").textContent = "Saved!";
    setTimeout(() => ($("s-status").textContent = ""), 2000);
  } catch {
    $("s-status").textContent = "Failed — daemon offline?";
    $("s-status").style.color = "var(--fail)";
    setTimeout(() => { $("s-status").textContent = ""; $("s-status").style.color = ""; }, 3000);
  }
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
dirInput.addEventListener("blur", () => {
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dir-wrapper")) $("dir-history").classList.add("hidden");
});

// --- Daemon health ---
async function checkDaemon() {
  const dot = $("status-dot");
  try {
    await SnatchAPI.health();
    dot.className = "dot online";
    dot.title = SnatchAPI.getMode() === "native" ? "Connected (native)" : "Daemon online";
  } catch {
    dot.className = "dot offline";
    dot.title = "Daemon offline";
  }
}

init();
