// U1 Farm Control — farm view (list, selection, groups) and bulk operations, Bambu Farm Manager style.
// Loaded after app.js and shares its globals (config, states, cards, t, esc, toast, ...).

const selected = new Set();   // ids das impressoras selecionadas
let stateFilter = null;       // filtro por estado (chips do topo)
let sortKey = 'name', sortDir = 1;
const jobsMap = {};           // jobId -> job (espelho do processo principal)
const IDLE_STATES = ['standby', 'complete', 'cancelled'];

// ---------------- preferências de visão ----------------
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
function viewMode() { return lsGet('view', (config?.printers?.length || 0) > 6 ? 'list' : 'cards'); }
const groupFilter = () => lsGet('group', '');
const nameFilter = () => ($('#nameFilter')?.value || '').trim().toLowerCase();
function groupsOf() { return [...new Set(config.printers.map((p) => p.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); }
function visible(p) {
  const g = groupFilter();
  if (g && (p.group || '') !== g) return false;
  const q = nameFilter();
  if (q && !(`${p.name} ${p.host} ${p.group || ''}`.toLowerCase().includes(q))) return false;
  if (stateFilter && stateOf(states[p.id]) !== stateFilter) return false;
  return true;
}
const visiblePrinters = () => config.printers.filter(visible);
const byId = (id) => config.printers.find((p) => p.id === id);

// ---------------- barra do farm ----------------
function onRebuild() {
  $('#farmbar').hidden = !config.printers.length;
  for (const id of [...selected]) if (!byId(id)) selected.delete(id);
  $$('#viewSeg .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === viewMode()));
  const gs = groupsOf();
  const cur = groupFilter();
  $('#groupFilter').innerHTML = `<option value="">${t('fm.allGroups')}</option>` +
    gs.map((g) => `<option value="${esc(g)}"${g === cur ? ' selected' : ''}>${esc(g)} (${config.printers.filter((p) => p.group === g).length})</option>`).join('');
  $('#groupFilter').hidden = !gs.length;
}

function syncSelection() {
  $$('input[data-sel]').forEach((c) => (c.checked = selected.has(c.dataset.sel)));
  $$('[data-row]').forEach((r) => r.classList.toggle('selected', selected.has(r.dataset.row)));
  const vis = visiblePrinters();
  const nSelVis = vis.filter((p) => selected.has(p.id)).length;
  const h = $('#selHeader');
  if (h) { h.checked = vis.length > 0 && nSelVis === vis.length; h.indeterminate = nSelVis > 0 && nSelVis < vis.length; }
  $('#selCount').textContent = selected.size ? t('fm.selCount', { n: selected.size }) : t('fm.selNoneYet');
  $$('#bulkActions [data-bulk]').forEach((b) => (b.disabled = !selected.size));
  // visão em cards com filtro de estado: recria se o conjunto visível mudou
  if (viewMode() === 'cards') {
    const want = vis.map((p) => p.id).join('|');
    const have = config.printers.filter((p) => cards[p.id]).map((p) => p.id).join('|');
    if (want !== have) rebuild();
  }
}

// ---------------- visão em lista ----------------
function sortVal(p) {
  const s = states[p.id];
  switch (sortKey) {
    case 'group': return (p.group || '').toLowerCase();
    case 'state': return ['error', 'paused', 'printing', 'complete', 'cancelled', 'standby', 'offline'].indexOf(stateOf(s));
    case 'progress': return progressOf(s);
    case 'remain': { const st = stateOf(s); return (st === 'printing' || st === 'paused') ? (etaSeconds(s) ?? 1e9) : 1e10; }
    case 'file': return (s?.status?.print_stats?.filename || '').toLowerCase();
    default: return p.name.toLowerCase();
  }
}
function filSwatches(s) {
  const ptc = s?.status?.print_task_config || {};
  return [0, 1, 2, 3].map((i) => {
    const empty = ptc.filament_exist?.[i] === false || filLoaded(s, i) === false;
    const name = empty ? t('fil.none') : filName(s, i);
    const ty = empty ? '—' : (ptc.filament_type?.[i] || '?');
    return `<span class="lsw${empty ? ' nofil' : ''}" title="T${i}: ${esc(name)}"><i style="background:${empty ? 'transparent' : argbToCss(ptc.filament_color_rgba?.[i])}"></i>${esc(ty)}</span>`;
  }).join('');
}
function renderList() {
  const rows = visiblePrinters().sort((a, b) => {
    const x = sortVal(a), y = sortVal(b);
    return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })) * sortDir;
  });
  $$('#list th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === sortKey));
  $('#listBody').innerHTML = rows.map((p) => {
    const s = states[p.id];
    const st = stateOf(s);
    const ps = s?.status?.print_stats || {};
    const active = st === 'printing' || st === 'paused';
    const pct = Math.floor(progressOf(s) * 100);
    const hasJob = !!ps.filename && st !== 'standby';
    const msg = ps.message ? ` <span class="warnmsg" title="${esc(ps.message)}">⚠</span>` : '';
    const jobBusy = busyJobFor(p.id);
    return `<tr data-row="${esc(p.id)}" class="st-${st}">
      <td class="c-sel"><input type="checkbox" data-sel="${esc(p.id)}" /></td>
      <td><b>${esc(p.name)}</b><div class="mut mono">${esc(p.host)}</div></td>
      <td>${esc(p.group || '')}</td>
      <td><span class="badge ${st}">${stateName(st)}</span>${jobBusy ? ` <span class="mut" title="${esc(jobBusy)}">⚙</span>` : ''}</td>
      <td class="c-prog">${hasJob ? `<div class="bar"><i style="width:${active || st === 'complete' ? (st === 'complete' ? 100 : pct) : 0}%"></i></div><span>${active ? pctText(pct) : ''}</span>` : ''}</td>
      <td class="mono">${active ? fmtDur(etaSeconds(s)) : ''}</td>
      <td class="c-file" title="${esc(ps.filename || '')}">${hasJob ? esc(cleanName(ps.filename)) : '<span class="mut">—</span>'}${msg}</td>
      <td class="c-fil">${st === 'offline' ? '' : filSwatches(s)}</td>
      <td class="c-act">
        <button class="btn ghost small" data-ra="files" title="${t('tip.files')}">📁</button>
        <button class="btn ghost small" data-ra="card" title="${t('fm.openCard')}">▣</button>
        <button class="btn ghost small" data-ra="web" title="${t('tip.web')}">🌐</button>
      </td></tr>`;
  }).join('') || `<tr><td colspan="9" class="offline-box">${t('fm.noMatch')}</td></tr>`;
}

function busyJobFor(id) {
  for (const j of Object.values(jobsMap)) if (!j.done && j.items[id] && ['pending', 'running'].includes(j.items[id].status)) return t('bk.op.' + j.op);
  return null;
}

// ---------------- elegibilidade (espelha a regra do processo principal) ----------------
function elig(op, id) {
  const st = stateOf(states[id]);
  if (st === 'offline') return t('bk.why.offline');
  if (['unload', 'filament', 'print', 'sendprint'].includes(op) && busyJobFor(id)) return t('bk.why.busyJob');
  if (['unload', 'filament', 'print', 'sendprint'].includes(op) && !IDLE_STATES.includes(st)) return t('bk.why.notIdle', { s: stateName(st) });
  if (op === 'pause' && st !== 'printing') return t('bk.why.notPrinting');
  if (op === 'resume' && st !== 'paused') return t('bk.why.notPaused');
  if (op === 'cancel' && !['printing', 'paused'].includes(st)) return t('bk.why.notPrinting');
  return null;
}
// mesma checagem de filamento do lib/bulk.js (versão do navegador)
function mismatches(info, ptc) {
  const out = [];
  if (!info || !ptc) return out;
  const n = (s) => String(s || '').toUpperCase().replace(/[\s_-]+/g, '');
  for (const i of info.used || []) {
    if (i > 3) out.push(t('bk.mm.head', { i }));
    else if (ptc.filament_exist?.[i] === false) out.push(t('bk.mm.empty', { i }));
    else if (n(info.types[i]) && n(ptc.filament_type?.[i]) && n(ptc.filament_type[i]) !== 'NONE' && n(info.types[i]) !== n(ptc.filament_type[i]))
      out.push(t('bk.mm.type', { i, want: info.types[i], have: ptc.filament_type[i] }));
  }
  return out;
}

// ---------------- diálogo de operação em massa ----------------
const FIL_TYPES = ['PLA', 'PLA-CF', 'PETG', 'PETG-CF', 'PET', 'ABS', 'ASA', 'TPU', 'PA', 'PA-CF', 'PC', 'PVA', 'HIPS', 'PP'];
const FIL_SUBS = ['Basic', 'Matte', 'Silk', 'HF', 'Tough', 'Lite', 'Metal', 'Marble', 'Wood', 'Glow', 'Translucent', 'Galaxy', 'Sparkle', 'Support'];
const FIL_VENDORS = ['Generic', 'Snapmaker', 'Polymaker', 'Bambu', 'Elegoo', 'eSun', 'Sunlu', 'Creality', 'Prusament'];
let bk = null; // contexto do diálogo aberto

function closeBulk() { $('#bulk').close(); bk = null; }

async function openBulk(op, ids) {
  ids = (ids || [...selected]).filter((id) => byId(id));
  if (!ids.length) return toast(t('fm.selectFirst'), true);
  if (op === 'more') return openMore(ids);
  bk = { op, ids, files: [], start: false, existing: null, existingList: null };
  const body = $('#bulkBody');
  body.innerHTML = `
    <div class="dlg-head"><h2>${t('bk.title.' + op)}</h2><button class="btn ghost small" data-bk="close">✕</button></div>
    <div class="bk-targets" id="bkTargets"></div>
    <div class="bk-form" id="bkForm">${formHtml(op, ids)}</div>
    <div class="dlg-actions"><button class="btn ghost" data-bk="close">${t('cancel')}</button>
      <button class="btn ${['cancel', 'cooldown'].includes(op) ? 'danger' : 'primary'}" data-bk="run" id="bkRun">${t('bk.run.' + op)}</button></div>`;
  $('#bulk').showModal();
  if (op === 'filament') prefillFilament(ids);
  if (op === 'print') loadExisting();
  renderTargets();
}

function formHtml(op, ids) {
  const dl = (id, arr) => `<datalist id="${id}">${arr.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
  switch (op) {
    case 'unload': return `
      <label class="check"><input type="radio" name="bkHeads" value="loaded" checked /> ${t('bk.unloadLoaded')}</label>
      <label class="check"><input type="radio" name="bkHeads" value="pick" /> ${t('bk.unloadPick')}</label>
      <div class="heads-pick">${[0, 1, 2, 3].map((i) => `<label class="check"><input type="checkbox" data-head="${i}" /> T${i}</label>`).join('')}</div>
      <label class="field"><span>${t('bk.parallel')}</span><input type="number" id="bkParallel" class="input" min="1" max="100" value="10" /></label>
      <p class="hint">${t('bk.unloadHint')}</p>`;
    case 'filament': {
      const presets = config.filamentPresets || [];
      return `${dl('dlTypes', FIL_TYPES)}${dl('dlSubs', FIL_SUBS)}${dl('dlVendors', FIL_VENDORS)}
      <div class="preset-row">
        <select id="bkPreset" class="input sm"><option value="">${t('bk.presetPick')}</option>${presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>
        <button class="btn small" data-bk="presetApply">${t('bk.presetApply')}</button>
        <button class="btn small ghost" data-bk="presetSave">${t('bk.presetSave')}</button>
        <button class="btn small ghost" data-bk="presetDel" title="${t('bk.presetDel')}">🗑</button>
      </div>
      <table class="fil-edit"><thead><tr><th></th><th>${t('bk.fType')}</th><th>${t('bk.fSub')}</th><th>${t('bk.fVendor')}</th><th>${t('bk.fColor')}</th></tr></thead><tbody>
      ${[0, 1, 2, 3].map((i) => `<tr data-fh="${i}">
        <td><label class="check"><input type="checkbox" data-fon="${i}" /> <b>T${i}</b></label></td>
        <td><input class="input sm" data-ff="type" list="dlTypes" value="PLA" /></td>
        <td><input class="input sm" data-ff="subtype" list="dlSubs" value="Basic" /></td>
        <td><input class="input sm" data-ff="vendor" list="dlVendors" value="Generic" /></td>
        <td><input type="color" data-ff="color" value="#ffffff" /></td></tr>`).join('')}
      </tbody></table>
      <label class="check"><input type="checkbox" id="bkForce" /> ${t('bk.force')}</label>
      <p class="hint">${t(ids.length > 1 ? 'bk.filHintMany' : 'bk.filHint')}</p>`;
    }
    case 'send': return `
      <div class="row-actions left"><button class="btn" data-bk="pick">${t('bk.pickFiles')}</button><span class="mut" id="bkFilesInfo">${t('bk.noFilesYet')}</span></div>
      <div id="bkFiles" class="bk-files"></div>
      <label class="check"><input type="radio" name="bkMode" value="upload" checked /> ${t('bk.modeUpload')}</label>
      <label class="check"><input type="radio" name="bkMode" value="print" /> ${t('bk.modePrint')}</label>
      <div id="bkPrintOpts" hidden>${printOpts()}</div>`;
    case 'print': return `
      <input id="bkSearch" class="input" placeholder="${t('files.search')}" />
      <div id="bkExisting" class="bk-files tall"><div class="offline-box">${t('files.loading')}</div></div>
      ${printOpts()}`;
    default: return `<p>${t('bk.simpleText', { op: t('bk.op.' + op) })}</p>`;
  }
}
function printOpts() {
  return `<label class="field"><span>${t('fm.stagger')}</span><input type="number" id="bkStagger" class="input" min="0" max="600" step="5" value="${esc(config.stagger ?? 20)}" /></label>
    <label class="check"><input type="checkbox" id="bkCheckFil" checked /> ${t('bk.checkFil')}</label>
    <label class="check"><input type="checkbox" id="bkPlate" /> <b>${t('bk.plateClear')}</b></label>`;
}

// quem recebe / quem fica de fora (com motivo)
function effOp() {
  if (bk.op === 'send') return bk.start ? 'sendprint' : 'send';
  return bk.op;
}
function renderTargets() {
  if (!bk) return;
  const op = effOp();
  const ok = [], skip = [], warn = [];
  let info = null;
  if (op === 'sendprint') info = bk.files[0]?.info;
  const checkFil = $('#bkCheckFil')?.checked;
  for (const id of bk.ids) {
    const p = byId(id);
    let why = elig(op, id);
    if (!why && bk.op === 'print' && bk.existing && !bk.existing.ids.includes(id)) why = t('bk.why.noFile');
    if (!why && op === 'sendprint' && info) {
      const mm = mismatches(info, states[id]?.status?.print_task_config);
      if (mm.length) { if (checkFil) why = mm.join(' · '); else warn.push({ p, why: mm.join(' · ') }); }
    }
    (why ? skip : ok).push({ p, why });
  }
  bk.okIds = ok.map((x) => x.p.id);
  const list = (arr, cls) => arr.map((x) => `<li class="${cls}"><b>${esc(x.p.name)}</b>${x.why ? ` — ${esc(x.why)}` : ''}</li>`).join('');
  $('#bkTargets').innerHTML = `<div class="bk-sum"><b>${t('bk.willRun', { n: ok.length, total: bk.ids.length })}</b>${skip.length ? ` · <span class="err">${t('bk.skipped', { n: skip.length })}</span>` : ''}${warn.length ? ` · <span class="warnc">${t('bk.warned', { n: warn.length })}</span>` : ''}</div>
    ${skip.length || warn.length ? `<details><summary>${t('bk.details')}</summary><ul class="bk-skip">${list(skip, 'err')}${list(warn, 'warnc')}</ul></details>` : ''}
    <div class="bk-names mut">${ok.slice(0, 40).map((x) => esc(x.p.name)).join(', ')}${ok.length > 40 ? '…' : ''}</div>`;
  $('#bkRun').disabled = !ok.length;
}

function prefillFilament(ids) {
  // começa com o que a primeira impressora tem carregado
  const ptc = states[ids[0]]?.status?.print_task_config;
  if (!ptc) return;
  $$('#bkForm tr[data-fh]').forEach((tr) => {
    const i = Number(tr.dataset.fh);
    const set = (k, v) => { if (v && v !== 'NONE') $(`[data-ff="${k}"]`, tr).value = v; };
    set('type', ptc.filament_type?.[i]);
    set('subtype', ptc.filament_sub_type?.[i]);
    set('vendor', ptc.filament_vendor?.[i]);
    const c = ptc.filament_color_rgba?.[i];
    if (c && /^[0-9a-f]{6}/i.test(c)) $('[data-ff="color"]', tr).value = '#' + c.slice(0, 6).toLowerCase();
  });
}
function filRow(i) {
  const tr = $(`#bkForm tr[data-fh="${i}"]`);
  const v = (k) => $(`[data-ff="${k}"]`, tr).value.trim();
  return { type: v('type'), subtype: v('subtype'), vendor: v('vendor'), color: v('color').replace('#', '') + 'FF' };
}

async function savePresets(list) {
  config = await window.farm.setConfig({ filamentPresets: list });
}

async function loadExisting() {
  const ids = bk.ids.filter((id) => !elig('print', id));
  if (!ids.length) { $('#bkExisting').innerHTML = `<div class="offline-box">${t('bk.noIdle')}</div>`; return; }
  try {
    bk.existingList = await window.farm.bulkFilesOn(ids);
    bk.existingIds = ids;
    renderExisting();
  } catch (e) {
    $('#bkExisting').innerHTML = `<div class="offline-box">${t('files.failed')}</div>`;
  }
}
function renderExisting() {
  const q = ($('#bkSearch').value || '').toLowerCase();
  const rows = (bk.existingList || []).filter((f) => f.path.toLowerCase().includes(q)).slice(0, 300);
  $('#bkExisting').innerHTML = rows.map((f) => `<label class="frow pick${bk.existing?.path === f.path ? ' on' : ''}">
      <input type="radio" name="bkExFile" value="${esc(f.path)}" ${bk.existing?.path === f.path ? 'checked' : ''} />
      <div class="fi"><b title="${esc(f.path)}">${esc(cleanName(f.path))}</b>
      <span>${t('bk.onPrinters', { n: f.ids.length, total: bk.existingIds.length })} · ${new Date(f.modified * 1000).toLocaleString(L.locale)} · ${(f.size / 1048576).toFixed(1)} MB</span></div></label>`).join('')
    || `<div class="offline-box">${t('files.empty')}</div>`;
}

function renderPicked() {
  const f = bk.files;
  $('#bkFilesInfo').textContent = f.length ? t('bk.filesPicked', { n: f.length }) : t('bk.noFilesYet');
  $('#bkFiles').innerHTML = f.map((x) => {
    const i = x.info || {};
    const heads = (i.used || []).map((h) => `T${h}${i.types[h] ? ' ' + esc(i.types[h]) : ''}`).join(', ');
    const parts = [`${(i.size / 1048576).toFixed(1)} MB`];
    if (i.estimatedTime) parts.push(fmtDur(i.estimatedTime));
    if (i.weight) parts.push(`${Math.round(i.weight)} g`);
    if (heads) parts.push(t('bk.usesHeads', { h: heads }));
    return `<div class="frow"><div class="fi"><b>${esc(x.name)}</b><span>${parts.join(' · ')}</span></div></div>`;
  }).join('');
  const printRadio = $('input[name="bkMode"][value="print"]');
  printRadio.disabled = f.length !== 1;
  if (f.length !== 1 && bk.start) { $('input[name="bkMode"][value="upload"]').checked = true; bk.start = false; $('#bkPrintOpts').hidden = true; }
  printRadio.parentElement.title = f.length > 1 ? t('bk.onePrintFile') : '';
}

async function runBulk() {
  const op = bk.op;
  const ids = bk.okIds || [];
  if (!ids.length) return;
  let params = {};
  if (op === 'unload') {
    const mode = $('input[name="bkHeads"]:checked').value;
    const heads = mode === 'loaded' ? 'loaded' : $$('#bkForm [data-head]:checked').map((c) => Number(c.dataset.head));
    if (heads !== 'loaded' && !heads.length) return toast(t('fil.selectFirst'), true);
    params = { heads, parallel: Number($('#bkParallel').value) || 10 };
  } else if (op === 'filament') {
    const heads = {};
    $$('#bkForm [data-fon]:checked').forEach((c) => { heads[c.dataset.fon] = filRow(c.dataset.fon); });
    if (!Object.keys(heads).length) return toast(t('bk.pickHeadFil'), true);
    for (const f of Object.values(heads)) if (!f.type) return toast(t('bk.needType'), true);
    params = { heads, force: $('#bkForce').checked };
  } else if (op === 'send') {
    if (!bk.files.length) return toast(t('bk.noFile'), true);
    params = { files: bk.files.map((f) => ({ path: f.path, name: f.name, info: f.info })), start: bk.start };
    if (bk.start) {
      if (!$('#bkPlate').checked) return toast(t('bk.confirmPlate'), true);
      Object.assign(params, { stagger: Number($('#bkStagger').value) || 0, checkFilament: $('#bkCheckFil').checked });
    }
  } else if (op === 'print') {
    if (!bk.existing) return toast(t('bk.noFile'), true);
    if (!$('#bkPlate').checked) return toast(t('bk.confirmPlate'), true);
    params = { filename: bk.existing.path, stagger: Number($('#bkStagger').value) || 0, checkFilament: $('#bkCheckFil').checked };
  }
  try {
    const job = await window.farm.bulkRun(op, ids, params);
    // as atualizações por evento podem chegar antes desta resposta: não sobrescrever um estado mais novo
    if (!jobsMap[job.id] || (jobsMap[job.id].updated || 0) < (job.updated || 0)) jobsMap[job.id] = job;
    closeBulk();
    openJobs();
  } catch (e) {
    toast(t('error.prefix', { msg: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }), true);
  }
}

function openMore(ids) {
  const body = $('#bulkBody');
  bk = { op: 'more', ids };
  body.innerHTML = `<div class="dlg-head"><h2>${t('fm.moreTitle', { n: ids.length })}</h2><button class="btn ghost small" data-bk="close">✕</button></div>
    <div class="more-grid">
      <button class="btn" data-more="cooldown">${t('ctl.cool')}</button>
      <button class="btn" data-more="lightOn">${t('bk.op.lightOn')}</button>
      <button class="btn" data-more="lightOff">${t('bk.op.lightOff')}</button>
    </div>`;
  $('#bulk').showModal();
}

// eventos do diálogo
$('#bulkBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-bk],[data-more]');
  if (!b || !bk) return;
  if (b.dataset.more) { const ids = bk.ids; closeBulk(); return openBulk(b.dataset.more, ids); }
  const a = b.dataset.bk;
  if (a === 'close') return closeBulk();
  if (a === 'run') return runBulk();
  if (a === 'pick') {
    const files = await window.farm.bulkPickFiles();
    if (files.length) { bk.files = files; renderPicked(); renderTargets(); }
    return;
  }
  if (a === 'presetApply' || a === 'presetDel') {
    const i = $('#bkPreset').value;
    if (i === '') return toast(t('bk.presetPick'), true);
    const list = [...(config.filamentPresets || [])];
    if (a === 'presetDel') {
      list.splice(Number(i), 1);
      await savePresets(list);
      $('#bkPreset').innerHTML = `<option value="">${t('bk.presetPick')}</option>` + list.map((p, k) => `<option value="${k}">${esc(p.name)}</option>`).join('');
      return;
    }
    const pr = list[Number(i)];
    let rows = $$('#bkForm [data-fon]:checked').map((c) => c.dataset.fon);
    if (!rows.length) rows = ['0', '1', '2', '3'];
    for (const r of rows) {
      const tr = $(`#bkForm tr[data-fh="${r}"]`);
      $('[data-ff="type"]', tr).value = pr.type; $('[data-ff="subtype"]', tr).value = pr.subtype;
      $('[data-ff="vendor"]', tr).value = pr.vendor; $('[data-ff="color"]', tr).value = '#' + pr.color.slice(0, 6).toLowerCase();
      $(`[data-fon="${r}"]`).checked = true;
    }
    return;
  }
  if (a === 'presetSave') {
    const first = $('#bkForm [data-fon]:checked');
    const f = filRow(first ? first.dataset.fon : 0);
    const name = `${f.vendor} ${f.type} ${f.subtype} #${f.color.slice(0, 6)}`;
    const list = [...(config.filamentPresets || []).filter((p) => p.name !== name), { name, ...f }];
    await savePresets(list);
    $('#bkPreset').innerHTML = `<option value="">${t('bk.presetPick')}</option>` + list.map((p, k) => `<option value="${k}"${p.name === name ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    toast(t('bk.presetSaved', { name }));
  }
});
$('#bulkBody').addEventListener('input', (e) => {
  if (!bk) return;
  const tr = e.target.closest('tr[data-fh]');
  if (tr && e.target.dataset.ff) $(`[data-fon="${tr.dataset.fh}"]`).checked = true;
  if (e.target.id === 'bkSearch') renderExisting();
});
$('#bulkBody').addEventListener('change', (e) => {
  if (!bk) return;
  if (e.target.name === 'bkMode') { bk.start = e.target.value === 'print'; $('#bkPrintOpts').hidden = !bk.start; renderTargets(); }
  if (e.target.id === 'bkCheckFil') renderTargets();
  if (e.target.name === 'bkHeads' || e.target.dataset.head) {
    if (e.target.dataset.head) $('input[name="bkHeads"][value="pick"]').checked = true;
  }
  if (e.target.name === 'bkExFile') {
    bk.existing = bk.existingList.find((f) => f.path === e.target.value);
    renderExisting();
    renderTargets();
  }
});
$('#bulk').addEventListener('close', () => { bk = null; });

// ---------------- tarefas ----------------
const ICON = { pending: '⏳', running: '⚙', ok: '✅', error: '⛔', skipped: '⤼' };
function openJobs() { renderJobs(); $('#jobs').showModal(); }
function renderJobs() {
  const list = Object.values(jobsMap).sort((a, b) => b.created - a.created);
  const running = list.filter((j) => !j.done).length;
  $('#jobsBadge').hidden = !running;
  $('#jobsBadge').textContent = running;
  if (!$('#jobs').open) return;
  const openState = {};
  $$('#jobsList details[data-job]').forEach((d) => (openState[d.dataset.job] = d.open));
  $('#jobsList').innerHTML = list.map((j) => {
    const items = Object.entries(j.items);
    const c = { ok: 0, error: 0, skipped: 0, running: 0, pending: 0 };
    items.forEach(([, x]) => (c[x.status] = (c[x.status] || 0) + 1));
    const isOpen = openState[j.id] ?? !j.done;
    const time = new Date(j.created).toLocaleTimeString(L.locale, { hour: '2-digit', minute: '2-digit' });
    const order = { running: 0, pending: 1, error: 2, skipped: 3, ok: 4 };
    items.sort((a, b) => (order[a[1].status] - order[b[1].status]) || a[1].name.localeCompare(b[1].name, undefined, { numeric: true }));
    return `<details class="job" data-job="${j.id}" ${isOpen ? 'open' : ''}>
      <summary><span class="jt">${j.done ? '' : '<span class="spin">⚙</span> '}${t('bk.op.' + j.op)}</span> <span class="mut">${time}</span>
        <span class="jc">✅ ${c.ok} · ⛔ ${c.error} · ⤼ ${c.skipped}${j.done ? '' : ` · ⚙ ${c.running + c.pending}`}</span>
        ${!j.done ? `<button class="btn small ghost" data-stop="${j.id}" ${j.cancelRequested ? 'disabled' : ''}>${t('bk.stop')}</button>` : ''}</summary>
      <div class="jrows">${items.map(([, x]) => `<div class="jrow ${x.status}"><span>${ICON[x.status] || '•'}</span><b>${esc(x.name)}</b>
        <span class="jmsg">${esc(x.msg || '')}</span>${x.status === 'running' && x.pct != null ? `<div class="bar mini"><i style="width:${x.pct}%"></i></div><span class="mono">${x.pct}%</span>` : ''}</div>`).join('')}</div>
    </details>`;
  }).join('') || `<div class="offline-box">${t('fm.noJobs')}</div>`;
}
$('#jobsList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stop]');
  if (b) { e.preventDefault(); window.farm.bulkStop(b.dataset.stop); b.disabled = true; }
});
$('#jobsClose').addEventListener('click', () => $('#jobs').close());
$('#jobsClear').addEventListener('click', async () => {
  await window.farm.bulkClear();
  for (const [k, j] of Object.entries(jobsMap)) if (j.done) delete jobsMap[k];
  renderJobs();
});
$('#btnJobs').addEventListener('click', openJobs);

// ---------------- importação em massa nas configurações ----------------
function importLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[;\t,]/).map((x) => x.trim());
    let [name, host, group] = parts;
    // aceita também só o IP por linha
    if (parts.length === 1) { host = name; name = ''; }
    if (!/^[\w.-]+(:\d+)?$/.test(host || '')) continue;
    out.push({ name, host, group: group || '' });
  }
  return out;
}
$('#importApply').addEventListener('click', () => {
  const items = importLines($('#importBox').value);
  if (!items.length) return toast(t('fm.importNone'), true);
  const rows = $('#printerRows');
  const existing = new Set($$('#printerRows [data-k=host]').map((i) => i.value.trim()));
  let added = 0, n = rows.children.length;
  for (const it of items) {
    if (existing.has(it.host)) continue;
    existing.add(it.host);
    n++; added++;
    rows.appendChild(printerRow({ id: 'p' + Date.now() + '_' + n, name: it.name || `U1 - ${String(n).padStart(2, '0')}`, host: it.host, group: it.group }));
  }
  $('#importBox').value = '';
  toast(t('fm.imported', { n: added }));
});
// gera uma faixa: "192.168.0.101-150;Prateleira A"
$('#importRange').addEventListener('click', () => {
  const v = $('#importBox').value.trim();
  const m = v.match(/^(\d+\.\d+\.\d+\.)(\d+)\s*-\s*(\d+)\s*(?:[;,]\s*(.*))?$/);
  if (!m) return toast(t('fm.rangeHelp'), true);
  const [, base, a, b, group] = m;
  const from = Number(a), to = Number(b);
  if (!(from <= to && to <= 254 && to - from < 256)) return toast(t('fm.rangeHelp'), true);
  const lines = [];
  // continua a numeração depois das impressoras que já estão na lista
  const start = $('#printerRows').children.length + 1;
  for (let i = from, k = start; i <= to; i++, k++) lines.push(`U1 - ${String(k).padStart(2, '0')};${base}${i};${group || ''}`);
  $('#importBox').value = lines.join('\n');
});

// ---------------- eventos gerais ----------------
function initFarm() {
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    lsSet('view', b.dataset.view);
    rebuild();
  });
  $('#groupFilter').addEventListener('change', (e) => { lsSet('group', e.target.value); rebuild(); });
  $('#nameFilter').addEventListener('input', () => rebuild());
  $('#selAll').addEventListener('click', () => { visiblePrinters().forEach((p) => selected.add(p.id)); syncSelection(); });
  $('#selIdle').addEventListener('click', () => {
    selected.clear();
    visiblePrinters().filter((p) => IDLE_STATES.includes(stateOf(states[p.id]))).forEach((p) => selected.add(p.id));
    syncSelection();
  });
  $('#selNone').addEventListener('click', () => { selected.clear(); syncSelection(); });
  $('#selHeader').addEventListener('change', (e) => {
    visiblePrinters().forEach((p) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id)));
    syncSelection();
  });
  document.addEventListener('change', (e) => {
    const c = e.target.closest('input[data-sel]');
    if (!c) return;
    c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel);
    syncSelection();
  });
  // clicar na linha seleciona (como no Farm Manager); shift+clique seleciona um intervalo
  let lastRow = null;
  $('#listBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-row]');
    if (!tr) return;
    const p = byId(tr.dataset.row);
    const ra = e.target.closest('[data-ra]');
    if (ra) {
      if (ra.dataset.ra === 'files') return openFiles(p);
      if (ra.dataset.ra === 'web') return window.farm.openExternal(`http://${p.host}`);
      if (ra.dataset.ra === 'card') { lsSet('view', 'cards'); $('#nameFilter').value = p.name; return rebuild(); }
    }
    if (e.target.closest('input')) { lastRow = tr.dataset.row; return; }
    if (e.shiftKey && lastRow) {
      const ids = $$('#listBody tr[data-row]').map((r) => r.dataset.row);
      const [x, y] = [ids.indexOf(lastRow), ids.indexOf(tr.dataset.row)].sort((a, b) => a - b);
      ids.slice(x, y + 1).forEach((id) => selected.add(id));
    } else {
      selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id);
    }
    lastRow = tr.dataset.row;
    syncSelection();
  });
  $$('#list th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; }
    renderList(); syncSelection();
  }));
  $('#summary').addEventListener('click', (e) => {
    const c = e.target.closest('[data-stf]');
    if (!c) return;
    stateFilter = stateFilter === c.dataset.stf ? null : c.dataset.stf;
    rebuild();
  });
  $('#bulkActions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]');
    if (b) openBulk(b.dataset.bulk);
  });
  window.farm.onJob((j) => {
    if (jobsMap[j.id] && (jobsMap[j.id].updated || 0) > (j.updated || 0)) return;
    jobsMap[j.id] = j;
    renderJobs();
    if (bk) renderTargets();
  });
  window.farm.bulkJobs().then((list) => { list.forEach((j) => { if (!jobsMap[j.id]) jobsMap[j.id] = j; }); renderJobs(); });
  onRebuild();
  syncSelection();
}

