#!/usr/bin/env bash
set -euo pipefail

echo "============================================"
echo "  MochiDrop - Desktop Setup (macOS / Linux)"
echo "============================================"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install from https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --legacy-peer-deps
fi

echo "Building MochiDrop..."
npm run build
npm run build:server

export NODE_ENV=production
export PORT=3000

echo "Starting MochiDrop at http://127.0.0.1:3000"
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "http://127.0.0.1:3000") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "http://127.0.0.1:3000") &
fi

node dist/server.mjs
