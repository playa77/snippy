// main.js — Snippy v1.1.5
// Electron main process: SSH terminals, SFTP file manager, gateway health,
// settings persistence, close confirmation, font size control.

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');

// ---------------------------------------------------------------------------
// Disable Chromium SUID sandbox (required on Linux without root-owned helper)
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('no-sandbox');

// ---------------------------------------------------------------------------
// App version — single source of truth
// ---------------------------------------------------------------------------
const APP_VERSION = '1.1.5';

// ---------------------------------------------------------------------------
// Persistent settings — plain JSON file in userData directory
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  host: '',
  port: 22,
  username: '',
  password: '',
  privateKeyPath: '',
  agentCommand: 'openclaw tui',
  workspacePath: '~/.openclaw/workspace',
  gatewayHost: 'localhost',
  gatewayPort: 18789,
  fontSize: 14,
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'snippy-config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return { ...CONFIG_DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...CONFIG_DEFAULTS };
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Runtime config — loaded from disk on startup
// ---------------------------------------------------------------------------
let config = CONFIG_DEFAULTS;

// ---------------------------------------------------------------------------
// Active SSH sessions: keyed by tab id ('agent' | 'vps')
// ---------------------------------------------------------------------------
const sessions = {};

// ---------------------------------------------------------------------------
// Dedicated SFTP connection (separate from terminal sessions)
// ---------------------------------------------------------------------------
let sftpConn = null;
let sftpClient = null;

// ---------------------------------------------------------------------------
// Gateway health polling
// ---------------------------------------------------------------------------
let gatewayPollTimer = null;
const GATEWAY_POLL_INTERVAL_MS = 5000;

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

  // -----------------------------------------------------------------------
  // Close confirmation dialog
  // -----------------------------------------------------------------------
  let forceClose = false;

  mainWindow.on('close', (e) => {
    if (forceClose) return; // Already confirmed, let it close

    e.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Quit Snippy?',
        message: 'Are you sure you want to quit Snippy?',
      })
      .then(({ response }) => {
        if (response === 0) {
          forceClose = true;
          cleanupAllSessions();
          mainWindow.close();
        }
      });
  });

  // Remove default menu bar
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  config = loadConfig();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// IPC: app metadata
// ---------------------------------------------------------------------------
ipcMain.handle('get-version', () => APP_VERSION);

// ---------------------------------------------------------------------------
// IPC: settings management
// ---------------------------------------------------------------------------
ipcMain.handle('get-config', () => {
  // Return config with password masked for display
  return { ...config, password: config.password ? '••••••••' : '' };
});

ipcMain.handle('get-config-raw', () => {
  // Return full config including real password (for settings form population)
  return { ...config };
});

ipcMain.handle('set-config', (_event, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: font size
// ---------------------------------------------------------------------------
ipcMain.handle('get-font-size', () => config.fontSize || 14);

ipcMain.handle('set-font-size', (_event, size) => {
  config.fontSize = size;
  saveConfig();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: SSH connect
// ---------------------------------------------------------------------------
ipcMain.handle('ssh-connect', (_event, tabId) => {
  return new Promise((resolve) => {
    destroySession(tabId);

    if (!config.host || !config.username) {
      resolve({ ok: false, error: 'Host and username are required. Open settings to configure.' });
      return;
    }

    const conn = new Client();
    sessions[tabId] = { conn, shell: null };

    const sshConfig = buildSshConfig();
    if (sshConfig.error) {
      resolve({ ok: false, error: sshConfig.error });
      return;
    }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          resolve({ ok: false, error: `Shell error: ${err.message}` });
          return;
        }

        sessions[tabId].shell = stream;

        // For AGENT tab, send the configured command immediately
        if (tabId === 'agent') {
          stream.write(config.agentCommand + '\n');
          agentReconnectAttempts = 0;
        }

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
          if (tabId === 'agent') scheduleAgentReconnect();
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
      if (tabId === 'agent') scheduleAgentReconnect();
      resolve({ ok: false, error: err.message });
    });

    conn.on('end', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`ssh-status-${tabId}`, { status: 'ended' });
      }
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`ssh-status-${tabId}`, { status: 'connecting' });
    }
    conn.connect(sshConfig);
  });
});

// ---------------------------------------------------------------------------
// IPC: SSH input / resize / disconnect
// ---------------------------------------------------------------------------
ipcMain.on('ssh-input', (_event, tabId, data) => {
  const session = sessions[tabId];
  if (session && session.shell && session.shell.writable) {
    session.shell.write(data);
  }
});

ipcMain.on('ssh-resize', (_event, tabId, cols, rows) => {
  const session = sessions[tabId];
  if (session && session.shell) {
    session.shell.setWindow(rows, cols, 0, 0);
  }
});

