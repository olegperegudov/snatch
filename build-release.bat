@echo off
REM Snatch — local RELEASE build (produces installer .exe)
REM Requires TAURI_SIGNING_PRIVATE_KEY env var for updater signing

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

echo [3/3] Building Snatch (release)...
call npx tauri build

echo.
echo Done! Installer at: src-tauri\target\release\bundle\nsis\
popd
pause
