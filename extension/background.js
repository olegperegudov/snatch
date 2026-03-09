importScripts("api.js");

// Store detected video URLs per tab: tabId -> [{url, type, label}]
const tabVideos = new Map();

// --- Init: detect communication mode ---
SnatchAPI.detectMode().then((mode) => {
  console.log(`[Snatch] Background started, mode: ${mode}`);
});

// Register push handler for native mode queue updates
SnatchAPI.onQueueUpdate((data) => {
  updateBadgeFromItems((data && data.items) || []);
});

// --- Intercept video stream URLs via webRequest ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url.toLowerCase();
    if (
      url.includes(".m3u8") ||
      url.includes(".mpd") ||
      url.includes("/manifest") ||
      url.includes("video/mp4") ||
      (url.includes(".mp4") && details.type === "media")
    ) {
      const tabId = details.tabId;
      if (tabId < 0) return;

      if (!tabVideos.has(tabId)) tabVideos.set(tabId, []);
      const videos = tabVideos.get(tabId);

      // Deduplicate
      if (!videos.some((v) => v.url === details.url)) {
        videos.push({
          url: details.url,
          type: guessType(details.url),
          label: makeLabel(details.url),
        });
        rebuildMenu(tabId);
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Messages from content.js and popup ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "video_url" && sender.tab) {
    const tabId = sender.tab.id;
    if (!tabVideos.has(tabId)) tabVideos.set(tabId, []);
    const videos = tabVideos.get(tabId);
    if (!videos.some((v) => v.url === msg.url)) {
      videos.push({
        url: msg.url,
        type: guessType(msg.url),
        label: makeLabel(msg.url),
      });
      rebuildMenu(tabId);
    }
  }

  if (msg.type === "get_videos") {
    const videos = tabVideos.get(msg.tabId) || [];
    sendResponse({ videos });
  }
});

// --- Context menu: parent created once on install/update ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "snatch-parent",
      title: "Snatch",
      contexts: ["page", "video", "audio", "link"],
    });
  });
});


// Track which dynamic menu IDs exist
let dynamicMenuIds = [];

async function rebuildMenu(forTabId) {
  // Remove old dynamic items
  for (const id of dynamicMenuIds) {
    chrome.contextMenus.remove(id, () => chrome.runtime.lastError);
  }
  dynamicMenuIds = [];

  const videos = tabVideos.get(forTabId) || [];
  if (videos.length === 0) return;

  // Get tab title for labeling
  let tabTitle = "";
  try {
    const tab = await chrome.tabs.get(forTabId);
    tabTitle = (tab.title || "").slice(0, 30);
    if ((tab.title || "").length > 30) tabTitle += "...";
  } catch {}

  // Separator
  const sepId = "snatch-sep";
  chrome.contextMenus.create(
    { id: sepId, parentId: "snatch-parent", type: "separator", contexts: ["page", "video", "audio", "link"] },
    () => chrome.runtime.lastError
  );
  dynamicMenuIds.push(sepId);

  // One item per detected video
  videos.forEach((v, i) => {
    const id = `snatch-video-${i}`;
    const res = guessResolution(v.url);
    const tag = res ? `${res} ${v.type}` : v.type;
    const label = `[${tag}] ${tabTitle}`;
    chrome.contextMenus.create(
      {
        id,
        parentId: "snatch-parent",
        title: label,
        contexts: ["page", "video", "audio", "link"],
      },
      () => chrome.runtime.lastError
    );
    dynamicMenuIds.push(id);
  });
}

// Rebuild menu when switching tabs
chrome.tabs.onActivated.addListener(({ tabId }) => {
  rebuildMenu(tabId);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab.id;
  const title = tab.title || "";
  let url = "";

  if (info.menuItemId.startsWith("snatch-video-")) {
    const idx = parseInt(info.menuItemId.replace("snatch-video-", ""));
    const videos = tabVideos.get(tabId) || [];
    if (videos[idx]) url = videos[idx].url;
  }

  if (!url) return;

  try {
    await SnatchAPI.download({ url, page_url: tab.url, title });
    updateDownloadBadge();
  } catch (e) {
    // briefly show error, then resume normal badge
    chrome.action.setBadgeBackgroundColor({ color: "#f44336" });
    chrome.action.setBadgeText({ text: "!" });
    setTimeout(updateDownloadBadge, 2000);
  }
});

// --- Clean up on tab close ---
chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideos.delete(tabId);
});

// --- Helpers ---
function guessType(url) {
  if (url.includes(".m3u8")) return "HLS";
  if (url.includes(".mpd")) return "DASH";
  if (url.includes(".mp4")) return "MP4";
  return "video";
}

function guessResolution(url) {
  // Try to extract resolution hints from URL
  const patterns = [
    /(\d{3,4})p/i,           // 720p, 1080p
    /[\/_](\d{3,4})[\/_]/,   // /720/ or _1080_
    /(\d{3,4})x(\d{3,4})/,   // 1920x1080
    /height[=_](\d{3,4})/i,  // height=720
    /res[=_](\d{3,4})/i,     // res=1080
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

function makeLabel(url) {
  const type = guessType(url);
  const res = guessResolution(url);

  // Get filename or path segment for identification
  let name = "";
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // Pick last meaningful segment (not just "manifest" or "index.m3u8")
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(parts[i]);
      if (!seg.match(/^(manifest|index|master|playlist|chunklist)\b/i)) {
        name = seg;
        break;
      }
    }
    if (!name && parts.length) name = parts[parts.length - 1];
  } catch {
    name = url.slice(-30);
  }

  // Truncate name
  if (name.length > 25) name = name.slice(0, 22) + "...";

  const parts = [name, type];
  if (res) parts.push(res);
  return parts.join(" | ");
}

// --- Download count badge ---
function updateBadgeFromItems(items) {
  const active = items.filter((i) => i.status === "downloading" || i.status === "pending" || i.status === "paused");
  const downloading = items.filter((i) => i.status === "downloading").length;

  if (!active.length) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const text = downloading > 0 ? `${downloading}/${active.length}` : String(active.length);
  chrome.action.setBadgeBackgroundColor({ color: downloading > 0 ? "#22c55e" : "#eab308" });
  chrome.action.setBadgeText({ text });
}

async function updateDownloadBadge() {
  try {
    const data = await SnatchAPI.queue();
    updateBadgeFromItems((data && data.items) || []);
  } catch {
    chrome.action.setBadgeText({ text: "" });
  }
}

// --- Icon color based on daemon status ---
let _daemonOnline = false;

async function tintIcon(online) {
  if (online === _daemonOnline) return;
  _daemonOnline = online;

  const imageData = {};
  for (const size of [16, 48, 128]) {
    const resp = await fetch(`icons/icon${size}.png`);
    const bitmap = await createImageBitmap(await resp.blob());
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, size, size);

    if (!online) {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        // Shift green pixels → amber/yellow
        if (g > r * 1.2 && g > b * 1.5) {
          d[i]     = Math.min(255, Math.floor(g * 1.45)); // R up
          d[i + 1] = Math.floor(g * 0.78);                // G down
          d[i + 2] = Math.floor(b * 0.15);                // B ~0
        }
      }
    }
    imageData[size] = img;
  }
  chrome.action.setIcon({ imageData });
}

async function checkDaemonHealth() {
  try {
    await SnatchAPI.health();
    tintIcon(true);
  } catch {
    tintIcon(false);
  }
}

// Poll every 2 seconds (HTTP mode fallback; native mode uses push updates)
setInterval(() => { updateDownloadBadge(); checkDaemonHealth(); }, 2000);
updateDownloadBadge();
checkDaemonHealth();
