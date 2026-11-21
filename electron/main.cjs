const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let serverProcess = null;

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
          setTimeout(check, 200);
        }
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('Timed out waiting for MochiDrop local server.'));
        } else {
          setTimeout(check, 200);
        }
      });
      req.setTimeout(1000, () => req.destroy());
    };
    check();
  });
}

async function startLocalServer(port) {
  const appRoot = app.getAppPath();
  const serverEntry = path.join(appRoot, 'dist', 'server.mjs');
  const downloadsDir = path.join(app.getPath('downloads'), 'MochiDrop');

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      APP_URL: `http://127.0.0.1:${port}`,
      MOCHIDROP_DATA_DIR: downloadsDir,
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  await waitForHealth(port);
}

async function createMainWindow() {
  const port = await findAvailablePort(3000);
  await startLocalServer(port);

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

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);

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
