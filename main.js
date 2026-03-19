// main.js — Snippy v1.1.9
// Electron main process: SSH terminals, SFTP file manager, gateway health,
// settings persistence, close confirmation, font size control.

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');
const pty = require('node-pty');
const { exec } = require('child_process');

// ---------------------------------------------------------------------------
// Disable Chromium SUID sandbox (required on Linux without root-owned helper)
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('no-sandbox');

// ---------------------------------------------------------------------------
// App version — single source of truth
// ---------------------------------------------------------------------------
const APP_VERSION = '1.1.9';

// ---------------------------------------------------------------------------
// Persistent settings — plain JSON file in userData directory
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  host: '',
  port: 22,
  username: '',
  password: '',
  privateKeyPath: '',
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
// Active PTY sessions: keyed by tab id ('agent' | 'vps')
// ---------------------------------------------------------------------------
const sessions = new Map();

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
const RECONNECT_STABLE_RESET_MS = 30000;

let sshpassAvailable = false;
let debugLogPath = null;
const debugModeEnabled = process.argv.includes('--debug');
const ansiRegex = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
let mainWindow = null;

function sanitizeForLog(value, options = {}) {
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 600;
  const redactKeys = new Set(['password', 'passphrase', 'secret', 'token', 'privateKey']);

  if (value == null) return String(value);
  if (typeof value === 'string') {
    const escaped = value
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…(truncated)` : escaped;
  }

  if (typeof value === 'object') {
    try {
      const replacer = (key, val) => {
        if (redactKeys.has(key)) return '<redacted>';
        if (typeof val === 'string' && val.length > maxLength) {
          return `${val.slice(0, maxLength)}…(truncated)`;
        }
        return val;
      };
      return JSON.stringify(value, replacer);
    } catch (_) {
      return '[unserializable object]';
    }
  }

  return String(value);
}

function initDebugLogger() {
  if (!debugModeEnabled) return;
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    debugLogPath = path.join(logsDir, `snippy-debug-${stamp}.log`);
    fs.writeFileSync(debugLogPath, '', 'utf8');
    debugLog('logger', 'Debug logger initialized', {
      debugLogPath,
      appVersion: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      node: process.version,
      cwd: process.cwd(),
      userData: app.getPath('userData'),
    });
  } catch (err) {
    console.error('[snippy] Failed to initialize debug logger:', err.message);
  }
}

function debugLog(scope, message, details) {
  if (!debugModeEnabled) return;
  const now = new Date().toISOString();
  const detailPart = details === undefined ? '' : ` | details=${sanitizeForLog(details)}`;
  const line = `[${now}] [${scope}] ${message}${detailPart}\n`;

  try {
    if (debugLogPath) {
      fs.appendFileSync(debugLogPath, line, 'utf8');
    }
  } catch (err) {
    console.error('[snippy] Failed writing debug log:', err.message);
  }

  // Keep main process diagnostics visible in terminal too.
  process.stdout.write(line);
}

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

app.whenReady().then(async () => {
  config = loadConfig();
  initDebugLogger();
  debugLog('app', 'Debug mode enabled');
  debugLog('app', 'Loaded config from disk', { ...config, password: config.password ? '<redacted>' : '' });
  sshpassAvailable = await checkSshpassAvailable();
  debugLog('app', 'sshpass availability detected', { sshpassAvailable });
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// IPC: app metadata
// ---------------------------------------------------------------------------
ipcMain.handle('get-version', () => APP_VERSION);
ipcMain.handle('debug:get-log-info', () => ({ enabled: debugModeEnabled, path: debugLogPath || '' }));

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
  debugLog('ipc:set-config', 'Renderer updated config', { ...newConfig, password: newConfig?.password ? '<redacted>' : '' });
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
// IPC: PTY connect / disconnect / input / resize / retry
// ---------------------------------------------------------------------------
ipcMain.handle('pty:connect', async (_event, { tabId, config: rendererConfig }) => {
  debugLog('pty:connect', 'Connect requested', {
    tabId,
    rendererConfig: rendererConfig ? { ...rendererConfig, password: rendererConfig.password ? '<redacted>' : '' } : null,
  });
  if (rendererConfig && typeof rendererConfig === 'object') {
    config = { ...config, ...rendererConfig };
  }

  if (!config.host || !config.username) {
    throw new Error('Host and username are required. Open settings to configure.');
  }

  const existing = sessions.get(tabId);
  if (existing && existing.retryTimer) {
    clearTimeout(existing.retryTimer);
    existing.retryTimer = null;
  }

  await createPTYSession(tabId, { ...config }, { preserveRetryCount: false });
});

ipcMain.handle('zellij:list-sessions', async () => {
  debugLog('zellij:list', 'Listing sessions requested');
  return listZellijSessions();
});

ipcMain.handle('zellij:kill-session', async (_event, { name }) => {
  debugLog('zellij:kill', 'Kill session requested', { name });
  return killZellijSession(name);
});

ipcMain.handle('zellij:create-openclaw', async () => {
  debugLog('zellij:create-openclaw', 'Ensure openclaw requested');
  return ensureOpenClawSession();
});

ipcMain.handle('pty:disconnect', async (_event, { tabId }) => {
  debugLog('pty:disconnect', 'Disconnect requested', { tabId });
  const session = sessions.get(tabId);
  if (session) session.intentionalDisconnect = true;
  destroySession(tabId);
});

ipcMain.handle('pty:retry', async (_event, { tabId }) => {
  debugLog('pty:retry', 'Manual retry requested', { tabId });
  const session = sessions.get(tabId);
  if (session) {
    session.retryCount = 0;
    session.intentionalDisconnect = false;
  }
  await createPTYSession(tabId, { ...config }, { preserveRetryCount: false });
});

ipcMain.on('pty:input', (_event, { tabId, data }) => {
  const session = sessions.get(tabId);
  if (!session || !session.ptyProcess || session.status !== 'connected') return;
  session.ptyProcess.write(data);
});

ipcMain.on('pty:resize', (_event, { tabId, cols, rows }) => {
  resizePTY(tabId, cols, rows);
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

// ---------------------------------------------------------------------------
// IPC: download multiple files/dirs as .tar.gz archive
// Uses SSH exec to tar on the remote, then SFTP downloads the archive.
// Sends progress updates via 'download-progress' IPC channel.
// Supports cancellation via 'download-cancel' IPC.
//
// CANCEL DESIGN: The cancel handler itself sends the 'cancelled' progress
// event immediately and does all cleanup. It does NOT depend on the archive
// handler's promise chain resolving. Connections are killed with .destroy()
// (hard socket kill) not .end() (graceful — can hang while tar/transfer is
// still running on the remote).
// ---------------------------------------------------------------------------
function sendDownloadProgress(phase, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-progress', { phase, ...detail });
  }
}

// Active download state — tracked so cancellation can tear it down
let dlActive = false;
let dlCancelled = false;
let dlTarConn = null;       // SSH connection running tar
let dlRemoteTmpPath = '';   // remote archive path to clean up
let dlLocalSavePath = '';   // local partial file to clean up

// ---------------------------------------------------------------------------
// IPC: cancel active download
//
// This is the AUTHORITATIVE cancel path. It:
//   1. Hard-kills active connections with .destroy()
//   2. Sends 'cancelled' progress event immediately (renderer updates UI)
//   3. Deletes partial local file
//   4. Fires-and-forgets remote temp cleanup
//   5. Reconnects SFTP in the background
//
// The archive handler's promise chain MAY eventually resolve too, but the
// renderer does not depend on it. The renderer is purely event-driven.
// ---------------------------------------------------------------------------
ipcMain.handle('download-cancel', async () => {
  if (!dlActive) return { ok: false, error: 'No active download.' };

  dlCancelled = true;
  dlActive = false;

  // Hard-kill tar SSH connection — .destroy() kills the socket immediately,
  // unlike .end() which sends a graceful disconnect and waits.
  if (dlTarConn) {
    try { dlTarConn.destroy(); } catch (_) { /* ignore */ }
    dlTarConn = null;
  }

  // Hard-kill SFTP connection to abort any active fastGet transfer.
  if (sftpConn) {
    try { sftpConn.destroy(); } catch (_) { /* ignore */ }
    sftpConn = null;
    sftpClient = null;
  }

  // Delete partial local file
  if (dlLocalSavePath) {
    try { fs.unlinkSync(dlLocalSavePath); } catch (_) { /* ignore */ }
  }

  // Tell renderer IMMEDIATELY — do not wait for handler chain
  sendDownloadProgress('cancelled', { message: 'Download cancelled.' });

  // Fire-and-forget: clean up remote temp file (non-critical, it's in /tmp)
  cleanupRemoteFile(dlRemoteTmpPath).catch(() => {});

  // Reconnect SFTP so the file manager keeps working
  reconnectSftp().catch(() => {});

  return { ok: true };
});

// Helper: clean up remote temp file via a fresh ephemeral SSH connection
async function cleanupRemoteFile(remotePath) {
  if (!remotePath) return;
  const sshConfig = buildSshConfig();
  if (sshConfig.error) return;

  await new Promise((resolve) => {
    const conn = new Client();

    // Safety timeout — don't hang forever on cleanup
    const timeout = setTimeout(() => {
      try { conn.destroy(); } catch (_) { /* ignore */ }
      resolve();
    }, 10000);

    conn.on('ready', () => {
      conn.exec(`rm -f '${remotePath.replace(/'/g, "'\\''")}'`, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); resolve(); return; }
        stream.on('close', () => { clearTimeout(timeout); conn.end(); resolve(); });
      });
    });
    conn.on('error', () => { clearTimeout(timeout); resolve(); });
    conn.connect(sshConfig);
  });
}

