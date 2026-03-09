// renderer.js — Snippy v0.1.0
// Manages xterm.js terminal instances and wires them to the SSH IPC bridge.

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const tabs = {
    agent: {
      terminal: null,
      fitAddon: null,
      connected: false,
      cleanupData: null,
      cleanupStatus: null,
    },
    vps: {
      terminal: null,
      fitAddon: null,
      connected: false,
      cleanupData: null,
      cleanupStatus: null,
    },
  };

  let activeTab = 'agent';

  // -------------------------------------------------------------------------
  // DOM references
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const inputHost = $('#input-host');
  const inputPort = $('#input-port');
  const inputUser = $('#input-user');
  const inputPass = $('#input-pass');
  const btnConnect = $('#btn-connect');
  const btnDisconnect = $('#btn-disconnect');
  const versionLabel = $('#version-label');

  // -------------------------------------------------------------------------
  // Init: set version label
  // -------------------------------------------------------------------------
  window.snippy.getVersion().then((v) => {
    versionLabel.textContent = `v${v}`;
    document.title = `Snippy v${v}`;
  });

  // -------------------------------------------------------------------------
  // Create xterm.js terminals for both tabs
  // -------------------------------------------------------------------------
  for (const tabId of ['agent', 'vps']) {
    const terminal = new window.Terminal({
      cursorBlink: true,
      fontSize: 14,
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

    const container = $(`#term-${tabId}`);
    terminal.open(container);

    tabs[tabId].terminal = terminal;
    tabs[tabId].fitAddon = fitAddon;

    // Wire keystrokes to SSH
    terminal.onData((data) => {
      if (tabs[tabId].connected) {
        window.snippy.sendInput(tabId, data);
      }
    });

    // Notify main process on terminal resize
    terminal.onResize(({ cols, rows }) => {
      if (tabs[tabId].connected) {
        window.snippy.resize(tabId, cols, rows);
      }
    });
  }

  // Initial fit for the active pane
  setTimeout(() => fitActiveTerminal(), 100);

  // -------------------------------------------------------------------------
  // Tab switching
  // -------------------------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      if (tabId === activeTab) return;

      // Update button states
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      // Update pane visibility
      document.querySelectorAll('.terminal-pane').forEach((p) => p.classList.remove('active'));
      $(`#pane-${tabId}`).classList.add('active');

      activeTab = tabId;

      // Refit the newly visible terminal
      setTimeout(() => fitActiveTerminal(), 50);
    });
  });

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------
  btnConnect.addEventListener('click', handleConnect);

  // Allow pressing Enter in any input field to connect
  [inputHost, inputPort, inputUser, inputPass].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleConnect();
    });
  });

  async function handleConnect() {
    const host = inputHost.value.trim();
    const port = parseInt(inputPort.value.trim(), 10) || 22;
    const username = inputUser.value.trim();
    const password = inputPass.value;

    if (!host || !username) {
      showOverlay('agent', 'Hostname and username are required.');
      return;
    }

    // Push config to main process
    await window.snippy.setConfig({ host, port, username, password });

    // Connect both tabs
    connectTab('agent');
    connectTab('vps');

    // Toggle buttons
    btnConnect.style.display = 'none';
    btnDisconnect.style.display = '';
  }

  async function connectTab(tabId) {
    const tab = tabs[tabId];

    // Clean up previous listeners
    if (tab.cleanupData) tab.cleanupData();
    if (tab.cleanupStatus) tab.cleanupStatus();

    // Show connecting state
    showOverlay(tabId, 'Connecting...');
    setStatusDot(tabId, 'connecting');

    // Listen for SSH data
    tab.cleanupData = window.snippy.onData(tabId, (data) => {
      tab.terminal.write(data);
    });

    // Listen for status changes
    tab.cleanupStatus = window.snippy.onStatus(tabId, (info) => {
      handleStatusChange(tabId, info);
    });

    // Initiate connection
    const result = await window.snippy.connect(tabId);

    if (result.ok) {
      tab.connected = true;
      hideOverlay(tabId);
      setStatusDot(tabId, 'connected');

      // Fit terminal and send initial size
      setTimeout(() => {
        fitActiveTerminal();
        const { cols, rows } = tab.terminal;
        window.snippy.resize(tabId, cols, rows);
      }, 100);

      // Focus the terminal if it's the active tab
      if (tabId === activeTab) {
        tab.terminal.focus();
      }
    } else {
      tab.connected = false;
      showOverlay(tabId, `Connection failed: ${result.error}`);
      setStatusDot(tabId, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------
  btnDisconnect.addEventListener('click', async () => {
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

    btnConnect.style.display = '';
    btnDisconnect.style.display = 'none';
  });

  // -------------------------------------------------------------------------
  // Handle SSH status events
  // -------------------------------------------------------------------------
  function handleStatusChange(tabId, info) {
    switch (info.status) {
      case 'connecting':
        setStatusDot(tabId, 'connecting');
        break;
      case 'closed':
      case 'ended':
        tabs[tabId].connected = false;
        setStatusDot(tabId, 'disconnected');
        if (tabId !== 'agent') {
          // VPS doesn't auto-reconnect
          showOverlay(tabId, 'Connection closed.');
        }
        break;
      case 'error':
        tabs[tabId].connected = false;
        setStatusDot(tabId, 'error');
        showOverlay(tabId, `Error: ${info.message}`);
        break;
      case 'reconnecting':
        setStatusDot(tabId, 'connecting');
        showOverlay(
          tabId,
          `Reconnecting... attempt ${info.attempt}/${info.maxAttempts}\n` +
          `(next retry in ${Math.round(info.delayMs / 1000)}s)`
        );
        break;
      case 'reconnect-failed':
        setStatusDot(tabId, 'error');
        showOverlay(tabId, `Reconnection failed: ${info.message}\nClick Connect to try again.`);
        btnConnect.style.display = '';
        btnDisconnect.style.display = 'none';
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Handle auto-reconnect trigger from main process
  // -------------------------------------------------------------------------
  window.snippy.onTriggerReconnect((tabId) => {
    connectTab(tabId);
  });

  // -------------------------------------------------------------------------
  // Overlay helpers
  // -------------------------------------------------------------------------
  function showOverlay(tabId, message) {
    const overlay = $(`#overlay-${tabId}`);
    overlay.textContent = message;
    overlay.classList.remove('hidden');
  }

  function hideOverlay(tabId) {
    $(`#overlay-${tabId}`).classList.add('hidden');
  }

  // -------------------------------------------------------------------------
  // Status dot helper
  // -------------------------------------------------------------------------
  function setStatusDot(tabId, state) {
    const dot = $(`#status-${tabId}`);
    dot.className = 'tab-status ' + state;
  }

  // -------------------------------------------------------------------------
  // Fit terminal to pane
  // -------------------------------------------------------------------------
  function fitActiveTerminal() {
    const tab = tabs[activeTab];
    if (tab && tab.fitAddon) {
      try {
        tab.fitAddon.fit();
      } catch (_) {
        // Fit can fail if terminal isn't visible yet; safe to ignore
      }
    }
  }

  // Refit on window resize
  window.addEventListener('resize', () => {
    fitActiveTerminal();
    // Also send new dimensions to SSH
    const tab = tabs[activeTab];
    if (tab && tab.connected) {
      const { cols, rows } = tab.terminal;
      window.snippy.resize(activeTab, cols, rows);
    }
  });
})();
