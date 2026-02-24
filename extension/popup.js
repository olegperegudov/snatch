const DAEMON = "http://127.0.0.1:9111";

let currentTab = null;
let pollInterval = null;

// --- Tab switching ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("hidden");
    // Hide settings when switching tabs
    document.getElementById("settings").classList.add("hidden");
  });
});

// --- Settings toggle ---
document.getElementById("settings-btn").addEventListener("click", () => {
  const settings = document.getElementById("settings");
  const tabs = document.querySelectorAll(".tab-content");
  const isHidden = settings.classList.contains("hidden");
  tabs.forEach((t) => t.classList.toggle("hidden", isHidden));
  settings.classList.toggle("hidden", !isHidden);
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

  pollInterval = setInterval(() => { loadQueue(); loadCompleted(); }, 2000);
}

// --- Detected videos ---
async function loadDetected() {
  if (!currentTab) return;

  const response = await chrome.runtime.sendMessage({
    type: "get_videos",
    tabId: currentTab.id,
  });

  const videos = response?.videos || [];
  const list = document.getElementById("detected-list");
  const empty = document.getElementById("detected-empty");

  if (videos.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  list.innerHTML = '<div class="empty-small">Probing streams...</div>';

  // Probe each URL to get real resolutions
  const allVariants = [];
  for (const v of videos) {
    try {
      const res = await fetch(`${DAEMON}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: v.url }),
      });
      const data = await res.json();
      for (const variant of data.variants || []) {
        // Deduplicate by resolution (same resolution from different URLs = same stream)
        if (!allVariants.some((x) => x.resolution === variant.resolution)) {
          allVariants.push(variant);
        }
      }
    } catch {
      allVariants.push({ url: v.url, resolution: "unknown", type: v.type, height: 0 });
    }
  }

  // Sort: highest resolution first
  allVariants.sort((a, b) => (b.height || 0) - (a.height || 0));

  // Filter by preferred resolution if enabled
  let filtered = allVariants;
  if (currentSettings.filter_resolution && currentSettings.preferred_resolution !== "best") {
    const targetHeight = parseInt(currentSettings.preferred_resolution);
    if (targetHeight) {
      const match = allVariants.filter((v) => v.height === targetHeight);
      if (match.length > 0) filtered = match;
    }
  }

  const title = currentTab.title || "";
  const shortTitle = title.length > 30 ? title.slice(0, 27) + "..." : title;

  list.innerHTML = filtered
    .map((v, i) => `
      <div class="detected-item">
        <div class="detected-info">
          <span class="detected-tag">${v.resolution}</span>
          <span class="detected-title" title="${esc(title)}">${esc(shortTitle)}</span>
        </div>
        <div class="detected-actions">
          <button class="force-btn" data-idx="${i}" title="Force download (ignore history)">f</button>
          <button class="dl-btn" data-idx="${i}">Download</button>
        </div>
      </div>
    `)
    .join("");

  // Download button
  list.querySelectorAll(".dl-btn").forEach((btn) => {
    btn.addEventListener("click", () => doDownload(btn, filtered[btn.dataset.idx], false));
  });

  // Force button
  list.querySelectorAll(".force-btn").forEach((btn) => {
    btn.addEventListener("click", () => doDownload(btn, filtered[btn.dataset.idx], true));
  });

  async function doDownload(btn, v, force) {
    const row = btn.closest(".detected-actions");
    try {
      const dlRes = await fetch(`${DAEMON}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: v.url,
          page_url: currentTab.url,
          title: `${currentTab.title} [${v.resolution}]`,
          force,
        }),
      });
      const dlData = await dlRes.json();
      if (dlData.reason === "already_downloaded") {
        row.innerHTML = '<span class="dl-done-label">Done</span>';
      } else {
        row.innerHTML = '<span class="dl-queued-label">Queued</span>';
        loadQueue();
      }
    } catch {
      row.innerHTML = '<span class="dl-error-label">Error</span>';
    }
  }
}

// --- Queue ---
async function loadQueue() {
  try {
    const res = await fetch(`${DAEMON}/queue`);
    const data = await res.json();
    renderQueue(data.items);
  } catch {
    renderQueue([]);
  }
}

