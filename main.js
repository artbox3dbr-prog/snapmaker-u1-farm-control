// U1 Farm Control — Electron ana süreç
// Yazıcıları Moonraker API üzerinden yoklar, her yazıcı için sistem tepsisinde
// yüzde gösteren dinamik bir ikon tutar.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const I18N = require('./renderer/i18n.js');
const bulk = require('./lib/bulk.js');

const POLL_MS = 2000;
const DEFAULT_CONFIG = {
  printers: [], // ilk açılışta Ayarlar'dan eklenir
  trayPerPrinter: true,
  notifications: true,
  startMinimized: false,
  stagger: 20,        // seconds between print starts in a bulk print (avoids power spikes)
  uploadParallel: 4,  // simultaneous uploads in a bulk send
};

let win = null;
let trays = {};          // printerId -> Tray
let mainTray = null;     // trayPerPrinter=false iken tek tepsi
let config = null;
let states = {};         // printerId -> son durum
let metaCache = {};      // host|filename -> metadata
let quitting = false;
let startHidden = false;

const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...c };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(config, null, 2));
}

// ---------------- Moonraker ----------------
// Toda a comunicação passa pelo lib/bulk.js (net do Electron com reserva no fetch do Node)
const api = (host, pathName, opts = {}) => bulk.api(host, pathName, opts);

const QUERY_OBJECTS = [
  'print_stats', 'display_status', 'virtual_sdcard', 'heater_bed', 'extruder', 'extruder1', 'extruder2', 'extruder3',
  'toolhead', 'fan', 'webhooks', 'idle_timeout', 'gcode_move', 'print_task_config', 'pause_resume',
  'temperature_sensor cavity', 'led cavity_led', 'fan_generic cavity_fan', 'system_stats', 'motion_report',
  'filament_feed left', 'filament_feed right', 'machine_state_manager',
  'filament_motion_sensor e0_filament', 'filament_motion_sensor e1_filament', 'filament_motion_sensor e2_filament', 'filament_motion_sensor e3_filament',
];
const QUERY = '/printer/objects/query?' + QUERY_OBJECTS.map(encodeURIComponent).join('&');

async function getMeta(host, filename) {
  if (!filename) return null;
  const key = host + '|' + filename;
  if (metaCache[key]) return metaCache[key];
  try {
    const m = await api(host, '/server/files/metadata?filename=' + encodeURIComponent(filename));
    metaCache[key] = m;
    return m;
  } catch {
    return null;
  }
}

async function pollPrinter(p) {
  const prev = states[p.id];
  let s;
  try {
    const r = await api(p.host, QUERY);
    const st = r.status;
    const ps = st.print_stats || {};
    const meta = await getMeta(p.host, ps.filename);
    s = { online: true, klippy: st.webhooks?.state || 'unknown', status: st, meta, ts: Date.now() };
  } catch (e) {
    // Klippy kapalı olabilir ama Moonraker açık olabilir
    let klippy = 'offline';
    try {
      const info = await api(p.host, '/server/info', { timeout: 2500 });
      klippy = info.klippy_state || 'offline';
    } catch {}
    s = { online: klippy !== 'offline', klippy, error: String(e.message || e), status: null, meta: null, ts: Date.now() };
  }
  states[p.id] = s;
  handleTransitions(p, prev, s);
  return s;
}

function stateOf(s) {
  if (!s || !s.online) return 'offline';
  if (s.klippy !== 'ready') return 'error';
  return s.status?.print_stats?.state || 'standby';
}

function progressOf(s) {
  const st = s?.status;
  if (!st) return 0;
  // Snapmaker: virtual_sdcard.progress dosya pozisyonu tabanlı, display_status M73 tabanlı
  const d = st.display_status?.progress;
  const v = st.virtual_sdcard?.progress;
  const p = (typeof d === 'number' && d > 0) ? d : (v || 0);
  return Math.max(0, Math.min(1, p));
}

