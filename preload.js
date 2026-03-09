// preload.js — Snippy v0.1.0
// Exposes a safe IPC bridge to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippy', {
  // ---------------------------------------------------------------------------
  // App metadata
  // ---------------------------------------------------------------------------
  getVersion: () => ipcRenderer.invoke('get-version'),

  // ---------------------------------------------------------------------------
  // Config (temporary API until settings UI in v0.5.0)
  // ---------------------------------------------------------------------------
  setConfig: (config) => ipcRenderer.invoke('set-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // ---------------------------------------------------------------------------
  // SSH session management
  // ---------------------------------------------------------------------------
  connect: (tabId) => ipcRenderer.invoke('ssh-connect', tabId),
  disconnect: (tabId) => ipcRenderer.invoke('ssh-disconnect', tabId),
  sendInput: (tabId, data) => ipcRenderer.send('ssh-input', tabId, data),
  resize: (tabId, cols, rows) => ipcRenderer.send('ssh-resize', tabId, cols, rows),

  // ---------------------------------------------------------------------------
  // SSH event listeners
  // ---------------------------------------------------------------------------
  onData: (tabId, callback) => {
    const channel = `ssh-data-${tabId}`;
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener(channel, handler);
  },

  onStatus: (tabId, callback) => {
    const channel = `ssh-status-${tabId}`;
    const handler = (_event, status) => callback(status);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  onTriggerReconnect: (callback) => {
    const handler = (_event, tabId) => callback(tabId);
    ipcRenderer.on('ssh-trigger-reconnect', handler);
    return () => ipcRenderer.removeListener('ssh-trigger-reconnect', handler);
  },
});
