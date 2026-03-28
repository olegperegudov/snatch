const API = "http://127.0.0.1:9111";

// Store detected video URLs per tab: tabId -> [{url, type, label}]
const tabVideos = new Map();

// --- Intercept video stream URLs via webRequest ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url.toLowerCase();
    if (url.startsWith("chrome-extension://") || url.startsWith("moz-extension://")) return;
    if (
      url.includes(".m3u8") ||
      url.includes(".mpd") ||
      url.includes("video/mp4") ||
      (url.includes(".mp4") && details.type === "media")
    ) {
      const tabId = details.tabId;
      if (tabId < 0) return;

      if (!tabVideos.has(tabId)) tabVideos.set(tabId, []);
      const videos = tabVideos.get(tabId);

      if (!videos.some((v) => v.url === details.url)) {
        videos.push({
          url: details.url,
          type: guessType(details.url),
        });
        rebuildMenu(tabId);
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Messages from content.js ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "video_url" && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabVideos.has(tabId)) tabVideos.set(tabId, []);
    const videos = tabVideos.get(tabId);
    if (!videos.some((v) => v.url === msg.url)) {
      videos.push({ url: msg.url, type: guessType(msg.url) });
      rebuildMenu(tabId);
    }
  }

  if (msg.type === "get_videos") {
    sendResponse({ videos: tabVideos.get(msg.tabId) || [] });
  }

  if (msg.type === "check_health") {
    fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .then((d) => sendResponse({ ok: true, version: d.version }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Download request — runs in background, survives popup/tab close
  if (msg.type === "download") {
    fetch(`${API}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.data),
    })
      .then((r) => r.json())
      .then((d) => sendResponse({ ok: true, data: d }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// --- Context menu ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "snatch-parent",
      title: "Snatch",
      contexts: ["page", "video", "audio", "link"],
    });
  });
});

let dynamicMenuIds = [];

async function rebuildMenu(forTabId) {
  for (const id of dynamicMenuIds) {
    chrome.contextMenus.remove(id, () => chrome.runtime.lastError);
  }
  dynamicMenuIds = [];

  const videos = tabVideos.get(forTabId) || [];
  if (videos.length === 0) return;

  let tabTitle = "";
  try {
    const tab = await chrome.tabs.get(forTabId);
    tabTitle = (tab.title || "").slice(0, 30);
    if ((tab.title || "").length > 30) tabTitle += "...";
  } catch {}

  const sepId = "snatch-sep";
  chrome.contextMenus.create(
    { id: sepId, parentId: "snatch-parent", type: "separator", contexts: ["page", "video", "audio", "link"] },
    () => chrome.runtime.lastError
  );
  dynamicMenuIds.push(sepId);

  videos.forEach((v, i) => {
    const id = `snatch-video-${i}`;
    const res = guessResolution(v.url);
    const tag = res ? `${res} ${v.type}` : v.type;
    const label = `[${tag}] ${tabTitle}`;
    chrome.contextMenus.create(
      { id, parentId: "snatch-parent", title: label, contexts: ["page", "video", "audio", "link"] },
      () => chrome.runtime.lastError
    );
    dynamicMenuIds.push(id);
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => rebuildMenu(tabId));

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId.startsWith("snatch-video-")) return;
  const idx = parseInt(info.menuItemId.replace("snatch-video-", ""));
  const videos = tabVideos.get(tab.id) || [];
  if (!videos[idx]) return;

  const url = videos[idx].url;
  try {
    await fetch(`${API}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, page_url: tab.url, title: tab.title || "" }),
    });
    updateBadge();
  } catch {
    chrome.action.setBadgeBackgroundColor({ color: "#f44336" });
    chrome.action.setBadgeText({ text: "!" });
    setTimeout(updateBadge, 2000);
  }
});

// --- Clean up on tab close ---
chrome.tabs.onRemoved.addListener((tabId) => tabVideos.delete(tabId));

// --- Helpers ---
function guessType(url) {
  if (url.includes(".m3u8")) return "HLS";
  if (url.includes(".mpd")) return "DASH";
  if (url.includes(".mp4")) return "MP4";
  return "video";
}

function guessResolution(url) {
  const patterns = [
    /(\d{3,4})p/i,
    /[\/_](\d{3,4})[\/_]/,
    /(\d{3,4})x(\d{3,4})/,
    /height[=_](\d{3,4})/i,
    /res[=_](\d{3,4})/i,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) {
      const val = parseInt(m[2] || m[1]);
      if (val >= 240 && val <= 4320) return `${val}p`;
    }
  }
  return "";
}

// --- Badge: show active download count ---
async function updateBadge() {
  try {
    const res = await fetch(`${API}/queue`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    const items = data.items || [];
    const active = items.filter((i) => i.status === "downloading" || i.status === "pending");
    const dl = items.filter((i) => i.status === "downloading").length;

    if (!active.length) {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    chrome.action.setBadgeBackgroundColor({ color: dl > 0 ? "#22c55e" : "#eab308" });
    chrome.action.setBadgeText({ text: dl > 0 ? `${dl}/${active.length}` : String(active.length) });
  } catch {
    chrome.action.setBadgeText({ text: "" });
  }
}

setInterval(updateBadge, 3000);
updateBadge();
