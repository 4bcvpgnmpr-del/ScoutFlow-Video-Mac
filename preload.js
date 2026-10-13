const { contextBridge, ipcRenderer, webUtils } = require('electron');
let progCb = null;
ipcRenderer.on('ff:progress', (_e, sec) => { if (progCb) progCb(sec); });
contextBridge.exposeInMainWorld('scoutDesktop', {
  platform: process.platform,
  pathFor: (f) => { try { return webUtils.getPathForFile(f) || ''; } catch (_) { return ''; } },
  start: () => ipcRenderer.invoke('ff:start'),
  write: (job, name, data) => ipcRenderer.invoke('ff:write', job, name, data),
  append: (job, name, data, first) => ipcRenderer.invoke('ff:append', job, name, data, first),
  pathOf: (job, name) => ipcRenderer.invoke('ff:pathOf', job, name),
  read: (job, name) => ipcRenderer.invoke('ff:read', job, name),
  del: (job, name) => ipcRenderer.invoke('ff:del', job, name),
  exec: (job, args) => ipcRenderer.invoke('ff:exec', job, args),
  kill: (job) => ipcRenderer.invoke('ff:kill', job),
  onProgress: (cb) => { progCb = cb; },
  chooseDir: () => ipcRenderer.invoke('save:choose'),
  move: (job, name, dir, dest) => ipcRenderer.invoke('ff:move', job, name, dir, dest),
  show: (p) => ipcRenderer.invoke('save:show', p),
  keepAwake: (on) => ipcRenderer.invoke('ff:awake', !!on)
});
