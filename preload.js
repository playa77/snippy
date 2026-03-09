// preload.js — Snippy v1.0.1
// Secure IPC bridge between main and renderer processes.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippy', {
  // -------------------------------------------------------------------------
  // App metadata
  // -------------------------------------------------------------------------
  getVersion: () => ipcRenderer.invoke('get-version'),

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  getConfig: () => ipcRenderer.invoke('get-config'),
  getConfigRaw: () => ipcRenderer.invoke('get-config-raw'),
  setConfig: (config) => ipcRenderer.invoke('set-config', config),

  // -------------------------------------------------------------------------
  // Font size
  // -------------------------------------------------------------------------
  getFontSize: () => ipcRenderer.invoke('get-font-size'),
  setFontSize: (size) => ipcRenderer.invoke('set-font-size', size),

  // -------------------------------------------------------------------------
  // SSH session management
  // -------------------------------------------------------------------------
  connect: (tabId) => ipcRenderer.invoke('ssh-connect', tabId),
  disconnect: (tabId) => ipcRenderer.invoke('ssh-disconnect', tabId),
  sendInput: (tabId, data) => ipcRenderer.send('ssh-input', tabId, data),
  resize: (tabId, cols, rows) => ipcRenderer.send('ssh-resize', tabId, cols, rows),

  onData: (tabId, callback) => {
    const channel = `ssh-data-${tabId}`;
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
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

  // -------------------------------------------------------------------------
  // SFTP file manager
  // -------------------------------------------------------------------------
  sftpConnect: () => ipcRenderer.invoke('sftp-connect'),
  sftpList: (remotePath) => ipcRenderer.invoke('sftp-list', remotePath),
  sftpReadFile: (remotePath) => ipcRenderer.invoke('sftp-read-file', remotePath),
  sftpWriteFile: (remotePath, content) => ipcRenderer.invoke('sftp-write-file', remotePath, content),
  sftpMkdir: (remotePath) => ipcRenderer.invoke('sftp-mkdir', remotePath),
  sftpRename: (oldPath, newPath) => ipcRenderer.invoke('sftp-rename', oldPath, newPath),
  sftpDelete: (remotePath) => ipcRenderer.invoke('sftp-delete', remotePath),
  sftpRmdir: (remotePath) => ipcRenderer.invoke('sftp-rmdir', remotePath),
  sftpDownload: (remotePath, suggestedName) => ipcRenderer.invoke('sftp-download', remotePath, suggestedName),
  sftpUpload: (remoteDir) => ipcRenderer.invoke('sftp-upload', remoteDir),
  sftpRealpath: (remotePath) => ipcRenderer.invoke('sftp-realpath', remotePath),

  // -------------------------------------------------------------------------
  // Gateway health
  // -------------------------------------------------------------------------
  gatewayPollStart: () => ipcRenderer.invoke('gateway-poll-start'),
  gatewayPollStop: () => ipcRenderer.invoke('gateway-poll-stop'),
  gatewayControl: (action) => ipcRenderer.invoke('gateway-control', action),

  onGatewayStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('gateway-status', handler);
    return () => ipcRenderer.removeListener('gateway-status', handler);
  },
});
