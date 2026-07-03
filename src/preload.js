'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('supa', {
  onInit: (fn) => ipcRenderer.on('ui:init', (_e, p) => fn(p)),
  onUsage: (fn) => ipcRenderer.on('usage:update', (_e, p) => fn(p)),
  onError: (fn) => ipcRenderer.on('usage:error', (_e, p) => fn(p)),
  onLoading: (fn) => ipcRenderer.on('usage:loading', (_e, p) => fn(p)),
  onBreaker: (fn) => ipcRenderer.on('usage:breaker', (_e, p) => fn(p)),
  refresh: () => ipcRenderer.send('ui:refresh'),
  openSettings: () => ipcRenderer.send('ui:openSettings'),
  hide: () => ipcRenderer.send('ui:hide'),
  setHeight: (h) => ipcRenderer.send('ui:height', h),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (next) => ipcRenderer.invoke('settings:set', next),
});