// Helper: reconnect SFTP after a cancel tore down the connection
async function reconnectSftp() {
  return new Promise((resolve) => {
    if (sftpClient) { resolve({ ok: true }); return; }

    const sshConfig = buildSshConfig();
    if (sshConfig.error) { resolve({ ok: false }); return; }

    const conn = new Client();
    sftpConn = conn;

    // Safety timeout
    const timeout = setTimeout(() => {
      try { conn.destroy(); } catch (_) { /* ignore */ }
      sftpConn = null;
      resolve({ ok: false });
    }, 10000);

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        clearTimeout(timeout);
        if (err) { resolve({ ok: false }); return; }
        sftpClient = sftp;
        resolve({ ok: true });
      });
    });
    conn.on('error', () => { clearTimeout(timeout); sftpConn = null; resolve({ ok: false }); });
    conn.connect(sshConfig);
  });
}

ipcMain.handle('sftp-download-archive', async (_event, remoteDirPath, entryNames) => {
  if (!sftpClient) return { ok: false, error: 'SFTP not connected.' };
  if (!config.host || !config.username) return { ok: false, error: 'Not connected.' };
  if (!entryNames || entryNames.length === 0) return { ok: false, error: 'No entries selected.' };

  // Reset cancellation state
  dlActive = true;
  dlCancelled = false;
  dlTarConn = null;
  dlRemoteTmpPath = '';
  dlLocalSavePath = '';

  // Let user choose where to save the archive
  const suggestedName = 'snippy-download.tar.gz';
  const dialogResult = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    title: 'Download archive',
    filters: [{ name: 'tar.gz archive', extensions: ['tar.gz'] }],
  });

  if (dialogResult.canceled || !dialogResult.filePath) {
    dlActive = false;
    return { ok: false, error: 'Cancelled.' };
  }

  dlLocalSavePath = dialogResult.filePath;
  const entryCount = entryNames.length;

  // Build a unique temp path on the remote for the archive
  const tmpName = `snippy-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`;
  dlRemoteTmpPath = `/tmp/${tmpName}`;

  // Escape entry names for shell
  const escapedNames = entryNames.map((n) => "'" + n.replace(/'/g, "'\\''") + "'");
  const tarCmd = `tar czf ${dlRemoteTmpPath} -C '${remoteDirPath.replace(/'/g, "'\\''")}' ${escapedNames.join(' ')} 2>&1; echo "SNIPPY_EXIT:$?"`;

  // ---- Phase 1: Archive on remote ----
  sendDownloadProgress('archiving', {
    message: `Archiving ${entryCount} item${entryCount > 1 ? 's' : ''} on remote...`,
  });

  const tarResult = await new Promise((resolve) => {
    if (dlCancelled) { resolve({ ok: false, error: 'Cancelled.' }); return; }

    const conn = new Client();
    dlTarConn = conn;
    const sshConfig = buildSshConfig();
    if (sshConfig.error) {
      dlTarConn = null;
      resolve({ ok: false, error: sshConfig.error });
      return;
    }

    conn.on('ready', () => {
      conn.exec(tarCmd, (err, stream) => {
        if (err) {
          conn.end();
          dlTarConn = null;
          resolve({ ok: false, error: `SSH exec error: ${err.message}` });
          return;
        }

        let output = '';
        stream.on('data', (data) => { output += data.toString(); });
        stream.stderr.on('data', (data) => { output += data.toString(); });
        stream.on('close', () => {
          dlTarConn = null;
          try { conn.end(); } catch (_) { /* ignore */ }

          if (dlCancelled) {
            resolve({ ok: false, error: 'Cancelled.' });
            return;
          }

          const exitMatch = output.match(/SNIPPY_EXIT:(\d+)/);
          const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : -1;
          if (exitCode === 0) {
            resolve({ ok: true });
          } else {
            const cleanOutput = output.replace(/SNIPPY_EXIT:\d+\s*$/, '').trim();
            resolve({ ok: false, error: `tar failed (exit ${exitCode}): ${cleanOutput}` });
          }
        });
      });
    });

    conn.on('error', (err) => {
      dlTarConn = null;
      resolve({ ok: false, error: dlCancelled ? 'Cancelled.' : `SSH error: ${err.message}` });
    });

    conn.connect(sshConfig);
  });

  // If cancelled, the cancel handler already sent the progress event and
  // cleaned up. Just return so the IPC resolves (unblocks renderer if it
  // happens to be awaiting it).
  if (dlCancelled) { dlActive = false; return { ok: false, error: 'Cancelled.' }; }

  if (!tarResult.ok) {
    dlActive = false;
    sendDownloadProgress('error', { message: tarResult.error });
    return tarResult;
  }

  // ---- Phase 2: Stat the archive to get total size ----
  sendDownloadProgress('stat', { message: 'Preparing download...' });

  const statResult = await new Promise((resolve) => {
    if (dlCancelled || !sftpClient) { resolve({ ok: false, error: 'Cancelled.', size: 0 }); return; }
    sftpClient.stat(dlRemoteTmpPath, (err, stats) => {
      if (err) resolve({ ok: false, error: err.message, size: 0 });
      else resolve({ ok: true, size: stats.size });
    });
  });

  const totalBytes = statResult.ok ? statResult.size : 0;

  if (dlCancelled) { dlActive = false; return { ok: false, error: 'Cancelled.' }; }

  // ---- Phase 3: SFTP download with step progress ----
  sendDownloadProgress('downloading', {
    message: 'Downloading...',
    bytesTransferred: 0,
    totalBytes,
    percent: 0,
  });

  const downloadResult = await new Promise((resolve) => {
    if (dlCancelled || !sftpClient) { resolve({ ok: false, error: 'Cancelled.' }); return; }

    const opts = {
      step: (bytesTransferred, _chunk, total) => {
        const percent = total > 0 ? Math.round((bytesTransferred / total) * 100) : 0;
        sendDownloadProgress('downloading', {
          message: 'Downloading...',
          bytesTransferred,
          totalBytes: total,
          percent,
        });
      },
    };

    sftpClient.fastGet(dlRemoteTmpPath, dlLocalSavePath, opts, (err) => {
      if (err) {
        resolve({ ok: false, error: dlCancelled ? 'Cancelled.' : `Download failed: ${err.message}` });
      } else {
        resolve({ ok: true, localPath: dlLocalSavePath });
      }
    });
  });

  if (dlCancelled) { dlActive = false; return { ok: false, error: 'Cancelled.' }; }

  if (!downloadResult.ok) {
    dlActive = false;
    sendDownloadProgress('error', { message: downloadResult.error });
    return downloadResult;
  }

  // ---- Phase 4: Cleanup remote temp file ----
  sendDownloadProgress('cleanup', { message: 'Cleaning up remote temp file...' });
  await cleanupRemoteFile(dlRemoteTmpPath);

  // ---- Done ----
  dlActive = false;
  const sizeStr = formatBytesMain(totalBytes);
  sendDownloadProgress('done', {
    message: `Download complete — ${sizeStr}`,
    bytesTransferred: totalBytes,
    totalBytes,
    percent: 100,
  });

  return downloadResult;
});