// Dil: config.language ('auto' → sistem dili)
let L = I18N.make('en');
const t = (k, v) => L.t(k, v);
function applyLanguage() { L = I18N.make(I18N.resolve(config.language, app.getLocale())); }
const stateName = (st) => t('state.' + st);

function handleTransitions(p, prev, s) {
  if (!config.notifications || !prev) return;
  const a = stateOf(prev), b = stateOf(s);
  if (a === b) return;
  const file = s.status?.print_stats?.filename || prev.status?.print_stats?.filename || '';
  let title = null, body = file;
  if (b === 'complete' && a === 'printing') title = t('n.complete', { name: p.name });
  else if (b === 'error') title = t('n.error', { name: p.name }), body = s.status?.print_stats?.message || s.error || file;
  else if (b === 'paused') title = t('n.paused', { name: p.name });
  else if (b === 'cancelled') title = t('n.cancelled', { name: p.name });
  else if (b === 'offline') title = t('n.offline', { name: p.name }), body = p.host;
  else if (b === 'printing' && (a === 'standby' || a === 'complete' || a === 'cancelled')) title = t('n.started', { name: p.name });
  if (title && Notification.isSupported()) {
    const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
    n.on('click', showWindow);
    n.show();
  }
}

async function pollAll() {
  await Promise.all(config.printers.map(pollPrinter));
  if (win && !win.isDestroyed()) win.webContents.send('states', states);
  updateTrays();
}

// ---------------- Tepsi ikonları ----------------
// İkonlar renderer'daki canvas ile çiziliyor (yüzde rakamı + halka) ve buraya data URL olarak geliyor.
let trayImages = {}; // id -> dataURL

function trayTooltip(p) {
  const s = states[p.id];
  const st = stateOf(s);
  let t = `${p.name} — ${stateName(st)}`;
  if (st === 'printing' || st === 'paused') {
    t += ' ' + L.t('pct', { n: Math.floor(progressOf(s) * 100) });
    const eta = etaSeconds(s);
    if (eta != null) t += '\n' + L.t('tray.remaining', { d: fmtDur(eta) });
    const fn = s.status.print_stats.filename || '';
    if (fn) t += `\n${fn.replace(/\.gcode$/i, '')}`;
  }
  return t.slice(0, 127);
}

function etaSeconds(s) {
  const st = s?.status;
  if (!st) return null;
  const prog = progressOf(s);
  const dur = st.print_stats?.print_duration || 0;
  const est = s.meta?.estimated_time;
  let byFile = (prog > 0.02 && dur > 60) ? dur / prog - dur : null;
  let bySlicer = est ? Math.max(0, est * (1 - prog)) : null;
  if (byFile != null && bySlicer != null) {
    const w = Math.min(1, prog * 2); // ilerledikçe gerçek süreye daha çok güven
    return byFile * w + bySlicer * (1 - w);
  }
  return byFile ?? bySlicer;
}
const fmtDur = (sec) => L.fmtDur(sec, true);

function buildMenu() {
  const items = config.printers.map((p) => {
    const s = states[p.id];
    const st = stateOf(s);
    const pct = (st === 'printing' || st === 'paused') ? ' — ' + t('pct', { n: Math.floor(progressOf(s) * 100) }) : '';
    return { label: `${p.name}: ${stateName(st)}${pct}`, click: showWindow };
  });
  return Menu.buildFromTemplate([
    { label: 'U1 Farm Control', enabled: false },
    { type: 'separator' },
    ...items,
    { type: 'separator' },
    { label: t('menu.open'), click: showWindow },
    ...config.printers.map((p) => ({ label: t('menu.web', { name: p.name }), click: () => shell.openExternal(`http://${p.host}`) })),
    { type: 'separator' },
    { label: t('menu.quit'), click: () => { quitting = true; app.quit(); } },
  ]);
}

function blankIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
}

