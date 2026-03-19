// preload.js — Snippy v1.1.9
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
  // PTY terminal session management
  // -------------------------------------------------------------------------
  ptyConnect: (tabId, cfg) => ipcRenderer.invoke('pty:connect', { tabId, config: cfg }),
  ptyDisconnect: (tabId) => ipcRenderer.invoke('pty:disconnect', { tabId }),
  ptyRetry: (tabId) => ipcRenderer.invoke('pty:retry', { tabId }),
  ptyInput: (tabId, data) => ipcRenderer.send('pty:input', { tabId, data }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  zellijListSessions: () => ipcRenderer.invoke('zellij:list-sessions'),
  zellijKillSession: (name) => ipcRenderer.invoke('zellij:kill-session', { name }),
  zellijCreateOpenClaw: () => ipcRenderer.invoke('zellij:create-openclaw'),

  onPtyData: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },

  onPtyStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pty:status', handler);
    return () => ipcRenderer.removeListener('pty:status', handler);
  },

  onPtyError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('pty:error', handler);
    return () => ipcRenderer.removeListener('pty:error', handler);
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
  sftpDownloadArchive: (remoteDirPath, entryNames) => ipcRenderer.invoke('sftp-download-archive', remoteDirPath, entryNames),
  downloadCancel: () => ipcRenderer.invoke('download-cancel'),
  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
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

  onGatewayLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('gateway-log', handler);
    return () => ipcRenderer.removeListener('gateway-log', handler);
  },

  onGatewayLogDone: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('gateway-log-done', handler);
    return () => ipcRenderer.removeListener('gateway-log-done', handler);
  },
});
