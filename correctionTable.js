const { KalmanFilter, State } = require('kalman-filter');

class Correction {
  /**
   * Represents a Kalman correction at a cell in a correction table
   */

  static minTrace = null;

  constructor(stability = 100000, initialState) {
    const filterModel = {
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[stability, 0], [0, stability]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1, 1],// process noise covariance matrix Q
      }
    };
    this.filter = new KalmanFilter(filterModel);
    this.filterState = null;
    if (initialState != null) {
      this.filterState = new State(initialState);
    }
    if (Correction.minTrace == null) {
      Correction.calculateMinTrace(stability);
    }
  }

  static calculateMinTrace(stability) {
    const cFilter = new KalmanFilter({
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[stability, 0], [0, stability]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1, 1],// process noise covariance matrix Q
      }
    });

    let trace = 0;
    let N = 10000;
    let previousCorrected = null;
    let observation = [0, 0];
    for (let x = 0; x < N; x++) {
      previousCorrected = cFilter.filter({ previousCorrected, observation });
    }
    Correction.minTrace = previousCorrected.covariance[0][0] + previousCorrected.covariance[1][1];
  }

  update(groundSpeed, current, boatSpeed, heading) {
    if (groundSpeed.n < 2 || current.n < 2 || boatSpeed.n < 2) return;
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

    var groundVector = rotateValue(groundSpeed.obs);
    var currentVector = rotateValue(current.obs);
    var boatVector = boatSpeed.obs;

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




  getCorrection() {
    return [this.x, this.y, this.N];
  }

  getInfo() {
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

  get trace() {
    if (this.filterState == null) return 0;
    const covariance = this.filterState.covariance;
    return covariance[0][0] + covariance[1][1];
  }

  get covariance() {
    return this.filterState.covariance;
  }


  toJSON() {
    return this.N != 0 ? { state: this.filterState } : { state: null };
  }

  static fromJSON(data, stability) {
    if (!data || data.state === undefined) {
      return new Correction();
    }
    return new Correction(stability, data.state ?? null);
  }
}


class CorrectionTable {
  /**
   * Represents a 2D correction table for heel and speed.
   */
  constructor(heelStep = 5, speedStep = 1, maxHeel = 45, maxSpeed = 20, stability = 100000) {
    // possible bug if max is not a multiplication of step
    this.heelStep = heelStep; // Step size for heel
    this.speedStep = speedStep; // Step size for speed
    this.maxHeel = maxHeel; // Maximum heel value
    this.maxSpeed = maxSpeed; // Maximum speed value

    // Initialize the correction table as a 2D array
    Correction.minTrace = null;
    this.table = Array.from({ length: (2 * Math.ceil(maxHeel / heelStep)) + 1 }, () =>
      Array.from({ length: Math.ceil(maxSpeed / speedStep) + 1 }, () => new Correction(stability))
    );
  }

  get heelCenter() {
    return this.maxHeel / this.heelStep;
  }

  _getHeelIndex(heel) {
    // Center index for heel = 0
    const center = Math.floor((this.table.length - 1) / 2);

    // Calculate offset, shifting heel by half a step for symmetric mapping
    const offset = Math.round(heel / this.heelStep);

    // Determine index relative to the center
    const i = center + offset;

    // Clamp index to valid range
    return Math.max(0, Math.min(i, this.table.length - 1));
  }

  _getSpeedIndex(speed) {
    return Math.max(0, Math.min(Math.floor((speed + this.speedStep / 2) / this.speedStep), this.table.length - 1));
  }

  _getIndices(heel, speed) {
    /** Calculate array indices for the given heel and speed. */
    const heelIndex = this._getHeelIndex(heel);
    const speedIndex = this._getSpeedIndex(speed);
    return { heelIndex, speedIndex };
  }

  update(groundSpeed, current, boatSpeed, heading, heel, speed) {
    const i = this._getIndices(heel, speed);
    this.table[i.heelIndex][i.speedIndex].update(groundSpeed, current, boatSpeed, heading);
  }

  getKalmanCorrection(heel, speed) {
    /**
   * Return a estimated correction based on interpolation and weighting of correction variance;
   */
    if (speed == 0) return { x: 0, y: 0 };
    const neighbours = this.findNeighbours(heel, speed);
    let totalWeight = 0;
    let x = 0;
    let y = 0;
    for (const neighbour of neighbours) {
      const { correction, distance } = neighbour;
      if (correction.N > 0) {
        const weightDistance = 1 / (distance + 1e-6); // Distance-based weight
        const weightCovariance = Correction.minTrace / (correction.trace + 1e-6); // Covariance-based weight
        const weight = weightDistance * weightCovariance;
        x += correction.x * weight;
        y += correction.y * weight;
        totalWeight += weight;
      }
    }
    if (totalWeight == 0) return { x: 0, y: 0, totalWeight };
    x = x / totalWeight;
    y = y / totalWeight;
    return { x, y, totalWeight };
  }

  findNeighbours(heel, speed) {
    // bound heel and speed
    if (heel < -this.maxHeel) heel = - this.maxHeel;
    if (heel > this.maxHeel) heel = this.maxHeel;
    if (speed < 0) speed = 0;
    if (speed > this.maxSpeed) speed = this.maxSpeed;
    // Calculate the heel and speed indices based on the value
    const heelIndex = (heel / this.heelStep) + this.heelCenter;
    const speedIndex = speed / this.speedStep;

    // Determine floor and ceil for both heel and speed
    const heelFloorIndex = Math.floor(heelIndex);
    const heelCeilIndex = Math.ceil(heelIndex);
    const speedFloorIndex = Math.floor(speedIndex);
    const speedCeilIndex = Math.ceil(speedIndex);

    // Collect all valid neighboring indices
    const neighbours = [];
    for (let h = heelFloorIndex; h <= heelCeilIndex; h++) {
      for (let s = speedFloorIndex; s <= speedCeilIndex; s++) {
        if (h >= 0 && h < this.table.length && s >= 0 && s < this.table[0].length) {
          const distance = this.calculateNormalizedDistance(heel, speed, h, s);
          neighbours.push({ correction: this.table[h][s], distance });
        }
      }
    }
    return neighbours;
  }


  calculateNormalizedDistance(heel, speed, heelIndex, speedIndex) {
    // Center values of the table cell identified by indices
    const cellHeel = (heelIndex - this.heelCenter) * this.heelStep + this.heelStep / 2;
    const cellSpeed = speedIndex * this.speedStep + this.speedStep / 2;
    // Normalize distances to table cell units
    const normalizedHeelDistance = (heel - cellHeel) / this.heelStep;
    const normalizedSpeedDistance = (speed - cellSpeed) / this.speedStep;

    // Combine distances into a single normalized distance (e.g., Euclidean)
    const totalNormalizedDistance = Math.sqrt(
      normalizedHeelDistance ** 2 + normalizedSpeedDistance ** 2
    );
    return totalNormalizedDistance;
  }

  getN(heel, speed) {
    const i = this._getIndices(heel, speed);
    return this.table[i.heelIndex][i.speedIndex].N;
  }

  getInfo() {
    return {
      heelStep: this.heelStep,
      speedStep: this.speedStep,
      maxHeel: this.maxHeel,
      maxSpeed: this.maxSpeed,
      table: this.table.map(row => row.map(correction => correction.getInfo()))
    };
  }

  toJSON() {
    return {
      heelStep: this.heelStep,
      speedStep: this.speedStep,
      maxHeel: this.maxHeel,
      maxSpeed: this.maxSpeed,
      table: this.table.map(row => row.map(correction => correction.toJSON()))
    };
  }


  static fromJSON(data, stability) {
    const instance = new CorrectionTable(); // Replace `YourClass` with the actual class name
    instance.heelStep = data.heelStep;
    instance.speedStep = data.speedStep;
    instance.maxHeel = data.maxHeel;
    instance.maxSpeed = data.maxSpeed;

    // Deserialize the table
    instance.table = data.table.map(row =>
      row.map(correctionData => Correction.fromJSON(correctionData, stability))
    );

    return instance;
  }
}

module.exports = { CorrectionTable };
