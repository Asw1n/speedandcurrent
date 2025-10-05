const API_BASE_URL = "/plugins/speedandcurrent"; // Adjust based on your server configuration
import TableRenderer from './TableRenderer.js';


let updateInterval = 1000;
let updateTimer;
let updatesPaused = false;

let vAngle = 1;
let dAngle = 2;
let vSpeed = 1;
let dSpeed = 1;


const LS_KEYS = {
  speed: 'sc_speed_unit',
  angle: 'sc_angle_unit',
  color: 'sc_color_mode',
  metrics: 'sc_table_metrics'
};

export function handleSpeedUnitChange(value) {
  if (value == "knots") {
    vSpeed = 1.943844;
    dSpeed = 1;
    localStorage.setItem(LS_KEYS.speed, 'knots');
    return;
  }
  if (value == "kmh") {
    vSpeed = 3.6;
    dSpeed = 1;
    localStorage.setItem(LS_KEYS.speed, 'kmh');
    return;
  }
  vSpeed = 1;
  dSpeed = 1;
  localStorage.setItem(LS_KEYS.speed, 'ms');
}

export function handleAngleUnitChange(value) {
  if (value == "degrees") {
    vAngle = 180 / Math.PI;
    dAngle = 0;
    localStorage.setItem(LS_KEYS.angle, 'degrees');
    return;
  }
  vAngle = 1;
  dAngle = 2;
  localStorage.setItem(LS_KEYS.angle, 'radians');
}



// Removed table style switch; rendering is driven by metrics selection.

export function handleColorModeChange(value) {
  if (tableRenderer && tableRenderer.setColorMode) {
    tableRenderer.setColorMode(value);
    localStorage.setItem(LS_KEYS.color, value);
    // re-render immediately using last data if available
    // fetchAndUpdateData will repaint next tick; do a quick repaint now if cached
    // (Simplest approach: trigger fetch)
    fetchAndUpdateData();
  }
}

function cAngle(value) {
  value *= vAngle;
  return value.toFixed(dAngle);
}

function cSpeed(value) {
  value *= vSpeed;
  return value.toFixed(dSpeed);
}

let selectedMetrics = {
  correction: true,
  factor: true,
  leeway: true,
  trace: false,
  N: true,
};

function buildCellContent(parts) {
  // parts is array of strings; filter falsy and join
  return parts.filter(Boolean).join('\n');
}

function cartesian(correction, speed, heel) {
  if (correction.N == 0) return null;
  const bits = [];
  if (selectedMetrics.correction) {
    bits.push(` <div><strong>X:</strong> ${cSpeed(correction.x)}</div>`);
    bits.push(` <div><strong>Y:</strong> ${cSpeed(correction.y)}</div>`);
  }
  if (selectedMetrics.trace && Number.isFinite(correction.trace)) {
    bits.push(` <div><strong>trace:</strong> ${Number(correction.trace).toPrecision(2)}</div>`);
  }
  if (selectedMetrics.N) {
    bits.push(` <div><strong>N:</strong> ${correction.N}</div>`);
  }
  return buildCellContent(bits);
}

function polar(correction, speed, heel) {
  if (speed == 0 || correction.N == 0) return null;
  const bits = [];
  // Prefer server-provided values when available
  const factor = Number.isFinite(correction.factor) ? correction.factor : (speed > 0 ? (correction.x + speed) / speed : 0);
  const leewayRad = Number.isFinite(correction.leeway) ? correction.leeway : Math.atan2(correction.y, speed + correction.x);
  const leewayDisplay = leewayRad; // signed value; color uses |leeway|

  if (selectedMetrics.factor) {
    bits.push(` <div><strong>factor:</strong> ${factor.toFixed(2)}</div>`);
  }
  if (selectedMetrics.leeway) {
    bits.push(` <div><strong>leeway:</strong> ${cAngle(leewayDisplay)}</div>`);
  }
  if (selectedMetrics.trace && Number.isFinite(correction.trace)) {
    bits.push(` <div><strong>trace:</strong> ${Number(correction.trace).toPrecision(2)}</div>`);
  }
  if (selectedMetrics.N) {
    bits.push(` <div><strong>N:</strong> ${correction.N}</div>`);
  }
  return buildCellContent(bits);
}