// Helper: format bytes for progress messages (main process)
function formatBytesMain(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

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
        const numericCode = Number.parseInt(trimmed, 10);
        const isHttpCode = Number.isInteger(numericCode) && numericCode >= 100 && numericCode <= 599;
        if (trimmed === 'DOWN' || trimmed === '' || trimmed === '000' || !isHttpCode) {
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

function resolveAuthMode(sshConfig) {
  if (sshConfig.privateKeyPath) return 'key';
  if (sshConfig.password) return 'password';
  return 'none';
}

function buildTerminalConfig(runtimeConfig) {
  const authMode = resolveAuthMode(runtimeConfig);
  if (authMode === 'none') {
    return { error: 'No password or SSH key configured.' };
  }

  return {
    host: runtimeConfig.host,
    port: runtimeConfig.port || 22,
    username: runtimeConfig.username,
    authMode,
    keyPath: runtimeConfig.privateKeyPath,
    password: runtimeConfig.password,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getAgentTabRemoteCommand() {
  const zellijInstallHint = 'sudo apt update && sudo apt install zellij';
  const openclawSession = 'openclaw';
  return [
    `if ! command -v zellij >/dev/null 2>&1; then`,
    `  echo '[snippy] zellij is not installed on the remote VPS.';`,
    `  echo '[snippy] Install it with: ${zellijInstallHint}';`,
    `  exit 127;`,
    `fi;`,
    `if ! zellij list-sessions 2>/dev/null | awk '{print $1}' | grep -Fxq ${shellQuote(openclawSession)}; then`,
    `  zellij --session ${shellQuote(openclawSession)} -d;`,
    `fi;`,
    `exec zellij attach ${shellQuote(openclawSession)}`,
  ].join(' ');
}

function buildSSHArgs(tabId, terminalConfig) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(terminalConfig.port || 22),
  ];

  if (tabId === 'agent') {
    args.push('-tt');
  }

  if (terminalConfig.authMode === 'key' && terminalConfig.keyPath) {
    args.push('-i', terminalConfig.keyPath);
    args.push('-o', 'IdentitiesOnly=yes');
  }

  args.push(`${terminalConfig.username}@${terminalConfig.host}`);

  if (tabId === 'agent') {
    args.push(getAgentTabRemoteCommand());
  }

  return args;
}

function resolveSSHBinary(terminalConfig) {
  return terminalConfig.authMode === 'password' ? 'sshpass' : 'ssh';
}

function buildSpawnArgs(tabId, terminalConfig) {
  const sshArgs = buildSSHArgs(tabId, terminalConfig);
  if (terminalConfig.authMode === 'password') {
    return ['-e', 'ssh', ...sshArgs];
  }
  return sshArgs;
}

function buildSpawnEnv(terminalConfig) {
  const env = { ...process.env, TERM: 'xterm-256color' };
  if (terminalConfig.authMode === 'password') {
    env.SSHPASS = terminalConfig.password || '';
  }
  return env;
}

function sendPtyStatus(tabId, status, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = { tabId, status };
  if (message) payload.message = message;
  debugLog('pty:status', 'Status update sent to renderer', payload);
  mainWindow.webContents.send('pty:status', payload);
}

function sendPtyError(tabId, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  debugLog('pty:error', 'Error sent to renderer', { tabId, message });
  mainWindow.webContents.send('pty:error', { tabId, message });
}

async function runRemoteCommand(command) {
  const sshConfig = buildSshConfig();
  if (sshConfig.error) {
    return { ok: false, error: sshConfig.error };
  }

  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finalize = (result) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) { /* ignore */ }
      resolve(result);
    };

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          finalize({ ok: false, error: err.message });
          return;
        }

        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });

        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });

        stream.on('close', (code) => {
          if (code === 0) {
            finalize({ ok: true, stdout, stderr });
            return;
          }

          const msg = stderr.trim() || stdout.trim() || `Remote command exited with code ${code}.`;
          finalize({ ok: false, error: msg, stdout, stderr, code });
        });
      });
    });

    conn.on('error', (err) => {
      finalize({ ok: false, error: err.message });
    });

    conn.connect(sshConfig);
  });
}

