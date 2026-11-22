@echo off
title MochiDrop Installer & Launcher
echo ============================================
echo   MochiDrop - Desktop Setup for Windows
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [!] Node.js 20+ is required. Download it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --legacy-peer-deps
)

echo Building MochiDrop...
call npm run build
call npm run build:server

echo.
echo Starting MochiDrop on http://127.0.0.1:3000 ...
start "" http://127.0.0.1:3000
set NODE_ENV=production
set PORT=3000
node dist/server.mjs
pause
