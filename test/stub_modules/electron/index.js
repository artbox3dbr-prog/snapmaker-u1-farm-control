// Minimal Electron stub: runs main.js in plain Node, exposes IPC for tests.
const EventEmitter = require('events');
const os = require('os'), path = require('path'), fs = require('fs');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'u1farm-'));
const handlers = {}, listeners = {}, sent = [];
const hub = new EventEmitter();
const ipcMain = { handle: (c, fn) => (handlers[c] = fn), on: (c, fn) => (listeners[c] = fn) };
class BrowserWindow extends EventEmitter {
  constructor() { super(); this.webContents = { send: (ch, data) => { sent.push(ch); hub.emit('send', ch, data); }, setWindowOpenHandler() {}, on() {}, toggleDevTools() {} }; }
  loadFile() {} isDestroyed() { return false; } isMinimized() { return false; } show() {} focus() {} hide() {} restore() {}
}
class Tray { setToolTip() {} setContextMenu() {} setImage() {} on() {} destroy() {} }
const img = { resize: () => img };
const notifications = [];
class Notification { constructor(o) { this.o = o; } on() {} show() { notifications.push(this.o); } static isSupported() { return true; } }
const dialogState = { files: [] };
// net falso (imita o ClientRequest do Electron sobre o http do Node) para exercitar o caminho do app
const http = require('http');
function fakeRequest({ method, url }) {
  const ee = new EventEmitter();
  const headers = {}, chunks = [];
  let total = 0;
  ee.setHeader = (k, v) => (headers[k] = v);
  ee.write = (c) => { chunks.push(Buffer.from(c)); total += c.length; };
  ee.getUploadProgress = () => ({ active: true, started: true, current: total, total });
  ee.abort = () => {};
  ee.end = (c) => {
    if (c) ee.write(c);
    const body = Buffer.concat(chunks);
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, 'Content-Length': body.length } }, (res) => ee.emit('response', res));
    r.on('error', (e) => ee.emit('error', e));
    r.end(body);
  };
  return ee;
}
const net = process.env.NONET ? undefined : { fetch: (u, o) => fetch(u, o), request: fakeRequest };
module.exports = {
  app: {
    getPath: () => userData, whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true, on() {}, setAppUserModelId() {},
    getVersion: () => require('../../../package.json').version, getLocale: () => 'pt-BR', getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {}, quit() {},
  },
  BrowserWindow, Tray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromPath: () => img, createFromDataURL: () => img },
  ipcMain, Notification, net, shell: { openExternal() {} },
  dialog: { showOpenDialog: async () => ({ canceled: !dialogState.files.length, filePaths: dialogState.files }) },
  __test: { handlers, listeners, hub, notifications, dialogState, userData },
};
