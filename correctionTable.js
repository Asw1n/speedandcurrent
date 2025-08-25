const { Table2D} = require('signalkutilities');
const { KalmanFilter, State } = require('kalman-filter');

class CorrectionTable extends Table2D{
  /**
   * Represents a 2D correction table for heel and speed.
   */



  static fromJSON(data, stability) {
    const table = new CorrectionTable(data.id, data.row, data.col, stability);
    table.table = data.table.map(row => row.map(cellData => CorrectionEstimator.fromJSON(cellData)));
    return table;
  }

  constructor(id, row, col, stability=5) {
    super(id, row, col, CorrectionEstimator, CorrectionEstimator.getFilterModel(stability));
    this.lastUpdatedCell = null;
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
  
  report() {
    return {
      id: this.id,
      row: { min: this.min[0], max: this.max[0], step: this.step[0] },
      col: { min: this.min[1], max: this.max[1], step: this.step[1] },
      table: this.table.map(row =>
        row.map(correction => {
          const cellReport = correction.report();
          // Mark selected if this is the last updated cell
          cellReport.displayAttributes = {
            selected: correction === this.lastUpdatedCell
          };
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
        covariance: [[10 ** stability, 0], [0, 10 ** stability]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1, 1],// process noise covariance matrix Q
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
    if(groundSpeed.n < 2 || current.n < 2 || boatSpeed.n < 2)  return;
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
