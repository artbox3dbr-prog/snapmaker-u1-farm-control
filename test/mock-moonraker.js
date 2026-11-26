// Mock Snapmaker U1 Moonraker: N printers on consecutive ports. Records every command.
'use strict';
const http = require('http');

function makePrinter(i, initial) {
  const p = {
    i, log: [], files: {}, state: initial.state || 'standby', filename: initial.filename || '', progress: initial.progress || 0,
    homed: '', ptc: {
      filament_exist: initial.exist || [true, true, true, true],
      filament_type: initial.types || ['PLA', 'PLA', 'PETG', 'PLA'],
      filament_sub_type: ['Basic', 'Matte', 'Basic', 'Silk'],
      filament_vendor: ['Polymaker', 'Polymaker', 'Generic', 'Bambu'],
      filament_color_rgba: ['000000FF', 'FFFFFFFF', 'FF0000FF', '00FF00FF'],
    },
  };
  return p;
}

function status(p) {
  const ext = (n) => ({ temperature: 25 + n, target: 0, power: 0 });
  return {
    print_stats: { state: p.state, filename: p.filename, print_duration: p.state === 'printing' ? 600 : 0, total_duration: 600, filament_used: 1234, message: '', info: { current_layer: 3, total_layer: 100 } },
    display_status: { progress: p.progress }, virtual_sdcard: { progress: p.progress },
    heater_bed: { temperature: 60, target: 60 }, extruder: ext(0), extruder1: ext(1), extruder2: ext(2), extruder3: ext(3),
    toolhead: { extruder: 'extruder', homed_axes: p.homed }, fan: { speed: 0.5 }, webhooks: { state: 'ready' },
    gcode_move: { speed_factor: 1, extrude_factor: 1 }, print_task_config: p.ptc,
    'temperature_sensor cavity': { temperature: 30, measured_max_temp: 35 }, 'led cavity_led': { color_data: [[0, 0, 0, 0]] },
    system_stats: { sysload: 0.3, memavail: 200000 }, motion_report: { live_velocity: 120 },
    'filament_feed left': { extruder0: { filament_detected: p.ptc.filament_exist[0], channel_state: 'load_finish' }, extruder1: { filament_detected: p.ptc.filament_exist[1], channel_state: 'load_finish' } },
    'filament_feed right': { extruder2: { filament_detected: p.ptc.filament_exist[2], channel_state: 'load_finish' }, extruder3: { filament_detected: p.ptc.filament_exist[3], channel_state: 'load_finish' } },
  };
}

function parseParams(line) {
  const o = {};
  for (const m of line.matchAll(/([A-Z_]+)=(\S+)/g)) o[m[1]] = m[2];
  return o;
}

function serve(p, port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
    const ok = (result) => send(200, { result });
    const bad = (msg) => send(400, { error: { code: 400, message: msg } });
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const path = u.pathname;
      if (path === '/printer/objects/query') {
        const st = status(p);
        const wanted = [...u.searchParams.keys()];
        const out = {};
        for (const k of wanted) if (st[k] !== undefined) out[k] = st[k];
        return ok({ eventtime: Date.now() / 1000, status: out });
      }
      if (path === '/server/info') return ok({ klippy_state: 'ready' });
      if (path === '/printer/gcode/script') {
        const script = u.searchParams.get('script');
        p.log.push(script);
        for (const line of script.split('\n')) {
          if (line === 'G28') p.homed = 'xyz';
          if (line.startsWith('AUTO_FEEDING_BATCH ACTION=DOING') && line.includes('STAGE=doing')) {
            if (['printing', 'paused'].includes(p.state)) return bad('busy');
            const e = Number(parseParams(line).EXTRUDER);
            await new Promise((r) => setTimeout(r, 300));
            p.ptc.filament_exist[e] = false;
          }
          if (line.startsWith('SET_PRINT_FILAMENT_CONFIG')) {
            if (p.state === 'printing') return bad('[print_task_config] cannot set while printing');
            const q = parseParams(line);
            const e = Number(q.CONFIG_EXTRUDER);
            if (!(e >= 0 && e <= 3) || !q.VENDOR || !q.FILAMENT_TYPE || !q.FILAMENT_SUBTYPE || !q.FILAMENT_COLOR_RGBA) return bad('[print_task_config] filament_config, incomplete parameters');
            p.ptc.filament_vendor[e] = q.VENDOR; p.ptc.filament_type[e] = q.FILAMENT_TYPE;
            p.ptc.filament_sub_type[e] = q.FILAMENT_SUBTYPE; p.ptc.filament_color_rgba[e] = q.FILAMENT_COLOR_RGBA;
            p.ptc.filament_exist[e] = true;
          }
        }
        return ok('ok');
      }
      if (path === '/printer/print/start') {
        const fn = u.searchParams.get('filename');
        if (!p.files[fn]) return bad(`File ${fn} does not exist`);
        if (['printing', 'paused'].includes(p.state)) return bad('Printer is busy');
        p.log.push('START ' + fn + ' @' + Date.now());
        p.state = 'printing'; p.filename = fn; p.progress = 0.01;
        return ok('ok');
      }
      if (path === '/printer/print/pause') { p.log.push('PAUSE'); if (p.state === 'printing') p.state = 'paused'; return ok('ok'); }
      if (path === '/printer/print/resume') { p.log.push('RESUME'); if (p.state === 'paused') p.state = 'printing'; return ok('ok'); }
      if (path === '/printer/print/cancel') { p.log.push('CANCEL'); p.state = 'cancelled'; return ok('ok'); }
      if (path === '/server/files/upload') {
        const ct = req.headers['content-type'] || '';
        const boundary = ct.split('boundary=')[1];
        const parts = body.toString('latin1').split('--' + boundary);
        let fname = null, data = null, root = null;
        for (const part of parts) {
          const m = part.match(/name="(\w+)"(?:; filename="([^"]+)")?\r\n(?:[^\r\n]*\r\n)*\r\n([\s\S]*)\r\n$/);
          if (!m) continue;
          if (m[1] === 'root') root = m[3];
          if (m[1] === 'file') { fname = m[2]; data = Buffer.from(m[3], 'latin1'); }
        }
        if (!fname || root !== 'gcodes') return bad('bad upload');
        p.files[fname] = { size: data.length, modified: Date.now() / 1000, data };
        p.log.push('UPLOAD ' + fname + ' ' + data.length);
        return send(201, { result: { item: { path: fname, root: 'gcodes' }, action: 'create_file' } });
      }
      if (path === '/server/files/list') return ok(Object.entries(p.files).map(([path, f]) => ({ path, size: f.size, modified: f.modified })));
      if (path === '/server/files/metadata') {
        const fn = u.searchParams.get('filename');
        if (!p.files[fn]) return bad('no metadata');
        return ok({ filename: fn, filament_type: 'PLA', estimated_time: 3600, thumbnails: [] });
      }
      if (path === '/server/history/list') return ok({ jobs: [] });
      if (path.startsWith('/server/files/camera')) { res.writeHead(404); return res.end(); }
      send(404, { error: { message: 'not found ' + path } });
    });
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

function start(base, configs) {
  return configs.map((c, k) => { const p = makePrinter(k, c); p.srv = serve(p, base + k); p.port = base + k; return p; });
}
module.exports = { start };
