const { Delta, PolarDelta, SI } = require('./pluginUtils.js');
const { CorrectionTable } = require('./correctionTable.js');
const { KalmanFilter } = require('kalman-filter');

class Reporter {
  constructor() {
    this.report = {};
    this.options = null;
  }

  newReport(timestamp, options) {
    this.report = {
      timestamp: timestamp,
      options: options,
      polarSteps: [
      ],
      attitudeSteps: [
      ],
      deltas: [
      ],
      tables: [],
    };
  }

  addPolar(label, polar) {
    this.report.polarSteps.push(
      {
        label: label,
        speed: (polar.speed.value),
        angle: (polar.angle.value)
      });
  }

  addAttitude(label, delta) {
    this.report.attitudeSteps.push(
      {
        label: label,
        roll: (delta.value.roll),
        pitch: (delta.value.pitch),
      }
    );
  }

  addRotation(label, value) {
    this.report.attitudeSteps.push(
      {
        label: label,
        roll: (value.roll),
        pitch: (value.pitch),
      }
    );
  }

  addDelta(label, value) {
    this.report.deltas.push(
      {
        label: label,
        value: (value.value),
      }
    );

  }

  addTable(table, heel, speed) {
    const data = table.getInfo();
    let { heelIndex, speedIndex } = table._getIndices(heel, speed);
    data.heelIndex = heelIndex;
    data.speedIndex = speedIndex;
    this.report.tables.push(data);
  }

  getReport() {
    return this.report;
  }
}



