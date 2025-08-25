class TableRenderer {
  constructor() {
    this.formatColumnHeader = this.defaultDisplay;
    this.formatRowHeader = this.defaultDisplay;
    this.formatCell = this.defaultDisplay;
    this.formatCellX = this.defaultDisplay;
    this.formatCellY = this.defaultDisplay;
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

  setCellFormatX(cellX) {
    cellX != null ? this.formatCellX = cellX : this.formatCellX = this.defaultDisplay;
  }

  setCellFormatY(cellY) {
    cellY != null ? this.formatCellY = cellY : this.formatCellY = this.defaultDisplay;
  }

  render(data) {
    const {id, row, col, table, displayAttributes } = data;
    this.data = data;
    const label = displayAttributes && displayAttributes.label ? displayAttributes.label : "";
    
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
      if (value.displayAttributes && value.displayAttributes.selected) cell.classList.add('selectedCell');

      rowElement.appendChild(cell);
      cIndex++;
    }
    return rowElement;
  }

  defaultDisplay(value) {
    return value.toFixed(2);
  }

  createSurfacePlot() {
    const { row, col, table, id } = this.data;

    // Format the axes values
    const x = [];
    for (let c = col.min; c <= col.max + 0.01; c += col.step) {
      x.push(this.formatColumnHeader(c));
    }

    const y = [];
    for (let r = row.min; r <= row.max + 0.01; r += row.step) {
      y.push(this.formatRowHeader(r));
    }
    

    const zX = table.map(row => row.map(cell => cell.N > 0 ? cell.x : null)); // Assuming 'x' values for the surface plot
    const zY = table.map(row => row.map(cell => cell.N > 0 ? cell.y : null)); // Assuming 'y' values for the surface plot

    // Open a new window
    const newWindow = window.open('', 'Correction Plot', 'width=1024,height=800');
    newWindow.document.title = 'Correction Plot';

    // Create div elements for the plots
    const plotDivX = newWindow.document.createElement('div');
    plotDivX.id = 'surfacePlotX';
    plotDivX.style.width = '100%';
    plotDivX.style.height = '400px';

    const plotDivY = newWindow.document.createElement('div');
    plotDivY.id = 'surfacePlotY';
    plotDivY.style.width = '100%';
    plotDivY.style.height = '400px';

    newWindow.document.body.appendChild(plotDivX);
    newWindow.document.body.appendChild(plotDivY);

    // Data for the surface plots
    const plotDataX = [{
      type: 'surface',
      x: x,
      y: y,
      z: zX
    }];

    const plotDataY = [{
      type: 'surface',
      x: x,
      y: y,
      z: zY
    }];

    // Layout for the surface plots
    const layoutX = {
      title: 'X-value',
      autosize: true,
      scene: {
        xaxis: { title: 'Speed' },
        yaxis: { title: 'Heel' },
        zaxis: { title: 'Correction' }
      }
    };

    const layoutY = {
      title: 'Y-value',
      autosize: true,
      scene: {
        xaxis: { title: 'Speed' },
        yaxis: { title: 'Heel' },
        zaxis: { title: 'Correction' }
      }
    };

    const config = {
      displayModeBar: false,
      responsive: true // Ensure the plot is responsive
    };

    // Render the plots using Plotly
    Plotly.newPlot(plotDivX, plotDataX, layoutX, config);
    Plotly.newPlot(plotDivY, plotDataY, layoutY, config);
  }
}

export default TableRenderer;