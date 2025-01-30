class Delta {
  constructor(app, pluginId, path) {
    this.path = path;
    this.value = 0;
    this.timestamp = 0;
    this.onChange = null;
    this.app = app;
    this.pluginId = pluginId;
    this.id = "";
  }

  setId(id) {
    this.id = id;
  }

  setValue(value) {
    this.value = value;
    this.timestamp = timestamp;
  }

  getValue() {
    return this.value;
  }

  getMessage() {
    return {
      path: this.path,
      value: this.value
    };
  }

  copyFrom(delta) {
    if (!(delta instanceof Delta)) throw new Error('Parameter must be of type Delta');
    this.value = typeof delta.value === 'object' && delta.value !== null
      ? structuredClone(delta.value)
      : delta.value;
    this.timestamp = new Date(delta.timestamp);
  }

  sendDelta() {
    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: {
            label: this.pluginId
          },
          values: [{ path: this.path, value: this.value }]
        }]
    };
    this.app.handleMessage(this.pluginId, delta);
  }

  subscribe(unsubscribes, policy) {
    if (this.path?.trim?.().length) {
      this.app.debug(`subscribing to ${this.path}`);
      let localSubscription = {
        context: "vessels.self",
        subscribe: [{ path: this.path, policy: policy }]
      };
      this.app.subscriptionmanager.subscribe(
        localSubscription,
        unsubscribes,
        subscriptionError => {
          this.app.error('Error:' + subscriptionError);
        },
        delta => {
          delta.updates.forEach(u => {
            //this.app.debug(u.source?.label);
            //this.app.debug(this.pluginId);
            if (u.source?.label !== this.pluginId) {
              u.values.forEach(v => {
                this.value = v.value;
                this.timestamp = new Date(u.timestamp);
                if (typeof this.onChange === 'function')
                  this.onChange(this.timestamp);
              }
              )

            }
          }
          )
        }
      )
    }
  }


}

class PolarDelta {
  constructor(app, pluginId, speedPath, anglePath) {
    this.speed = new Delta(app, pluginId, speedPath);
    this.angle = new Delta(app, pluginId, anglePath);
    this.smoothener = new ExponentialMovingAverage();
    this.label = "polar";
    this.plane = "ref_Boat";
    this.id = "";
    this.app = app;
    this.pluginId = pluginId;
  }

  setId(id, refPlane, label) {
    this.id = id;
    this.plane = refPlane;
    this.label = label;
  }

  debug(message) {
    this.app.debug(`${message}: ${this.speed.value} , ${this.angle.value}`);
  }

  getTimestamp() {
    return this.speed.timestamp > this.angle.timestamp ? this.speed.timestamp : this.angle.timestamp;
  }

  setValue(value) {
    this.speed.value = value.speed;
    this.angle.value = value.angle;
  }

  setSpeed(value) {
    this.speed.setValue(value);
  }

  setAngle(value) {
    this.angle.setValue(value);
  }

  setVectorValue(vector) {
    this.speed.value = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
    this.angle.value = Math.atan2(vector.y, vector.x);
  }

  getValue() {
    return { speed: this.speed.value, angle: this.angle.value };
  }

  smoothen(timeConstant = 0) {
    this.setVectorValue(this.smoothener.update(this.getVectorValue(), this.getTimestamp(), timeConstant));
  }

  getVectorValue() {
    return { x: this.speed.value * Math.cos(this.angle.value), y: this.speed.value * Math.sin(this.angle.value) };
  }


  subscribe(unsubscribes, policy = "instant") {
    this.speed.subscribe(unsubscribes, policy);
    this.angle.subscribe(unsubscribes, policy);
  }

  sendDelta() {
    this.speed.sendDelta();
    this.angle.sendDelta();
  }

  rotate(angle) {
    this.angle.value = (this.angle.value + angle + Math.PI) % (2 * Math.PI) - Math.PI;
  }