module.exports = function (app) {

  let unsubscribes = [];
  let options = {};
  let isRunning = false;
  let corrTable = null;
  var heading, attitude,  boatSpeed, correctedBoatSpeed, groundSpeed, current, deltaV, reporter, lastSave;


  const plugin = {};
  plugin.id = "SpeedAndCurrent";
  plugin.name = "Speed and current";
  plugin.description = "An experimental plugin that uses sensor fusion to get boat speed, current and leeway.";
  plugin.schema = {
    type: "object",
    properties: {
      doStartFresh: {
        type: "boolean",
        title: "Empty correction table",
        description: "Restart with a fresh correction table. WARNING: all current corrections will be lost permanently!",
        default: false
      },
      heelStep: {
        type: "number",
        title: "Step size for heel",
        description: "Correction table stepsize for heel.",
        default: 8
      },
      maxHeel: {
        type: "number",
        title: "Maximum heel in correction table",
        description: "Correction table maximum heel.",
        default: 32
      },
      speedStep: {
        type: "number",
        title: "Step size for speed",
        description: "Correction table stepsize for speed.",
        default: 1
      },
      maxSpeed: {
        type: "number",
        title: "Maximum speed in correction table",
        description: "Correction table maximum speed.",
        default: 9
      },
      doEstimate: {
        type: "boolean",
        title: "Update correction table",
        description: "Update estimations in the correction table.",
        default: true,
      },
      doCorrect: {
        type: "boolean",
        title: "Correct boat speed",
        description: "Correct boat speed using correction table. This includes adding leeway.",
        default: true,
      },
      correctionStability: {
        type: "number",
        title: "Stability of correction estimation",
        description: `The stability of the correction estimation indicates how much the estimation is trusted 
        opposed to the calculation of . Biggeboat speed. Bigger values give more trust to the estimation and more stable estimations`,
        default: 7,
        minimum: 5,
        maximum: 12
      },
      preventDuplication: {
        type: "boolean",
        title: "Prevent duplication of boat speed",
        description: "Overwrite boat speed from sensor with corrected boat speed.",
        default: true,
      },
      noCurrent: {
        type: "boolean",
        title: "assume no current",
        description: `The estimator assumes that there is no current. 
        This can improve the quality of the estimation on standing waters.`,
        default: false,
      },
            doCurrent: {
        type: "boolean",
        title: "Estimate current",
        description: "Estimate water current.",
        default: true,
      },
      currentStability: {
        type: "number",
        title: "Stability of current estimation",
        description: `The stability of the current estimation indicates how much the estimation is trusted 
        opposed to the calculation of current. Bigger values give more trust to the estimation and more sable estimations`,
        default: 5,
        minimum: 3,
        maximum: 12
      },
    }
  };

  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

    router.get('/getResults', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reporter?.getReport());
      }

    });

    router.get('/getVectors', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        const v = {  deltas: [], polars: [] };
        const d = [heading, attitude];
        const p = [groundSpeed, boatSpeed, correctedBoatSpeed, current, deltaV];
        p.forEach(polar => {
          v.polars.push({
            id: polar.id,
            plane: polar.plane,
            label: polar.label,
            speed: polar.speed.value,
            angle: polar.angle.value,
          });
        });
        d.forEach(delta => {
          v.deltas.push({
            id: delta.id,
            value: delta.value,
          });
        });
        res.json(v);
      }
    });

  }

  function saveTable(options, correctionTable) {
    options.correctionTable = correctionTable.toJSON();
    app.savePluginOptions(options, () => { app.debug('Correction table saved') });
    return new Date();
  }


  plugin.start = (opts) => {
    app.debug("plugin started");
    options = opts;
    if (enforceConsistancy() && !options.doStartFresh) {
      corrTable = CorrectionTable.fromJSON(options.correctionTable, 10 ** options.correctionStability);
      app.debug("Correction table loaded");
      lastSave = new Date();
    }
    else {
      corrTable = new CorrectionTable(SI.fromDegrees(options.heelStep), SI.fromKnots(options.speedStep), SI.fromDegrees(options.maxHeel), SI.fromKnots(options.maxSpeed), 10 ** options.correctionStability);
      app.debug("Correction table created");
      options.doStartFresh = false;
      lastSave = saveTable(options, corrTable);
    }


    // TBD: headingTrue or headingMagnetic
    heading = new Delta(app, plugin.id, "navigation.headingMagnetic");
    attitude = new Delta(app, plugin.id, "navigation.attitude");
    currentDelta = new Delta(app, plugin.id, "environment.current");
    attitude.value = { pitch: 0, roll: 0, yaw: 0 }; //prevents errors when there is no attitude sensor
    //apparentWind = new PolarDelta(app, plugin.id, "environment.wind.speedApparent", "environment.wind.angleApparent");
    boatSpeed = new PolarDelta(app, plugin.id, "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    correctedBoatSpeed = new PolarDelta(app, plugin.id, "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    groundSpeed = new PolarDelta(app, plugin.id, "navigation.speedOverGround", "navigation.courseOverGroundTrue");
    current = new PolarDelta(app, plugin.id, );
    deltaV = new PolarDelta(app, plugin.id);


    heading.setId("heading");
    attitude.setId("attitude");
    boatSpeed.setId("boatSpeed", "ref_boat", "speed through water");
    correctedBoatSpeed.setId("correctedSpeed", "ref_boat", "corrected boat Speed");
    groundSpeed.setId("groundSpeed", "ref_ground", "speed over ground");
    current.setId("current", "ref_ground", "current");
    deltaV.setId("correction","ref_boat","correction");

    reporter = new Reporter();

    groundSpeed.subscribe(unsubscribes, "instant");
    heading.subscribe(unsubscribes, "instant");
    attitude.subscribe(unsubscribes, "instant");
    if (options?.preventDuplication) {
      boatSpeed.catchDeltas(calculate);
    }
    else {
      boatSpeed.speed.subscribe(unsubscribes, "instant");
      boatSpeed.speed.onChange = calculate;
    }

    const stability = 10 ** (options.currentStability);
    const currentEstimator = new KalmanFilter({
      observation: {
        stateProjection: [[.999, 0], [0, .999]], // observation matrix H
        covariance: [[1 * stability, 0], [0, 1 * stability]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1, 1],// process noise covariance matrix Q
      }
    });
    let previousCorrected = null;


    isRunning = true;


    function calculate(timestamp) {
      // prepare iteration
      correctedBoatSpeed.copyFrom(boatSpeed);
      heel = attitude.value.roll;
      speed = boatSpeed.speed.value;
      boatAngle = heading.value;
      reporter.newReport(timestamp, options);
      reporter.addPolar("ground speed", groundSpeed);
      reporter.addPolar("boat speed", boatSpeed);
      reporter.addAttitude("Attitude", attitude);
      reporter.addDelta("heading", heading);


      if (options.doCorrect) {
        corrTable.update(groundSpeed.getVectorValue(), current.getVectorValue(), boatSpeed.getVectorValue(), heading.value, heel, speed);
      }
      reporter.addTable(corrTable, heel, speed);

      // correct boat speed

      cor = corrTable.getKalmanCorrection(heel, speed);
      deltaV.setVectorValue(cor);
      deltaV.rotate(Math.PI);
      reporter.addPolar("correction", deltaV);
      correctedBoatSpeed.add(deltaV);
      reporter.addPolar("corrected boat speed", correctedBoatSpeed);
      if (!options.noCurrent && cor.totalWeight > 0) {
        // estimate current when there is a corrected boat speed;
        current.copyFrom(correctedBoatSpeed);
        current.rotate(boatAngle);
        current.substract(groundSpeed);
        const v = current.getVectorValue();
        const observation = [v.x, v.y];
        previousCorrected = currentEstimator.filter({ previousCorrected, observation });
        v.x = previousCorrected.mean[0][0];
        v.y = previousCorrected.mean[1][0];
        current.setVectorValue(v);
      }
      if (options.doCurrent) {
        const c = current.getValue();
        const cc= {drift: current.speed, setTrue: current.angle, setMagnetic: null};
        currentDelta.setValue(cc);
        currentDelta.sendDelta();
      }

      if (options.doCorrect) correctedBoatSpeed.sendDelta();

      reporter.addPolar("current", current);
      if (new Date() - lastSave > 5 * 60 * 1000) {
        lastSave = saveTable(options, corrTable);
      }

    }

    function enforceConsistancy() {
      // function is bugged due to IS units vs knots and degrees
      if (!options?.correctionTable) return false;
      const table = options.correctionTable;
      options.maxSpeed = Math.ceil(options.maxSpeed / options.speedStep) * options.speedStep;
      options.maxHeel = Math.ceil(options.maxHeel / options.heelStep) * options.heelStep;
      if (!isEqual(SI.fromKnots(options.maxSpeed), table.maxSpeed)) return false;
      if (!isEqual(SI.fromDegrees(options.maxHeel), table.maxHeel)) return false;
      if (!isEqual(SI.fromKnots(options.speedStep), table.speedStep)) return false;
      if (!isEqual(SI.fromDegrees(options.heelStep), table.heelStep)) return false;
      return true;
    }

    function isEqual(a, b) {
      const TOLERANCE = 1e-5;
      if (Math.abs(a - b) < TOLERANCE) {
        return true;
      }
      return false;
    }
  }


  plugin.stop = () => {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    //corrTable.save(app);
    if (corrTable != null) {
      lastSave = saveTable(options, corrTable);
    }
    options = {};
    heading = null;
    attitude = null;
    apparentWind = null;
    boatSpeed = null;
    groundSpeed = null;
    current = null;
    deltaV = null;
    reporter = null;
    isRunning = false;
    corrTable = null;
    deltaV = null;
  };
  return plugin;
};
