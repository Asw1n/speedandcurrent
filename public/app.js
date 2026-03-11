import TableRenderer from './TableRenderer.js';

const API_BASE = '/plugins/speedandcurrent';

// ─── Unit conversion (knots / degrees, fixed) ───────────────────────────────
const vAngle = 180 / Math.PI;
const dAngle = 0;
const vSpeed = 1.943844;
const dSpeed = 1;

function cAngle(v) { return (v * vAngle).toFixed(dAngle); }
function cSpeed(v) { return (v * vSpeed).toFixed(dSpeed); }

// ─── TableRenderer instance ───────────────────────────────────────────────────
const tableRenderer = new TableRenderer();

// ─── Live state (indexed + raw arrays) ───────────────────────────────────────
let state = {
  polarsAll: [], deltasAll: [], attitudesAll: [],
  polarsById: {}, deltasById: {}, attitudesById: {},
  tablesById: {}
};

function normaliseState(data) {
  // reporter.report() returns { polars: {[id]:item}, deltas: {[id]:item},
  //                             tables: {[id]:item}, attitudes: {[id]:item} }
  const polarsById    = {};
  const deltasById    = {};
  const attitudesById = {};
  const tablesById    = {};
  for (const [id, v] of Object.entries(data.polars    || {})) polarsById[id]    = { ...v, id };
  for (const [id, v] of Object.entries(data.deltas    || {})) deltasById[id]    = { ...v, id };
  for (const [id, v] of Object.entries(data.attitudes || {})) attitudesById[id] = { ...v, id };
  for (const [id, v] of Object.entries(data.tables    || {})) tablesById[id]    = { ...v, id };
  const polarsAll    = Object.values(polarsById);
  const deltasAll    = Object.values(deltasById);
  const attitudesAll = Object.values(attitudesById);
  state = { polarsAll, deltasAll, attitudesAll, polarsById, deltasById, attitudesById, tablesById };
}

// ─── Static meta (fetched once at startup from /api/meta) ─────────────────────
let metaById = {}; // keyed by item id

async function loadMeta() {
  const data = await apiGet('/api/meta');
  if (!data) return;
  // reporter.meta() returns { polars: {[id]:meta}, deltas: {[id]:meta}, ... }
  // Flatten into a single metaById lookup.
  metaById = {};
  for (const category of ['polars', 'deltas', 'attitudes', 'tables']) {
    const bucket = data[category] || {};
    for (const [id, m] of Object.entries(bucket)) {
      metaById[id] = { ...m, id };
    }
  }
}

function isStale(item) {
  if (!item) return true;
  return item.state?.stale === true;
}

// ─── Config (live settings mirror) ───────────────────────────────────────────
let config = null;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiGet(path) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin' });
  } catch (err) {
    showMessage(`Cannot reach server: ${err.message}`);
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    showMessage('Not signed in. Please <a href="/">sign in</a>.', true);
    return null;
  }
  if (res.status === 503) { showMessage('Plugin is not running.'); return null; }
  if (!res.ok) { showMessage(`Server error ${res.status}`); return null; }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) { showMessage('Unexpected server response.'); return null; }
  showMessage('');
  return res.json();
}

// PUT /api/settings: server returns full merged config — store it and re-render.
async function apiPutSettings(body) {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  config = await res.json();
  renderSettingsPanel();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  return res.json();
}

function showMessage(html, isLink = false) {
  const el = document.getElementById('message');
  if (!el) return;
  if (isLink) el.innerHTML = html;
  else el.textContent = html;
}

