const { PolarStat, DeltaStat, DeltaBase, DeltaSubscribe, PolarDeltaBase, PolarDeltaCatch, PolarDeltaSubscribe, SI } = require('signalkutilities');
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
        speed: (polar.pValue.speed),
        angle: (polar.pValue.angle)
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
  let lastSave = null;
  var residu, heading, attitude, boatSpeed, boatSpeedPolar, correctedBoatSpeed, groundSpeed, current, currentDelta, speedCorrection, reporter;


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
      currentStability1: {
        type: "number",
        title: "Stability of current estimation when updating correction",
        description: `The stability of the current estimation indicates how much the estimation is trusted 
        opposed to the calculation of current. Bigger values give more trust to the estimation and more sable estimations`,
        default: 5,
        minimum: 4,
        maximum: 8
      },
      currentStability2: {
        type: "number",
        title: "Stability of current estimation when correction is fixed",
        description: `The stability of the current estimation indicates how much the estimation is trusted 
        opposed to the calculation of current. Bigger values give more trust to the estimation and more sable estimations`,
        default: 2,
        minimum: 1,
        maximum: 5
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
        const v = { deltas: [], polars: [] };
        const d = [heading, attitude];
        const p = [groundSpeed, boatSpeedPolar, correctedBoatSpeed, current, speedCorrection, residu];
        p.forEach(polar => {
          v.polars.push({
            id: polar.id,
            plane: polar.plane,
            label: polar.label,
            speed: polar.pValue.speed,
            angle: polar.pValue.angle,
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

    // correction table
    if ( enforceConsistancy() && !options.doStartFresh) {
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

    // heading
    // TBD: headingTrue or headingMagnetic
    heading = new DeltaSubscribe("navigation.headingTrue");
    heading.subscribe(app, plugin.id, unsubscribes);
    heading.setId("heading");

    //attitude
    attitude = new DeltaSubscribe("navigation.attitude");
    attitude.value = { pitch: 0, roll: 0, yaw: 0 }; //prevents errors when there is no attitude sensor
    attitude.setId("attitude");
    attitude.subscribe(app, plugin.id, unsubscribes);

    // current
    currentDelta = new DeltaBase("environment.current");

    current = new PolarDeltaBase();
    current.setId("current", "ref_ground", "current");
    const currentStat = new PolarStat(current);

    // boat speed
    if (options.preventDuplication) {
      // DeltaCatch needed here 
      boatSpeed = new DeltaSubscribe("navigation.speedThroughWater");
      boatSpeed.subscribe(app, plugin.id, unsubscribes, calculate);
    }
    else {
      boatSpeed = new DeltaSubscribe("navigation.speedThroughWater");
      boatSpeed.subscribe(app, plugin.id, unsubscribes, calculate);
    }

    boatSpeedPolar = new PolarDeltaBase("navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    boatSpeedPolar.setId("boatSpeed", "ref_boat", "speed through water");
    const boatSpeedStat = new PolarStat(boatSpeedPolar);

    correctedBoatSpeed = new PolarDeltaBase("navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    correctedBoatSpeed.setId("correctedSpeed", "ref_boat", "corrected boat Speed");

    boatSpeedRefGround = new PolarDeltaBase();
    

    // ground speed
    groundSpeed = new PolarDeltaSubscribe("navigation.speedOverGround", "navigation.courseOverGroundTrue");
    groundSpeed.subscribe(app, plugin.id, unsubscribes);
    groundSpeed.setId("groundSpeed", "ref_ground", "speed over ground");
    const groundSpeedStat = new PolarStat(groundSpeed);

    // correction vector
    speedCorrection = new PolarDeltaBase();
    speedCorrection.setId("correction", "ref_boat", "correction");

    // residu
    residu = new PolarDeltaBase();
    residu.setId("residu", "ref_boat", "residu");

    reporter = new Reporter();

    // filter for current
    stability = 10 ** (options.doEstimate ? options.currentStability1 : options.currentStability2);
    const currentEstimator = new KalmanFilter({
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[1 * stability, 0], [0, 1 * stability]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[.9993, 0], [0, .9993]], // state transition matrix F
        covariance: [1, 1],// process noise covariance matrix Q
        init: {
          mean:[[0],[0]],
          covariance: [[1 , 0], [0, 1 ]]
        }
      }
    });
    let currentEstimation = null;

    // filter for boat speed
    stability = 10 ** (1);
    const boatSpeedEstimator = new KalmanFilter({
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[1 * stability, 0], [0, 1 * stability]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1, 1],// process noise covariance matrix Q
      }
    });
    let boatSpeedEstimation = null;


    isRunning = true;

function addSome() {
  groundSpeed.addVector({ x: SI.fromKnots(0), y: SI.fromKnots(1)});
}


    function calculate(timestamp) {


      // prepare iteration
      boatSpeedPolar.setVValue({ x: boatSpeed.value, y: 0 });
      groundSpeedStat.sample();
      currentStat.sample();
      boatSpeedStat.sample();
      heel = attitude.value.roll;
      speed = boatSpeed.value;
      theta = heading.value;
      reporter.newReport(timestamp, options);
      reporter.addPolar("ground speed", groundSpeed);
      reporter.addPolar("observed boat speed", boatSpeedPolar);
      reporter.addAttitude("Attitude", attitude);
      reporter.addDelta("heading", heading);

      // update correction table
      if (options.doCorrect) {
        corrTable.update(groundSpeedStat, currentStat, boatSpeedStat, theta, heel, speed);
      }
      reporter.addTable(corrTable, heel, speed);

      // correct and estimate boat speed
      estimateBoatSpeed();

      if (!options.noCurrent ) {
        estimateCurrent();
        // estimate current when there is a corrected boat speed;
      }
      calcResidu() ;

      const c = current.getPValue();
      const cc = { drift: current.speed, setTrue: current.angle, setMagnetic: null };
      currentDelta.setValue(cc);

      // Send calculated dalts
      if (options.doCurrent) DeltaBase.sendDeltas(app, plugin.id, [currentDelta]);
      if (options.doCorrect) PolarDeltaBase.sendDeltas(app, plugin.id, [correctedBoatSpeed]);

      // Save correction table 
      // periodically 
      if (new Date() - lastSave > 5 * 60 * 1000) {
        lastSave = saveTable(options, corrTable);
      }
    }

    function estimateBoatSpeed() {
      cor = corrTable.getKalmanCorrection(heel, speed);
      // app.debug(cor);
      correctedBoatSpeed.copyFrom(boatSpeedPolar);
      speedCorrection.setVValue(cor);
      
      reporter.addPolar("correction", speedCorrection);
      correctedBoatSpeed.add(speedCorrection);
      reporter.addPolar("corrected boatSpeed", correctedBoatSpeed);
      const v = correctedBoatSpeed.getVValue();
      const observation =[v.x, v.y];
      boatSpeedEstimation = boatSpeedEstimator.filter({ previousCorrected: boatSpeedEstimation, observation  });
      correctedBoatSpeed.setKValue(boatSpeedEstimation);
      reporter.addPolar("estimated boatSpeed", correctedBoatSpeed);
    }

    function estimateCurrent() {
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      reporter.addPolar("boat speed over ground", boatSpeedRefGround);
      current.copyFrom(groundSpeed);
      current.substract(boatSpeedRefGround);
      reporter.addPolar("ground minus boat", current);
      const v = current.getVValue();
      const observation = [v.x, v.y];
      currentEstimation = currentEstimator.filter({ previousCorrected: currentEstimation, observation });
      current.setKValue(currentEstimation);
      reporter.addPolar("estimated current", current);
    }

    function calcResidu() {
      residu.copyFrom(groundSpeed);
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      residu.substract(boatSpeedRefGround);
      residu.substract(current);
      reporter.addPolar("residu", residu);
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
    
    residu = null;
    heading = null;
    attitude = null;
    boatSpeed = null;
    boatSpeedPolar = null;
    correctedBoatSpeed = null;
    groundSpeed = null;
    current = null;
    currentDelta = null;
    speedCorrection = null;
    reporter = null;
    isRunning = false;
    corrTable = null;
  };
  return plugin;
};
