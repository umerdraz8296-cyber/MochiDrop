# MochiDrop

A fast, monochrome desktop download manager and media streamer with multi-stream acceleration, built-in cinema playback (including MKV & Dual Audio), and direct VLC / MPV / IINA / PotPlayer streaming.

## Install on Your PC (Recommended)

Anyone can install **MochiDrop** directly on their computer from **GitHub Releases**:

1. Open the **Releases** section on the right sidebar of this GitHub repository.
2. Download the installer for your operating system:
   - **Windows**: `MochiDrop-*-Setup.exe` (full installer with Start Menu & Desktop shortcut) or `MochiDrop-*-Portable.exe` (no install needed)
   - **macOS**: `MochiDrop-*-arm64.dmg` / `MochiDrop-*-x64.dmg`
   - **Linux**: `MochiDrop-*.AppImage`
3. Run the installer and launch **MochiDrop**.

> **How to publish a new PC installer release (for repo owner):**
> Go to **Actions** → **Build & Release PC Desktop Installer** → click **Run workflow** (or push a version tag like `git tag v1.0.0 && git push origin v1.0.0`). GitHub automatically builds the Windows `.exe`, macOS `.dmg`, and Linux `.AppImage` and publishes them in **Releases**.

## Quick Run from Source

Requires **Node.js 20+**:

- **Windows**: Double-click `install-windows.bat`
- **macOS / Linux**: Run `./install-mac-linux.sh`

Or manually:

```bash
npm install
npm run build
npm run build:server
NODE_ENV=production node dist/server.mjs
```

Then open `http://127.0.0.1:3000`.
