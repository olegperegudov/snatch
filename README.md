<p align="center">
  <img src="raccoon_master.png" width="96" alt="Snatch logo" />
</p>

<h1 align="center">Snatch</h1>

<p align="center">
  Chrome extension + companion app for downloading video streams.<br/>
  See a video playing? Click the icon → it's downloading.
</p>

---

Snatch is a Chrome extension paired with a small local app. The extension detects video streams on any website. The companion app downloads them to your computer as mp4 files.

**No accounts, no cloud, no subscriptions.** Everything runs on your machine. Your downloads and history never leave localhost.

## Getting started

**Step 1.** Install the Chrome extension from [**Releases**](https://github.com/olegperegudov/snatch/releases/latest) — download `snatch-extension.zip`, unzip, then load in `chrome://extensions/` (Developer mode → Load unpacked).

**Step 2.** Install the companion app from the same [**Releases**](https://github.com/olegperegudov/snatch/releases/latest) page — run the installer. It sits in your system tray and handles downloads.

**Step 3.** Browse the web. When Snatch detects a video stream, click the extension icon → pick resolution → download. That's it.

The companion app auto-updates — you'll see a green indicator in settings when a new version is available.

## Why Snatch

- **Private** — no data leaves your machine, no analytics, no telemetry
- **Simple** — one click to download, no configuration needed
- **Smart** — auto-detects streams, picks the best quality, skips duplicates
- **Open source** — inspect every line of code

## Settings

Click the gear icon in the popup:

- **Resolution** — preferred quality (best / 1080p / 720p / 480p)
- **Download folder** — where files are saved
- **Skip downloaded** — don't re-download videos you already have
- **Max parallel** — how many downloads run at once

---

<details>
<summary><b>Alternative: Python daemon (Linux / macOS)</b></summary>

Instead of the companion app, you can run the Python daemon directly.

**Prerequisites:** Python 3.10+, ffmpeg in PATH

```bash
cd snatch/daemon
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

</details>

<details>
<summary><b>How it works under the hood</b></summary>

The Chrome extension monitors network requests for `.m3u8` (HLS), `.mpd` (DASH), and `.mp4` streams. When you click download, it sends the stream URL to the companion app running on `localhost:9111`. The companion uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/) to download and merge stream segments into a single mp4 file.

```
Chrome Extension                    Companion App (localhost:9111)
┌────────────────────┐              ┌────────────────────────────┐
│ Detect streams     │───download──▶│ Download queue             │
│ Pick resolution    │◀──progress──│ yt-dlp + ffmpeg             │
│ Show queue         │              │ History & dedup             │
│ Track history      │              │ Settings                   │
└────────────────────┘              └────────────────────────────┘
```

**Built with:** Chrome Extensions MV3 · Tauri v2 (Rust) · FastAPI (Python) · yt-dlp · ffmpeg

</details>

## License

MIT
