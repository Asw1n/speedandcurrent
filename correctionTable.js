const { Table2D} = require('signalkutilities');
const { KalmanFilter, State } = require('kalman-filter');

const MAX_INTERPOLATION_DISTANCE = 2.5;
const MIN_CELL_INDEX = 50;
const Q_RECALCULATION_INTERVAL = 600;
const MIN_Q_PAIR_COUNT = 3;
const DEFAULT_Q = 0.002;
const COVARIANCE_FLOOR = 1e-9;
const OBSERVATION_STATE_PROJECTION = [[1, 0], [0, 1]]; // observation matrix H
const DYNAMIC_TRANSITION = [[1, 0], [0, 1]]; // state transition matrix F

// Module-level helpers — avoids creating new Function objects on every Kalman update call
function _rotateValue(cos, sin, vector) {
  return [
     cos * vector[0] + sin * vector[1],
    -sin * vector[0] + cos * vector[1]
  ];
}

function _rotateVariance(cos, sin, vector) {
  return [
    [vector[0] * cos ** 2 + vector[1] * sin ** 2, (vector[1] - vector[0]) * cos * sin],
    [(vector[1] - vector[0]) * cos * sin,          vector[0] * sin ** 2 + vector[1] * cos ** 2]
  ];
}

function _addHeadingVariance(covariance, groundVector, currentVector, headingVariance) {
  const variance = Number.isFinite(headingVariance) && headingVariance >= 0 ? headingVariance : 0;
  if (variance === 0) return covariance;

  const ux = groundVector[0] - currentVector[0];
  const uy = groundVector[1] - currentVector[1];
  const jx = uy;
  const jy = -ux;
  return [
    [covariance[0][0] + jx * variance * jx, covariance[0][1] + jx * variance * jy],
    [covariance[1][0] + jy * variance * jx, covariance[1][1] + jy * variance * jy]
  ];
}

function _median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function _symmetricCovariance(covariance, diagonalInflation = 0) {
  if (!Array.isArray(covariance) || !Array.isArray(covariance[0]) || !Array.isArray(covariance[1])) return null;
  const xx = covariance[0][0] + diagonalInflation;
  const yy = covariance[1][1] + diagonalInflation;
  const xy = (covariance[0][1] + covariance[1][0]) / 2;
  if (![xx, xy, yy].every(Number.isFinite)) return null;
  return [[Math.max(xx, COVARIANCE_FLOOR), xy], [xy, Math.max(yy, COVARIANCE_FLOOR)]];
}

function _inverse2(matrix) {
  const det = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  if (!Number.isFinite(det) || det <= COVARIANCE_FLOOR ** 2) return null;
  return [
    [matrix[1][1] / det, -matrix[0][1] / det],
    [-matrix[1][0] / det, matrix[0][0] / det]
  ];
}

class CorrectionTable extends Table2D{
  /**
   * Represents a 2D correction table for heel and speed.
   */



  static fromJSON(data, stability) {
    const table = new CorrectionTable(data.id, data.row, data.col, stability);
    table.table = data.table.map(row => row.map(cellData => CorrectionEstimator.fromJSON(cellData, stability)));
    table.calculateQ();
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
    const newTable = new CorrectionTable(oldTable.id, newRow, newCol, stability);

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
        const covXY = Number.isFinite(variance?.covariance?.[0]?.[1]) ? variance.covariance[0][1] : 0;
        const covariance = [[covXX, covXY], [covXY, covYY]];

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
    // Table2D persists the constructor param verbatim as `this.parameters`. The live filter model
    // carries a runtime callback for observation.covariance, which JSON.stringify would silently
    // drop. Replace it with a serializable descriptor so persisted files stay honest.
    this.parameters = CorrectionEstimator.getModelDescriptor(stability);
    this.lastUpdatedCell = null;
    this.lastUpdateResult = null;
    this.neighbours = [];
    this.q = DEFAULT_Q;
    this.qPairCount = 0;
    this.qEstimate = null;
    this.qSource = 'fallback';
    this.acceptedObservationsSinceQ = 0;
  }
  
  update(speed, heel, groundSpeed, current, boatSpeed, heading, headingVariance) {
    const cell = this.getCell(speed, heel);
    const accepted = cell?.update(groundSpeed, current, boatSpeed, heading, headingVariance);
    this.lastUpdatedCell = cell;
    this.lastUpdateResult = accepted === true ? 'accepted' : 'rejected';
    if (accepted === true) {
      this.acceptedObservationsSinceQ++;
      if (this.acceptedObservationsSinceQ >= Q_RECALCULATION_INTERVAL) {
        this.calculateQ();
      }
    }
    return accepted === true;
  }