function parseZellijSessionsOutput(output) {
  debugLog('zellij:parse', 'Raw zellij list-sessions output', { output });

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(ansiRegex, '').trim())
    .filter(Boolean);

  const parsed = lines.map((line) => {
    const [nameToken] = line.split(/\s+/);
    const name = (nameToken || '').replace(/[,*]+$/g, '');
    const createdMatch = line.match(/\[Created ([^\]]+)\]/i);
    const clientsMatch = line.match(/\((\d+)\s+clients?\)/i);
    const ageMatch = line.match(/\]\s*([^()]+?)\s*(?:\(|$)/);

    return {
      name,
      created: createdMatch ? createdMatch[1].trim() : 'Unknown',
      age: ageMatch ? ageMatch[1].trim() : 'Unknown',
      clients: clientsMatch ? Number(clientsMatch[1]) : 0,
      raw: line,
    };
  }).filter((session) => !!session.name);

  debugLog('zellij:parse', 'Parsed zellij sessions', parsed);
  return parsed;
}

async function listZellijSessions() {
  const result = await runRemoteCommand(`bash -lc ${shellQuote('command -v zellij >/dev/null 2>&1 && zellij list-sessions')}`);
  debugLog('zellij:list', 'Remote list command completed', result);
  if (!result.ok) {
    const combined = `${result.error || ''}\n${result.stderr || ''}\n${result.stdout || ''}`;
    if (/command not found|not installed|zellij/i.test(combined)) {
      return { ok: false, error: 'zellij is not installed on the VPS. Install it with: sudo apt update && sudo apt install zellij' };
    }
    return { ok: false, error: result.error || 'Failed to list zellij sessions.' };
  }
  return { ok: true, sessions: parseZellijSessionsOutput(result.stdout || '') };
}

