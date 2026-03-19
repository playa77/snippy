// renderer.js — Snippy v1.1.10
// Manages xterm terminals, copy/paste, file manager, gateway health,
// settings panel, and font size controls.

(function () {
  'use strict';

  // =========================================================================
  // STATE
  // =========================================================================
  const tabs = {
    agent: { terminal: null, fitAddon: null, connected: false },
    vps: { terminal: null, fitAddon: null, connected: false },
  };
  const TERMINAL_TAB_IDS = ['agent', 'vps'];

  let activeTab = 'agent';
  let currentFontSize = 14;
  let isConnected = false;
  let cleanupPtyData = null;
  let cleanupPtyStatus = null;
  let cleanupPtyError = null;

  // File manager state
  let fmCurrentPath = '';
  let fmEntries = [];
  let fmSelectedEntries = new Set();  // Set of entry names currently checked
  let fmContextTarget = null;     // entry targeted by right-click
  let fmEditorDirty = false;
  let fmEditingPath = '';
  let sessionsRefreshInFlight = false;

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
    wireSessionsTab();
    wirePtyEvents();
  })();

  // =========================================================================
  // TERMINALS
  // =========================================================================
  function createTerminals() {
    for (const tabId of TERMINAL_TAB_IDS) {
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
        if (tabs[tabId].connected) window.snippy.ptyInput(tabId, data);
      });

      // Binary data (e.g., mouse reporting) -> PTY
      terminal.onBinary((data) => {
        if (tabs[tabId].connected) window.snippy.ptyInput(tabId, data);
      });

      // Resize -> SSH
      terminal.onResize(({ cols, rows }) => {
        if (tabs[tabId].connected) {
          window.snippy.ptyResize(tabId, cols, rows);
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
              window.snippy.ptyInput(tabId, text);
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

  function wirePtyEvents() {
    if (cleanupPtyData) cleanupPtyData();
    if (cleanupPtyStatus) cleanupPtyStatus();
    if (cleanupPtyError) cleanupPtyError();

    cleanupPtyData = window.snippy.onPtyData(({ tabId, data }) => {
      const tab = tabs[tabId];
      if (!tab || !tab.terminal) return;
      tab.terminal.write(typeof data === 'string' ? data : String(data));
    });

    cleanupPtyStatus = window.snippy.onPtyStatus((payload) => {
      handleStatusChange(payload.tabId, payload);
    });

    cleanupPtyError = window.snippy.onPtyError(({ tabId, message }) => {
      const tab = tabs[tabId];
      if (!tab || !tab.terminal) return;
      tab.terminal.write(`\r\n\x1b[31m[snippy] ${message}\x1b[0m\r\n`);
      setStatusDot(tabId, 'error');
    });
  }

  function fitActiveTerminal() {
    if (activeTab !== 'agent' && activeTab !== 'vps') return;
    const tab = tabs[activeTab];
    if (tab && tab.fitAddon) {
      try { tab.fitAddon.fit(); } catch (_) { /* ignore */ }
    }
  }

  function fitAllTerminals() {
    for (const tabId of TERMINAL_TAB_IDS) {
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

        if (tabId === 'sessions' && isConnected) {
          refreshSessionsList();
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

    if (activeTab === 'sessions') {
      refreshSessionsList();
    }
  }

  async function connectTab(tabId) {
    const tab = tabs[tabId];

    showOverlay(tabId, 'Connecting...');
    setStatusDot(tabId, 'connecting');
    try {
      await window.snippy.ptyConnect(tabId, await window.snippy.getConfigRaw());
      tab.connected = true;
      hideOverlay(tabId);
      setStatusDot(tabId, 'connected');

      setTimeout(() => {
        fitActiveTerminal();
        const { cols, rows } = tab.terminal;
        window.snippy.ptyResize(tabId, cols, rows);
      }, 100);

      if (tabId === activeTab) tab.terminal.focus();
    } catch (err) {
      tab.connected = false;
      showOverlay(tabId, `Connection failed: ${err.message}`);
      setStatusDot(tabId, 'error');
    }
  }

  async function handleDisconnect() {
    for (const tabId of TERMINAL_TAB_IDS) {
      await window.snippy.ptyDisconnect(tabId);
      tabs[tabId].connected = false;
      setStatusDot(tabId, 'disconnected');
      showOverlay(tabId, 'Disconnected.');
    }

    window.snippy.gatewayPollStop();
    isConnected = false;

    showOverlay('files', 'Connect to a VPS first to browse files.');
    setSessionsStatus('Connect to a VPS first to manage zellij sessions.');
    renderSessionsTable([]);

    btnConnect.style.display = '';
    btnDisconnect.style.display = 'none';
  }

  function refreshConnectButtonState() {
    const hasConnectedTerminal = TERMINAL_TAB_IDS.some((tabId) => tabs[tabId].connected);
    isConnected = hasConnectedTerminal;
    btnConnect.style.display = hasConnectedTerminal ? 'none' : '';
    btnDisconnect.style.display = hasConnectedTerminal ? '' : 'none';
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
        refreshConnectButtonState();
        break;
      case 'disconnected':
        tabs[tabId].connected = false;
        setStatusDot(tabId, 'disconnected');
        if (info.message) showOverlay(tabId, info.message);
        refreshConnectButtonState();
        break;
      case 'error':
        tabs[tabId].connected = false;
        setStatusDot(tabId, 'error');
        showOverlay(tabId, `Error: ${info.message}`);
        refreshConnectButtonState();
        break;
      case 'reconnecting':
        setStatusDot(tabId, 'connecting');
        showOverlay(tabId, info.message || 'Reconnecting...');
        break;
      case 'reconnect-failed':
      case 'failed':
        setStatusDot(tabId, 'error');
        showOverlay(tabId, `${info.message || 'Reconnection failed.'}\nClick Connect to try again.`);
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

    for (const tabId of TERMINAL_TAB_IDS) {
      const tab = tabs[tabId];
      if (tab && tab.terminal) {
        tab.terminal.options.fontSize = currentFontSize;
      }
    }

    // Re-fit after font size change
    setTimeout(() => {
      fitAllTerminals();
      // Send new dimensions to SSH for connected terminals
      for (const tabId of TERMINAL_TAB_IDS) {
        if (tabs[tabId].connected) {
          const { cols, rows } = tabs[tabId].terminal;
          window.snippy.ptyResize(tabId, cols, rows);
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
    for (const tabId of TERMINAL_TAB_IDS) {
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
            window.snippy.ptyInput(contextTabId, text);
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

    // Download selected entries as .tar.gz archive — progress modal.
    //
    // ARCHITECTURE: This is fully event-driven. The download IPC call is
    // fire-and-forget (not awaited). All UI state changes come from the
    // 'download-progress' events. The Cancel button calls downloadCancel()
    // fire-and-forget. The cancel handler in main.js sends 'cancelled'
    // immediately. The Close button dismisses the modal.
    //
    // This means even if the download IPC promise never resolves (e.g. a
    // destroyed socket doesn't trigger callbacks), the UI still works.
    $('#fm-btn-download').addEventListener('click', () => {
      if (!fmCurrentPath || fmSelectedEntries.size === 0) return;
      const btn = $('#fm-btn-download');
      btn.disabled = true;

      const overlay = $('#download-overlay');
      const dlStatus = $('#dl-status');
      const dlMessage = $('#dl-message');
      const dlBarFill = $('#dl-bar-fill');
      const dlDetail = $('#dl-detail');
      const dlClose = $('#dl-close');
      const dlCancel = $('#dl-cancel');

      // Guard against double-cleanup
      let cleaned = false;

      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (cleanupProgress) { cleanupProgress(); cleanupProgress = null; }
        dlCancel.removeEventListener('click', onCancel);
        dlClose.removeEventListener('click', onClose);
        dlCancel.textContent = 'Cancel';
        overlay.classList.remove('visible');
        btn.disabled = false;
        updateDownloadBtn();
      }

      // Reset modal state
      dlStatus.textContent = 'Preparing...';
      dlStatus.className = 'dl-status';
      dlMessage.textContent = 'Preparing...';
      dlBarFill.style.width = '0%';
      dlBarFill.classList.add('indeterminate');
      dlDetail.textContent = '';
      dlClose.disabled = true;
      dlCancel.classList.remove('hidden');
      dlCancel.disabled = false;
      dlCancel.textContent = 'Cancel';
      overlay.classList.add('visible');

      // Wire cancel — fire-and-forget, no await
      let cancelClicked = false;
      function onCancel() {
        if (cancelClicked) return;
        cancelClicked = true;
        dlCancel.disabled = true;
        dlCancel.textContent = 'Cancelling...';
        window.snippy.downloadCancel().catch(() => {});
        // Do NOT await — the 'cancelled' progress event updates the UI
      }
      dlCancel.addEventListener('click', onCancel);

      // Wire close — dismisses modal
      function onClose() {
        cleanup();
      }
      dlClose.addEventListener('click', onClose);

      // Listen for progress events from main process
      let cleanupProgress = window.snippy.onDownloadProgress((data) => {
        switch (data.phase) {
          case 'archiving':
            dlStatus.textContent = 'Archiving...';
            dlStatus.className = 'dl-status';
            dlMessage.textContent = data.message;
            dlBarFill.classList.add('indeterminate');
            dlBarFill.style.width = '30%';
            dlDetail.textContent = '';
            break;

          case 'stat':
            dlMessage.textContent = data.message;
            break;

          case 'downloading':
            dlStatus.textContent = 'Downloading...';
            dlStatus.className = 'dl-status';
            dlBarFill.classList.remove('indeterminate');
            dlBarFill.style.width = (data.percent || 0) + '%';
            dlMessage.textContent = data.message;
            if (data.totalBytes > 0) {
              dlDetail.textContent = formatBytes(data.bytesTransferred || 0) + ' / ' + formatBytes(data.totalBytes) + '  (' + data.percent + '%)';
            }
            break;

          case 'cleanup':
            dlStatus.textContent = 'Cleaning up...';
            dlCancel.classList.add('hidden');
            dlBarFill.style.width = '100%';
            dlMessage.textContent = data.message;
            dlDetail.textContent = '';
            break;

          // Terminal states — enable Close, hide Cancel
          case 'done':
            dlStatus.textContent = 'Complete';
            dlStatus.className = 'dl-status done';
            dlCancel.classList.add('hidden');
            dlBarFill.style.width = '100%';
            dlMessage.textContent = data.message;
            dlDetail.textContent = '';
            dlClose.disabled = false;
            break;

          case 'cancelled':
            dlStatus.textContent = 'Cancelled';
            dlStatus.className = 'dl-status error';
            dlCancel.classList.add('hidden');
            dlBarFill.classList.remove('indeterminate');
            dlBarFill.style.width = '0%';
            dlMessage.textContent = data.message;
            dlDetail.textContent = '';
            dlClose.disabled = false;
            break;

          case 'error':
            dlStatus.textContent = 'Failed';
            dlStatus.className = 'dl-status error';
            dlCancel.classList.add('hidden');
            dlBarFill.classList.remove('indeterminate');
            dlBarFill.style.width = '0%';
            dlMessage.textContent = data.message;
            dlDetail.textContent = '';
            dlClose.disabled = false;
            break;
        }
      });

      // Fire-and-forget the download IPC. The ONLY case where we use the
      // return value is save-dialog-cancel (user hit Cancel in the OS file
      // picker before any progress events started).
      const entryNames = Array.from(fmSelectedEntries);
      window.snippy.sftpDownloadArchive(fmCurrentPath, entryNames).then((result) => {
        if (!result.ok && result.error === 'Cancelled.' && !cancelClicked) {
          // Save dialog was cancelled — no progress modal needed
          cleanup();
          return;
        }
        // For all other completions (success/error/cancel), the progress
        // listener already updated the UI. Enable Close as a safety net
        // in case a progress event was missed.
        dlClose.disabled = false;
        dlCancel.classList.add('hidden');
      }).catch(() => {
        // IPC error — enable Close so the user isn't stuck
        dlClose.disabled = false;
        dlCancel.classList.add('hidden');
        dlStatus.textContent = 'Failed';
        dlStatus.className = 'dl-status error';
        dlMessage.textContent = 'IPC error — download process may have crashed.';
      });
    });

    // Select All
    $('#fm-btn-select-all').addEventListener('click', () => {
      fmSelectedEntries.clear();
      for (const entry of fmEntries) {
        fmSelectedEntries.add(entry.name);
      }
      $$('.fm-entry .fm-checkbox').forEach((cb) => { cb.checked = true; });
      updateEntryHighlights();
      updateDownloadBtn();
    });

    // Select None
    $('#fm-btn-select-none').addEventListener('click', () => {
      fmSelectedEntries.clear();
      $$('.fm-entry .fm-checkbox').forEach((cb) => { cb.checked = false; });
      updateEntryHighlights();
      updateDownloadBtn();
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

  // =========================================================================
  // ZELLIJ SESSIONS TAB
  // =========================================================================
  function wireSessionsTab() {
    const refreshBtn = $('#sessions-btn-refresh');
    const createBtn = $('#sessions-btn-create-openclaw');
    const killBtn = $('#sessions-btn-kill');

    refreshBtn.addEventListener('click', () => refreshSessionsList());
    createBtn.addEventListener('click', async () => {
      if (!isConnected) {
        setSessionsStatus('Connect to a VPS first to manage zellij sessions.');
        return;
      }

      setSessionsStatus('Ensuring openclaw session exists...');
      const result = await window.snippy.zellijCreateOpenClaw();
      if (!result.ok) {
        setSessionsStatus(result.error || 'Failed to create openclaw session.');
        return;
      }

      setSessionsStatus('OpenClaw session is ready.');
      refreshSessionsList();
    });

    killBtn.addEventListener('click', async () => {
      if (!isConnected) {
        setSessionsStatus('Connect to a VPS first to manage zellij sessions.');
        return;
      }

      const selected = getSelectedSessionName();
      if (!selected) {
        setSessionsStatus('Select a session to kill.');
        return;
      }

      const confirmed = confirm(`Kill zellij session "${selected}"?`);
      if (!confirmed) return;

      const result = await window.snippy.zellijKillSession(selected);
      if (!result.ok) {
        setSessionsStatus(result.error || `Failed to kill session "${selected}".`);
        return;
      }

      setSessionsStatus(`Killed session "${selected}".`);
      refreshSessionsList();
    });
  }

  async function refreshSessionsList() {
    if (!isConnected) {
      setSessionsStatus('Connect to a VPS first to manage zellij sessions.');
      renderSessionsTable([]);
      return;
    }
    if (sessionsRefreshInFlight) return;

    sessionsRefreshInFlight = true;
    setSessionsStatus('Loading zellij sessions...');
    setSessionsControlsEnabled(false);

    try {
      const result = await window.snippy.zellijListSessions();
      if (!result.ok) {
        renderSessionsTable([]);
        setSessionsStatus(result.error || 'Failed to load zellij sessions.');
        return;
      }

      renderSessionsTable(result.sessions || []);
      const count = (result.sessions || []).length;
      setSessionsStatus(count === 0 ? 'No active zellij sessions found.' : `Loaded ${count} active zellij session${count === 1 ? '' : 's'}.`);
    } finally {
      sessionsRefreshInFlight = false;
      setSessionsControlsEnabled(true);
    }
  }

  function renderSessionsTable(sessions) {
    const tbody = $('#sessions-table-body');
    tbody.innerHTML = '';

    if (!sessions.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'sessions-empty';
      cell.textContent = 'No sessions.';
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    for (const session of sessions) {
      const row = document.createElement('tr');
      row.dataset.session = session.name;

      row.innerHTML = `
        <td>${escapeHtml(session.name || '')}</td>
        <td>${escapeHtml(session.created || 'Unknown')}</td>
        <td>${escapeHtml(session.age || 'Unknown')}</td>
        <td>${Number.isFinite(session.clients) ? session.clients : 0}</td>
      `;

      row.addEventListener('click', () => {
        $('#sessions-table-body tr.selected')?.classList.remove('selected');
        row.classList.add('selected');
      });

      tbody.appendChild(row);
    }
  }

  function setSessionsStatus(message) {
    $('#sessions-status').textContent = message || '';
  }

  function setSessionsControlsEnabled(enabled) {
    $('#sessions-btn-refresh').disabled = !enabled;
    $('#sessions-btn-create-openclaw').disabled = !enabled;
    $('#sessions-btn-kill').disabled = !enabled;
  }

  function getSelectedSessionName() {
    const selectedRow = $('#sessions-table-body tr.selected');
    return selectedRow ? selectedRow.dataset.session : '';
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
    fmSelectedEntries.clear();
    updateDownloadBtn();

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

      // Checkbox for multi-select
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'fm-checkbox';
      cb.checked = fmSelectedEntries.has(entry.name);
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cb.checked) {
          fmSelectedEntries.add(entry.name);
        } else {
          fmSelectedEntries.delete(entry.name);
        }
        updateEntryHighlights();
        updateDownloadBtn();
      });

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = entry.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;

      el.appendChild(cb);
      el.appendChild(icon);
      el.appendChild(name);

      if (!entry.isDirectory) {
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatBytes(entry.size);
        el.appendChild(size);
      }

      // Single click -> toggle checkbox selection
      el.addEventListener('click', (e) => {
        if (e.target === cb) return; // checkbox handles itself
        cb.checked = !cb.checked;
        if (cb.checked) {
          fmSelectedEntries.add(entry.name);
        } else {
          fmSelectedEntries.delete(entry.name);
        }
        updateEntryHighlights();
        updateDownloadBtn();
      });

      // Double click -> open (navigate into dir / edit file)
      el.addEventListener('dblclick', (e) => {
        if (e.target === cb) return;
        openEntry(entry);
      });

      // Right-click -> context menu
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fmContextTarget = entry;

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

    updateEntryHighlights();
  }

  // Sync .selected class with the current checkbox state
  function updateEntryHighlights() {
    $$('.fm-entry').forEach((el) => {
      const cb = el.querySelector('.fm-checkbox');
      if (cb && cb.checked) {
        el.classList.add('selected');
      } else {
        el.classList.remove('selected');
      }
    });
  }

  // Enable/disable the toolbar Download button based on selection count
  function updateDownloadBtn() {
    const btn = $('#fm-btn-download');
    if (!btn) return;
    const count = fmSelectedEntries.size;
    btn.disabled = count === 0;
    btn.textContent = count > 0 ? `Download (${count})` : 'Download';
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
        window.snippy.ptyResize(activeTab, cols, rows);
      }
    }
  });
})();
