# Snatch — Video Stream Downloader

Chrome extension + local Python daemon for downloading HLS/DASH video streams. One click to queue, downloads silently in the background.

## How it works

```
Chrome Extension (MV3)              Python Daemon (localhost:9111)
┌──────────────────────┐            ┌───────────────────────────┐
│ background.js         │──POST────▶│ FastAPI server             │
│  webRequest listener  │           │  POST /download            │
│  context menu         │◀──GET────│  GET  /queue               │
│ content.js            │           │  POST /probe (HLS parser)  │
│  XHR/fetch hook       │           │  GET  /completed           │
│ popup (tabs UI)       │           │  GET/PUT /settings         │
│  detected + queue     │           │                            │
│  completed history    │           │ yt-dlp + ffmpeg             │
└──────────────────────┘            │  HLS/DASH → mp4            │
                                    └───────────────────────────┘
```

The extension intercepts `.m3u8` / `.mpd` / `.mp4` requests via `webRequest` and `XHR/fetch` hooks. When you click Download, it sends the URL to the local daemon which uses `yt-dlp` to download and merge the stream into an mp4 file.

## Prerequisites

- **Python 3.10+**
- **ffmpeg** in PATH (`sudo apt install ffmpeg` or [download](https://ffmpeg.org/download.html))
- **Chrome/Chromium** browser

## Setup

### 1. Daemon

```bash
cd snatch/daemon
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" → select `snatch/extension/` folder
4. (Optional) Enable in Incognito: extension details → "Allow in Incognito"

## Running

```bash
# Start the daemon
cd snatch/daemon
.venv/bin/python main.py
```

Or add an alias to your shell:
```bash
alias snatch="~/snatch/daemon/.venv/bin/python ~/snatch/daemon/main.py"
```

The daemon runs on `http://127.0.0.1:9111`.

## Usage

1. Open any page with video (HLS/DASH streams)
2. The extension badge shows detected streams
3. **Click the extension icon** → see detected resolutions → click Download
4. **Right-click** → Snatch → pick a resolution from the context menu
5. Downloads queue is visible in the popup (Downloads tab)
6. Completed downloads are in the Completed tab with links to source and file location

## Features

- Auto-detection of HLS (.m3u8) and DASH (.mpd) streams
- Resolution selection (best / 1080p / 720p / 480p)
- Probe endpoint parses m3u8 master playlists for real resolutions
- URL-based resolution extraction (for CDNs that encode resolution in URL)
- Concurrent downloads with configurable parallelism
- Download history with deduplication (skip already downloaded)
- Temp dir for downloads — no partial files cluttering your folder
- "Show in folder" button opens Explorer with the file selected (WSL2 compatible)
- Badge shows queue status: `pending|downloading`
- Works in Incognito mode

## Settings

Accessible via the gear icon in the popup:

| Setting | Default | Description |
|---------|---------|-------------|
| Resolution | best | Preferred download resolution |
| Only show selected resolution | off | Filter detected list |
| Skip already downloaded | on | Check history before downloading |
| Download folder | ~/Downloads | Where files are saved |
| Max parallel downloads | 2 | Concurrent download limit |

## Project structure

```
snatch/
├── daemon/
│   ├── main.py              # FastAPI server, endpoints, history
│   ├── downloader.py         # yt-dlp wrapper, progress hooks
│   ├── download_queue.py     # Queue with semaphore, state persistence
│   ├── requirements.txt
│   ├── settings.json         # User settings (auto-created)
│   └── history.json          # Download history (auto-created)
├── extension/
│   ├── manifest.json         # Chrome MV3 manifest
│   ├── background.js         # Service worker: webRequest, context menu, badge
│   ├── content.js            # XHR/fetch hook for stream detection
│   ├── popup.html            # Popup UI
│   ├── popup.js              # Popup logic: tabs, queue, completed
│   ├── popup.css             # Dark theme styles
│   └── icons/                # Extension icons (16, 48, 128px)
└── README.md
```