async function ensureOpenClawSession() {
  const ensureCommand = [
    'if ! command -v zellij >/dev/null 2>&1; then',
    "  echo 'zellij missing';",
    '  exit 127;',
    'fi;',
    "if ! zellij list-sessions 2>/dev/null | awk '{print $1}' | grep -Fxq 'openclaw'; then",
    "  zellij --session 'openclaw' -d;",
    'fi',
  ].join(' ');

  const result = await runRemoteCommand(`bash -lc ${shellQuote(ensureCommand)}`);
  debugLog('zellij:create-openclaw', 'Ensure command completed', result);
  if (!result.ok) {
    const combined = `${result.error || ''}\n${result.stderr || ''}\n${result.stdout || ''}`;
    if (/zellij missing|command not found|not installed|zellij/i.test(combined)) {
      return { ok: false, error: 'zellij is not installed on the VPS. Install it with: sudo apt update && sudo apt install zellij' };
    }
    return { ok: false, error: result.error || 'Failed to create openclaw session.' };
  }
  return { ok: true };
}

async function killZellijSession(name) {
  if (!name) return { ok: false, error: 'Session name is required.' };
  const sessionName = shellQuote(name);
  const command = [
    'if ! command -v zellij >/dev/null 2>&1; then',
    "  echo 'zellij missing';",
    '  exit 127;',
    'fi;',
    `zellij delete-session ${sessionName} 2>/dev/null || zellij kill-session ${sessionName} 2>/dev/null`,
  ].join(' ');

  const result = await runRemoteCommand(`bash -lc ${shellQuote(command)}`);
  debugLog('zellij:kill', 'Kill command completed', result);
  if (!result.ok) {
    const combined = `${result.error || ''}\n${result.stderr || ''}\n${result.stdout || ''}`;
    if (/zellij missing|command not found|not installed|zellij/i.test(combined)) {
      return { ok: false, error: 'zellij is not installed on the VPS. Install it with: sudo apt update && sudo apt install zellij' };
    }
    return { ok: false, error: result.error || `Failed to kill session "${name}".` };
  }

  return { ok: true };
}