function unifiedCellRenderer(correction, speed, heel) {
  // Combines polar-oriented metrics and cartesian correction based on selections
  if (correction.N == 0) return null;
  const bits = [];
  // Polar-ish metrics
  if (selectedMetrics.factor && (speed !== 0)) {
    const factor = Number.isFinite(correction.factor) ? correction.factor : (speed > 0 ? (correction.x + speed) / speed : 0);
    bits.push(` <div><strong>factor:</strong> ${factor.toFixed(2)}</div>`);
  }
  if (selectedMetrics.leeway && (speed !== 0)) {
    const leewayRad = Number.isFinite(correction.leeway) ? correction.leeway : Math.atan2(correction.y, speed + correction.x);
    bits.push(` <div><strong>leeway:</strong> ${cAngle(leewayRad)}</div>`);
  }
  // Cartesian correction (always available)
  if (selectedMetrics.correction) {
    bits.push(` <div><strong>X:</strong> ${cSpeed(correction.x)}</div>`);
    bits.push(` <div><strong>Y:</strong> ${cSpeed(correction.y)}</div>`);
  }
  if (selectedMetrics.trace && Number.isFinite(correction.trace)) {
    bits.push(` <div><strong>trace:</strong> ${Number(correction.trace).toPrecision(2)}</div>`);
  }
  if (selectedMetrics.N) {
    bits.push(` <div><strong>N:</strong> ${correction.N}</div>`);
  }
  return buildCellContent(bits);
}



