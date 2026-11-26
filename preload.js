const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('farm', {
  onStates: (cb) => ipcRenderer.on('states', (_e, s) => cb(s)),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (c) => ipcRenderer.invoke('config:set', c),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  action: (id, action, value) => ipcRenderer.invoke('printer:action', { id, action, value }),
  sendTrayImages: (imgs) => ipcRenderer.send('tray:images', imgs),
  wakeCamera: (id) => ipcRenderer.invoke('camera:wake', id),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // operações em massa
  bulkRun: (op, ids, params) => ipcRenderer.invoke('bulk:run', { op, ids, params }),
  bulkEligibility: (op, ids) => ipcRenderer.invoke('bulk:eligibility', { op, ids }),
  bulkPickFiles: () => ipcRenderer.invoke('bulk:pickFiles'),
  bulkFilesOn: (ids) => ipcRenderer.invoke('bulk:filesOn', ids),
  bulkJobs: () => ipcRenderer.invoke('bulk:jobs'),
  bulkStop: (id) => ipcRenderer.invoke('bulk:stop', id),
  bulkClear: () => ipcRenderer.invoke('bulk:clear'),
  onJob: (cb) => ipcRenderer.on('bulk:job', (_e, j) => cb(j)),
});