async function createPTYSession(tabId, runtimeConfig, options = {}) {
  const existing = sessions.get(tabId);
  const preservedRetryCount = options.preserveRetryCount && existing ? existing.retryCount : 0;
  destroySession(tabId);

  const terminalConfig = buildTerminalConfig(runtimeConfig);
  debugLog('pty:create', 'Creating PTY session', {
    tabId,
    preserveRetryCount: !!options.preserveRetryCount,
    preservedRetryCount,
    terminalConfig: {
      ...terminalConfig,
      password: terminalConfig.password ? '<redacted>' : '',
    },
  });
  if (terminalConfig.error) {
    sendPtyError(tabId, terminalConfig.error);
    throw new Error(terminalConfig.error);
  }

  if (terminalConfig.authMode === 'password' && !sshpassAvailable) {
    const message = 'Password authentication requires sshpass.\nInstall with: sudo apt install sshpass\nOr switch to SSH key authentication in Settings.';
    sendPtyError(tabId, message);
    throw new Error(message);
  }

  sendPtyStatus(tabId, 'connecting');

  const session = {
    id: tabId,
    ptyProcess: null,
    status: 'connecting',
    retryCount: preservedRetryCount,
    retryTimer: null,
    reconnectResetTimer: null,
    intentionalDisconnect: false,
    configSnapshot: terminalConfig,
  };
  sessions.set(tabId, session);

  try {
    const binary = resolveSSHBinary(terminalConfig);
    const args = buildSpawnArgs(tabId, terminalConfig);
    const env = buildSpawnEnv(terminalConfig);
    debugLog('pty:create', 'Spawning PTY process', {
      tabId,
      binary,
      args,
      envPreview: { TERM: env.TERM, SSHPASS: env.SSHPASS ? '<set>' : '<unset>' },
    });

    const ptyProcess = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.cwd(),
      env,
    });

    session.ptyProcess = ptyProcess;
    session.status = 'connected';
    session.intentionalDisconnect = false;

    if (session.reconnectResetTimer) {
      clearTimeout(session.reconnectResetTimer);
      session.reconnectResetTimer = null;
    }
    session.reconnectResetTimer = setTimeout(() => {
      const activeSession = sessions.get(tabId);
      if (!activeSession || activeSession !== session) return;
      activeSession.retryCount = 0;
      activeSession.reconnectResetTimer = null;
      debugLog('pty:reconnect', 'Reset retry counter after stable connection window', {
        tabId,
        stableMs: RECONNECT_STABLE_RESET_MS,
      });
    }, RECONNECT_STABLE_RESET_MS);

    sendPtyStatus(tabId, 'connected');

    ptyProcess.onData((data) => {
      debugLog('pty:data', 'Received PTY output', { tabId, length: data ? data.length : 0, data: sanitizeForLog(data, { maxLength: 1200 }) });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { tabId, data });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      debugLog('pty:exit', 'PTY exited', { tabId, exitCode, signal });
      handlePTYExit(tabId, exitCode, signal);
    });
  } catch (err) {
    session.status = 'disconnected';
    debugLog('pty:create', 'Failed to create PTY session', { tabId, error: err.message, stack: err.stack });
    sendPtyError(tabId, err.message);
    throw err;
  }
}