ipcMain.handle('ssh-disconnect', (_event, tabId) => {
  destroySession(tabId);
  if (tabId === 'agent' && agentReconnectTimer) {
    clearTimeout(agentReconnectTimer);
    agentReconnectTimer = null;
    agentReconnectAttempts = 0;
  }
  return { ok: true };
});

// ===========================================================================
// SFTP FILE MANAGER
// ===========================================================================

// ---------------------------------------------------------------------------
// IPC: establish SFTP connection
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-connect', () => {
  return new Promise((resolve) => {
    destroySftp();

    if (!config.host || !config.username) {
      resolve({ ok: false, error: 'Host and username required.' });
      return;
    }

    const conn = new Client();
    sftpConn = conn;

    const sshConfig = buildSshConfig();
    if (sshConfig.error) {
      resolve({ ok: false, error: sshConfig.error });
      return;
    }

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          resolve({ ok: false, error: `SFTP init error: ${err.message}` });
          return;
        }
        sftpClient = sftp;
        resolve({ ok: true });
      });
    });

    conn.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    conn.connect(sshConfig);
  });
});

// ---------------------------------------------------------------------------
// IPC: list directory
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-list', async (_event, remotePath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    sftpClient.readdir(remotePath, (err, list) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }

      const entries = list
        .map((item) => ({
          name: item.filename,
          isDirectory: (item.attrs.mode & 0o40000) !== 0,
          size: item.attrs.size,
          modifiedMs: item.attrs.mtime * 1000,
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      resolve({ ok: true, entries });
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: read file
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-read-file', async (_event, remotePath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    const chunks = [];
    const stream = sftpClient.createReadStream(remotePath, { encoding: 'utf8' });

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve({ ok: true, content: chunks.join('') }));
    stream.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ---------------------------------------------------------------------------
// IPC: write file
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-write-file', async (_event, remotePath, content) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    const stream = sftpClient.createWriteStream(remotePath);
    stream.on('close', () => resolve({ ok: true }));
    stream.on('error', (err) => resolve({ ok: false, error: err.message }));
    stream.end(content, 'utf8');
  });
});

// ---------------------------------------------------------------------------
// IPC: create directory
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-mkdir', async (_event, remotePath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    sftpClient.mkdir(remotePath, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: rename file/directory
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-rename', async (_event, oldPath, newPath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    sftpClient.rename(oldPath, newPath, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: delete file
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-delete', async (_event, remotePath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    sftpClient.unlink(remotePath, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: delete directory (rmdir — must be empty)
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-rmdir', async (_event, remotePath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  return new Promise((resolve) => {
    sftpClient.rmdir(remotePath, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: download file — user picks local save path via native dialog
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-download', async (_event, remotePath, suggestedName) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    title: 'Download file',
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, error: 'Cancelled.' };
  }

  return new Promise((resolve) => {
    sftpClient.fastGet(remotePath, result.filePath, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, localPath: result.filePath });
    });
  });
});

// ---------------------------------------------------------------------------
// IPC: upload file — user picks local file via native dialog
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-upload', async (_event, remoteDir) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload file',
    properties: ['openFile', 'multiSelections'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'Cancelled.' };
  }

  const errors = [];

  for (const localPath of result.filePaths) {
    const fileName = path.basename(localPath);
    const remotePath = remoteDir.replace(/\/$/, '') + '/' + fileName;

    await new Promise((resolve) => {
      sftpClient.fastPut(localPath, remotePath, (err) => {
        if (err) errors.push(`${fileName}: ${err.message}`);
        resolve();
      });
    });
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('\n') };
  }

  return { ok: true, count: result.filePaths.length };
});

// ---------------------------------------------------------------------------
// IPC: resolve a remote path (expands ~ via SFTP home directory)
// ---------------------------------------------------------------------------
ipcMain.handle('sftp-realpath', async (_event, remotePath) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };

  // If the path starts with ~, resolve home first then append the rest
  if (remotePath.startsWith('~/') || remotePath === '~') {
    return new Promise((resolve) => {
      // SFTP realpath('.') returns the user's home directory
      sftpClient.realpath('.', (err, homePath) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }

        let fullPath;
        if (remotePath === '~') {
          fullPath = homePath;
        } else {
          fullPath = homePath.replace(/\/$/, '') + remotePath.slice(1);
        }

        // Now check if this path actually exists
        sftpClient.stat(fullPath, (statErr) => {
          if (statErr) {
            resolve({ ok: false, error: `Path does not exist: ${fullPath}` });
          } else {
            resolve({ ok: true, path: fullPath });
          }
        });
      });
    });
  }

  return new Promise((resolve) => {
    sftpClient.realpath(remotePath, (err, absPath) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, path: absPath });
    });
  });
});

// ===========================================================================
// GATEWAY HEALTH
// ===========================================================================

