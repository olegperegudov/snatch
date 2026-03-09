# Chrome Web Store Listing

## Name
Snatch — Video Stream Downloader

## Short Description (132 chars max)
Detect and download video streams (HLS, DASH, MP4) from any webpage. Requires free companion app.

## Detailed Description
Snatch detects video streams (HLS/m3u8, DASH/mpd, MP4) on any webpage and downloads them with one click.

HOW IT WORKS
1. Install this extension
2. Download the free companion app from GitHub (link shown in extension)
3. Browse any page with video — Snatch detects streams automatically
4. Click the extension icon to see detected streams and download

FEATURES
- Automatic stream detection (HLS, DASH, MP4)
- One-click download with resolution selection
- Download queue with pause/resume
- Skip already downloaded videos
- Configurable download folder and max parallel downloads
- Works with the free open-source companion app (no account needed)

COMPANION APP
Snatch requires a small companion app running on your computer to handle the actual downloads. The companion app is free, open-source, and available on GitHub. The extension will show a banner with the download link if the companion is not detected.

The companion app:
- Runs as a tray icon (no window)
- Uses yt-dlp for reliable stream downloading
- Stores downloads in your chosen folder
- All processing happens locally on your machine

SOURCE CODE
Snatch is fully open-source: https://github.com/olegperegudov/snatch

## Category
Productivity

## Language
English

---

## Privacy Justification (for Chrome Web Store review)

### Why <all_urls> host permission?
Video streams can appear on any website. The extension needs to monitor network requests across all URLs to detect HLS (.m3u8), DASH (.mpd), and MP4 streams. Without this permission, the extension cannot detect video streams on arbitrary websites.

### Why webRequest permission?
Used to intercept network requests and identify video stream URLs (m3u8, mpd, mp4) as they load. The extension only looks at URL patterns — it does not read or modify request/response bodies.

### Why nativeMessaging permission?
Used to communicate with the companion desktop app via Chrome's Native Messaging API for faster, more reliable communication than HTTP localhost.

### Why tabs permission?
Used to get the current tab's URL and title, which are used as metadata for downloads (page URL for history tracking, title for file naming).

### Why storage permission?
Stores user preferences (auto-download toggle, download directory history) locally in Chrome storage.

### Why activeTab permission?
Used to identify the currently active tab when the user opens the extension popup, to show detected streams for that specific tab.

### Data handling
- No user data is collected, transmitted, or stored externally
- All communication is local (extension ↔ companion app on localhost)
- No analytics, no tracking, no third-party services
- Download history is stored locally on the user's machine
