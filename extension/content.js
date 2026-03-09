// Hook XHR and fetch to catch video stream URLs that webRequest might miss
(function () {
  const VIDEO_PATTERNS = [".m3u8", ".mpd", "/videoplayback"];

  function isVideoUrl(url) {
    if (typeof url !== "string") return false;
    const lower = url.toLowerCase();
    return VIDEO_PATTERNS.some((p) => lower.includes(p));
  }

  function report(url) {
    try {
      chrome.runtime.sendMessage({ type: "video_url", url });
    } catch (e) {
      // Extension context invalidated, ignore
    }
  }

  // Hook XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isVideoUrl(url)) report(url);
    return origOpen.call(this, method, url, ...rest);
  };

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = function (input, ...args) {
    const url = typeof input === "string" ? input : input?.url;
    if (isVideoUrl(url)) report(url);
    return origFetch.call(this, input, ...args);
  };
})();