async function getFromServer(endpoint) {
  try {
    const response = await fetch(`${API_BASE_URL}/${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 503) {
        document.getElementById("message").innerHTML = "Plugin is not running";
      } else {
        document.getElementById("message").innerHTML = "Failed to fetch data. Error: " + response.status + " " + response.statusText;
      }
    }
    else {
      document.getElementById("message").innerHTML = "";
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch data from server:", error);
    document.getElementById("message").innerHTML = error;
    return null;
  }
}



function updateOptions(data) {
  const optionsContent = document.getElementById('options-content');
  optionsContent.innerHTML = ''; // Clear previous content

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Option Name</th><th>Value</th>';
  table.appendChild(headerRow);

  Object.entries(data.options).forEach(([key, value]) => {
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') {

      const row = document.createElement('tr');
      row.innerHTML = `<td>${key}</td><td>${value}</td>`;
      table.appendChild(row);
    };
  });

  optionsContent.appendChild(table);
}


function updatePolar(data) {
  const stepsList = document.getElementById('speeds-container');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  table.classList.add('polar');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Speed</th><th>Angle</th><th>Trace</th>';
  table.appendChild(headerRow);

  data.polars.forEach(polar => {
    const row = document.createElement('tr');
    if (polar.id) {
      row.id = polar.id;
    }
    if (polar.displayAttributes.unstable) {
      row.classList.add('unstable');
    }
  row.innerHTML = `<td>${polar.displayAttributes.label}</td><td>${cSpeed(polar.magnitude)}</td><td>${cAngle(polar.angle)}</td><td>${(polar.trace !== undefined && polar.trace !== null ? Number(polar.trace).toPrecision(2) : '')}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateDelta(data) {
  const stepsList = document.getElementById('delta-container');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  table.classList.add('delta');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Value</th><th>Variance</th>';
  table.appendChild(headerRow);

  data.deltas.forEach(delta => {
    const row = document.createElement('tr');
    if (delta.id) {
      row.id = delta.id;
    }
    if (delta.displayAttributes.unstable) {
      row.classList.add('unstable');
    }
  row.innerHTML = `<td>${delta.displayAttributes.label}</td><td>${cAngle(delta.value)}</td><td>${(delta.variance !== undefined && delta.variance !== null ? Number(delta.variance).toPrecision(2) : '')}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateAttitude(data) {
  const attitudeContainer = document.getElementById('attitude-container');
  attitudeContainer.innerHTML = '';
  const table = document.createElement('table');
  table.classList.add('attitude');

  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>roll</th><th>pitch</th><th>yaw</th>';
  table.appendChild(headerRow);


  data.attitudes.forEach(attitude => {
    const row = document.createElement('tr');
    if (attitude.id) {
      row.id = attitude.id;
    }
    if (attitude.displayAttributes.unstable) {
      row.classList.add('unstable');
    }
    row.innerHTML = `<td>${attitude.displayAttributes.label}</td><td>${cAngle(attitude.value.roll)}</td><td>${cAngle(attitude.value.pitch)}</td><td>${cAngle(attitude.value.yaw)}</td>`;
    table.appendChild(row);
  });
  attitudeContainer.appendChild(table);
}

function updateTable(data) {
  const tableContainer = document.getElementById('table-container');
  tableContainer.innerHTML = '';
    data.tables.forEach(table => {
    const tableElement = tableRenderer.render(table);
    tableContainer.appendChild(tableElement);
  });
}




async function fetchAndUpdateData() {
  const data = await getFromServer('getResults'); // Updated endpoint
  if (data) {
    //console.log(data);
    //updateOptions(data);
    updatePolar(data);
    updateAttitude(data);
    updateDelta(data);
    updateTable(data);
  }
}

function startUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(fetchAndUpdateData, updateInterval);
}

export function toggleUpdates() {
  updatesPaused = !updatesPaused;
  const toggleButton = document.getElementById('toggle-updates');

  if (updatesPaused) {
    clearInterval(updateTimer);
    toggleButton.textContent = "Resume";
  } else {
    toggleButton.textContent = "Pause";
    startUpdates();
  }
}





//document.getElementById('toggle-updates').addEventListener('click', toggleUpdates);

const tableRenderer = new TableRenderer();
tableRenderer.setColumnHeaderFormat(cAngle);
tableRenderer.setRowHeaderFormat(cSpeed);
// Default cell format is unified and driven by metrics; set to polar-like by default
tableRenderer.setCellFormat(unifiedCellRenderer);

function initSettingsFromStorage() {
  try {
    const speedUnit = localStorage.getItem(LS_KEYS.speed) || 'knots';
    const angleUnit = localStorage.getItem(LS_KEYS.angle) || 'degrees';
    const colorMode = localStorage.getItem(LS_KEYS.color) || 'none';
    const metricsRaw = localStorage.getItem(LS_KEYS.metrics);

    const speedEl = document.getElementById('speed-unit');
    const angleEl = document.getElementById('angle-unit');
    const colorEl = document.getElementById('color-mode');
    const metricsEls = {
      correction: document.getElementById('show-correction'),
      factor: document.getElementById('show-factor'),
      leeway: document.getElementById('show-leeway'),
      trace: document.getElementById('show-trace'),
      N: document.getElementById('show-N'),
    };
    if (speedEl) speedEl.value = speedUnit;
    if (angleEl) angleEl.value = angleUnit;
    if (colorEl) colorEl.value = colorMode;
    if (metricsRaw) {
      try {
        const parsed = JSON.parse(metricsRaw);
        selectedMetrics = { ...selectedMetrics, ...parsed };
      } catch {}
    }
    // Initialize checkboxes to match selectedMetrics
    if (metricsEls.correction) metricsEls.correction.checked = !!selectedMetrics.correction;
    if (metricsEls.factor) metricsEls.factor.checked = !!selectedMetrics.factor;
    if (metricsEls.leeway) metricsEls.leeway.checked = !!selectedMetrics.leeway;
    if (metricsEls.trace) metricsEls.trace.checked = !!selectedMetrics.trace;
    if (metricsEls.N) metricsEls.N.checked = !!selectedMetrics.N;

    // Apply handlers (order: units, then renderer-dependent)
    handleSpeedUnitChange(speedUnit);
    handleAngleUnitChange(angleUnit);
    handleColorModeChange(colorMode);
  } catch (e) {
    // Fallback to defaults on any error
    handleSpeedUnitChange('knots');
    handleAngleUnitChange('degrees');
    handleColorModeChange('none');
  }
}

export function handleMetricsChange() {
  const metricsEls = {
    correction: document.getElementById('show-correction'),
    factor: document.getElementById('show-factor'),
    leeway: document.getElementById('show-leeway'),
    trace: document.getElementById('show-trace'),
    N: document.getElementById('show-N'),
  };
  selectedMetrics = {
    correction: metricsEls.correction ? !!metricsEls.correction.checked : selectedMetrics.correction,
    factor: metricsEls.factor ? !!metricsEls.factor.checked : selectedMetrics.factor,
    leeway: metricsEls.leeway ? !!metricsEls.leeway.checked : selectedMetrics.leeway,
    trace: metricsEls.trace ? !!metricsEls.trace.checked : selectedMetrics.trace,
    N: metricsEls.N ? !!metricsEls.N.checked : selectedMetrics.N,
  };
  try {
    localStorage.setItem(LS_KEYS.metrics, JSON.stringify(selectedMetrics));
  } catch {}
  // Re-render with current data (trigger fetch or reuse last render by forcing a refresh)
  fetchAndUpdateData();
}


// Attach functions to the window object to make them globally accessible
window.handleSpeedUnitChange = handleSpeedUnitChange;
window.handleAngleUnitChange = handleAngleUnitChange;
window.handleColorModeChange = handleColorModeChange;
window.handleMetricsChange = handleMetricsChange;
window.toggleUpdates = toggleUpdates;


// Initial fetch and start updates
initSettingsFromStorage();
startUpdates();