function renderQueue(items) {
  const list = document.getElementById("queue-list");
  const empty = document.getElementById("queue-empty");

  // Filter out done/cancelled — they auto-clear
  const active = items.filter((i) => i.status !== "done" && i.status !== "cancelled");

  if (active.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  // Newest first in display
  list.innerHTML = active
    .reverse()
    .map((item) => {
      const statusClass = `status-${item.status}`;
      const showProgress = item.status === "downloading";
      const showCancel = item.status === "downloading" || item.status === "pending";
      const info = [];

      if (item.status === "downloading") {
        if (item.speed) info.push(item.speed);
        if (item.eta) info.push(`ETA: ${item.eta}`);
      }
      if (item.status === "pending") info.push("queued");
      if (item.status === "error") info.push(item.error || "Error");

      const title = item.title || item.filename || item.url;

      return `
        <div class="item ${statusClass}">
          <div class="item-header">
            <span class="item-title" ${item.page_url ? `data-url="${esc(item.page_url)}"` : ""} title="${esc(title)}">${esc(title)}</span>
            ${showCancel ? `<button class="item-cancel" data-id="${item.id}" title="Cancel">&#10005;</button>` : ""}
          </div>
          ${showProgress ? `
            <div class="progress-bar">
              <div class="progress-fill" style="width:${item.progress || 0}%"></div>
            </div>
          ` : ""}
          <div class="item-info">
            <span>${Math.round(item.progress || 0)}%</span>
            ${info.map((i) => `<span>${esc(i)}</span>`).join("")}
          </div>
        </div>
      `;
    })
    .join("");

  // Clickable titles — open page_url
  list.querySelectorAll(".item-title[data-url]").forEach((el) => {
    el.addEventListener("click", () => {
      chrome.tabs.create({ url: el.dataset.url });
    });
  });

  // Cancel button
  list.querySelectorAll(".item-cancel").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`${DAEMON}/queue/${btn.dataset.id}`, { method: "DELETE" });
      loadQueue();
    });
  });
}

// --- Completed ---
async function loadCompleted() {
  try {
    const res = await fetch(`${DAEMON}/completed`);
    const data = await res.json();
    renderCompleted(data.items || []);
  } catch {
    renderCompleted([]);
  }
}

function renderCompleted(items) {
  const list = document.getElementById("completed-list");
  const empty = document.getElementById("completed-empty");

  if (items.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = items
    .map((item) => {
      const shortTitle = (item.title || item.filename || "untitled").slice(0, 35);
      const displayTitle = (item.title || item.filename || "untitled").length > 35
        ? shortTitle + "..." : shortTitle;
      let domain = "";
      try { domain = new URL(item.page_url).hostname; } catch {}
      const skipped = item.last_skipped && (item.last_skipped > (item.completed_at || 0));

      return `
        <div class="completed-item${skipped ? " completed-skipped" : ""}" title="${skipped ? "Skipped (already downloaded)" : ""}"">
          <div class="completed-main">
            ${item.resolution ? `<span class="detected-tag">${esc(item.resolution)}</span>` : ""}
            <span class="completed-title" ${item.page_url ? `data-url="${esc(item.page_url)}"` : ""} title="${esc(item.title || "")}">${esc(displayTitle)}</span>
          </div>
          <div class="completed-meta">
            ${domain ? `<span class="completed-url" data-url="${esc(item.page_url)}" title="${esc(item.page_url)}">${esc(domain)}</span>` : ""}
            ${item.filename ? `<button class="completed-dest" data-filename="${esc(item.filename)}" title="Show in folder">&#128194;</button>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  // Clickable titles — open page_url
  list.querySelectorAll(".completed-title[data-url]").forEach((el) => {
    el.addEventListener("click", () => {
      chrome.tabs.create({ url: el.dataset.url });
    });
  });

  // URL click — open in current window (works in incognito too)
  list.querySelectorAll(".completed-url").forEach((el) => {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      chrome.tabs.create({ url: el.dataset.url });
    });
  });

  // Dest buttons — reveal file
  list.querySelectorAll(".completed-dest").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`${DAEMON}/reveal_file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: btn.dataset.filename }),
      });
    });
  });
}

