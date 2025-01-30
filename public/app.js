const API_BASE_URL = "/plugins/speedandcurrent"; // Adjust based on your server configuration

let updateInterval = 1000;
let updateTimer;
let updatesPaused = false;

let vAngle = 1;
let dAngle = 2;
let vSpeed = 1;
let dSpeed = 1;


function handleSpeedUnitChange(value) {
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

function handleAngleUnitChange(value) {
  if (value == "degrees") {
    vAngle = 180 / Math.PI;
    dAngle = 0;
    return;
  }
  vAngle = 1;
  dAngle = 2;
}


function cAngle(value) {
  value *= vAngle;
  return value.toFixed(dAngle);
}

function cSpeed(value) {
  value *= vSpeed;
  return value.toFixed(dSpeed);
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
      throw new Error(`Error fetching data: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch data from server:", error);
    return null;
  }
}

function updateMetadata(data) {
  document.getElementById('timestamp').textContent = data.timestamp;
}

function updateOptions(data) {
  const optionsContent = document.getElementById('options-content');
  optionsContent.innerHTML = ''; // Clear previous content

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Option Name</th><th>Value</th>';
  table.appendChild(headerRow);

  Object.entries(data.options).forEach(([key, value]) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${key}</td><td>${value}</td>`;
    table.appendChild(row);
  });

  optionsContent.appendChild(table);
}


function updateSpeed(data) {
  const stepsList = document.getElementById('speeds-container');
  stepsList.innerHTML = ''; // Clear previous steps

  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th>Label</th><th>Speed</th><th>Angle</th>';
  table.appendChild(headerRow);

  data.polarSteps.forEach(step => {
    const row = document.createElement('tr');
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
    row.innerHTML = `<td>${step.label}</td><td>${cAngle(step.roll)}</td><td>${cAngle(step.pitch)}</td>`;
    table.appendChild(row);
  });
  attitudeContainer.appendChild(table);
}

function updateTable(data) {

  const tableContainer = document.getElementById('table-container');
  tableContainer.innerHTML = '';
  const { heelStep, speedStep, maxHeel, maxSpeed, table, heelIndex, speedIndex } = data.tables[0];

  // Create a table element
  const tableElement = document.createElement('table');
  tableElement.style.borderCollapse = 'collapse';
  tableElement.style.width = '100%';

  // Create header row
  const headerRow = document.createElement('tr');
  const firstHeaderCell = document.createElement('th');
  firstHeaderCell.innerText = "Heel \\ Speed";
  firstHeaderCell.style.border = '1px solid black';
  firstHeaderCell.style.padding = '5px';
  headerRow.appendChild(firstHeaderCell);

  for (let speed = 0; speed <= maxSpeed; speed += speedStep) {
    const headerCell = document.createElement('th');
    headerCell.innerText = `${cSpeed(speed)} `;
    headerCell.style.border = '1px solid black';
    headerCell.style.padding = '5px';
    headerRow.appendChild(headerCell);
  }

  tableElement.appendChild(headerRow);

  // Create rows for each heel step
  for (let i = 0; i < table.length; i++) {
    const heel = - maxHeel + i * heelStep;
    const row = document.createElement('tr');

    // First column with the heel value
    const heelCell = document.createElement('th');
    heelCell.innerText = `${cAngle(heel)}`;
    heelCell.style.border = '1px solid black';
    heelCell.style.padding = '5px';
    row.appendChild(heelCell);

    // Add cells for each speed step
    for (let j = 0; j < table[i].length; j++) {
      const correction = table[i][j];
      const cell = document.createElement('td');
      cell.style.border = '1px solid black';
      cell.style.padding = '5px';
      cell.style.textAlign = 'center';

      // Display correction values if available
      if (correction.N > 0) {
        cell.innerHTML = `
                    <div><strong>X:</strong> ${cSpeed(correction.x)}</div>
                    <div><strong>Y:</strong> ${cSpeed(correction.y)}</div>
                    <div><strong>N:</strong> ${correction.N}</div>
                    <div><strong>trace:</strong> ${correction.trace.toFixed(2)}</div>
                `;
      }
      else {
        cell.innerText = "—";
        cell.style.color = '#ccc';
      }
      if (i == heelIndex && j == speedIndex) cell.style.color = '#F00';

      row.appendChild(cell);
    }

    tableElement.appendChild(row);
  }

  tableContainer.appendChild(tableElement);
}


async function fetchAndUpdateData() {
  const data = await getFromServer('getResults'); // Updated endpoint
  if (data) {
    //console.log(data);
    updateMetadata(data);
    updateOptions(data);
    updateSpeed(data);
    updateAttitude(data);
    updateDelta(data);
    updateTable(data);
  }
}

function startUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(fetchAndUpdateData, updateInterval);
}

function toggleUpdates() {
  updatesPaused = !updatesPaused;
  const toggleButton = document.getElementById('toggle-updates');

  if (updatesPaused) {
    clearInterval(updateTimer);
    toggleButton.textContent = "Resume Updates";
  } else {
    toggleButton.textContent = "Pause Updates";
    startUpdates();
  }
}

document.getElementById('update-interval').addEventListener('input', (event) => {
  updateInterval = parseInt(event.target.value, 10) || 1000;
  if (!updatesPaused) startUpdates();
});

document.getElementById('toggle-updates').addEventListener('click', toggleUpdates);


// Initial fetch and start updates
startUpdates();
