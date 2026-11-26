// U1 Farm Control — farm-wide (bulk) operations.
// Plain Node module (no Electron imports) so it can be tested against a mock Moonraker.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------- Moonraker helpers ----------------
async function api(host, pathName, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 4000);
  try {
    const r = await fetch(`http://${hostPort(host)}${pathName}`, { method: opts.method || 'GET', signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return j.result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally {
    clearTimeout(t);
  }
}
// "192.168.0.10" → "192.168.0.10:7125"; "host:port" is kept (used by tests / custom ports)
function hostPort(host) { return /:\d+$/.test(host) ? host : `${host}:7125`; }

const gcode = (host, script, timeout = 15000) =>
  api(host, '/printer/gcode/script?script=' + encodeURIComponent(script), { method: 'POST', timeout });

// ---------------- Upload (multipart, streamed, with progress) ----------------
// Moonraker: POST /server/files/upload  fields: root=gcodes, path=<subdir>, file=<data>
function uploadFile(host, filePath, { remoteName, subdir = '', onProgress, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let size;
    try { size = fs.statSync(filePath).size; } catch (e) { return reject(e); }
    const name = (remoteName || path.basename(filePath)).replace(/["\r\n]/g, '_');
    const boundary = '----u1farm' + Math.random().toString(16).slice(2);
    const field = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    const head = Buffer.from(
      field('root', 'gcodes') + (subdir ? field('path', subdir) : '') +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const [h, port] = hostPort(host).split(':');
    const req = http.request({
      host: h, port: Number(port), path: '/server/files/upload', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': head.length + size + tail.length },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        clearTimeout(timer);
        let j = {};
        try { j = JSON.parse(body); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j.result || j);
        else reject(new Error(j?.error?.message || `HTTP ${res.statusCode}`));
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(head);
    let sent = 0, lastPct = -1;
    const rs = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    rs.on('data', (chunk) => {
      sent += chunk.length;
      const pct = Math.floor((sent / size) * 100);
      if (onProgress && pct !== lastPct) { lastPct = pct; onProgress(pct); }
      if (!req.write(chunk)) { rs.pause(); req.once('drain', () => rs.resume()); }
    });
    rs.on('error', (e) => req.destroy(e));
    rs.on('end', () => req.end(tail));
  });
}

// ---------------- G-code inspection ----------------
// Reads the slicer header/footer (Snapmaker Orca / Orca / Prusa style "; key = value")
// to learn which toolheads the file uses and which filament type each expects.
function readSlice(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n).toString('utf8');
}
function parseGcodeInfo(filePath) {
  const info = { name: path.basename(filePath), size: 0, types: [], colors: [], used: null, estimatedTime: null, weight: null };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    info.size = size;
    const HEAD = 256 * 1024, TAIL = 512 * 1024;
    let text = readSlice(fd, 0, Math.min(size, HEAD));
    if (size > HEAD) text += '\n' + readSlice(fd, Math.max(HEAD, size - TAIL), Math.min(TAIL, size - HEAD));
    const kv = {};
    for (const m of text.matchAll(/^;\s*([A-Za-z_][\w \[\]()]*?)\s*=\s*(.*)$/gm)) {
      const k = m[1].trim().toLowerCase();
      if (!(k in kv)) kv[k] = m[2].trim();
    }
    const list = (v) => (v == null ? [] : String(v).split(/[;,]/).map((x) => x.trim().replace(/^"|"$/g, '')));
    info.types = list(kv['filament_type']).map((x) => x.toUpperCase());
    info.colors = list(kv['filament_colour'] ?? kv['extruder_colour']);
    // per-extruder usage: "filament used [mm] = 120.3, 0.00, 54.1, 0.00"
    const usage = kv['filament used [mm]'] ?? kv['filament used [g]'] ?? kv['total filament used for wipe tower [g]'] ?? null;
    if (usage != null) {
      const nums = list(usage).map(Number);
      if (nums.length > 1 && nums.every((n) => !isNaN(n))) info.used = nums.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
    }
    // single-extruder files: only T0 is used
    if (!info.used && info.types.length === 1) info.used = [0];
    const w = parseFloat(kv['total filament weight [g]'] ?? kv['filament used [g]']);
    if (!isNaN(w)) info.weight = w;
    const et = kv['estimated printing time (normal mode)'] ?? kv['estimated printing time'];
    if (et) info.estimatedTime = parseDuration(et);
  } catch (e) {
    info.error = String(e.message || e);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  return info;
}
function parseDuration(s) {
  let sec = 0, any = false;
  for (const m of String(s).matchAll(/(\d+)\s*([dhms])/g)) {
    any = true;
    sec += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]];
  }
  return any ? sec : null;
}

// Compare what the file needs with what the printer has loaded (print_task_config).
// Returns a list of human-readable problems; empty list = OK.
function filamentMismatches(info, ptc) {
  const out = [];
  if (!info || !ptc) return out;
  const used = info.used || [];
  for (const i of used) {
    if (i > 3) { out.push({ head: i, kind: 'head' }); continue; }
    if (ptc.filament_exist && ptc.filament_exist[i] === false) { out.push({ head: i, kind: 'empty' }); continue; }
    const want = norm(info.types[i]);
    const have = norm(ptc.filament_type?.[i]);
    if (want && have && have !== 'NONE' && want !== have) out.push({ head: i, kind: 'type', want: info.types[i], have: ptc.filament_type[i] });
  }
  return out;
}
const norm = (s) => String(s || '').toUpperCase().replace(/[\s_-]+/g, '');

// ---------------- G-code script builders ----------------
// Same sequence the touchscreen uses: home if needed → AUTO_FEEDING_BATCH prepare/doing per head.
function unloadScript(heads, homed) {
  const lines = [];
  if (!homed) lines.push('G28');
  lines.push('AUTO_FEEDING_BATCH ACTION=START');
  for (const i of heads) {
    const n = Number(i);
    if (!(Number.isInteger(n) && n >= 0 && n <= 3)) throw new Error('bad head');
    lines.push(`AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=${n} UNLOAD=1 STAGE=prepare`);
    lines.push(`AUTO_FEEDING_BATCH ACTION=DOING EXTRUDER=${n} UNLOAD=1 STAGE=doing`);
  }
  lines.push('AUTO_FEEDING_BATCH');
  return lines.join('\n');
}

// Klipper parameters cannot contain spaces → keep a safe token.
const token = (s, fallback) => {
  const v = String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^\w.+\-]/g, '');
  return v || fallback;
};
function normColor(c) {
  let v = String(c || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(v)) v += 'FF';
  if (!/^[0-9a-f]{8}$/i.test(v)) throw new Error('bad color');
  return v.toUpperCase();
}
// Writes the head's filament like the touchscreen does (firmware print_task_config).
function filamentScript(head, f, force) {
  const n = Number(head);
  if (!(Number.isInteger(n) && n >= 0 && n <= 3)) throw new Error('bad head');
  return `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=${n} VENDOR=${token(f.vendor, 'Generic')} ` +
    `FILAMENT_TYPE=${token(f.type, 'PLA').toUpperCase()} FILAMENT_SUBTYPE=${token(f.subtype, 'Basic')} ` +
    `FILAMENT_COLOR_RGBA=${normColor(f.color)}${force ? ' FORCE=1' : ''}`;
}

// ---------------- concurrency ----------------
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; } catch (e) { results[i] = { ok: false, error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  api, gcode, hostPort, uploadFile, parseGcodeInfo, parseDuration, filamentMismatches,
  unloadScript, filamentScript, normColor, token, runPool, sleep,
};
