@echo off
REM Snatch — local DEV build (fast iteration, no signing)
REM Works from UNC paths (WSL filesystem)

pushd "%~dp0companion"
if errorlevel 1 (
    echo Failed to enter companion directory
    pause
    exit /b 1
)

echo [1/3] Installing npm deps...
call npm install --silent 2>nul

echo [2/3] Checking yt-dlp sidecar...
if not exist "src-tauri\binaries\yt-dlp-x86_64-pc-windows-msvc.exe" (
    echo Downloading yt-dlp...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'src-tauri\binaries\yt-dlp-x86_64-pc-windows-msvc.exe'"
)

echo [3/3] Building + launching Snatch (debug)...
call npx tauri dev

popd