// Acima de 8 impressoras um ícone por máquina lota a bandeja: usa um ícone-resumo do farm
const TRAY_PER_MAX = 8;
const perPrinterTray = () => config.trayPerPrinter && config.printers.length > 0 && config.printers.length <= TRAY_PER_MAX;
function ensureTrays() {
  const want = perPrinterTray() ? config.printers.map((p) => p.id) : ['__main'];
  for (const id of Object.keys(trays)) {
    if (!want.includes(id)) { trays[id].destroy(); delete trays[id]; }
  }
  for (const id of want) {
    if (!trays[id]) {
      const t = new Tray(blankIcon());
      t.on('click', showWindow);
      t.on('double-click', showWindow);
      trays[id] = t;
    }
  }
}

function updateTrays() {
  ensureTrays();
  const menu = buildMenu();
  if (perPrinterTray()) {
    for (const p of config.printers) {
      const t = trays[p.id];
      if (!t) continue;
      t.setToolTip(trayTooltip(p));
      t.setContextMenu(menu);
      const img = trayImages[p.id];
      if (img) t.setImage(nativeImage.createFromDataURL(img));
    }
  } else {
    const t = trays.__main;
    t.setToolTip(config.printers.length ? config.printers.map(trayTooltip).join('\n').slice(0, 127) : t('tray.noPrinters'));
    t.setContextMenu(menu);
    if (trayImages.__main) t.setImage(nativeImage.createFromDataURL(trayImages.__main));
  }
}

// ---------------- Pencere ----------------
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'U1 Farm Control',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: !(config.startMinimized || startHidden),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Alta alınınca tepsiye küçül
  win.on('minimize', (e) => { e.preventDefault(); win.hide(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------------- Kamera ----------------
// Stok U1 firmware'inde kamera kendiliğinden yayın yapmaz; Moonraker websocket'ine
// camera.start_monitor gönderilince /server/files/camera/monitor.jpg dosyasını güncellemeye başlar.
function wakeCamera(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, info) => { if (done) return; done = true; try { ws.close(); } catch {} resolve({ ok, info }); };
    const ws = new WebSocket(`ws://${host}:7125/websocket`, { handshakeTimeout: 4000 });
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'camera.start_monitor', params: { domain: 'lan', interval: 0 }, id: 4242 })));
    ws.on('message', (data) => {
      try {
        const j = JSON.parse(data.toString());
        if (j.id === 4242) finish(!j.error, j.result || j.error);
      } catch {}
    });
    ws.on('error', (e) => finish(false, String(e.message || e)));
    setTimeout(() => finish(false, t('err.timeout')), 6000);
  });
}
ipcMain.handle('camera:wake', (_e, id) => {
  const p = config.printers.find((x) => x.id === id);
  return p ? wakeCamera(p.host) : { ok: false, info: t('err.notFound') };
});

