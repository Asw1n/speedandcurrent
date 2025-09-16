class LeakyExtremes {
  /**
   * @param {Object} opts
   * @param {number} opts.initialMin
   * @param {number} opts.initialMax
   * @param {number} opts.tau - time constant in seconds for exponential decay
   * @param {number} opts.catchupTau - time constant in seconds for fast catchup
   * @param {boolean} opts.isAngle - true if data is angular (radians)
   * @param {number} opts.period - period for angle wrapping (e.g., 2*Math.PI)
   */
  constructor({  initialMin=0, initialMax=0, tau = .15, catchupTau=.5, isAngle = false, period = 2 * Math.PI }) {
    this.min = initialMin;
    this.max = initialMax;
    this.tau = tau;
    this.catchupTau = catchupTau;
    this.isAngle = isAngle;
    this.period = period;
    this.lastUpdate = Date.now();
  }

  // Helper for angle difference in [-period/2, period/2]
  angleDiff(a, b) {
    let d = a - b;
    while (d > this.period / 2) d -= this.period;
    while (d < -this.period / 2) d += this.period;
    return d;
  }

  // Helper for angle normalization to [0, period)
  normalizeAngle(a) {
    while (a < 0) a += this.period;
    while (a >= this.period) a -= this.period;
    return a;
  }

  update(obs) {
    if (!isFinite(obs) ) return;
    const now = Date.now();
    const dt = (now - this.lastUpdate) / 1000;
    if (dt==0) return; 
    this.lastUpdate = now;

    if (!this.isAngle) {
      // Linear data
      // Update min
      if (obs < this.min) {
        const alpha = 1 - Math.exp(-dt / this.catchupTau);
        this.min += (obs - this.min) * alpha;
      } else {
        const alpha = 1 - Math.exp(-dt / this.tau);
        this.min += (obs - this.min) * alpha;
      }
      // Update max
      if (obs > this.max) {
        const alpha = 1 - Math.exp(-dt / this.catchupTau);
        this.max += (obs - this.max) * alpha;
      } else {
        const alpha = 1 - Math.exp(-dt / this.tau);
        this.max += (obs - this.max) * alpha;
      }
    } else {
      // Angular data
      obs=this.normalizeAngle(obs);
      let minDiff = this.angleDiff(obs, this.min);
      let maxDiff = this.angleDiff(obs, this.max);

      // Update min
      if (minDiff < 0) {
        const alpha = 1 - Math.exp(-dt / this.catchupTau);
        this.min = this.normalizeAngle(this.min + minDiff * alpha);
      } else {
        const alpha = 1 - Math.exp(-dt / this.tau);
        this.min = this.normalizeAngle(this.min + minDiff * alpha);
      }
      // Update max
      if (maxDiff > 0) {
        const alpha = 1 - Math.exp(-dt / this.catchupTau);
        this.max = this.normalizeAngle(this.max + maxDiff * alpha);
      } else {
        const alpha = 1 - Math.exp(-dt / this.tau);
        this.max = this.normalizeAngle(this.max + maxDiff * alpha);
      }
      
    }
  }

  // For angles, returns the minimal arc between min and max
  get range() {
    if (!this.isAngle) {
      return this.max - this.min;
    } else {
      let diff = this.angleDiff(this.max, this.min);
      return Math.abs(diff);
    }
  }
}

module.exports = { LeakyExtremes };