  calculateQ() {
    const pairEstimates = [];
    for (let row = 0; row < this.n[0]; row++) {
      for (let col = 0; col < this.n[1]; col++) {
        const first = this.table[row][col];
        if (first.N <= MIN_CELL_INDEX) continue;
        for (const [rowOffset, colOffset] of [[1, 0], [0, 1]]) {
          const second = this.table[row + rowOffset]?.[col + colOffset];
          if (!second || second.N <= MIN_CELL_INDEX) continue;
          const firstCovariance = _symmetricCovariance(first.covariance);
          const secondCovariance = _symmetricCovariance(second.covariance);
          if (!firstCovariance || !secondCovariance) continue;
          const dx = first.x - second.x;
          const dy = first.y - second.y;
          const uncertainty = firstCovariance[0][0] + firstCovariance[1][1]
            + secondCovariance[0][0] + secondCovariance[1][1];
          pairEstimates.push((dx * dx + dy * dy - uncertainty) / 2);
        }
      }
    }

    const estimate = _median(pairEstimates);
    this.qPairCount = pairEstimates.length;
    this.qEstimate = Number.isFinite(estimate) ? estimate : null;
    if (pairEstimates.length >= MIN_Q_PAIR_COUNT && estimate > 0) {
      this.q = estimate;
      this.qSource = 'derived';
    } else {
      this.q = DEFAULT_Q;
      this.qSource = 'fallback';
    }
    this.acceptedObservationsSinceQ = 0;
    return this.q;
  }

  _findEligibleNeighbours(speed, heel) {
    const neighbours = [];
    for (let row = 0; row < this.n[0]; row++) {
      for (let col = 0; col < this.n[1]; col++) {
        const cell = this.table[row][col];
        cell.effectiveVariance = null;
        if (cell.N <= MIN_CELL_INDEX) continue;
        const rowDistance = (this.indexToValue(row, 0) - speed) / this.step[0];
        const colDistance = (this.indexToValue(col, 1) - heel) / this.step[1];
        const dist = Math.sqrt(rowDistance * rowDistance + colDistance * colDistance);
        if (Number.isFinite(dist) && dist <= MAX_INTERPOLATION_DISTANCE) {
          neighbours.push({ cell, row, col, dist, normWeight: 0 });
        }
      }
    }
    return neighbours.sort((a, b) => a.dist - b.dist);
  }

  getCorrection(speed, heel) {
    this.neighbours = this._findEligibleNeighbours(speed, heel);
    const emptyResult = { correction: { x: 0, y: 0 }, variance: { x: 0, y: 0, covariance: [[0, 0], [0, 0]] } };
    if (this.neighbours.length === 0) return emptyResult;

    const precision = [[0, 0], [0, 0]];
    const information = [0, 0];
    let totalScalarWeight = 0;
    for (const neighbour of this.neighbours) {
      const effectiveCovariance = _symmetricCovariance(neighbour.cell.covariance, this.q * neighbour.dist ** 2);
      const cellPrecision = effectiveCovariance && _inverse2(effectiveCovariance);
      if (!cellPrecision) continue;

      neighbour.effectiveCovariance = effectiveCovariance;
      neighbour.cell.effectiveVariance = effectiveCovariance[0][0] + effectiveCovariance[1][1];
      neighbour.scalarWeight = cellPrecision[0][0] + cellPrecision[1][1];
      totalScalarWeight += neighbour.scalarWeight;
      precision[0][0] += cellPrecision[0][0];
      precision[0][1] += cellPrecision[0][1];
      precision[1][0] += cellPrecision[1][0];
      precision[1][1] += cellPrecision[1][1];
      information[0] += cellPrecision[0][0] * neighbour.cell.x + cellPrecision[0][1] * neighbour.cell.y;
      information[1] += cellPrecision[1][0] * neighbour.cell.x + cellPrecision[1][1] * neighbour.cell.y;
    }

    const covariance = _inverse2(precision);
    if (!covariance) return emptyResult;
    for (const neighbour of this.neighbours) {
      neighbour.normWeight = totalScalarWeight > 0 && Number.isFinite(neighbour.scalarWeight)
        ? neighbour.scalarWeight / totalScalarWeight
        : 0;
    }
    const x = covariance[0][0] * information[0] + covariance[0][1] * information[1];
    const y = covariance[1][0] * information[0] + covariance[1][1] * information[1];
    return {
      correction: { x, y },
      variance: { x: covariance[0][0], y: covariance[1][1], covariance }
    };
  }
  