// ---------------- IPC ----------------
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, c) => {
  config = { ...config, ...c };
  saveConfig();
  applyLanguage();
  metaCache = {};
  for (const id of Object.keys(states)) if (!config.printers.find((p) => p.id === id)) delete states[id];
  pollAll();
  return config;
});
ipcMain.handle('autostart:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('autostart:set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.on('tray:images', (_e, imgs) => { trayImages = imgs; updateTrays(); });
ipcMain.handle('open:external', (_e, url) => shell.openExternal(url));

ipcMain.handle('printer:action', async (_e, { id, action, value }) => {
  const p = config.printers.find((x) => x.id === id);
  if (!p) throw new Error(t('err.notFound'));
  const gcode = (script) => api(p.host, '/printer/gcode/script?script=' + encodeURIComponent(script), { method: 'POST', timeout: 15000 });
  switch (action) {
    case 'pause': return api(p.host, '/printer/print/pause', { method: 'POST', timeout: 15000 });
    case 'resume': return api(p.host, '/printer/print/resume', { method: 'POST', timeout: 15000 });
    case 'cancel': return api(p.host, '/printer/print/cancel', { method: 'POST', timeout: 15000 });
    case 'estop': return api(p.host, '/printer/emergency_stop', { method: 'POST' });
    case 'firmware_restart': return api(p.host, '/printer/firmware_restart', { method: 'POST' });
    case 'light': return gcode(`SET_LED LED=cavity_led RED=${value ? 1 : 0} GREEN=${value ? 1 : 0} BLUE=${value ? 1 : 0} WHITE=${value ? 1 : 0}`);
    case 'speed': return gcode(`M220 S${Math.round(value)}`);
    case 'flow': return gcode(`M221 S${Math.round(value)}`);
    case 'fan': return gcode(`M106 S${Math.round(value * 255 / 100)}`);
    case 'bed': return gcode(`SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${Math.round(value)}`);
    case 'nozzle': return gcode(`SET_HEATER_TEMPERATURE HEATER=${value.heater} TARGET=${Math.round(value.target)}`);
    case 'unload': {
      // Dokunmatik ekranın kullandığı akış: ısıt → AUTO_FEEDING UNLOAD prepare/doing → ısıtıcıyı kapat
      const list = Array.isArray(value) ? value : [value];
      const st = await api(p.host, '/printer/objects/query?print_stats&toolhead');
      const ps = st.status.print_stats?.state;
      if (ps === 'printing' || ps === 'paused') throw new Error(t('err.unloadPrinting'));
      let script;
      try { script = bulk.unloadScript(list, (st.status.toolhead?.homed_axes || '') === 'xyz'); } catch { throw new Error(t('err.badHead')); }
      return api(p.host, '/printer/gcode/script?script=' + encodeURIComponent(script), { method: 'POST', timeout: 15 * 60 * 1000 });
    }
    case 'cooldown': return gcode('TURN_OFF_HEATERS');
    case 'gcode': return gcode(String(value));
    case 'history': return api(p.host, '/server/history/list?limit=15&order=desc');
    case 'files': return api(p.host, '/server/files/list?root=gcodes');
    case 'start': return api(p.host, '/printer/print/start?filename=' + encodeURIComponent(value), { method: 'POST', timeout: 15000 });
    default: throw new Error(t('err.unknown', { a: action }));
  }
});

// ---------------- Operações em massa (estilo Bambu Farm Manager) ----------------
// Cada operação vira um "job" com um item por impressora; o progresso vai para a UI via 'bulk:job'.
const jobs = {};        // jobId -> job
const busyIds = {};     // printerId -> jobId (uma operação longa por impressora de cada vez)
const IDLE = ['standby', 'complete', 'cancelled'];
let jobSeq = 0;

function emitJob(job) {
  job.updated = Date.now();
  if (win && !win.isDestroyed()) win.webContents.send('bulk:job', job);
}
function setItem(job, id, patch) {
  Object.assign(job.items[id], patch);
  emitJob(job);
}
async function freshState(p) {
  const r = await bulk.api(p.host, '/printer/objects/query?print_stats&toolhead&webhooks&print_task_config');
  const st = r.status;
  const klippy = st.webhooks?.state;
  return { state: klippy !== 'ready' ? 'error' : (st.print_stats?.state || 'standby'), st };
}
const homed = (st) => (st.toolhead?.homed_axes || '') === 'xyz';

// Pré-checagem para exibir na UI quem pode receber a operação (sem rede: usa o último estado)
function eligibility(op, p) {
  const s = states[p.id];
  const st = stateOf(s);
  if (st === 'offline') return { ok: false, why: t('bk.why.offline') };
  if (busyIds[p.id]) return { ok: false, why: t('bk.why.busyJob') };
  if (['unload', 'filament', 'print'].includes(op) && !IDLE.includes(st)) return { ok: false, why: t('bk.why.notIdle', { s: stateName(st) }) };
  if (op === 'pause' && st !== 'printing') return { ok: false, why: t('bk.why.notPrinting') };
  if (op === 'resume' && st !== 'paused') return { ok: false, why: t('bk.why.notPaused') };
  if (op === 'cancel' && !['printing', 'paused'].includes(st)) return { ok: false, why: t('bk.why.notPrinting') };
  return { ok: true };
}

async function doUnload(job, p, params) {
  const { state, st } = await freshState(p);
  if (!IDLE.includes(state)) throw new Error(t('bk.why.notIdle', { s: stateName(state) }));
  const ptc = st.print_task_config || {};
  let heads = params.heads === 'loaded'
    ? [0, 1, 2, 3].filter((i) => ptc.filament_exist?.[i] !== false)
    : params.heads.filter((i) => ptc.filament_exist?.[i] !== false);
  if (!heads.length) return t('bk.nothingToUnload');
  setItem(job, p.id, { msg: t('bk.unloading', { list: heads.map((i) => 'T' + i).join(', ') }) });
  await bulk.gcode(p.host, bulk.unloadScript(heads, homed(st)), 15 * 60 * 1000);
  return t('bk.unloaded', { list: heads.map((i) => 'T' + i).join(', ') });
}

async function doFilament(job, p, params) {
  const { state } = await freshState(p);
  if (!IDLE.includes(state)) throw new Error(t('bk.why.notIdle', { s: stateName(state) }));
  const done = [];
  for (const [head, f] of Object.entries(params.heads)) {
    setItem(job, p.id, { msg: `T${head}…` });
    await bulk.gcode(p.host, bulk.filamentScript(head, f, params.force), 20000);
    done.push('T' + head);
  }
  return t('bk.filamentSet', { list: done.join(', ') });
}

async function checkPrint(p, info, check) {
  const { state, st } = await freshState(p);
  if (!IDLE.includes(state)) throw new Error(t('bk.why.notIdle', { s: stateName(state) }));
  if (check && info) {
    const mm = bulk.filamentMismatches(info, st.print_task_config);
    if (mm.length) throw new Error(mm.map((m) => m.kind === 'empty' ? t('bk.mm.empty', { i: m.head })
      : m.kind === 'type' ? t('bk.mm.type', { i: m.head, want: m.want, have: m.have }) : t('bk.mm.head', { i: m.head })).join(' · '));
  }
}

// Envio (e impressão opcional) de arquivos do PC: uploads em paralelo, inícios escalonados
async function doSendJob(job, printers, params) {
  const files = params.files;
  const toStart = [];
  await bulk.runPool(printers, config.uploadParallel || 4, async (p) => {
    try {
      for (let k = 0; k < files.length; k++) {
        const f = files[k];
        setItem(job, p.id, { status: 'running', msg: t('bk.uploading', { f: f.name, k: k + 1, n: files.length }), pct: 0 });
        await bulk.uploadFile(p.host, f.path, {
          onProgress: (pct) => { job.items[p.id].pct = pct; throttleEmit(job); },
        });
      }
      metaCache = {};
      if (params.start) { setItem(job, p.id, { msg: t('bk.waitStart'), pct: 100 }); toStart.push(p); }
      else setItem(job, p.id, { status: 'ok', msg: t('bk.uploaded'), pct: 100 });
    } catch (e) {
      setItem(job, p.id, { status: 'error', msg: String(e.message || e) });
    }
  });
  if (params.start) await staggeredStart(job, toStart, files[0].name, files[0].info, params);
}

async function doPrintExistingJob(job, printers, params) {
  let info = null;
  // metadados do Moonraker (tipo de filamento) para a checagem, se houver
  try {
    const m = await bulk.api(printers[0].host, '/server/files/metadata?filename=' + encodeURIComponent(params.filename));
    const types = String(m?.filament_type || '').split(/[;,]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (types.length === 1) info = { types, used: [0] };
  } catch {}
  await staggeredStart(job, printers, params.filename, info, params);
}

async function staggeredStart(job, printers, filename, info, params) {
  const gap = Math.max(0, Number(params.stagger ?? config.stagger ?? 0)) * 1000;
  let lastStart = 0;
  for (const p of printers) {
    if (job.cancelRequested) { setItem(job, p.id, { status: 'skipped', msg: t('bk.stopped') }); continue; }
    try {
      setItem(job, p.id, { status: 'running', msg: t('bk.starting') });
      await checkPrint(p, info, params.checkFilament);      // recusa antes de esperar
      const wait = lastStart ? gap - (Date.now() - lastStart) : 0;
      if (wait > 0) {
        setItem(job, p.id, { msg: t('bk.waitStagger', { s: Math.ceil(wait / 1000) }) });
        await bulk.sleep(wait);
        if (job.cancelRequested) { setItem(job, p.id, { status: 'skipped', msg: t('bk.stopped') }); continue; }
        await checkPrint(p, info, params.checkFilament);    // alguém pode ter mexido durante a espera
      }
      await bulk.api(p.host, '/printer/print/start?filename=' + encodeURIComponent(filename), { method: 'POST', timeout: 20000 });
      lastStart = Date.now();
      setItem(job, p.id, { status: 'ok', msg: t('bk.started') });
    } catch (e) {
      setItem(job, p.id, { status: 'error', msg: String(e.message || e) });
    }
  }
}

let emitTimer = null;
function throttleEmit(job) {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = null; emitJob(job); }, 400);
}