// ---------------- versão + diagnóstico de conexão ----------------
window.farm.appInfo?.().then((i) => { $('#appVer').textContent = 'v' + i.version; }).catch(() => {});
let diagText = '';
$('#btnDiag').addEventListener('click', async () => {
  $('#diagBody').innerHTML = `<div class="offline-box">${t('dg.running')}</div>`;
  $('#diag').showModal();
  try {
    const r = await window.farm.diag();
    const lines = [`U1 Farm Control v${r.version} · ${r.platform} · ${r.transports.join(', ')}`];
    const html = r.printers.map((p) => {
      lines.push(`\n${p.name} (${p.host}) — ${p.state}${p.lastError ? ' — ' + p.lastError : ''}${p.proxy ? ' — proxy: ' + p.proxy : ''}`);
      p.tests.forEach((x) => lines.push(`  ${x.ok ? 'OK ' : 'ERRO'} ${x.path}: ${x.msg}`));
      return `<div class="job"><div class="jrows" style="padding-top:10px"><b>${esc(p.name)}</b> <span class="mut">${esc(p.host)} · ${esc(p.proxy || '')}</span>
        ${p.tests.map((x) => `<div class="jrow ${x.ok ? 'ok' : 'error'}"><span>${x.ok ? '✅' : '⛔'}</span><b>${esc(x.path)}</b><span class="jmsg">${esc(x.msg)}</span></div>`).join('')}</div></div>`;
    }).join('');
    diagText = lines.join('\n');
    $('#diagBody').innerHTML = `<p class="mut">${esc(lines[0])}</p>${html}`;
  } catch (e) {
    diagText = String(e.message || e);
    $('#diagBody').innerHTML = `<div class="offline-box">${esc(diagText)}</div>`;
  }
});
$('#diagCopy').addEventListener('click', () => { navigator.clipboard.writeText(diagText).then(() => toast(t('dg.copied'))); });
$('#diagClose').addEventListener('click', () => $('#diag').close());
