// TableRenderer — purpose-built renderer for the correction table.
// Rows = speed bins (knots), columns = heel bins (degrees).
// Each learned cell shows factor deviation (±%) and leeway (°).
// Background encodes factor and leeway; a bottom bar encodes fusion weight.
// Active cell (last updated) gets a thin black border.

const RAD_TO_DEG = 180 / Math.PI;
const MPS_TO_KNOTS = 1.943844;

const DEFAULT_SPEED_SYMBOL = 'kn';
const DEFAULT_HEEL_SYMBOL  = '°';

const MARKER_CORRECTED_COLOR = '#0d6efd';
const MARKER_RAW_COLOR = '#dc3545';
const MARKER_DOT_RADIUS = 8;
function fmtSpeed(mps)  { return (mps * MPS_TO_KNOTS).toFixed(1); }
function fmtHeel(rad)   { return (rad * RAD_TO_DEG).toFixed(0); }
function fmtFactor(f)   { const p = (f - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }
function fmtLeeway(rad) { const d = rad * RAD_TO_DEG; return (d >= 0 ? '+' : '') + d.toFixed(0) + '°'; }

class TableRenderer {

  // opts.fmtSpeed / opts.fmtHeel: optional unit-aware formatter functions.
  // Fall back to the module-level fmtSpeed / fmtHeel when not provided.
  render(data, opts = {}) {
    const { id, row, col, table, displayAttributes } = data;
    const label = displayAttributes?.label ?? '';
    const maxDev = this._computeMaxDev(table);
    const fmtSpeedFn  = opts.fmtSpeed    || fmtSpeed;
    const fmtHeelFn   = opts.fmtHeel     || fmtHeel;
    const speedSymbol = opts.speedSymbol || DEFAULT_SPEED_SYMBOL;
    const heelSymbol  = opts.heelSymbol  || DEFAULT_HEEL_SYMBOL;
    const cornerText  = `${speedSymbol} / ${heelSymbol}`;

    const el = document.createElement('table');
    el.id = id;
    el.classList.add('Table2D');
    el.appendChild(this._headerRow(col, cornerText, fmtHeelFn));

    let rIndex = 0;
    for (let r = row.min; r <= row.max + 0.01; r += row.step) {
      el.appendChild(this._dataRow(r, rIndex, col, table, maxDev, fmtSpeedFn));
      rIndex++;
    }

    const wrap = document.createElement('div');
    wrap.classList.add('Table2D-wrap');
    wrap.appendChild(el);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('Table2D-markers');
    wrap.appendChild(svg);
    return wrap;
  }

  // Overlay a dot for the uncorrected (raw) speed and a dot for the corrected
  // speed, both positioned at the raw heel column.
  // wrap: the element returned by render(). row/col: the table's axis config
  // ({min,max,step}). marker: { rawSpeed, heel, correctedSpeed } in raw (SI)
  // units, or null/undefined to clear the overlay.
  renderMarkers(wrap, row, col, marker) {
    const svg = wrap.querySelector('.Table2D-markers');
    const table = wrap.querySelector('.Table2D');
    if (!svg || !table) return;
    svg.innerHTML = '';
    if (!marker) return;
    const { rawSpeed, heel, correctedSpeed } = marker;
    if (![rawSpeed, heel, correctedSpeed].every(Number.isFinite)) return;

    const wrapRect = wrap.getBoundingClientRect();
    svg.setAttribute('width', wrapRect.width);
    svg.setAttribute('height', wrapRect.height);

    const rowHeaders = [...table.querySelectorAll('th.TableRowHeader:not(.TableCorner)')];
    const colHeaders = [...table.querySelectorAll('th.TablecolumnHeader')];
    if (!rowHeaders.length || !colHeaders.length) return;

    const centerY = rowHeaders.map(th => {
      const r = th.getBoundingClientRect();
      return (r.top + r.bottom) / 2 - wrapRect.top;
    });
    const centerX = colHeaders.map(th => {
      const r = th.getBoundingClientRect();
      return (r.left + r.right) / 2 - wrapRect.left;
    });

    const x       = this._lerpAxis(centerX, (heel - col.min) / col.step);
    const yRaw    = this._lerpAxis(centerY, (rawSpeed - row.min) / row.step);
    const yCorr   = this._lerpAxis(centerY, (correctedSpeed - row.min) / row.step);

    svg.appendChild(this._markerDot(x, yRaw, MARKER_RAW_COLOR));
    svg.appendChild(this._markerDot(x, yCorr, MARKER_CORRECTED_COLOR));
  }

  // Interpolate a continuous axis index (may be fractional, out of range) against
  // an array of known pixel centers for each axis bin.
  _lerpAxis(centers, frac) {
    const n = centers.length;
    const f = Math.max(0, Math.min(n - 1, frac));
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, n - 1);
    const t = f - i0;
    return centers[i0] + (centers[i1] - centers[i0]) * t;
  }

  _markerDot(x, y, color) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', MARKER_DOT_RADIUS);
    circle.setAttribute('fill', color);
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', 1);
    return circle;
  }

  _headerRow(col, cornerText, fmtHeelFn) {
    const tr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.textContent = cornerText;
    th0.classList.add('TableRowHeader', 'TableCorner');
    tr.appendChild(th0);
    for (let c = col.min; c <= col.max + 0.01; c += col.step) {
      const th = document.createElement('th');
      th.textContent = fmtHeelFn(c);
      th.classList.add('TablecolumnHeader');
      tr.appendChild(th);
    }
    return tr;
  }

  _dataRow(r, rIndex, col, table, maxDev, fmtSpeedFn) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = fmtSpeedFn(r);
    th.classList.add('TableRowHeader');
    tr.appendChild(th);
    let cIndex = 0;
    for (let c = col.min; c <= col.max + 0.01; c += col.step) {
      tr.appendChild(this._cellElement(table[rIndex][cIndex], maxDev));
      cIndex++;
    }
    return tr;
  }

  _cellElement(cell, maxDev) {
    const td = document.createElement('td');
    td.classList.add('TableCell');

    if (!cell || cell.N === 0) {
      td.classList.add('cell--empty');
      return td;
    }

    const factor = Number.isFinite(cell.factor) ? cell.factor : null;
    const leeway = Number.isFinite(cell.leeway) ? cell.leeway : null;

    if (factor !== null) {
      const d = document.createElement('div');
      d.className = 'cell-factor';
      d.textContent = fmtFactor(factor);
      td.appendChild(d);
      const color = this._factorColor(factor, maxDev);
      if (leeway !== null) {
        const angleDeg = 90 + leeway * RAD_TO_DEG;
        td.style.background = `repeating-linear-gradient(
          ${angleDeg}deg,
          ${color} 0px, ${color} 9px,
          #f0f0f0 9px, #f0f0f0 10px
        )`;
      } else {
        td.style.backgroundColor = color;
      }
    }
    if (leeway !== null) {
      const d = document.createElement('div');
      d.className = 'cell-leeway';
      d.textContent = fmtLeeway(leeway);
      td.appendChild(d);
    }

    const attrs = cell.displayAttributes;
    if (Number.isFinite(attrs?.normWeight) && attrs.normWeight > 0) {
      const d = document.createElement('div');
      d.className = 'cell-weight';
      const weight = Math.max(0, Math.min(1, attrs.normWeight));
      d.style.width = `${weight * 100}%`;
      d.title = `Fusion weight ${(weight * 100).toFixed(1)}%`;
      td.appendChild(d);
    }
    if (attrs?.selected) td.classList.add('cell--active');

    return td;
  }

  _computeMaxDev(table) {
    let maxDev = 0;
    for (const row of table) {
      for (const cell of row) {
        if (!cell || cell.N === 0 || !Number.isFinite(cell.factor)) continue;
        const dev = Math.abs(cell.factor - 1);
        if (dev > maxDev) maxDev = dev;
      }
    }
    return maxDev || 0.05;
  }

  _factorColor(factor, maxDev) {
    if (!Number.isFinite(factor)) return '';
    const dev = factor - 1;
    if (Math.abs(dev) < 1e-6) return '';
    const intensity = Math.min(1, Math.abs(dev) / maxDev);
    if (dev < 0) {
      return `rgb(255,${Math.round(255 - 90 * intensity)},${Math.round(255 * (1 - intensity))})`;
    }
    return `rgb(${Math.round(255 * (1 - intensity))},${Math.round(255 - 95 * intensity)},${Math.round(255 - 175 * intensity)})`;
  }
}

export default TableRenderer;