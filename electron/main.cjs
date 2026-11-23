const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let serverProcess = null;
let currentPort = 3000;
let isHotSwapping = false;

function normalizeVersion(raw) {
  return String(raw || '').trim().replace(/^v/i, '');
}

function compareSemver(aRaw, bRaw) {
  const parse = (v) => {
    const clean = normalizeVersion(v);
    const [core] = clean.split('-');
    const nums = core.split('.').map((p) => {
      const m = p.match(/^(\d+)/);
      return m ? Number(m[1]) : 0;
    });
    while (nums.length < 3) nums.push(0);
    return nums;
  };
  const a = parse(aRaw);
  const b = parse(bRaw);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return 1;
    if ((a[i] || 0) < (b[i] || 0)) return -1;
  }
  return 0;
}

function getLiveUpdateDir() {
  return path.join(app.getPath('userData'), 'live-update');
}

function readBundledDepsHash(appRoot) {
  try {
    const pkgPath = path.join(appRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return '';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.mochidropDepsHash === 'string' ? pkg.mochidropDepsHash.trim() : '';
  } catch {
    return '';
  }
}

function ensureNodeModulesJunction(versionDir, appRoot) {
  const appNodeModules = path.join(appRoot, 'node_modules');
  const linkPath = path.join(versionDir, 'node_modules');
  if (!fs.existsSync(appNodeModules)) return;
  try {
    if (fs.existsSync(linkPath)) return;
    fs.symlinkSync(appNodeModules, linkPath, 'junction');
  } catch {
    // ignore if already created or read-only
  }
}

function clearActiveLiveUpdate() {
  try {
    const activeFile = path.join(getLiveUpdateDir(), 'active.json');
    if (fs.existsSync(activeFile)) {
      fs.unlinkSync(activeFile);
    }
  } catch {
    // ignore
  }
}

function resolveServerLaunchTarget() {
  const appRoot = app.getAppPath();
  const bundledVersion = normalizeVersion(app.getVersion() || '1.0.0');
  const bundledDepsHash = readBundledDepsHash(appRoot);
  const liveUpdateDir = getLiveUpdateDir();
  const versionsBase = path.resolve(liveUpdateDir, 'versions');
  const activeFile = path.join(liveUpdateDir, 'active.json');

  try {
    if (fs.existsSync(activeFile)) {
      const meta = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      const activeVersion = normalizeVersion(meta?.version || '');
      const activeDir = typeof meta?.dir === 'string' ? path.resolve(meta.dir) : '';
      const activeDepsHash = typeof meta?.depsHash === 'string' ? meta.depsHash.trim() : '';

      const isConfined = activeDir.startsWith(versionsBase + path.sep);
      const isNewer = Boolean(activeVersion) && compareSemver(activeVersion, bundledVersion) > 0;
      const depsCompatible = !bundledDepsHash || !activeDepsHash || bundledDepsHash === activeDepsHash;
      const serverEntry = path.join(activeDir, 'dist', 'server.mjs');
      const indexHtml = path.join(activeDir, 'dist', 'index.html');

      if (isConfined && isNewer && depsCompatible && fs.existsSync(serverEntry) && fs.existsSync(indexHtml)) {
        ensureNodeModulesJunction(activeDir, appRoot);
        return {
          isLiveUpdate: true,
          cwd: activeDir,
          serverEntry,
          version: activeVersion,
          appRoot,
          bundledVersion,
          bundledDepsHash,
          liveUpdateDir,
        };
      }
    }
  } catch {
    // Fall back to bundled app
  }

  return {
    isLiveUpdate: false,
    cwd: appRoot,
    serverEntry: path.join(appRoot, 'dist', 'server.mjs'),
    version: bundledVersion,
    appRoot,
    bundledVersion,
    bundledDepsHash,
    liveUpdateDir,
  };
}

function findAvailablePort(preferred = 3000) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address();
        const port = typeof addr === 'object' && addr ? addr.port : 3000;
        fallback.close(() => resolve(port));
      });
    });
    srv.listen(preferred, '127.0.0.1', () => {
      srv.close(() => resolve(preferred));
    });
  });
}

function waitForHealth(port, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('MochiDrop local server health check failed.'));
        } else {
          setTimeout(check, 180);
        }
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('Timed out waiting for MochiDrop local server.'));
        } else {
          setTimeout(check, 180);
        }
      });
      req.setTimeout(1000, () => req.destroy());
    };
    check();
  });
}

function spawnServerProcess(port, target) {
  const downloadsDir = path.join(app.getPath('downloads'), 'MochiDrop');
  const child = spawn(process.execPath, [target.serverEntry], {
    cwd: target.cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      APP_URL: `http://127.0.0.1:${port}`,
      MOCHIDROP_DATA_DIR: downloadsDir,
      MOCHIDROP_LIVE_UPDATE_DIR: target.liveUpdateDir,
      MOCHIDROP_APP_ROOT: target.appRoot,
      MOCHIDROP_BUNDLED_VERSION: target.bundledVersion,
      MOCHIDROP_DEPS_HASH: target.bundledDepsHash,
      MOCHIDROP_APP_VERSION: target.version,
      MOCHIDROP_IS_DESKTOP: '1',
      MOCHIDROP_PLATFORM: process.platform,
      MOCHIDROP_ARCH: process.arch,
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  child.on('exit', (code) => {
    if (serverProcess !== child) return;
    if (code === 42) {
      // Full silent installer is replacing native binaries; exit Electron cleanly
      app.quit();
      return;
    }
    if (code === 43 && !isHotSwapping) {
      // In-app live update applied! Restart server on same port and reload window seamlessly
      isHotSwapping = true;
      void (async () => {
        try {
          await new Promise((r) => setTimeout(r, 250));
          await startLocalServer(currentPort);
          if (mainWindow && !mainWindow.isDestroyed()) {
            await mainWindow.webContents.session.clearCache().catch(() => {});
            await mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
          }
        } catch (err) {
          console.error('In-app update hot-swap failed, rolling back:', err);
          clearActiveLiveUpdate();
          try {
            await startLocalServer(currentPort);
            if (mainWindow && !mainWindow.isDestroyed()) {
              await mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
            }
          } catch {
            app.quit();
          }
        } finally {
          isHotSwapping = false;
        }
      })();
    }
  });

  serverProcess = child;
  return child;
}

async function startLocalServer(port) {
  const target = resolveServerLaunchTarget();
  const child = spawnServerProcess(port, target);

  try {
    await waitForHealth(port, target.isLiveUpdate ? 10000 : 15000);
  } catch (err) {
    if (target.isLiveUpdate) {
      // Automatic safety rollback if a live-updated bundle ever fails health check
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
      clearActiveLiveUpdate();
      const bundledTarget = resolveServerLaunchTarget();
      spawnServerProcess(port, bundledTarget);
      await waitForHealth(port, 15000);
      return;
    }
    throw err;
  }
}

async function createMainWindow() {
  currentPort = await findAvailablePort(3000);
  await startLocalServer(currentPort);

  mainWindow = new BrowserWindow({
    title: 'MochiDrop',
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createMainWindow).catch((err) => {
    console.error('Failed to launch MochiDrop:', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
  });
}