// ─── Settings: paramMeta ──────────────────────────────────────────────────────
// Each entry: { label, type, min?, max?, step?, default?, sourceOf? }
// sourceOf: { type:'polar'|'delta'|'attitude', id }
//   For polars: sources come from item.state.magnitude.sources
//   For deltas/attitudes: sources come from item.state.sources
const paramMeta = {
  estimateBoatSpeed:     { label: 'Estimate boat speed',                  type: 'boolean' },
  updateCorrectionTable: { label: 'Update correction table',              type: 'boolean' },
  assumeCurrent:         { label: 'Assume current during update',         type: 'boolean' },
  sogFallback:           { label: 'Groundspeed fallback',                 type: 'boolean', description: 'Output Groundspeed as Boatspeed when the paddlewheel sensor is malfunctioning or stalled.' },
  preventDuplication:    { label: 'Prevent speed duplication',            type: 'boolean', description: 'Replace the raw sensor boatspeed on the Signal K bus with the corrected value, preventing duplicate conflicting values.' },
  stability:             { label: 'Stability (1–20)',                     type: 'number', min: 1, max: 20, step: 1, default: 7, description: 'How quickly the correction table adapts to new observations. Higher values mean slower, more stable changes.' },
  headingSource:  { label: 'Heading source',          type: 'source', sourceOf: { type: 'delta',   id: 'heading.smoothed'     } },
  boatSpeedSource:{ label: 'Boat speed source',       type: 'source', sourceOf: { type: 'polar',   id: 'boatSpeed.smoothed'   } },
  SOGSource:      { label: 'Groundspeed source',      type: 'source', sourceOf: { type: 'polar',   id: 'groundSpeed.smoothed' } },
  attitudeSource: { label: 'Attitude source',         type: 'source', sourceOf: { type: 'attitude',id: 'attitude.smoothed'    } },
};

// Settings groups for each UI section
const INPUTS_SOURCE_KEYS      = ['headingSource','boatSpeedSource','SOGSource','attitudeSource'];
const ESTIMATION_SETTING_KEYS = ['sogFallback','preventDuplication'];
const LEARNING_SETTING_KEYS   = ['stability','assumeCurrent'];

function getStateItem(sourceOf) {
  if (!sourceOf) return null;
  switch (sourceOf.type) {
    case 'polar':    return state.polarsById[sourceOf.id];
    case 'delta':    return state.deltasById[sourceOf.id];
    case 'attitude': return state.attitudesById[sourceOf.id];
    default:         return null;
  }
}

function getSources(sourceOf) {
  const item = getStateItem(sourceOf);
  if (!item) return [];
  if (sourceOf.type === 'polar') {
    return Array.isArray(item.state?.magnitude?.sources) ? item.state.magnitude.sources : [];
  }
  // SmoothedHeading is a PolarSmoother reported as a delta; its sources are under state.angle
  return Array.isArray(item.state?.sources) ? item.state.sources
       : Array.isArray(item.state?.angle?.sources) ? item.state.angle.sources
       : [];
}

// Build one settings control for a key.
function createSettingControl(key, meta, value) {
  if (meta.type === 'boolean') {
    const lbl = document.createElement('label');
    lbl.className = 'switch switch-text switch-primary';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'switch-input form-check-input'; cb.checked = !!value;
    cb.addEventListener('change', () => apiPutSettings({ [key]: cb.checked }).catch(e => showMessage(`Save failed: ${e.message}`)));
    const sl = document.createElement('span');
    sl.className = 'switch-label'; sl.setAttribute('data-on', 'On'); sl.setAttribute('data-off', 'Off');
    const sh = document.createElement('span');
    sh.className = 'switch-handle';
    lbl.appendChild(cb); lbl.appendChild(sl); lbl.appendChild(sh);
    return lbl;
  }

  if (meta.type === 'number') {
    const wrap = document.createElement('span');
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'form-control form-control-sm d-inline-block';
    inp.style.width = '80px';
    inp.value = value !== undefined ? value : (meta.default !== undefined ? meta.default : '');
    if (meta.min !== undefined) inp.min = meta.min;
    if (meta.max !== undefined) inp.max = meta.max;
    if (meta.step !== undefined) inp.step = meta.step;
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) apiPutSettings({ [key]: v }).catch(e => showMessage(`Save failed: ${e.message}`));
    });
    wrap.appendChild(inp);
    if (meta.default !== undefined && value !== meta.default) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-link btn-sm p-0 ms-1';
      btn.title = `Reset to default (${meta.default})`;
      btn.textContent = '↺';
      btn.addEventListener('click', () => apiPutSettings({ [key]: meta.default }).catch(e => showMessage(`Save failed: ${e.message}`)));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  if (meta.type === 'source') {
    if (meta.disabled) {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'form-control form-control-sm';
      inp.value = (value || '').trim(); inp.disabled = true; inp.style.opacity = '0.5';
      return inp;
    }
    const sel = document.createElement('select');
    sel.className = 'form-select form-select-sm d-inline-block';
    sel.style.width = '200px';
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '(any)';
    sel.appendChild(blank);
    const sources = meta.sourceOf ? getSources(meta.sourceOf) : [];
    sources.forEach(src => {
      const opt = document.createElement('option');
      opt.value = src; opt.textContent = src;
      sel.appendChild(opt);
    });
    sel.value = (value || '').trim();
    sel.addEventListener('change', () => {
      apiPutSettings({ [key]: sel.value || ' ' }).catch(e => showMessage(`Save failed: ${e.message}`));
    });
    return sel;
  }

  // fallback: text input
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'form-control form-control-sm';
  inp.value = (value || '').trim();
  let debounce;
  inp.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => apiPutSettings({ [key]: inp.value.trim() || ' ' }).catch(e => showMessage(`Save failed: ${e.message}`)), 600);
  });
  return inp;
}

