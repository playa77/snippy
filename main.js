// main.js — Snippy v0.1.0
// Electron main process: manages SSH connections for AGENT and VPS tabs.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Client } = require('ssh2');

// ---------------------------------------------------------------------------
// App version — single source of truth
// ---------------------------------------------------------------------------
const APP_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Default connection config (will be replaced by settings UI in v0.5.0)
// ---------------------------------------------------------------------------
let config = {
  host: '',
  port: 22,
  username: '',
  password: '',
  privateKeyPath: '',
  agentCommand: 'openclaw tui',
  workspacePath: '~/.openclaw/workspace',
  gatewayHost: 'localhost',
  gatewayPort: 18789,
};

// ---------------------------------------------------------------------------
// Active SSH sessions: keyed by tab id ('agent' | 'vps')
// ---------------------------------------------------------------------------
const sessions = {};

// ---------------------------------------------------------------------------
// Reconnect state for the AGENT tab
// ---------------------------------------------------------------------------
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2000;
let agentReconnectAttempts = 0;
let agentReconnectTimer = null;

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: `Snippy v${APP_VERSION}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// IPC: return app version to renderer
// ---------------------------------------------------------------------------
ipcMain.handle('get-version', () => APP_VERSION);

// ---------------------------------------------------------------------------
// IPC: update connection config from renderer (temporary until settings UI)
// ---------------------------------------------------------------------------
ipcMain.handle('set-config', (_event, newConfig) => {
  config = { ...config, ...newConfig };
  return { ok: true };
});

ipcMain.handle('get-config', () => {
  // Return config but mask the password
  return { ...config, password: config.password ? '••••' : '' };
});

// ---------------------------------------------------------------------------
// IPC: connect a tab's SSH session
// ---------------------------------------------------------------------------
ipcMain.handle('ssh-connect', (_event, tabId) => {
  return new Promise((resolve) => {
    // Tear down any existing session for this tab
    destroySession(tabId);

    if (!config.host || !config.username) {
      resolve({ ok: false, error: 'Host and username are required. Open settings to configure.' });
      return;
    }

    const conn = new Client();
    sessions[tabId] = { conn, shell: null };

    // Build auth config
    const sshConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };

    // Prefer key if provided, fall back to password
    if (config.privateKeyPath) {
      try {
        const fs = require('fs');
        sshConfig.privateKey = fs.readFileSync(config.privateKeyPath);
      } catch (err) {
        resolve({ ok: false, error: `Failed to read SSH key: ${err.message}` });
        return;
      }
    } else if (config.password) {
      sshConfig.password = config.password;
    } else {
      resolve({ ok: false, error: 'No password or SSH key configured.' });
      return;
    }

    conn.on('ready', () => {
      // Request a PTY shell
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          resolve({ ok: false, error: `Shell error: ${err.message}` });
          return;
        }

        sessions[tabId].shell = stream;

        // For AGENT tab, send the configured command immediately
        if (tabId === 'agent') {
          stream.write(config.agentCommand + '\n');
          agentReconnectAttempts = 0; // successful connection resets counter
        }

        // Pipe shell stdout to renderer
        stream.on('data', (data) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(`ssh-data-${tabId}`, data.toString('binary'));
          }
        });

        stream.stderr.on('data', (data) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(`ssh-data-${tabId}`, data.toString('binary'));
          }
        });

        stream.on('close', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(`ssh-status-${tabId}`, { status: 'closed' });
          }
          destroySession(tabId);

          // Auto-reconnect logic for AGENT tab only
          if (tabId === 'agent') {
            scheduleAgentReconnect();
          }
        });

        resolve({ ok: true });
      });
    });

    conn.on('error', (err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`ssh-status-${tabId}`, {
          status: 'error',
          message: err.message,
        });
      }
      destroySession(tabId);

      if (tabId === 'agent') {
        scheduleAgentReconnect();
      }

      resolve({ ok: false, error: err.message });
    });

    conn.on('end', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`ssh-status-${tabId}`, { status: 'ended' });
      }
    });

    // Initiate connection
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`ssh-status-${tabId}`, { status: 'connecting' });
    }
    conn.connect(sshConfig);
  });
});

// ---------------------------------------------------------------------------
// IPC: send keystrokes from renderer terminal to SSH shell
// ---------------------------------------------------------------------------
ipcMain.on('ssh-input', (_event, tabId, data) => {
  const session = sessions[tabId];
  if (session && session.shell && session.shell.writable) {
    session.shell.write(data);
  }
});

// ---------------------------------------------------------------------------
// IPC: resize the remote PTY
// ---------------------------------------------------------------------------
ipcMain.on('ssh-resize', (_event, tabId, cols, rows) => {
  const session = sessions[tabId];
  if (session && session.shell) {
    session.shell.setWindow(rows, cols, 0, 0);
  }
});

// ---------------------------------------------------------------------------
// IPC: disconnect a tab
// ---------------------------------------------------------------------------
ipcMain.handle('ssh-disconnect', (_event, tabId) => {
  destroySession(tabId);
  // Cancel pending reconnect if disconnecting agent manually
  if (tabId === 'agent' && agentReconnectTimer) {
    clearTimeout(agentReconnectTimer);
    agentReconnectTimer = null;
    agentReconnectAttempts = 0;
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function destroySession(tabId) {
  const session = sessions[tabId];
  if (!session) return;

  if (session.shell) {
    try { session.shell.close(); } catch (_) { /* ignore */ }
    session.shell = null;
  }
  if (session.conn) {
    try { session.conn.end(); } catch (_) { /* ignore */ }
    session.conn = null;
  }
  delete sessions[tabId];
}

function scheduleAgentReconnect() {
  if (agentReconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh-status-agent', {
        status: 'reconnect-failed',
        message: `Gave up after ${RECONNECT_MAX_ATTEMPTS} attempts.`,
      });
    }
    agentReconnectAttempts = 0;
    return;
  }

  agentReconnectAttempts++;
  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, agentReconnectAttempts - 1);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh-status-agent', {
      status: 'reconnecting',
      attempt: agentReconnectAttempts,
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
      delayMs: delay,
    });
  }

  agentReconnectTimer = setTimeout(() => {
    agentReconnectTimer = null;
    // Re-invoke connect from main process side
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh-trigger-reconnect', 'agent');
    }
  }, delay);
}
