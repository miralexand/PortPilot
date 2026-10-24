'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('portpilot', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  getInterfaces: () => ipcRenderer.invoke('network:get-interfaces'),
  saveRule: (rule) => ipcRenderer.invoke('rules:save', rule),
  deleteRule: (id) => ipcRenderer.invoke('rules:delete', id),
  setRuleEnabled: (id, enabled) => ipcRenderer.invoke('rules:set-enabled', id, enabled),
  startService: () => ipcRenderer.invoke('service:start'),
  stopService: () => ipcRenderer.invoke('service:stop'),
  restartService: () => ipcRenderer.invoke('service:restart'),
  testRule: (id) => ipcRenderer.invoke('service:test-rule', id),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getConfig: () => ipcRenderer.invoke('config:get'),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  showConfigFile: () => ipcRenderer.invoke('app:show-config-file'),
  openHaproxyDir: () => ipcRenderer.invoke('app:open-haproxy-dir'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onStateChanged: (callback) => on('state:changed', callback),
  onLog: (callback) => on('log:appended', callback),
});