function renderSettingsRows(tableId, keys) {
  const table = document.getElementById(tableId);
  const tbody = table && table.querySelector('tbody');
  if (!tbody || !config) return;
  tbody.innerHTML = '';
  keys.forEach(key => {
    const meta = paramMeta[key];
    if (!meta) return;
    const value = config[key];
    const tr = document.createElement('tr');
    const tdL = document.createElement('td');
    tdL.textContent = meta.label;
    if (meta.description) {
      const desc = document.createElement('small');
      desc.className = 'text-muted d-block';
      desc.textContent = meta.description;
      tdL.appendChild(desc);
    }
    const tdC = document.createElement('td'); tdC.appendChild(createSettingControl(key, meta, value));
    tr.appendChild(tdL); tr.appendChild(tdC);
    tbody.appendChild(tr);
  });
}

function renderSectionToggles() {
  if (!config) return;
  [['toggle-estimateBoatSpeed', 'estimateBoatSpeed'], ['toggle-updateCorrectionTable', 'updateCorrectionTable']].forEach(([id, key]) => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.checked = !!config[key];
    cb.onchange = () => apiPutSettings({ [key]: cb.checked }).catch(e => showMessage(`Save failed: ${e.message}`));
  });
}

function renderSettingsPanel() {
  if (!config) return;
  renderSettingsRows('inputs-sources-table',      INPUTS_SOURCE_KEYS);
  renderSettingsRows('estimation-settings-table', ESTIMATION_SETTING_KEYS);
  renderSettingsRows('learning-settings-table',   LEARNING_SETTING_KEYS);
  renderSectionToggles();
}

// ─── Live data rendering ─────────────────────────────────────────────────────

function formatPolarValue(p) {
  if (!p) return '—';
  const spd = typeof p.magnitude === 'number' ? cSpeed(p.magnitude) : '—';
  const ang = typeof p.angle    === 'number' ? cAngle(p.angle)      : '—';
  return `${spd} kn / ${ang}°`;
}

function formatDeltaValue(d) {
  if (!d || typeof d.value !== 'number') return '—';
  const units = metaById[d.id]?.units;
  return units === 'm/s' ? `${cSpeed(d.value)} kn` : `${cAngle(d.value)}°`;
}

function formatAttitudeValue(a) {
  const v = (a && a.value) || {};
  const roll  = typeof v.roll  === 'number' ? cAngle(v.roll)  : '—';
  const pitch = typeof v.pitch === 'number' ? cAngle(v.pitch) : '—';
  return `roll ${roll}° / pitch ${pitch}°`;
}

function itemLabel(item) {
  return metaById[item.id]?.displayName ?? item.path ?? item.id;
}

function buildDataTable(rows) {
  const tbl = document.createElement('table');
  tbl.className = 'table table-sm table-borderless mb-0';
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    if (row.stale) tr.className = 'stale';
    const tdL = document.createElement('td'); tdL.textContent = row.label;
    const tdV = document.createElement('td'); tdV.textContent = row.value;
    tr.appendChild(tdL); tr.appendChild(tdV);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  return tbl;
}

// ─── Section rendering ───────────────────────────────────────────────────────
// Items are routed by explicit ID lists per section.
// Raw handlers have plain IDs ('boatSpeed', 'groundSpeed', 'attitude') — present when
// estimateBoatSpeed is enabled. Smoothed wrappers have '<id>.smoothed' IDs — present when
// updateCorrectionTable is enabled.

function filterById(arr, ids) {
  return ids.flatMap(id => {
    const item = arr.find(item => item.id === id);
    return item ? [item] : [];
  });
}

function renderGroupInto(elId, polars, deltas, attitudes) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const rows = [
    ...polars   .map(p => ({ label: itemLabel(p), value: formatPolarValue(p),    stale: isStale(p) })),
    ...deltas   .map(d => ({ label: itemLabel(d), value: formatDeltaValue(d),    stale: isStale(d) })),
    ...attitudes.map(a => ({ label: itemLabel(a), value: formatAttitudeValue(a), stale: isStale(a) }))
  ];
  if (rows.length) el.appendChild(buildDataTable(rows));
}

