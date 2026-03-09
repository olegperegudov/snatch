#!/usr/bin/env python3
"""
Snatch Native Messaging Host — installer.

Sets up the native messaging host for Chrome on the current platform:
  - Windows (WSL2): creates .bat wrapper + registry entry
  - Linux: copies manifest to ~/.config/google-chrome/NativeMessagingHosts/
  - macOS: copies manifest to ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/

Usage:
  python3 install_native_host.py <chrome-extension-id>

The extension ID is shown in chrome://extensions/ when developer mode is on.
"""

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

HOST_NAME = "com.snatch.companion"
SCRIPT_DIR = Path(__file__).resolve().parent
DAEMON_DIR = SCRIPT_DIR / "daemon"
NATIVE_HOST_SCRIPT = DAEMON_DIR / "native_host.py"
MANIFEST_TEMPLATE = DAEMON_DIR / "com.snatch.companion.json"


def get_extension_id():
    if len(sys.argv) < 2:
        print("Usage: python3 install_native_host.py <chrome-extension-id>")
        print("")
        print("Find your extension ID at chrome://extensions/ (enable Developer mode)")
        sys.exit(1)
    ext_id = sys.argv[1].strip()
    if len(ext_id) != 32 or not ext_id.isalpha():
        print(f"Warning: '{ext_id}' doesn't look like a Chrome extension ID (expected 32 lowercase letters)")
    return ext_id


def is_wsl():
    """Detect if running inside WSL."""
    try:
        with open("/proc/version", "r") as f:
            return "microsoft" in f.read().lower()
    except FileNotFoundError:
        return False


def wsl_to_windows_path(linux_path):
    """Convert a WSL path to a Windows path using wslpath."""
    result = subprocess.run(["wslpath", "-w", str(linux_path)], capture_output=True, text=True)
    return result.stdout.strip()


def install_wsl(extension_id):
    """Install on Windows via WSL2."""
    print("Detected: WSL2 (Chrome runs on Windows)")

    # 1. Create a .bat wrapper that Chrome (Windows) will execute
    bat_path = DAEMON_DIR / "snatch_native_host.bat"
    # The .bat calls wsl to run the Python script
    wsl_script_path = str(NATIVE_HOST_SCRIPT)
    bat_content = f'@echo off\nwsl python3 {wsl_script_path}\n'
    bat_path.write_text(bat_content)
    print(f"  Created: {bat_path}")

    # 2. Get Windows path to the .bat file
    bat_win_path = wsl_to_windows_path(bat_path)
    print(f"  Windows path: {bat_win_path}")

    # 3. Create the manifest with Windows path
    manifest = {
        "name": HOST_NAME,
        "description": "Snatch Companion - video download daemon bridge",
        "path": bat_win_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }

    # Save manifest to a temp location accessible from Windows
    manifest_path = DAEMON_DIR / f"{HOST_NAME}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    manifest_win_path = wsl_to_windows_path(manifest_path)
    print(f"  Manifest: {manifest_path}")

    # 4. Register in Windows registry via reg.exe
    reg_key = f"HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
    cmd = ["reg.exe", "add", reg_key, "/ve", "/t", "REG_SZ", "/d", manifest_win_path, "/f"]
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode == 0:
        print(f"  Registry: {reg_key} = {manifest_win_path}")
        print("\n  Installation complete!")
    else:
        print(f"  Registry error: {result.stderr}")
        print(f"  Try running manually: {' '.join(cmd)}")
        sys.exit(1)


def install_linux(extension_id):
    """Install on native Linux (Chrome installed locally)."""
    print("Detected: Linux")

    # Chrome and Chromium look in different directories
    targets = [
        Path.home() / ".config" / "google-chrome" / "NativeMessagingHosts",
        Path.home() / ".config" / "chromium" / "NativeMessagingHosts",
    ]

    manifest = {
        "name": HOST_NAME,
        "description": "Snatch Companion - video download daemon bridge",
        "path": str(NATIVE_HOST_SCRIPT),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }

    # Make native_host.py executable
    NATIVE_HOST_SCRIPT.chmod(0o755)

    for target_dir in targets:
        target_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = target_dir / f"{HOST_NAME}.json"
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(f"  Installed: {manifest_path}")

    print("\n  Installation complete!")


def install_macos(extension_id):
    """Install on macOS."""
    print("Detected: macOS")

    target_dir = Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "NativeMessagingHosts"
    target_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "name": HOST_NAME,
        "description": "Snatch Companion - video download daemon bridge",
        "path": str(NATIVE_HOST_SCRIPT),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }

    NATIVE_HOST_SCRIPT.chmod(0o755)

    manifest_path = target_dir / f"{HOST_NAME}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"  Installed: {manifest_path}")
    print("\n  Installation complete!")


def main():
    extension_id = get_extension_id()
    print(f"\nInstalling Snatch Native Messaging Host")
    print(f"  Extension ID: {extension_id}")
    print(f"  Host name: {HOST_NAME}")
    print()

    if is_wsl():
        install_wsl(extension_id)
    elif platform.system() == "Darwin":
        install_macos(extension_id)
    else:
        install_linux(extension_id)

    print(f"\n  Next steps:")
    print(f"  1. Make sure the Snatch daemon is running: cd daemon && python3 main.py")
    print(f"  2. Reload the extension in chrome://extensions/")
    print(f"  3. Open a page with video and test!")


if __name__ == "__main__":
    main()
