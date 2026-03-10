<p align="center">
  <img src="frog_master.png" width="96" alt="Snatch logo" />
</p>

<h1 align="center">Snatch</h1>

<p align="center">
  Video stream downloader for Chrome.<br/>
  Detects HLS/DASH streams on any page — one click to download as mp4.
</p>

<p align="center">
  <b>Local only</b> — everything runs on your machine, nothing leaves localhost<br/>
  <b>Open source</b> — Chrome extension + Python daemon, fully transparent
</p>

## How it works

1. Browse any page with video (HLS/DASH streams)
2. The extension badge lights up with detected streams
3. Click the extension icon → pick resolution → **Download**
4. The file appears in your Downloads folder

Under the hood: the extension intercepts `.m3u8` / `.mpd` / `.mp4` requests and sends them to a local Python daemon that uses `yt-dlp` + `ffmpeg` to download and merge streams.

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

## Quick start

### Prerequisites

- **Python 3.10+**
- **ffmpeg** in PATH (`sudo apt install ffmpeg` or [download](https://ffmpeg.org/download.html))
- **Chrome/Chromium** browser

### 1. Set up the daemon

```bash
cd snatch/daemon
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Load the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select `snatch/extension/` folder
4. *(Optional)* Enable in Incognito: extension details → "Allow in Incognito"

### 3. Run

```bash
cd snatch/daemon
.venv/bin/python main.py
```

The daemon runs on `http://127.0.0.1:9111`. You can also add a shell alias:

```bash
alias snatch="~/snatch/daemon/.venv/bin/python ~/snatch/daemon/main.py"
```

## Features

- **Auto-detection** — catches HLS (.m3u8) and DASH (.mpd) streams automatically
- **Resolution picker** — choose best / 1080p / 720p / 480p, or let it pick the best
- **Right-click menu** — right-click → Snatch → pick resolution from context menu
- **Download queue** — concurrent downloads with configurable parallelism
- **History & dedup** — tracks completed downloads, skips duplicates
- **Clean downloads** — temp dir for partial files, only finished mp4s in your folder
- **Show in folder** — opens Explorer with the file selected (WSL2 compatible)
- **Works in Incognito** — enable in extension settings

## Settings

Click the gear icon in the popup:

| Setting | Default | Description |
|---------|---------|-------------|
| **Resolution** | best | Preferred download resolution |
| **Only show selected** | off | Filter detected list to chosen resolution |
| **Skip downloaded** | on | Check history before downloading |
| **Download folder** | ~/Downloads | Where files are saved |
| **Max parallel** | 2 | Concurrent download limit |

## Privacy

- The daemon runs on `localhost:9111` — no external connections except to the video source
- No analytics, no tracking, no telemetry
- Download history stored locally in `daemon/history.json`
- Fully open source — inspect every line of code

## Tech stack

- [Chrome Extensions MV3](https://developer.chrome.com/docs/extensions/mv3/) — webRequest, service worker
- [FastAPI](https://fastapi.tiangolo.com/) — local HTTP daemon
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — stream downloading
- [ffmpeg](https://ffmpeg.org/) — stream merging

## License

MIT