function resizePTY(tabId, cols, rows) {
  const session = sessions.get(tabId);
  if (!session || !session.ptyProcess || session.status !== 'connected') return;
  try {
    session.ptyProcess.resize(cols, rows);
  } catch (_) {
    // Ignore resize races against session teardown.
  }
}

function destroySession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  debugLog('pty:destroy', 'Destroying session', { tabId, status: session.status, retryCount: session.retryCount, intentionalDisconnect: session.intentionalDisconnect });

  if (session.retryTimer) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }
  if (session.reconnectResetTimer) {
    clearTimeout(session.reconnectResetTimer);
    session.reconnectResetTimer = null;
  }
  if (session.ptyProcess) {
    try { session.ptyProcess.kill(); } catch (_) { /* ignore */ }
    session.ptyProcess = null;
  }

  sessions.delete(tabId);
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

function handlePTYExit(tabId, exitCode, signal) {
  const session = sessions.get(tabId);
  if (!session) return;
  debugLog('pty:exit-handler', 'Handling PTY exit', {
    tabId,
    exitCode,
    signal,
    status: session.status,
    retryCount: session.retryCount,
    intentionalDisconnect: session.intentionalDisconnect,
  });

  session.ptyProcess = null;

  if (session.intentionalDisconnect) {
    session.status = 'disconnected';
    sendPtyStatus(tabId, 'disconnected');
    sessions.delete(tabId);
    return;
  }

  if (tabId === 'vps') {
    session.status = 'disconnected';
    sendPtyStatus(tabId, 'disconnected', 'VPS session ended. Use Connect to reconnect.');
    sessions.delete(tabId);
    return;
  }

  if (session.retryCount >= RECONNECT_MAX_ATTEMPTS) {
    session.status = 'failed';
    sendPtyStatus(tabId, 'failed', `Connection failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Click Connect to retry.`);
    return;
  }

  const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, session.retryCount);
  session.retryCount += 1;
  session.status = 'reconnecting';
  debugLog('pty:reconnect', 'Scheduling reconnect attempt', {
    tabId,
    attempt: session.retryCount,
    maxAttempts: RECONNECT_MAX_ATTEMPTS,
    delayMs: delay,
    lastExitCode: exitCode,
    lastSignal: signal,
  });

  sendPtyStatus(tabId, 'reconnecting', `Reconnecting (attempt ${session.retryCount}/${RECONNECT_MAX_ATTEMPTS}) in ${delay / 1000}s...`);

  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    createPTYSession(tabId, { ...config }, { preserveRetryCount: true })
      .catch((err) => {
        debugLog('pty:reconnect', 'Reconnect attempt failed immediately', { tabId, error: err.message, stack: err.stack });
        sendPtyError(tabId, `Reconnect attempt failed: ${err.message}`);
        handlePTYExit(tabId, -1, null);
      });
  }, delay);
}

function checkSshpassAvailable() {
  return new Promise((resolve) => {
    exec('which sshpass', (err) => {
      resolve(!err);
    });
  });
}