// --- Settings ---
let currentSettings = {};

async function loadSettings() {
  try {
    const res = await fetch(`${DAEMON}/settings`);
    currentSettings = await res.json();
    document.getElementById("s-resolution").value = currentSettings.preferred_resolution || "best";
    document.getElementById("s-download-dir").value = currentSettings.download_dir || "";
    document.getElementById("s-max-concurrent").value = currentSettings.max_concurrent || 2;
    document.getElementById("s-filter-res").checked = currentSettings.filter_resolution || false;
    document.getElementById("s-skip-downloaded").checked = currentSettings.skip_downloaded !== false;
  } catch {}
}

document.getElementById("s-save").addEventListener("click", async () => {
  const dir = document.getElementById("s-download-dir").value.trim();
  const settings = {
    preferred_resolution: document.getElementById("s-resolution").value,
    download_dir: dir,
    max_concurrent: parseInt(document.getElementById("s-max-concurrent").value) || 2,
    filter_resolution: document.getElementById("s-filter-res").checked,
    skip_downloaded: document.getElementById("s-skip-downloaded").checked,
  };
  try {
    await fetch(`${DAEMON}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    currentSettings = settings;
    if (dir) addToDirHistory(dir);
    document.getElementById("s-status").textContent = "Saved!";
    setTimeout(() => (document.getElementById("s-status").textContent = ""), 2000);
  } catch {
    document.getElementById("s-status").textContent = "Failed — daemon offline?";
  }
});

// --- Dir history ---
async function getDirHistory() {
  const data = await chrome.storage.local.get("dirHistory");
  return data.dirHistory || [];
}

async function addToDirHistory(dir) {
  let history = await getDirHistory();
  history = [dir, ...history.filter((d) => d !== dir)].slice(0, 10);
  await chrome.storage.local.set({ dirHistory: history });
}

async function removeDirHistory(dir) {
  let history = await getDirHistory();
  history = history.filter((d) => d !== dir);
  await chrome.storage.local.set({ dirHistory: history });
}

async function renderDirHistory() {
  const dropdown = document.getElementById("dir-history");
  const history = await getDirHistory();
  if (history.length === 0) {
    dropdown.classList.add("hidden");
    return;
  }
  dropdown.innerHTML = history
    .map((d) => `
      <div class="dir-history-item">
        <span class="dir-history-path" title="${esc(d)}">${esc(d)}</span>
        <button class="dir-history-remove" data-dir="${esc(d)}" title="Remove">&#10005;</button>
      </div>
    `)
    .join("");
  dropdown.classList.remove("hidden");

  dropdown.querySelectorAll(".dir-history-path").forEach((el) => {
    el.addEventListener("click", () => {
      document.getElementById("s-download-dir").value = el.title;
      dropdown.classList.add("hidden");
    });
  });

  dropdown.querySelectorAll(".dir-history-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await removeDirHistory(btn.dataset.dir);
      renderDirHistory();
    });
  });
}

function winToWsl(path) {
  const m = path.trim().match(/^([A-Za-z]):[\\\/](.*)$/);
  if (!m) return path;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

const dirInput = document.getElementById("s-download-dir");
dirInput.addEventListener("focus", renderDirHistory);
dirInput.addEventListener("click", renderDirHistory);
dirInput.addEventListener("blur", () => {
  const converted = winToWsl(dirInput.value);
  if (converted !== dirInput.value) dirInput.value = converted;
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".dir-wrapper")) {
    document.getElementById("dir-history").classList.add("hidden");
  }
});

// --- Daemon health ---
async function checkDaemon() {
  const el = document.getElementById("daemon-status");
  try {
    await fetch(`${DAEMON}/health`);
    el.textContent = "Daemon online";
    el.className = "daemon-online";
  } catch {
    el.textContent = "Daemon offline";
    el.className = "daemon-offline";
  }
}

// --- Helpers ---
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

init();
