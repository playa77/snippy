// renderer.js — Snippy v1.1.0
// Manages xterm terminals, copy/paste, file manager, gateway health,
// settings panel, and font size controls.

(function () {
  'use strict';

  // =========================================================================
  // STATE
  // =========================================================================
  const tabs = {
    agent: { terminal: null, fitAddon: null, connected: false, cleanupData: null, cleanupStatus: null },
    vps:   { terminal: null, fitAddon: null, connected: false, cleanupData: null, cleanupStatus: null },
  };

  let activeTab = 'agent';
  let currentFontSize = 14;
  let isConnected = false;

  // File manager state
  let fmCurrentPath = '';
  let fmEntries = [];
  let fmSelectedEntry = null;     // { name, isDirectory, size }
  let fmContextTarget = null;     // entry targeted by right-click
  let fmEditorDirty = false;
  let fmEditingPath = '';

  // =========================================================================
  // DOM REFS
  // =========================================================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const inputHost = $('#input-host');
  const inputPort = $('#input-port');
  const inputUser = $('#input-user');
  const inputPass = $('#input-pass');
  const btnConnect = $('#btn-connect');
  const btnDisconnect = $('#btn-disconnect');
  const versionLabel = $('#version-label');

  // =========================================================================
  // INIT
  // =========================================================================
  (async function init() {
    // Version label
    const version = await window.snippy.getVersion();
    versionLabel.textContent = `v${version}`;
    document.title = `Snippy v${version}`;

    // Font size from persisted settings
    currentFontSize = await window.snippy.getFontSize();
    applyFontSize();

    // Populate connect bar from saved settings
    const cfg = await window.snippy.getConfigRaw();
    inputHost.value = cfg.host || '';
    inputPort.value = cfg.port || 22;
    inputUser.value = cfg.username || '';
    inputPass.value = cfg.password || '';

    // Create terminals
    createTerminals();

    // Wire up all event handlers
    wireTabSwitching();
    wireConnectDisconnect();
    wireFontSizeButtons();
    wireSettingsPanel();
    wireGateway();
    wireContextMenu();
    wireFileManager();

    // Listen for auto-reconnect trigger
    window.snippy.onTriggerReconnect((tabId) => connectTab(tabId));
  })();

  // =========================================================================
  // TERMINALS
  // =========================================================================
  function createTerminals() {
    for (const tabId of ['agent', 'vps']) {
      const terminal = new window.Terminal({
        cursorBlink: true,
        fontSize: currentFontSize,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        theme: {
          background: '#0f1117',
          foreground: '#e0e0e6',
          cursor: '#6c8cff',
          selectionBackground: '#6c8cff44',
        },
        allowProposedApi: true,
      });

      const fitAddon = new window.FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      terminal.open($(`#term-${tabId}`));

      tabs[tabId].terminal = terminal;
      tabs[tabId].fitAddon = fitAddon;

      // Keystrokes -> SSH
      terminal.onData((data) => {
        if (tabs[tabId].connected) {
          window.snippy.sendInput(tabId, data);
        }
      });

      // Resize -> SSH
      terminal.onResize(({ cols, rows }) => {
        if (tabs[tabId].connected) {
          window.snippy.resize(tabId, cols, rows);
        }
      });

      // Intercept Ctrl+Shift+C / Ctrl+Shift+V for copy/paste
      terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;

        // Ctrl+Shift+C -> copy selection
        if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
          const selection = terminal.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection);
          }
          return false; // prevent terminal from processing
        }

        // Ctrl+Shift+V -> paste
        if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
          navigator.clipboard.readText().then((text) => {
            if (text && tabs[tabId].connected) {
              window.snippy.sendInput(tabId, text);
            }
          });
          return false;
        }

        return true; // let terminal handle everything else
      });
    }

    // Initial fit
    setTimeout(() => fitActiveTerminal(), 100);
  }

  function fitActiveTerminal() {
    if (activeTab !== 'agent' && activeTab !== 'vps') return;
    const tab = tabs[activeTab];
    if (tab && tab.fitAddon) {
      try { tab.fitAddon.fit(); } catch (_) { /* ignore */ }
    }
  }

  function fitAllTerminals() {
    for (const tabId of ['agent', 'vps']) {
      const tab = tabs[tabId];
      if (tab && tab.fitAddon) {
        try { tab.fitAddon.fit(); } catch (_) { /* ignore */ }
      }
    }
  }

  // =========================================================================
  // TAB SWITCHING
  // =========================================================================
  function wireTabSwitching() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        if (tabId === activeTab) return;

        $$('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        $$('.content-pane').forEach((p) => p.classList.remove('active'));
        $(`#pane-${tabId}`).classList.add('active');

        activeTab = tabId;

        if (tabId === 'agent' || tabId === 'vps') {
          setTimeout(() => {
            fitActiveTerminal();
            if (tabs[tabId].connected) tabs[tabId].terminal.focus();
          }, 50);
        }

        // Auto-connect SFTP and load files when switching to FILES tab
        if (tabId === 'files' && isConnected) {
          initFileManager();
        }
      });
    });
  }

  // =========================================================================
  // CONNECT / DISCONNECT
  // =========================================================================
  function wireConnectDisconnect() {
    btnConnect.addEventListener('click', handleConnect);

    [inputHost, inputPort, inputUser, inputPass].forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleConnect();
      });
    });

    btnDisconnect.addEventListener('click', handleDisconnect);
  }

  async function handleConnect() {
    const host = inputHost.value.trim();
    const port = parseInt(inputPort.value.trim(), 10) || 22;
    const username = inputUser.value.trim();
    const password = inputPass.value;

    if (!host || !username) {
      showOverlay('agent', 'Hostname and username are required.');
      return;
    }

    // Save to config
    await window.snippy.setConfig({ host, port, username, password });

    // Connect both terminal tabs
    connectTab('agent');
    connectTab('vps');

    // Start gateway polling
    window.snippy.gatewayPollStart();

    isConnected = true;
    btnConnect.style.display = 'none';
    btnDisconnect.style.display = '';
  }

  async function connectTab(tabId) {
    const tab = tabs[tabId];

    if (tab.cleanupData) tab.cleanupData();
    if (tab.cleanupStatus) tab.cleanupStatus();

    showOverlay(tabId, 'Connecting...');
    setStatusDot(tabId, 'connecting');

    tab.cleanupData = window.snippy.onData(tabId, (data) => {
      tab.terminal.write(data);
    });

    tab.cleanupStatus = window.snippy.onStatus(tabId, (info) => {
      handleStatusChange(tabId, info);
    });

    const result = await window.snippy.connect(tabId);

    if (result.ok) {
      tab.connected = true;
      hideOverlay(tabId);
      setStatusDot(tabId, 'connected');

      setTimeout(() => {
        fitActiveTerminal();
        const { cols, rows } = tab.terminal;
        window.snippy.resize(tabId, cols, rows);
      }, 100);

      if (tabId === activeTab) tab.terminal.focus();
    } else {
      tab.connected = false;
      showOverlay(tabId, `Connection failed: ${result.error}`);
      setStatusDot(tabId, 'error');
    }
  }

  async function handleDisconnect() {
    for (const tabId of ['agent', 'vps']) {
      await window.snippy.disconnect(tabId);
      tabs[tabId].connected = false;
      if (tabs[tabId].cleanupData) tabs[tabId].cleanupData();
      if (tabs[tabId].cleanupStatus) tabs[tabId].cleanupStatus();
      tabs[tabId].cleanupData = null;
      tabs[tabId].cleanupStatus = null;
      setStatusDot(tabId, 'disconnected');
      showOverlay(tabId, 'Disconnected.');
    }

    window.snippy.gatewayPollStop();
    isConnected = false;

    showOverlay('files', 'Connect to a VPS first to browse files.');

    btnConnect.style.display = '';
    btnDisconnect.style.display = 'none';
  }

  function handleStatusChange(tabId, info) {
    switch (info.status) {
      case 'connecting':
        setStatusDot(tabId, 'connecting');
        break;
      case 'closed':
      case 'ended':
        tabs[tabId].connected = false;
        setStatusDot(tabId, 'disconnected');
        if (tabId !== 'agent') showOverlay(tabId, 'Connection closed.');
        break;
      case 'error':
        tabs[tabId].connected = false;
        setStatusDot(tabId, 'error');
        showOverlay(tabId, `Error: ${info.message}`);
        break;
      case 'reconnecting':
        setStatusDot(tabId, 'connecting');
        showOverlay(tabId, `Reconnecting... attempt ${info.attempt}/${info.maxAttempts}\n(next retry in ${Math.round(info.delayMs / 1000)}s)`);
        break;
      case 'reconnect-failed':
        setStatusDot(tabId, 'error');
        showOverlay(tabId, `Reconnection failed: ${info.message}\nClick Connect to try again.`);
        btnConnect.style.display = '';
        btnDisconnect.style.display = 'none';
        break;
    }
  }

  // =========================================================================
  // FONT SIZE
  // =========================================================================
  function wireFontSizeButtons() {
    $('#btn-font-up').addEventListener('click', () => changeFontSize(1));
    $('#btn-font-down').addEventListener('click', () => changeFontSize(-1));
  }

  function changeFontSize(delta) {
    currentFontSize = Math.max(8, Math.min(32, currentFontSize + delta));
    applyFontSize();
    window.snippy.setFontSize(currentFontSize);
  }

  function applyFontSize() {
    document.documentElement.style.setProperty('--font-size', currentFontSize + 'px');

    for (const tabId of ['agent', 'vps']) {
      const tab = tabs[tabId];
      if (tab && tab.terminal) {
        tab.terminal.options.fontSize = currentFontSize;
      }
    }

    // Re-fit after font size change
    setTimeout(() => {
      fitAllTerminals();
      // Send new dimensions to SSH for connected terminals
      for (const tabId of ['agent', 'vps']) {
        if (tabs[tabId].connected) {
          const { cols, rows } = tabs[tabId].terminal;
          window.snippy.resize(tabId, cols, rows);
        }
      }
    }, 50);
  }

  // =========================================================================
  // SETTINGS PANEL
  // =========================================================================
  function wireSettingsPanel() {
    const overlay = $('#settings-overlay');

    $('#btn-settings').addEventListener('click', async () => {
      const cfg = await window.snippy.getConfigRaw();
      $('#set-host').value = cfg.host || '';
      $('#set-port').value = cfg.port || 22;
      $('#set-username').value = cfg.username || '';
      $('#set-password').value = cfg.password || '';
      $('#set-key-path').value = cfg.privateKeyPath || '';
      $('#set-agent-cmd').value = cfg.agentCommand || 'openclaw tui';
      $('#set-workspace').value = cfg.workspacePath || '~/.openclaw/workspace';
      $('#set-gw-host').value = cfg.gatewayHost || 'localhost';
      $('#set-gw-port').value = cfg.gatewayPort || 18789;
      overlay.classList.add('visible');
    });

    $('#btn-settings-cancel').addEventListener('click', () => {
      overlay.classList.remove('visible');
    });

    $('#btn-settings-save').addEventListener('click', async () => {
      const newConfig = {
        host: $('#set-host').value.trim(),
        port: parseInt($('#set-port').value.trim(), 10) || 22,
        username: $('#set-username').value.trim(),
        password: $('#set-password').value,
        privateKeyPath: $('#set-key-path').value.trim(),
        agentCommand: $('#set-agent-cmd').value.trim() || 'openclaw tui',
        workspacePath: $('#set-workspace').value.trim() || '~/.openclaw/workspace',
        gatewayHost: $('#set-gw-host').value.trim() || 'localhost',
        gatewayPort: parseInt($('#set-gw-port').value.trim(), 10) || 18789,
      };

      await window.snippy.setConfig(newConfig);

      // Update connect bar to reflect new values
      inputHost.value = newConfig.host;
      inputPort.value = newConfig.port;
      inputUser.value = newConfig.username;
      inputPass.value = newConfig.password;

      overlay.classList.remove('visible');
    });

    // Close on clicking backdrop
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('visible');
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) {
        overlay.classList.remove('visible');
      }
    });
  }

  // =========================================================================
  // GATEWAY HEALTH + CONTROL
  // =========================================================================
  function wireGateway() {
    const led = $('#gateway-led');
    const logOverlay = $('#gateway-log-overlay');
    const logOutput = $('#gw-log-output');
    const logTitle = $('#gw-log-title');
    const logStatus = $('#gw-log-status');
    const logClose = $('#gw-log-close');

    let cleanupLog = null;
    let cleanupLogDone = null;

    window.snippy.onGatewayStatus((status) => {
      led.className = 'gateway-led ' + status;
      led.title = 'Gateway: ' + status;
    });

    // Gateway control buttons — confirmation + log window
    $$('.gw-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);

        // Confirmation dialog
        const confirmed = confirm(`${actionLabel} the OpenClaw gateway?`);
        if (!confirmed) return;

        // Open log window
        logOutput.textContent = '';
        logTitle.textContent = `Gateway ${actionLabel}`;
        logStatus.textContent = 'Running...';
        logStatus.className = 'gw-log-status';
        logOverlay.classList.add('visible');

        // Clean up previous listeners
        if (cleanupLog) cleanupLog();
        if (cleanupLogDone) cleanupLogDone();

        // Wire up live log streaming
        cleanupLog = window.snippy.onGatewayLog((data) => {
          logOutput.textContent += data;
          // Auto-scroll to bottom
          logOutput.scrollTop = logOutput.scrollHeight;
        });

        cleanupLogDone = window.snippy.onGatewayLogDone(() => {
          logStatus.textContent = 'Completed';
          logStatus.className = 'gw-log-status done';
        });

        // Fire the command
        const result = await window.snippy.gatewayControl(action);

        if (!result.ok) {
          logOutput.textContent += `\nError: ${result.error}\n`;
          logStatus.textContent = 'Failed';
          logStatus.className = 'gw-log-status done';
        }
      });
    });

    // Close log window
    logClose.addEventListener('click', () => {
      logOverlay.classList.remove('visible');
      if (cleanupLog) { cleanupLog(); cleanupLog = null; }
      if (cleanupLogDone) { cleanupLogDone(); cleanupLogDone = null; }
    });
  }

  // =========================================================================
  // COPY/PASTE CONTEXT MENU
  // =========================================================================
  function wireContextMenu() {
    const menu = $('#context-menu');
    let contextTabId = null;
    let contextInputEl = null; // for input/textarea right-click targets

    // Right-click on terminal panes
    for (const tabId of ['agent', 'vps']) {
      $(`#pane-${tabId}`).addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextTabId = tabId;
        contextInputEl = null;

        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.add('visible');
      });
    }

    // Right-click on any input or textarea anywhere in the app
    document.addEventListener('contextmenu', (e) => {
      const target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        e.preventDefault();
        contextTabId = null;
        contextInputEl = target;

        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.add('visible');
      }
    });

    // Copy
    $('#ctx-copy').addEventListener('click', () => {
      menu.classList.remove('visible');

      if (contextInputEl) {
        // Copy selected text from input/textarea
        const start = contextInputEl.selectionStart;
        const end = contextInputEl.selectionEnd;
        if (start !== end) {
          const selected = contextInputEl.value.substring(start, end);
          navigator.clipboard.writeText(selected);
        }
        return;
      }

      if (contextTabId) {
        const selection = tabs[contextTabId].terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
      }
    });

    // Paste
    $('#ctx-paste').addEventListener('click', () => {
      menu.classList.remove('visible');

      if (contextInputEl) {
        // Paste into input/textarea at cursor position
        navigator.clipboard.readText().then((text) => {
          if (!text) return;
          const el = contextInputEl;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          const before = el.value.substring(0, start);
          const after = el.value.substring(end);
          el.value = before + text + after;
          el.selectionStart = el.selectionEnd = start + text.length;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.focus();
        });
        return;
      }

      if (contextTabId) {
        navigator.clipboard.readText().then((text) => {
          if (text && tabs[contextTabId].connected) {
            window.snippy.sendInput(contextTabId, text);
          }
        });
      }
    });

    // Close menus on click anywhere else
    document.addEventListener('click', () => {
      menu.classList.remove('visible');
      $('#fm-context-menu').classList.remove('visible');
    });
  }

  // =========================================================================
  // FILE MANAGER
  // =========================================================================
  function wireFileManager() {
    $('#fm-btn-up').addEventListener('click', () => {
      if (!fmCurrentPath || fmCurrentPath === '/') return;
      const parent = fmCurrentPath.replace(/\/[^/]+\/?$/, '') || '/';
      navigateTo(parent);
    });

    $('#fm-btn-go').addEventListener('click', () => {
      const path = $('#fm-path').value.trim();
      if (path) navigateTo(path);
    });

    $('#fm-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const path = $('#fm-path').value.trim();
        if (path) navigateTo(path);
      }
    });

    $('#fm-btn-refresh').addEventListener('click', () => {
      if (fmCurrentPath) navigateTo(fmCurrentPath);
    });

    $('#fm-btn-new-file').addEventListener('click', async () => {
      const name = prompt('New file name:');
      if (!name) return;
      const fullPath = fmCurrentPath.replace(/\/$/, '') + '/' + name;
      const result = await window.snippy.sftpWriteFile(fullPath, '');
      if (result.ok) {
        navigateTo(fmCurrentPath);
      } else {
        alert('Failed to create file: ' + result.error);
      }
    });

    $('#fm-btn-new-dir').addEventListener('click', async () => {
      const name = prompt('New directory name:');
      if (!name) return;
      const fullPath = fmCurrentPath.replace(/\/$/, '') + '/' + name;
      const result = await window.snippy.sftpMkdir(fullPath);
      if (result.ok) {
        navigateTo(fmCurrentPath);
      } else {
        alert('Failed to create directory: ' + result.error);
      }
    });

    $('#fm-btn-upload').addEventListener('click', async () => {
      if (!fmCurrentPath) return;
      const result = await window.snippy.sftpUpload(fmCurrentPath);
      if (result.ok) {
        navigateTo(fmCurrentPath);
      } else if (result.error !== 'Cancelled.') {
        alert('Upload failed: ' + result.error);
      }
    });

    // File manager context menu
    const fmMenu = $('#fm-context-menu');

    $('#fmctx-open').addEventListener('click', () => {
      fmMenu.classList.remove('visible');
      if (fmContextTarget) openEntry(fmContextTarget);
    });

    $('#fmctx-rename').addEventListener('click', async () => {
      fmMenu.classList.remove('visible');
      if (!fmContextTarget) return;
      const newName = prompt('Rename to:', fmContextTarget.name);
      if (!newName || newName === fmContextTarget.name) return;
      const oldPath = fmCurrentPath.replace(/\/$/, '') + '/' + fmContextTarget.name;
      const newPath = fmCurrentPath.replace(/\/$/, '') + '/' + newName;
      const result = await window.snippy.sftpRename(oldPath, newPath);
      if (result.ok) {
        navigateTo(fmCurrentPath);
      } else {
        alert('Rename failed: ' + result.error);
      }
    });

    $('#fmctx-download').addEventListener('click', async () => {
      fmMenu.classList.remove('visible');
      if (!fmContextTarget || fmContextTarget.isDirectory) return;
      const remotePath = fmCurrentPath.replace(/\/$/, '') + '/' + fmContextTarget.name;
      const result = await window.snippy.sftpDownload(remotePath, fmContextTarget.name);
      if (!result.ok && result.error !== 'Cancelled.') {
        alert('Download failed: ' + result.error);
      }
    });

    $('#fmctx-delete').addEventListener('click', async () => {
      fmMenu.classList.remove('visible');
      if (!fmContextTarget) return;
      const confirmed = confirm(`Delete "${fmContextTarget.name}"?`);
      if (!confirmed) return;
      const remotePath = fmCurrentPath.replace(/\/$/, '') + '/' + fmContextTarget.name;
      let result;
      if (fmContextTarget.isDirectory) {
        result = await window.snippy.sftpRmdir(remotePath);
      } else {
        result = await window.snippy.sftpDelete(remotePath);
      }
      if (result.ok) {
        navigateTo(fmCurrentPath);
      } else {
        alert('Delete failed: ' + result.error);
      }
    });
  }

  async function initFileManager() {
    hideOverlay('files');

    // Establish SFTP connection
    const connResult = await window.snippy.sftpConnect();
    if (!connResult.ok) {
      showOverlay('files', 'SFTP connection failed: ' + connResult.error);
      return;
    }

    // Resolve workspace path
    const cfg = await window.snippy.getConfigRaw();
    const wpPath = cfg.workspacePath || '~/.openclaw/workspace';
    const resolved = await window.snippy.sftpRealpath(wpPath);

    if (resolved.ok) {
      navigateTo(resolved.path);
    } else {
      // Path might not exist yet — try home directory
      const home = await window.snippy.sftpRealpath('.');
      if (home.ok) {
        navigateTo(home.path);
      } else {
        navigateTo('/');
      }
    }
  }

  async function navigateTo(remotePath) {
    fmCurrentPath = remotePath;
    $('#fm-path').value = remotePath;
    fmSelectedEntry = null;

    // Clear editor
    showEditorPlaceholder('Select a file to view or edit.');

    const result = await window.snippy.sftpList(remotePath);
    if (!result.ok) {
      renderFileList([]);
      showEditorPlaceholder('Error: ' + result.error);
      return;
    }

    fmEntries = result.entries;
    renderFileList(result.entries);
  }

  function renderFileList(entries) {
    const list = $('#fm-list');
    list.innerHTML = '';

    for (const entry of entries) {
      const el = document.createElement('div');
      el.className = 'fm-entry';

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = entry.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;

      el.appendChild(icon);
      el.appendChild(name);

      if (!entry.isDirectory) {
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatBytes(entry.size);
        el.appendChild(size);
      }

      // Click -> open
      el.addEventListener('click', () => {
        // Highlight
        $$('.fm-entry').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');
        fmSelectedEntry = entry;
        openEntry(entry);
      });

      // Right-click -> context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fmContextTarget = entry;

        $$('.fm-entry').forEach((e) => e.classList.remove('selected'));
        el.classList.add('selected');

        const menu = $('#fm-context-menu');
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.add('visible');
      });

      list.appendChild(el);
    }

    if (entries.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'fm-message';
      msg.textContent = 'Empty directory.';
      list.appendChild(msg);
    }
  }

  function openEntry(entry) {
    if (entry.isDirectory) {
      const path = fmCurrentPath.replace(/\/$/, '') + '/' + entry.name;
      navigateTo(path);
      return;
    }

    // Open file for editing
    const fullPath = fmCurrentPath.replace(/\/$/, '') + '/' + entry.name;
    loadFileForEditing(fullPath, entry.name);
  }

  async function loadFileForEditing(fullPath, fileName) {
    const editor = $('#fm-editor');

    // Check file size — don't try to open huge binary files
    const result = await window.snippy.sftpReadFile(fullPath);

    if (!result.ok) {
      showEditorPlaceholder('Could not read file: ' + result.error);
      return;
    }

    fmEditingPath = fullPath;
    fmEditorDirty = false;

    editor.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'fm-editor-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'fm-editor-filename';
    nameEl.textContent = fullPath;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'fm-editor-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const textarea = editor.querySelector('.fm-textarea');
      if (!textarea) return;
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      const writeResult = await window.snippy.sftpWriteFile(fmEditingPath, textarea.value);
      if (writeResult.ok) {
        saveBtn.textContent = 'Saved';
        fmEditorDirty = false;
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
      } else {
        saveBtn.textContent = 'Error';
        alert('Save failed: ' + writeResult.error);
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
      }
      saveBtn.disabled = false;
    });

    header.appendChild(nameEl);
    header.appendChild(saveBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'fm-textarea';
    textarea.value = result.content;
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => { fmEditorDirty = true; });

    editor.appendChild(header);
    editor.appendChild(textarea);
  }

  function showEditorPlaceholder(text) {
    const editor = $('#fm-editor');
    editor.innerHTML = `<div class="fm-placeholder">${escapeHtml(text)}</div>`;
    fmEditingPath = '';
    fmEditorDirty = false;
  }

  // =========================================================================
  // HELPERS
  // =========================================================================
  function showOverlay(tabId, message) {
    const overlay = $(`#overlay-${tabId}`);
    if (!overlay) return;
    overlay.textContent = message;
    overlay.classList.remove('hidden');
  }

  function hideOverlay(tabId) {
    const overlay = $(`#overlay-${tabId}`);
    if (overlay) overlay.classList.add('hidden');
  }

  function setStatusDot(tabId, state) {
    const dot = $(`#status-${tabId}`);
    if (dot) dot.className = 'tab-status ' + state;
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes === undefined || bytes === null) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Refit on window resize
  window.addEventListener('resize', () => {
    fitActiveTerminal();
    if (activeTab === 'agent' || activeTab === 'vps') {
      const tab = tabs[activeTab];
      if (tab && tab.connected) {
        const { cols, rows } = tab.terminal;
        window.snippy.resize(activeTab, cols, rows);
      }
    }
  });
})();
