const { Table2D} = require('signalkutilities');
const { KalmanFilter, State } = require('kalman-filter');

class CorrectionTable extends Table2D{
  /**
   * Represents a 2D correction table for heel and speed.
   */



  static fromJSON(data, stability) {
    const table = new CorrectionTable(data.id, data.row, data.col, stability);
    table.table = data.table.map(row => row.map(cellData => CorrectionEstimator.fromJSON(cellData, stability)));
    return table;
  }

  /**
   * Resample an existing table onto a new grid conservatively.
   * - Seeds mean from oldTable.getCorrection at each new cell center
   * - Seeds diagonal covariance with a per-axis floor
   * - Sets index (N) = 0 so all cells can re-learn on the new grid
   *
   * @param {CorrectionTable} oldTable - Source table to sample from
   * @param {{min:number,max:number,step:number}} newRow - New speed axis definition (SI units)
   * @param {{min:number,max:number,step:number}} newCol - New heel axis definition (SI units)
   * @param {number} [stability=5] - Stability passed to new table filter model
   * @param {number} [varianceFloor=1e-4] - Floor applied to cov[0][0] and cov[1][1]
   * @returns {CorrectionTable}
   */
  static resample(oldTable, newRow, newCol, stability = 5, varianceFloor = 1e-4) {
    const newTable = new CorrectionTable("correctionTable", newRow, newCol, stability);

    const nRows = Math.round((newRow.max - newRow.min) / newRow.step) + 1;
    const nCols = Math.round((newCol.max - newCol.min) / newCol.step) + 1;

    for (let i = 0; i < nRows; i++) {
      const speed = newRow.min + i * newRow.step;
      for (let j = 0; j < nCols; j++) {
        const heel = newCol.min + j * newCol.step;

        const { correction, variance } = oldTable.getCorrection(speed, heel);

        const mean = [[(correction?.x ?? 0)], [(correction?.y ?? 0)]];
        const covXX = Math.max(Number.isFinite(variance?.x) ? variance.x : 0, varianceFloor);
        const covYY = Math.max(Number.isFinite(variance?.y) ? variance.y : 0, varianceFloor);
        const covariance = [[covXX, 0], [0, covYY]];

        // Decide initialization index based on coverage/support from old table
        const inBounds = (
          speed >= oldTable.min[0] && speed <= oldTable.max[0] &&
          heel  >= oldTable.min[1] && heel  <= oldTable.max[1]
        );
        let supportCount = 0;
        let effectiveN = 0;
        if (Array.isArray(oldTable.neighbours)) {
          for (const n of oldTable.neighbours) {
            const N = n?.cell?.N || 0;
            if (N > 0) supportCount++;
            const w = Number.isFinite(n?.normWeight) ? n.normWeight : 0;
            effectiveN += w * N;
          }
        }
        // Heuristic: require in-bounds AND at least 2 learned neighbours AND some effective support
        const index = (inBounds && supportCount >= 2 && effectiveN >= 1) ? 1 : 0;

        // Seed prior with mean and conservative covariance; index as decided above
        newTable.table[i][j].filterState = new State({ mean, covariance, index });
      }
    }
    newTable.setDisplayAttributes({ label: "correction table" });
    return newTable;
  }

  /**
   * Convenience to resample from serialized JSON table data
   */
  static resampleFromJSON(data, newRow, newCol, stability = 5, varianceFloor = 1e-4) {
    const oldTable = CorrectionTable.fromJSON(data, stability);
    return CorrectionTable.resample(oldTable, newRow, newCol, stability, varianceFloor);
  }

  constructor(id, row, col, stability=5) {
    super(id, row, col, CorrectionEstimator, CorrectionEstimator.getFilterModel(stability));
    this.lastUpdatedCell = null;
    this.neighbours = [];
  }
  
  update(speed, heel, groundSpeed, current, boatSpeed, heading) {
    const cell = this.getCell(speed, heel);
    cell?.update(groundSpeed, current, boatSpeed, heading);
    this.lastUpdatedCell = cell;
  }

