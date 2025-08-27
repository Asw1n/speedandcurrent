const API_BASE_URL = "/plugins/speedandcurrent";
let previous = 0;
let lastTime = new Date();

function getHeading(data) {
  let heading = 0;
  data.deltas.forEach(delta => {
    if (delta.id == "heading") {
      heading = delta.value * 180 / Math.PI;
    }
  });
  return heading;
}


function getLargest(data) {
  let largest = 1;
  data.polars.forEach(polar => {
    largest = Math.max(largest, Math.abs(polar.x));
    largest = Math.max(largest, Math.abs(polar.y));
  });
  return largest;
}

function drawBoat(canvas,  heading) {


  const hull = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hull.setAttribute("d", "M -45 8  Q 15 20 30 0 Q 15 -20 -45 -8 z");
  hull.setAttribute("fill", "none");
  hull.setAttribute("stroke", "black");
  hull.setAttribute("stroke-width", "1");
  //hull.setAttribute("transform", `scale(${1 - Math.abs(Math.sin(att.pitch))}, ${1 - Math.abs(Math.sin(att.roll))})`);
  hull.setAttribute("id", "hull");

  // const mast = document.createElementNS("http://www.w3.org/2000/svg", "line");
  // mast.setAttribute("x1", 0);
  // mast.setAttribute("y1", 0);
  // mast.setAttribute("x2", offset.x);
  // mast.setAttribute("y2", offset.y);
  // mast.setAttribute("id", "mast");


  const boat = document.createElementNS("http://www.w3.org/2000/svg", "g");
  boat.setAttribute("transform", `rotate(${heading - 90})`);
  boat.appendChild(hull);
  // boat.appendChild(mast);
  canvas.appendChild(boat);
}


function drawVectors(canvas, data, heading, scale) {
  data.polars.forEach(polar => {
    const vector = document.createElementNS("http://www.w3.org/2000/svg", "line");
    vector.setAttribute("x1", 0 );
    vector.setAttribute("y1", 0 );
    vector.setAttribute("x2", polar.x * scale );
    vector.setAttribute("y2", polar.y * scale );
    vector.setAttribute("id", polar.id);
    let dash;
    let s = scale * 5 / 1.94384 - 1;
    if (s > 50) {
      s = s / 5;
      dash = `1 1 ${s - 1} 1 ${s} 1 ${s} 1 ${s} 1 ${s - 1} 1 `;
    }
    else {
      dash = `1 1 ${s - 1} 1 ${s} 1 `;
    }
    vector.setAttribute("stroke-dasharray", dash);
    vector.setAttribute("stroke-dashoffset", `1`);
    if (polar.displayAttributes.plane == "Ground")
      vector.setAttribute("transform", `rotate(${-90})`);
    else
      vector.setAttribute("transform", `rotate(${heading - 90})`);
    canvas.appendChild(vector);
  });
}


async function fetchVectorData() {
  const data = await getFromServer('getVectors');
  if (data) {
    const canvas = document.getElementById("canvas");
    canvas.innerHTML = "";

    const heading = getHeading(data);
    const largest = getLargest(data);
    let time, deltaT;

    if (previous == 0) {
      previous = largest;
      lastTime = new Date();
    }
    else {
      time = new Date();
      deltaT = (time - lastTime)/1000;
      if (largest != previous)  {
        if (largest > previous) {
          previous *= (1.005 );
        }
        else {
          previous *= (0.9995 );
        }
      }
    }

    const scale = 95 / previous;

    drawBoat(canvas, heading);
    drawVectors(canvas, data, heading, scale);
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
          throw new Error("Plugin is not running");
        } else {
          throw new Error(`Error fetching data: ${response.statusText}`);
        }
      }
      

      const data = await response.json();
      return data;
    } catch (error) {
      handleError(error);
      return null;
    }
  }
}

function handleError(error) {
  console.log('Error:', error.message);
}


setInterval(fetchVectorData, 1000);