  scale(factor) {
    this.speed.value *= factor;
  }

  copyFrom(polar) {
    if (!(polar instanceof PolarDelta)) throw new Error('Parameter must be of type PolarDelta');
    this.speed.copyFrom(polar.speed);
    this.angle.copyFrom(polar.angle);
  }

  add(polar) {
    if (!(polar instanceof PolarDelta)) throw new Error('Parameter must be of type Polar2D');
    const a = this.getVectorValue();
    const b = polar.getVectorValue();
    this.setVectorValue({ x: a.x + b.x, y: a.y + b.y });
  }

  addVector(vector) {
    if (!("x" in vector && "y" in vector)) throw new Error('Parameter must have both x and y');
    const a = this.getVectorValue();
    if (!("x" in vector && "y" in vector)) throw new Error('Parameter must have both x and y');
    this.setVectorValue({ x: a.x + vector.x, y: a.y + vector.y });
  }

  substract(polar) {
    if (!(polar instanceof PolarDelta)) throw new Error('Parameter must be of type Polar2D');
    const a = this.getVectorValue();
    const b = polar.getVectorValue();
    this.setVectorValue({ x: a.x - b.x, y: a.y - b.y });
  }

  substractVector(vector) {
    if (!("x" in vector && "y" in vector)) throw new Error('Parameter must have both x and y');
    const a = this.getVectorValue();
    if (!("x" in vector && "y" in vector)) throw new Error('Parameter must have both x and y');
    this.setVectorValue({ x: a.x - vector.x, y: a.y - vector.y });
  }

  catchDeltas(callBack) {
    this.app.debug(`Catching ${this.speed.path} and ${this.angle.path}.`);
    this.app.registerDeltaInputHandler((delta, next) => {
      let found = false;

      delta?.updates.forEach(update => {

        if (update?.source?.label != this.pluginId) {
          const timestamp = new Date(update.timestamp);
          if (Array.isArray(update?.values)) {
            update?.values.forEach(pathValue => {
              if (this.speed.path == pathValue.path) {
                this.speed.value = pathValue.value;
                this.speed.timestamp = timestamp;
                found = true;
              }
              if (this.angle.path == pathValue.path) {
                this.angle.value = pathValue.value;
                this.angle.timestamp = timestamp;
                found = true;
              }
            }
            )
          }
        }
      })
      if (!found) {
        next(delta);
      }
      else {
        callBack(this.getTimestamp());
      }
    });
  }

}

class ExponentialMovingAverage {
  constructor() {
    this.ema = null; // Initial value
    this.lastTime = null; // Track the last update time
  }

  update(newValue, currentTime, timeConstant) {
    if (this.ema === null || timeConstant == 0) {
      // Initialize EMA with the first value
      this.ema = { x: newValue.x, y: newValue.y };
      this.lastTime = new Date(currentTime);
    }
    else {
      // Calculate the time difference
      const deltaTime = (currentTime - this.lastTime) / 1000;
      //if (deltaTime == 0) return { x: this.ema.x, y: this.ema.y };
      // Compute alpha
      const alpha = 1 - Math.exp(-deltaTime / timeConstant);
      // Update EMA
      this.ema.x = this.ema.x + alpha * (newValue.x - this.ema.x);
      this.ema.y = this.ema.y + alpha * (newValue.y - this.ema.y);

      // Update last time
      this.lastTime = new Date(currentTime);
    }
    //console.log(this.ema);
    return { x: this.ema.x, y: this.ema.y };
  }

}

class SI {
  /**
   * Utility class for unit conversions.
   */
  static toKnots(metersPerSecond) {
    return metersPerSecond * 1.94384;
  }

  static fromKnots(knots) {
    return knots / 1.94384;
  }

  static toDegrees(radians) {
    return radians * (180 / Math.PI);
  }

  static fromDegrees(degrees) {
    return degrees * (Math.PI / 180);
  }
}


module.exports = { Delta, PolarDelta, SI };