  getKalmanCorrection(speed, heel) {
    /**
   * Return a estimated correction based on interpolation and weighting of correction variance;
   */
    if (speed == 0) return { x: 0, y: 0 };
    const neighbours = this.findNeighbours(speed, heel);
    let totalWeightX   = 0;
    let totalWeightY   = 0;
    let x = 0;
    let y = 0;
    for (const neighbour of neighbours) {
      const { cell:correction, xdist, ydist } = neighbour;
      if (correction.N > 0) {
        const weightX = 1 / (xdist + 1e-6) ;
        const weightY = 1 / (ydist + 1e-6) ;
        const varianceX = correction.covariance[0][0];
        const varianceY = correction.covariance[1][1];
        const N = correction.N;
        const varWeightX = weightX * N / (varianceX + 1e-6);
        const varWeightY = weightY * N / (varianceY + 1e-6);
        x += correction.x * varWeightX;
        y += correction.y * varWeightY; 
        totalWeightX += varWeightX;
        totalWeightY += varWeightY;
      }
    }
    if (totalWeightX == 0 || totalWeightY == 0) return { x: 0, y: 0 };  
    x = x / totalWeightX;
    y = y / totalWeightY;
    return { x:x, y:y };

  }

  getCorrection(speed, heel) {
    this.neighbours = this.findClosest(speed, heel, 5);
    if (this.neighbours.length == 0) return { correction: {x: 0, y: 0}, variance: null };
    // Compute the correction and variance from the neighbours
    let x = 0;
    let y = 0;
    let varX = 0;
    let varY = 0;
    let totalWeight = 0;
    for (const neighbour of this.neighbours) {
      const { cell:correction, dist } = neighbour;
      if (correction.N > 0) {
        const weight = 1 / (dist + 1e-6); 
        neighbour.normWeight = weight;
        x += correction.x * weight;
        y += correction.y * weight;
        varX += correction.covariance[0][0] * weight ** 2;
        varY += correction.covariance[1][1] * weight ** 2;
        totalWeight += weight;
      }
    }
    for (const neighbour of this.neighbours) {
      if (totalWeight > 0) neighbour.normWeight /= totalWeight;
    }

    const corrAndVar = { correction: { x, y }, variance: { x: varX, y: varY } };
    if (totalWeight === 0) return corrAndVar;

    // Compute the final correction and variance
    x /= totalWeight;
    y /= totalWeight;
    varX /= totalWeight;
    varY /= totalWeight;
    this.totalWeight = totalWeight;

    return { correction: { x, y }, variance: { x: varX, y: varY } };
  }
  
  report() {
    return {
      id: this.id,
      row: { min: this.min[0], max: this.max[0], step: this.step[0] },
      col: { min: this.min[1], max: this.max[1], step: this.step[1] },
      table: this.table.map(row =>
        row.map((correction, colIndex, rowArray) => {
          const cellReport = correction.report();
          // Derive the bin coordinates from indices
          const speedBin = this.min[0] + this.step[0] * this.table.indexOf(rowArray); // row axis represents speed
          const heelBin = this.min[1] + this.step[1] * colIndex; // col axis represents heel
          // Compute forward speed after longitudinal correction
          const forward = speedBin + cellReport.x;
          // Factor (forward relative to original speed); guard division by zero
          const factor = speedBin > 0 ? forward / speedBin : null;
          // Leeway angle based on sideways over forward; only if forward > 0
          const leeway = (forward > 0 && cellReport.N > 0) ? Math.atan2(cellReport.y, forward) : null;
          // Trace ( cov_xx + cov_yy ) when covariance available and N>0
          let trace = null;
          if (cellReport.N > 0) {
            try {
              const cov = correction.covariance;
              if (cov && Array.isArray(cov) && cov[0] && cov[1] && Number.isFinite(cov[0][0]) && Number.isFinite(cov[1][1])) {
                const a = cov[0][0];
                const d = cov[1][1];
                //trace = Math.sqrt(a*a + d*d);
                trace = a + d;
              }
            } catch { /* silent */ }
          }
          cellReport.forward = forward;
          cellReport.factor = factor;
          cellReport.leeway = leeway;
          cellReport.trace = trace;
          cellReport.speedBin = speedBin;
          cellReport.heelBin = heelBin;
          // Mark selected if this is the last updated cell
          cellReport.displayAttributes = {
            selected: correction === this.lastUpdatedCell
          };
          const found = this.neighbours.find(n => n.cell === correction);
          if (found) {
            cellReport.displayAttributes.normWeight = found.normWeight;
          } else {
            cellReport.displayAttributes.normWeight = 0;
          }
          return cellReport;
        })
      ),
      displayAttributes: this.displayAttributes 
    };
  }

}

