// Minimal Electron stub: runs main.js in plain Node, exposes IPC for tests.
const EventEmitter = require('events');
const os = require('os'), path = require('path'), fs = require('fs');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'u1farm-'));
const handlers = {}, listeners = {}, sent = [];
const hub = new EventEmitter();
const ipcMain = { handle: (c, fn) => (handlers[c] = fn), on: (c, fn) => (listeners[c] = fn) };
class BrowserWindow extends EventEmitter {
  constructor() { super(); this.webContents = { send: (ch, data) => { sent.push(ch); hub.emit('send', ch, data); }, setWindowOpenHandler() {} }; }
  loadFile() {} isDestroyed() { return false; } isMinimized() { return false; } show() {} focus() {} hide() {} restore() {}
}
class Tray { setToolTip() {} setContextMenu() {} setImage() {} on() {} destroy() {} }
const img = { resize: () => img };
const notifications = [];
class Notification { constructor(o) { this.o = o; } on() {} show() { notifications.push(this.o); } static isSupported() { return true; } }
const dialogState = { files: [] };
module.exports = {
  app: {
    getPath: () => userData, whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true, on() {}, setAppUserModelId() {},
    getLocale: () => 'pt-BR', getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {}, quit() {},
  },
  BrowserWindow, Tray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromPath: () => img, createFromDataURL: () => img },
  ipcMain, Notification, shell: { openExternal() {} },
  dialog: { showOpenDialog: async () => ({ canceled: !dialogState.files.length, filePaths: dialogState.files }) },
  __test: { handlers, listeners, hub, notifications, dialogState, userData },
};