// ---------------------------------------------------------------------------
// IPC: start gateway health polling
// ---------------------------------------------------------------------------
ipcMain.handle('gateway-poll-start', () => {
  stopGatewayPoll();
  pollGatewayOnce();
  gatewayPollTimer = setInterval(pollGatewayOnce, GATEWAY_POLL_INTERVAL_MS);
  return { ok: true };
});

ipcMain.handle('gateway-poll-stop', () => {
  stopGatewayPoll();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: gateway control — start/stop/restart via SSH PTY with streamed output
// ---------------------------------------------------------------------------
let gatewayControlConn = null;

ipcMain.handle('gateway-control', async (_event, action) => {
  // action is one of: 'start', 'stop', 'restart'
  if (!config.host || !config.username) {
    return { ok: false, error: 'Not connected.' };
  }

  const commands = {
    start: 'openclaw gateway start',
    stop: 'openclaw gateway stop',
    restart: 'openclaw gateway restart',
  };

  const cmd = commands[action];
  if (!cmd) return { ok: false, error: `Unknown action: ${action}` };

  // Clean up any previous gateway control connection
  if (gatewayControlConn) {
    try { gatewayControlConn.end(); } catch (_) { /* ignore */ }
    gatewayControlConn = null;
  }

  return new Promise((resolve) => {
    const conn = new Client();
    gatewayControlConn = conn;

    const sshConfig = buildSshConfig();
    if (sshConfig.error) {
      resolve({ ok: false, error: sshConfig.error });
      return;
    }

    conn.on('ready', () => {
      // Use shell with PTY so interactive output works
      conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, stream) => {
        if (err) {
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }

        // Signal that the command is running — renderer should open the log window
        resolve({ ok: true, streaming: true });

        // Send the command followed by exit so the shell closes when done
        stream.write(cmd + ' 2>&1; echo "\\n[EXIT CODE: $?]"; exit\n');

        stream.on('data', (data) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-log', data.toString('utf8'));
          }
        });

        stream.stderr.on('data', (data) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-log', data.toString('utf8'));
          }
        });

        stream.on('close', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-log-done');
          }
          conn.end();
          gatewayControlConn = null;
        });
      });
    });

    conn.on('error', (err) => {
      resolve({ ok: false, error: err.message });
      gatewayControlConn = null;
    });

    conn.connect(sshConfig);
  });
});

function pollGatewayOnce() {
  if (!config.host || !config.username) return;

  // Use a temporary SSH connection to check if the gateway port is listening
  const conn = new Client();
  const sshConfig = buildSshConfig();
  if (sshConfig.error) return;

  const gwHost = config.gatewayHost || 'localhost';
  const gwPort = config.gatewayPort || 18789;

  conn.on('ready', () => {
    // Attempt TCP connection to the gateway via the SSH tunnel
    const checkCmd = `curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://${gwHost}:${gwPort}/ 2>/dev/null || echo "DOWN"`;

    conn.exec(checkCmd, (err, stream) => {
      if (err) {
        sendGatewayStatus('unknown');
        conn.end();
        return;
      }

      let output = '';
      stream.on('data', (data) => { output += data.toString(); });
      stream.on('close', () => {
        conn.end();
        const trimmed = output.trim();
        // Any HTTP response code means the gateway is up
        if (trimmed === 'DOWN' || trimmed === '') {
          sendGatewayStatus('down');
        } else {
          sendGatewayStatus('up');
        }
      });
    });
  });

  conn.on('error', () => {
    sendGatewayStatus('unknown');
  });

  conn.connect(sshConfig);
}

function sendGatewayStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway-status', status);
  }
}

function stopGatewayPoll() {
  if (gatewayPollTimer) {
    clearInterval(gatewayPollTimer);
    gatewayPollTimer = null;
  }
}

// ===========================================================================
// HELPERS
// ===========================================================================

function buildSshConfig() {
  const sshConfig = {
    host: config.host,
    port: config.port || 22,
    username: config.username,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };

  if (config.privateKeyPath) {
    try {
      sshConfig.privateKey = fs.readFileSync(config.privateKeyPath);
    } catch (err) {
      return { error: `Failed to read SSH key: ${err.message}` };
    }
  } else if (config.password) {
    sshConfig.password = config.password;
  } else {
    return { error: 'No password or SSH key configured.' };
  }

  return sshConfig;
}

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

function destroySftp() {
  if (sftpClient) {
    try { sftpClient.end(); } catch (_) { /* ignore */ }
    sftpClient = null;
  }
  if (sftpConn) {
    try { sftpConn.end(); } catch (_) { /* ignore */ }
    sftpConn = null;
  }
}

function cleanupAllSessions() {
  stopGatewayPoll();
  destroySession('agent');
  destroySession('vps');
  destroySftp();
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh-trigger-reconnect', 'agent');
    }
  }, delay);
}