class CorrectionEstimator {
  /**
   * Represents a Kalman correction at a cell in a correction table
   */

  static fromJSON(data, stability) {
    const filterModel = CorrectionEstimator.getFilterModel(stability);
    const estimator = new CorrectionEstimator(filterModel, data.state);
    return estimator;
  }

  static getFilterModel(stability = 5) {
    return {
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[1, 0], [0, 1]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1/10**stability, 1/10**stability],// process noise covariance matrix Q
      }
    };
  }

  constructor(filterModel, initialState) {
    this.filter = new KalmanFilter(filterModel);
    this.filterState = null;
    if (initialState != null) {
      this.filterState = new State(initialState);
    }
  }
  
  update(groundSpeed, current, boatSpeed, heading) {
    if(groundSpeed.xVariance == null || groundSpeed.yVariance == null ||
       current.xVariance == null || current.yVariance == null ||
       boatSpeed.xVariance == null || boatSpeed.yVariance == null ) {
       return false;
    }
    // Rotation matrix for -theta
    const cosTheta = Math.cos(heading);
    const sinTheta = Math.sin(heading);

    const rotateValue = (vector) => ([
      cosTheta * vector[0] + sinTheta * vector[1],
      -sinTheta * vector[0] + cosTheta * vector[1]]
    );

    const rotateVariance = (vector) => (
      [
        [vector[0] * cosTheta ** 2 + vector[1] * sinTheta ** 2,
        (vector[0] - vector[1]) * cosTheta * sinTheta],
        [(vector[0] - vector[1]) * cosTheta * sinTheta,
        vector[0] * sinTheta ** 2 + vector[1] * cosTheta ** 2]
      ]
    );

    var groundVector = rotateValue(groundSpeed.vector);
    var currentVector = rotateValue(current.vector);
    var boatVector = boatSpeed.vector;

    const observation = [
      -boatVector[0] + groundVector[0] - currentVector[0],
      -boatVector[1] + groundVector[1] - currentVector[1]
    ];

    var groundCov = rotateVariance(groundSpeed.variance);
    var currentCov = rotateVariance(current.variance);
    var boatCov = [[boatSpeed.variance[0], 0], [0, boatSpeed.variance[1]]];

    const observationCovariance = [[
      groundCov[0][0] + currentCov[0][0] + boatCov[0][0],
      groundCov[0][1] + currentCov[0][1] + boatCov[0][1]],
    [
      groundCov[1][0] + currentCov[1][0] + boatCov[1][0],
      groundCov[1][1] + currentCov[1][1] + boatCov[1][1]],
    ];
    this.filterState = this.filter.filter({ previousCorrected: this.filterState, observation, observationCovariance });
    //console.log("Filterstate:", this.filterState, "Covariance:", observationCovariance);
    return true;
  }


  report() {
    return { x: this.x, y: this.y, N: this.N };
  }

  get N() {
    if (this.filterState == null) return 0;
    return this.filterState.index;
  }

  get x() {
    if (this.filterState == null) return 0;
    return this.filterState.mean[0][0];
  }

  get y() {
    if (this.filterState == null) return 0;
    return this.filterState.mean[1][0];
  }

  get covariance() {
    return this.filterState.covariance;
  }


  toJSON() {
    return this.N != 0 ? { state: this.filterState } : { state: null };
  }

}


module.exports = { CorrectionTable };
