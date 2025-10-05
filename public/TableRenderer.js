class TableRenderer {
  constructor() {
    this.formatColumnHeader = this.defaultDisplay;
    this.formatRowHeader = this.defaultDisplay;
    this.formatCell = this.defaultDisplay;
    this.colorMode = 'none';
    this.cachedExtents = {}; // store min/max per mode
  }

  setColumnHeaderFormat(columnHeader) {
    columnHeader != null ? this.formatColumnHeader = columnHeader : this.formatColumnHeader = this.defaultDisplay;
  }

  setRowHeaderFormat(rowHeader) {
    rowHeader != null ? this.formatRowHeader = rowHeader : this.formatRowHeader = this.defaultDisplay;
  }

  setCellFormat(cell) {
    cell != null ? this.formatCell = cell : this.formatCell = this.defaultDisplay;
  }

  // Removed legacy X/Y specific formatting.

  render(data) {
    const {id, row, col, table, displayAttributes } = data;
    this.data = data;
    const label = displayAttributes && displayAttributes.label ? displayAttributes.label : "";

    // Pre-compute extents for color modes (skip weight which is already normalized)
    this.computeExtents(table);
    
    // Create a table element
    const tableElement = document.createElement('table');
  
    tableElement.id = id;
    tableElement.classList.add('Table2D');
    // create header row
    tableElement.appendChild(this.headerRow(col, label));

    // Create other rows 
    var rIndex = 0;
    for (let r = row.min; r <= row.max + 0.01; r += row.step) {
      tableElement.appendChild(this.tableRow(r, rIndex, col, table));
      rIndex++;
    }
    return tableElement;
  }

  headerRow(col, label) {
    // Create label cell
    const headerRow = document.createElement('tr');
    const firstHeaderCell = document.createElement('th');
    firstHeaderCell.innerText = label ? label : ''; 
    firstHeaderCell.classList.add('TableRowHeader');
    headerRow.appendChild(firstHeaderCell);
  
    // Create header row 
    for (let c = col.min; c <= col.max + 0.01; c += col.step) {
      const headerCell = document.createElement('th');
      headerCell.innerHTML = this.formatColumnHeader(c);
      headerCell.classList.add('TablecolumnHeader');
      headerRow.appendChild(headerCell);
    }
    return headerRow;
  }

  rowLabel(r) {
    const headerCell = document.createElement('th');
    headerCell.innerHTML = this.formatRowHeader(r);
    //headerCell.innerText = `${cSpeed(r)} `;
    headerCell.classList.add('TableRowHeader');
    return headerCell;
  }

  tableRow(r, rIndex, col, table) {
    var cIndex = 0;
    const rowElement = document.createElement('tr');
    rowElement.appendChild(this.rowLabel(r));
    for (let c = col.min; c <= col.max + 0.01; c += col.step) {
      const cell = document.createElement('td');
      cell.classList.add('TableCell');
      const value = table[rIndex][cIndex];
      const text = this.formatCell(value, r, c);
      if (text != null) {
         cell.innerHTML = text;
      }
      else {
      cell.classList.add('emptyCell');
      }
      if (value.displayAttributes && value.displayAttributes.selected) {
        cell.classList.add('selectedCell');
        //console.log(value);
      }
      // Apply coloring based on selected color mode
      this.applyColor(cell, value, table);

      rowElement.appendChild(cell);
      cIndex++;
    }
    return rowElement;
  }

  defaultDisplay(value) {
    return value.toFixed(2);
  }

  setColorMode(mode) {
    this.colorMode = mode || 'none';
  }

  computeExtents(table) {
    if (!Array.isArray(table)) return;
  const modesToCompute = ['leeway','factor','trace'];
    const accum = {};
    for (const m of modesToCompute) {
      accum[m] = {min: Infinity, max: -Infinity};
    }
    for (const row of table) {
      for (const cell of row) {
        if (!cell || cell.N === 0) continue;
        const {x,y} = cell;
        // Prefer server-provided leeway for consistent scaling; fallback to placeholder
        const leeway = Number.isFinite(cell.leeway)
          ? cell.leeway
          : (Number.isFinite(y) && Number.isFinite(x) ? Math.atan2(y, 1) : null);
        if (leeway != null) {
          if (leeway < accum.leeway.min) accum.leeway.min = leeway;
          if (leeway > accum.leeway.max) accum.leeway.max = leeway;
        }
        if (Number.isFinite(cell.factor)) {
          const f = cell.factor;
            if (f < accum.factor.min) accum.factor.min = f;
            if (f > accum.factor.max) accum.factor.max = f;
        }
        if (Number.isFinite(cell.trace)) {
          const t = cell.trace;
          if (t < accum.trace.min) accum.trace.min = t;
          if (t > accum.trace.max) accum.trace.max = t;
        }
      }
    }
    this.cachedExtents = accum;
  }

  applyColor(cell, value, table) {
    if (this.colorMode === 'none') return;
    // weight uses provided normWeight
    if (this.colorMode === 'weight') {
      const weight = value.displayAttributes && Number.isFinite(value.displayAttributes.normWeight) ? Math.min(1, value.displayAttributes.normWeight) : 0;
      const scaled = Math.pow(weight, 0.4);
      cell.style.backgroundColor = this.blueScale(scaled);
      return;
    }
    if (value.N === 0) return;
    let v = 0;
    if (this.colorMode === 'leeway') v = Number.isFinite(value.leeway) ? value.leeway : Math.atan2(value.y, 1); // prefer server-provided leeway
    else if (this.colorMode === 'factor') v = Number.isFinite(value.factor) ? value.factor : null;
    else if (this.colorMode === 'trace') v = Number.isFinite(value.trace) ? value.trace : null;

    const extent = this.cachedExtents[this.colorMode];
    if (!extent || !Number.isFinite(v) || extent.min === Infinity) return;

    let color;
    {
      // sequential for magnitude
      let norm;
      if (this.colorMode === 'leeway') {
        // leeway uses absolute value; recompute extent assuming cached min/max are signed
        const maxAbs = Math.max(Math.abs(extent.min), Math.abs(extent.max));
        norm = maxAbs > 0 ? Math.min(1, Math.abs(v) / maxAbs) : 0;
          if (norm === 0) {
            return; // blank for zero leeway
          }
      } else if (this.colorMode === 'factor') {
        // Asymmetric: baseline 1 -> blank. <1 use orange scale, >1 use green scale.
        if (!Number.isFinite(v) || v <= 0) return; // invalid or zero forward -> blank
        if (Math.abs(v - 1) < 1e-6) return; // exactly baseline
        // Determine deviation span using max distance from 1 among sampled extents
        const maxDev = Math.max(Math.abs(extent.min - 1), Math.abs(extent.max - 1));
        if (maxDev <= 0) return;
        const dev = (v - 1) / maxDev; // in [-1,1]
        const a = Math.min(1, Math.abs(dev));
        if (dev < 0) {
          // compression (factor<1): white -> orange (#FFA500)
          const r = Math.round(255 - (255-255)*a); // stays 255
          const g = Math.round(255 - (255-165)*a); // 255 -> 165
          const b = Math.round(255 - (255-0)*a);   // 255 -> 0
          color = `rgb(${r},${g},${b})`;
        } else {
          // expansion (factor>1): white -> green (#00A050 slightly toned)
          const target = {r:0,g:160,b:80};
          const r = Math.round(255 - (255-target.r)*a);
          const g = Math.round(255 - (255-target.g)*a);
          const b = Math.round(255 - (255-target.b)*a);
          color = `rgb(${r},${g},${b})`;
        }
        cell.style.backgroundColor = color;
        return;
      } else if (this.colorMode === 'trace') {
        if (!Number.isFinite(v) || v <= 0) return; // blank for no/zero trace
        // Scale 0..1
        const normTrace = (v - extent.min) / (extent.max - extent.min || 1);
        if (normTrace <= 0) return;
        const t = Math.pow(Math.min(1, Math.max(0, normTrace)), 0.5); // gamma 0.5 for contrast
        // White -> Purple (#8000FF) gradient
        const target = { r: 128, g: 0, b: 255 };
        const r = Math.round(255 - (255 - target.r) * t);
        const g = Math.round(255 - (255 - target.g) * t);
        const b = Math.round(255 - (255 - target.b) * t);
        cell.style.backgroundColor = `rgb(${r},${g},${b})`;
        return;
      } else {
        norm = (v - extent.min) / (extent.max - extent.min || 1); // 0..1
      }
      color = this.blueScale(Math.pow(norm,0.5));
    }
    cell.style.backgroundColor = color;
  }

  blueScale(t) {
    // t in [0,1]; 0 = white, 1 = deep blue
    if (!Number.isFinite(t)) t = 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const r = Math.round(255 - 255 * t);
    const g = Math.round(255 - 255 * t);
    const b = 255;
    return `rgb(${r},${g},${b})`;
  }

  redBlueDiverging(n) {
    // n in [-1,1]; negative=blue positive=red, 0=white
    const t = (n+1)/2; // 0..1
    const r = Math.round(255 * t);
    const g = Math.round(255 * (1 - Math.abs(n)));
    const b = Math.round(255 * (1 - t));
    return `rgb(${r},${g},${b})`;
  }
}

export default TableRenderer;