  report() {
    return {
      id: this.id,
      row: { min: this.min[0], max: this.max[0], step: this.step[0] },
      col: { min: this.min[1], max: this.max[1], step: this.step[1] },
      table: this.table.map((row, rowIndex) =>
        row.map((correction, colIndex) => {
          const cellReport = correction.report();
          // Derive the bin coordinates from indices
          const speedBin = this.min[0] + this.step[0] * rowIndex; // row axis represents speed
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
            const cov = correction.covariance;
            if (cov && Array.isArray(cov) && cov[0] && cov[1] && Number.isFinite(cov[0][0]) && Number.isFinite(cov[1][1])) {
              trace = cov[0][0] + cov[1][1];
            }
          }
          cellReport.forward = forward;
          cellReport.factor = factor;
          cellReport.leeway = leeway;
          cellReport.trace = trace;
          cellReport.effectiveVariance = Number.isFinite(correction.effectiveVariance)
            ? correction.effectiveVariance
            : null;
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
      displayAttributes: this.displayAttributes,
      q: this.q,
      qPairCount: this.qPairCount,
      qEstimate: this.qEstimate,
      qSource: this.qSource,
      lastUpdateResult: this.lastUpdateResult ?? null
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
        stateProjection: OBSERVATION_STATE_PROJECTION,
        // Measurement noise R is computed per observation in update() from live sensor
        // variances (see observationCovariance below) and supplied to the filter through
        // the `observationCovariance` option, rather than being a fixed matrix.
        covariance: (options) => options.observationCovariance,
        dimension: 2
      },
      dynamic: {
        transition: DYNAMIC_TRANSITION, // state transition matrix F
        covariance: [1/10**stability, 1/10**stability],// process noise covariance matrix Q
      }
    };
  }

  /**
   * Serializable descriptor of the filter model, stored in table.parameters for persistence.
   * Unlike getFilterModel(), this never contains functions.
   */
  static getModelDescriptor(stability = 5) {
    return {
      stability,
      observation: {
        stateProjection: OBSERVATION_STATE_PROJECTION,
        covariance: 'per-observation', // actual R supplied at runtime by CorrectionEstimator.update()
        dimension: 2
      },
      dynamic: {
        transition: DYNAMIC_TRANSITION,
        covariance: [1/10**stability, 1/10**stability]
      }
    };
  }

  constructor(filterModel, initialState) {
    this.filter = new KalmanFilter(filterModel);
    this.filterState = null;
    this.effectiveVariance = null;
    if (initialState != null) {
      this.filterState = new State(initialState);
    }
  }
  
  update(groundSpeed, current, boatSpeed, heading, headingVariance) {
    if(groundSpeed.xVariance == null || groundSpeed.yVariance == null ||
       current.xVariance == null || current.yVariance == null ||
       boatSpeed.xVariance == null || boatSpeed.yVariance == null ) {
       return false;
    }
    // Rotation matrix for -theta
    const cosTheta = Math.cos(heading);
    const sinTheta = Math.sin(heading);

    var groundVector = _rotateValue(cosTheta, sinTheta, groundSpeed.vector);
    var currentVector = _rotateValue(cosTheta, sinTheta, current.vector);
    var boatVector = boatSpeed.vector;

    const observation = [
      -boatVector[0] + groundVector[0] - currentVector[0],
      -boatVector[1] + groundVector[1] - currentVector[1]
    ];

    var groundCov = _rotateVariance(cosTheta, sinTheta, groundSpeed.variance);
    var currentCov = _rotateVariance(cosTheta, sinTheta, current.variance);
    var boatCov = [[boatSpeed.xVariance, 0], [0, boatSpeed.yVariance]];

    let observationCovariance = [[
      groundCov[0][0] + currentCov[0][0] + boatCov[0][0],
      groundCov[0][1] + currentCov[0][1] + boatCov[0][1]],
    [
      groundCov[1][0] + currentCov[1][0] + boatCov[1][0],
      groundCov[1][1] + currentCov[1][1] + boatCov[1][1]],
    ];
    observationCovariance = _addHeadingVariance(
      observationCovariance,
      groundVector,
      currentVector,
      headingVariance
    );
    // Mahalanobis distance check.
    // For empty cells (filterState === null) we use a diffuse prior — mean (0,0),
    // variance DIFFUSE_PRIOR_VAR — expressing "assume no correction needed, but
    // with high uncertainty".  This gates the very first observation instead of
    // accepting it unconditionally, preventing a single outlier from locking a
    // cell at a bad value.
    const DIFFUSE_PRIOR_VAR = 1.0; // (m/s)² — rejects corrections > ~3 m/s from zero
    const priorMean = this.filterState !== null
      ? [this.filterState.mean[0][0], this.filterState.mean[1][0]]
      : [0, 0];
    const priorCov = this.filterState !== null
      ? this.filterState.covariance
      : [[DIFFUSE_PRIOR_VAR, 0], [0, DIFFUSE_PRIOR_VAR]];
    const inno = [observation[0] - priorMean[0], observation[1] - priorMean[1]];
    const S = [
      [priorCov[0][0] + observationCovariance[0][0],
       priorCov[0][1] + observationCovariance[0][1]],
      [priorCov[1][0] + observationCovariance[1][0],
       priorCov[1][1] + observationCovariance[1][1]]
    ];
    const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    if (Number.isFinite(det) && det > 1e-12) {
      const Sinv = [
        [ S[1][1] / det, -S[0][1] / det],
        [-S[1][0] / det,  S[0][0] / det]
      ];
      const d2 = inno[0] * (Sinv[0][0] * inno[0] + Sinv[0][1] * inno[1])
               + inno[1] * (Sinv[1][0] * inno[0] + Sinv[1][1] * inno[1]);
      if (d2 > 9.21) return false;
    }
    this.filterState = this.filter.filter({ previousCorrected: this.filterState, observation, observationCovariance });
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


module.exports = { CorrectionTable, CorrectionEstimator };