const SIMPLE = {
  pause: (p) => bulk.api(p.host, '/printer/print/pause', { method: 'POST', timeout: 15000 }),
  resume: (p) => bulk.api(p.host, '/printer/print/resume', { method: 'POST', timeout: 15000 }),
  cancel: (p) => bulk.api(p.host, '/printer/print/cancel', { method: 'POST', timeout: 15000 }),
  cooldown: (p) => bulk.gcode(p.host, 'TURN_OFF_HEATERS'),
  lightOn: (p) => bulk.gcode(p.host, 'SET_LED LED=cavity_led RED=1 GREEN=1 BLUE=1 WHITE=1'),
  lightOff: (p) => bulk.gcode(p.host, 'SET_LED LED=cavity_led RED=0 GREEN=0 BLUE=0 WHITE=0'),
};
const LONG_OPS = ['unload', 'filament', 'send', 'print'];

async function runJob(job, printers, params) {
  const long = LONG_OPS.includes(job.op);
  if (long) for (const p of printers) busyIds[p.id] = job.id;
  try {
    if (job.op === 'send') return await doSendJob(job, printers, params);
    if (job.op === 'print') return await doPrintExistingJob(job, printers, params);
    const fn = job.op === 'unload' ? doUnload : job.op === 'filament' ? doFilament : (jb, p) => SIMPLE[job.op](p).then(() => t('bk.done'));
    // unload/filament: cada impressora independente; limite evita picos de consumo (aquecimento)
    const limit = job.op === 'unload' ? Math.max(1, Number(params.parallel) || 10) : 20;
    await bulk.runPool(printers, limit, async (p) => {
      if (job.cancelRequested) return setItem(job, p.id, { status: 'skipped', msg: t('bk.stopped') });
      setItem(job, p.id, { status: 'running', msg: t('bk.running') });
      try {
        const msg = await fn(job, p, params);
        setItem(job, p.id, { status: 'ok', msg: msg || t('bk.done') });
      } catch (e) {
        setItem(job, p.id, { status: 'error', msg: String(e.message || e) });
      }
    });
  } finally {
    if (long) for (const p of printers) if (busyIds[p.id] === job.id) delete busyIds[p.id];
    job.done = true;
    emitJob(job);
    if (long && config.notifications && Notification.isSupported()) {
      const vals = Object.values(job.items);
      const ok = vals.filter((x) => x.status === 'ok').length;
      new Notification({ title: t('bk.n.done', { op: t('bk.op.' + job.op) }), body: t('bk.n.body', { ok, n: vals.length }), icon: path.join(__dirname, 'assets', 'icon.png') }).show();
    }
  }
}

