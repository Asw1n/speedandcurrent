const API_BASE_URL = "/plugins/speedandcurrent"; // Adjust based on your server configuration
import TableRenderer from './tableRenderer.js';


let updateInterval = 1000;
let updateTimer;
let updatesPaused = false;

let vAngle = 1;
let dAngle = 2;
let vSpeed = 1;
let dSpeed = 1;


export function handleSpeedUnitChange(value) {
  if (value == "knots") {
    vSpeed = 1.943844;
    dSpeed = 1;
    return;
  }
  if (value == "kmh") {
    vSpeed = 3.6;
    dSpeed = 1;
    return;
  }
  vSpeed = 1;
  dSpeed = 1;
}

export function handleAngleUnitChange(value) {
  if (value == "degrees") {
    vAngle = 180 / Math.PI;
    dAngle = 0;
    return;
  }
  vAngle = 1;
  dAngle = 2;
}



export function handleTableStyleChange(value) {
  console.log(value);
  if (value == "cartesian") {
    tableRenderer.setCellFormat(cartesian);
  }
  else {
    tableRenderer.setCellFormat(polar);
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

function cartesian(correction, speed, heel) {
  if (correction.N == 0) return null;
  return ` <div><strong>X:</strong> ${cSpeed(correction.x)}</div>
           <div><strong>Y:</strong> ${cSpeed(correction.y)}</div>
           <div><strong>N:</strong> ${correction.N}</div>
          `;
}

function polar(correction, speed, heel) {
  if (speed == 0 || correction.N == 0) return null;
  const factor = (correction.x + speed) / speed;
  return ` <div><strong>factor:</strong> ${factor.toFixed(2)}</div>
           <div><strong>leeway:</strong> ${cAngle(Math.atan2(correction.y, speed))}</div>
           <div><strong>N:</strong> ${correction.N}</div>
          `;
}

function formatCellX(value, speed, heel) {
  if (value.N == 0) return null;
  return cSpeed(value.x);
}

function formatCellY(value, speed, heel) {
  if (value.N == 0) return null;
  return Math.abs(cSpeed(value.y));
}

function formatCellXPolar(value, speed, heel) {
  if (value.N == 0) return null;
  const factor = (correction.x + speed) / speed;
  return factor.toFixed(2);
}

function formatCellYPolar(value, speed, heel) {
  if (value.N == 0) return null;
  return Math.abs(cAngle(Math.atan2(value.y, speed)));
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
        document.getElementById("message").innerHTML = "Failed to fetch data";
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
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Speed</th><th>Angle</th>';
  table.appendChild(headerRow);

  data.polarSteps.forEach(step => {
    const row = document.createElement('tr');
    if (step.id != undefined)
      row.classList.add(step.id);
    row.innerHTML = `<td>${step.label}</td><td>${cSpeed(step.speed)}</td><td>${cAngle(step.angle)}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateDelta(data) {
  const stepsList = document.getElementById('delta-container');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Delta</th>';
  table.appendChild(headerRow);

  data.deltas.forEach(step => {
    const row = document.createElement('tr');
    if (step.id != undefined)
      row.classList.add(step.id);
    row.innerHTML = `<td>${step.label}</td><td>${cAngle(step.value)}</td>`;
    table.appendChild(row);
  });

  stepsList.appendChild(table);
}

function updateAttitude(data) {
  const attitudeContainer = document.getElementById('attitude-container');
  attitudeContainer.innerHTML = '';
  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>roll</th><th>pitch</th>';
  table.appendChild(headerRow);


  data.attitudeSteps.forEach(step => {
    const row = document.createElement('tr');
    if (step.id != undefined)
      row.classList.add(step.id);
    row.innerHTML = `<td>${step.label}</td><td>${cAngle(step.roll)}</td><td>${cAngle(step.pitch)}</td>`;
    table.appendChild(row);
  });
  attitudeContainer.appendChild(table);
}

function updateTable(data) {
  const tableContainer = document.getElementById('table-container');
  tableContainer.innerHTML = '';
  const tableElement = tableRenderer.render(data.tables[0]);
  tableContainer.appendChild(tableElement);
}




async function fetchAndUpdateData() {
  const data = await getFromServer('getResults'); // Updated endpoint
  if (data) {
    //console.log(data);
    updateOptions(data);
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

handleSpeedUnitChange("knots");
handleAngleUnitChange("degrees");

const tableRenderer = new TableRenderer();
handleTableStyleChange("cartesian");
tableRenderer.setColumnHeaderFormat(cAngle);
tableRenderer.setRowHeaderFormat(cSpeed);


// Attach functions to the window object to make them globally accessible
window.handleSpeedUnitChange = handleSpeedUnitChange;
window.handleAngleUnitChange = handleAngleUnitChange;
window.handleTableStyleChange = handleTableStyleChange;
window.toggleUpdates = toggleUpdates;


// Initial fetch and start updates
startUpdates();