function renderLiveSections() {
  // Inputs section — raw sensor readings only (smoothing is internal to the plugin)
  renderGroupInto('inputs-values',
    filterById(state.polarsAll,    ['boatSpeed', 'groundSpeed']),
    filterById(state.deltasAll,    ['heading.angle']),
    filterById(state.attitudesAll, ['attitude'])
  );

  // Estimation — inputs (raw sensor data used for boat speed estimation)
  renderGroupInto('estimation-inputs',
    filterById(state.polarsAll,    ['boatSpeed', 'groundSpeed']),
    filterById(state.deltasAll,    ['heading.angle']),
    filterById(state.attitudesAll, ['attitude'])
  );
  // Estimation — intermediates
  renderGroupInto('estimation-intermediates',
    filterById(state.polarsAll, ['boatSpeedRefGround', 'speedCorrection']),
    [], []
  );
  // Estimation — outputs
  renderGroupInto('estimation-outputs',
    filterById(state.polarsAll, ['correctedBoatSpeed', 'current.smoothed']),
    [], []
  );

  // Learning — inputs: smoothed sensors + current if assumeCurrent
  const learningCurrentPolars = (config && config.assumeCurrent)
    ? filterById(state.polarsAll, ['current.smoothed'])
    : [];
  renderGroupInto('learning-inputs',
    [...filterById(state.polarsAll, ['boatSpeed.smoothed', 'groundSpeed.smoothed']), ...learningCurrentPolars],
    filterById(state.deltasAll,    ['heading.smoothed']),
    filterById(state.attitudesAll, ['attitude.smoothed'])
  );
  // Learning — intermediates
  renderGroupInto('learning-intermediates',
    filterById(state.polarsAll, ['residual']),
    [], []
  );
  // Correction table
  const tableEl = document.getElementById('table-container');
  if (tableEl) {
    tableEl.innerHTML = '';
    Object.values(state.tablesById).forEach(t => tableEl.appendChild(tableRenderer.render(t)));
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
let updateTimer = null;

async function tick() {
  const data = await apiGet('/api/report');
  if (data) {
    normaliseState(data);
    renderLiveSections();
  }
}

function startUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(tick, 1000);
}



// ─── Vanilla modal helpers ────────────────────────────────────────────────────

function showModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  if (!document.getElementById('app-modal-backdrop')) {
    const bd = document.createElement('div');
    bd.id = 'app-modal-backdrop';
    bd.className = 'modal-backdrop show';
    document.body.appendChild(bd);
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.style.display = 'none'; el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
  document.body.classList.remove('modal-open');
  const bd = document.getElementById('app-modal-backdrop');
  if (bd) bd.remove();
}

// ─── Correction table manager ─────────────────────────────────────────────────

function setTableName(name) {
  const el = document.getElementById('active-table-name');
  if (el) el.textContent = name ? `(${name})` : '';
}

function modalStatus(modalId, msg, ok = false) {
  const el = document.getElementById('modal-' + modalId + '-status');
  if (el) { el.textContent = msg; el.className = 'small mr-auto ' + (ok ? 'text-success' : 'text-danger'); }
}

function initTableManager() {
  if (config && config.tableName) setTableName(config.tableName);

  // Wire close/cancel buttons and click-outside for each modal
  ['modal-create', 'modal-load', 'modal-copy', 'modal-resize'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll('.close, [data-dismiss="modal"]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(id));
    });
    el.addEventListener('click', e => { if (e.target === el) closeModal(id); });
  });

  // ── New ──
  document.getElementById('btn-tbl-new')?.addEventListener('click', () => {
    modalStatus('create', '');
    showModal('modal-create');
  });

  // ── Load ──
  document.getElementById('btn-tbl-load')?.addEventListener('click', async () => {
    const listEl = document.getElementById('table-list');
    const confirmBtn = document.getElementById('btn-load-confirm');
    if (listEl) listEl.innerHTML = '<li class="list-group-item text-muted small">Loading…</li>';
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.onclick = null; }
    modalStatus('load', '');
    showModal('modal-load');
    let selectedName = null;
    const tables = await apiGet('/api/tables');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!tables || tables.length === 0) {
      listEl.innerHTML = '<li class="list-group-item text-muted small">No saved tables found.</li>';
      return;
    }
    tables.forEach(t => {
      const li = document.createElement('li');
      li.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center'
        + (t.active ? ' active' : '');
      const span = document.createElement('span');
      span.textContent = t.name;
      li.appendChild(span);
      if (t.active) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-light';
        badge.textContent = 'active';
        li.appendChild(badge);
      }
      li.addEventListener('click', () => {
        listEl.querySelectorAll('li').forEach(l => l.classList.remove('active'));
        li.classList.add('active');
        selectedName = t.name;
        if (confirmBtn) confirmBtn.disabled = false;
      });
      listEl.appendChild(li);
    });
    if (confirmBtn) {
      confirmBtn.onclick = async () => {
        if (!selectedName) return;
        modalStatus('load', '');
        try {
          const r = await apiPost('/api/tables/load', { name: selectedName });
          setTableName(r.name);
          if (config) config.tableName = r.name;
          closeModal('modal-load');
          await tick();
        } catch (e) { modalStatus('load', e.message); }
      };
    }
  });

  // ── Copy ──
  document.getElementById('btn-tbl-copy')?.addEventListener('click', () => {
    modalStatus('copy', '');
    showModal('modal-copy');
  });

  // ── Resize ──
  document.getElementById('btn-tbl-resize')?.addEventListener('click', () => {
    modalStatus('resize', '');
    const t = Object.values(state.tablesById)[0];
    if (t && t.row && t.col) {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = +v.toFixed(3); };
      set('resize-maxSpeed',  t.row.max  * 1.943844);
      set('resize-speedStep', t.row.step * 1.943844);
      set('resize-maxHeel',   t.col.max  * (180 / Math.PI));
      set('resize-heelStep',  t.col.step * (180 / Math.PI));
    }
    showModal('modal-resize');
  });

  // ── Create confirm ──
  document.getElementById('btn-create-confirm')?.addEventListener('click', async () => {
    modalStatus('create', '');
    const body = {
      name:      (document.getElementById('create-name')?.value || '').trim(),
      maxSpeed:  Number(document.getElementById('create-maxSpeed')?.value),
      speedStep: Number(document.getElementById('create-speedStep')?.value),
      maxHeel:   Number(document.getElementById('create-maxHeel')?.value),
      heelStep:  Number(document.getElementById('create-heelStep')?.value),
    };
    if (!body.name) { modalStatus('create', 'Name is required.'); return; }
    try {
      const r = await apiPost('/api/tables/create', body);
      setTableName(r.name);
      if (config) config.tableName = r.name;
      closeModal('modal-create');
      await tick();
    } catch (e) { modalStatus('create', e.message); }
  });

  // ── Copy confirm ──
  document.getElementById('btn-copy-confirm')?.addEventListener('click', async () => {
    modalStatus('copy', '');
    const newName = (document.getElementById('copy-name')?.value || '').trim();
    if (!newName) { modalStatus('copy', 'New name is required.'); return; }
    try {
      const r = await apiPost('/api/tables/copy', { newName });
      setTableName(r.name);
      if (config) config.tableName = r.name;
      closeModal('modal-copy');
      await tick();
    } catch (e) { modalStatus('copy', e.message); }
  });

  // ── Resize confirm ──
  document.getElementById('btn-resize-confirm')?.addEventListener('click', async () => {
    modalStatus('resize', '');
    const body = {
      maxSpeed:  Number(document.getElementById('resize-maxSpeed')?.value),
      speedStep: Number(document.getElementById('resize-speedStep')?.value),
      maxHeel:   Number(document.getElementById('resize-maxHeel')?.value),
      heelStep:  Number(document.getElementById('resize-heelStep')?.value),
    };
    if (!Object.values(body).every(v => Number.isFinite(v) && v > 0)) {
      modalStatus('resize', 'All dimensions must be positive numbers.');
      return;
    }
    try {
      await apiPost('/api/tables/resize', body);
      closeModal('modal-resize');
      await tick();
    } catch (e) { modalStatus('resize', e.message); }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  initTableManager();

  config = await apiGet('/api/settings');
  if (config && config.tableName) setTableName(config.tableName);
  renderSettingsPanel();

  await loadMeta();
  await tick();
  // Re-render settings after first tick so source dropdowns are populated
  renderSettingsPanel();
  startUpdates();
}

window.addEventListener('DOMContentLoaded', () => {
  start();
});