ipcMain.handle('bulk:eligibility', (_e, { op, ids }) => {
  const out = {};
  for (const id of ids) { const p = config.printers.find((x) => x.id === id); if (p) out[id] = eligibility(op, p); }
  return out;
});
ipcMain.handle('bulk:pickFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: t('bk.pickTitle'), properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'G-code', extensions: ['gcode', 'gco', 'g'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map((fp) => ({ path: fp, name: path.basename(fp), info: bulk.parseGcodeInfo(fp) }));
});
// Arquivos presentes nas impressoras selecionadas: nome → em quais impressoras existe
ipcMain.handle('bulk:filesOn', async (_e, ids) => {
  const map = {};
  const ps = config.printers.filter((p) => ids.includes(p.id));
  await bulk.runPool(ps, 10, async (p) => {
    const list = await bulk.api(p.host, '/server/files/list?root=gcodes', { timeout: 8000 });
    for (const f of list) {
      if (!/\.(gcode|gco|g)$/i.test(f.path)) continue;
      const m = map[f.path] || (map[f.path] = { path: f.path, ids: [], modified: 0, size: f.size });
      m.ids.push(p.id);
      m.modified = Math.max(m.modified, f.modified || 0);
    }
  });
  return Object.values(map).sort((a, b) => b.modified - a.modified);
});
ipcMain.handle('bulk:run', (_e, { op, ids, params = {} }) => {
  const known = ['unload', 'filament', 'send', 'print', ...Object.keys(SIMPLE)];
  if (!known.includes(op)) throw new Error(t('err.unknown', { a: op }));
  if (op === 'send' && !params.files?.length) throw new Error(t('bk.noFile'));
  if (op === 'print' && !params.filename) throw new Error(t('bk.noFile'));
  // sends that also start a print need the same rules as a print
  const checkOp = op === 'send' && params.start ? 'print' : op;
  const id = 'j' + Date.now() + '_' + (++jobSeq);
  const job = { id, op, created: Date.now(), done: false, items: {}, title: params.title || '' };
  const run = [];
  for (const pid of ids) {
    const p = config.printers.find((x) => x.id === pid);
    if (!p) continue;
    // Envio sem impressão: não precisa estar ociosa
    const el = op === 'send' && !params.start ? (stateOf(states[p.id]) === 'offline' ? { ok: false, why: t('bk.why.offline') } : { ok: true }) : eligibility(checkOp, p);
    job.items[p.id] = { name: p.name, status: el.ok ? 'pending' : 'skipped', msg: el.ok ? t('bk.queued') : el.why, pct: null };
    if (el.ok) run.push(p);
  }
  jobs[id] = job;
  emitJob(job);
  if (run.length) runJob(job, run, params).catch((e) => { job.done = true; job.error = String(e.message || e); emitJob(job); });
  else { job.done = true; emitJob(job); }
  return job;
});
ipcMain.handle('bulk:jobs', () => Object.values(jobs).sort((a, b) => b.created - a.created));
ipcMain.handle('bulk:stop', (_e, id) => { if (jobs[id]) { jobs[id].cancelRequested = true; emitJob(jobs[id]); } return true; });
ipcMain.handle('bulk:clear', () => { for (const [k, j] of Object.entries(jobs)) if (j.done) delete jobs[k]; return true; });

// ---------------- Başlat ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId('com.u1farm.control');
  app.whenReady().then(() => {
    // mesma pilha de rede do navegador (proxy/configurações do Windows); o fetch do Node vira reserva
    if (net && typeof net.fetch === 'function') bulk.setTransport({ fetch: (u, o) => net.fetch(u, o), request: (o) => net.request(o) });
    config = loadConfig();
    applyLanguage();
    startHidden = process.argv.includes('--hidden');
    createWindow();
    ensureTrays();
    pollAll();
    setInterval(pollAll, POLL_MS);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', (e) => e.preventDefault?.());
}

