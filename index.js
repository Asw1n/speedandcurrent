const {  PolarStat, DeltaStat, DeltaBase, DeltaSubscribe, PolarDeltaBase, PolarDeltaCatch, PolarDeltaSubscribe, SI, Reporter } = require('signalkutilities');
const { CorrectionTable } = require('./correctionTable.js');
const { KalmanFilter } = require('kalman-filter');




module.exports = function (app) {

  let unsubscribes = [];
  let options = {};
  let isRunning = false;
  let corrTable = null;
  let lastSave = null;
  var residual, heading, attitude, boatSpeed, boatSpeedPolar, correctedBoatSpeed, groundSpeed, current, currentDelta, speedCorrection, reporter;


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
        const p = [groundSpeed, boatSpeedPolar, correctedBoatSpeed, current, speedCorrection, residual];
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

    // make options survive to the stop function
    options = opts;

    // correction table
    const table = loadTable(options);
    

    // heading
    // TBD: headingTrue or headingMagnetic
    heading = new DeltaSubscribe("navigation.headingTrue");
    heading.subscribe(app, plugin.id, unsubscribes);
    heading.setDisplayAttributes("heading","heading");

    //attitude
    attitude = new DeltaSubscribe("navigation.attitude");
    attitude.value = { pitch: 0, roll: 0, yaw: 0 }; //prevents errors when there is no attitude sensor
    attitude.setDisplayAttributes("attitude","attitude");
    attitude.subscribe(app, plugin.id, unsubscribes);
 
    // current
    currentDelta = new DeltaBase("environment.current");
    current = new PolarDeltaBase();
    current.setDisplayAttributes("current", "ref_ground", "current");

    const currentStat = new PolarStat(current);

    // magnetic variance 
    variance = new DeltaSubscribe("navigation.magneticVariation");

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
    boatSpeedPolar.setDisplayAttributes("boatSpeed", "ref_boat", "observed boat speed");
    const boatSpeedStat = new PolarStat(boatSpeedPolar);

    correctedBoatSpeed = new PolarDeltaBase("navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    correctedBoatSpeed.setDisplayAttributes("correctedSpeed", "ref_boat", "estimated boat Speed");

    boatSpeedRefGround = new PolarDeltaBase();
    boatSpeedRefGround.setDisplayAttributes("boatSpeedRefGround", "ref_ground","boat speed over ground");


    // ground speed
    groundSpeed = new PolarDeltaSubscribe("navigation.speedOverGround", "navigation.courseOverGroundTrue");
    groundSpeed.subscribe(app, plugin.id, unsubscribes);
    groundSpeed.setDisplayAttributes("groundSpeed", "ref_ground", "observed speed over ground");
    const groundSpeedStat = new PolarStat(groundSpeed);

    // correction vector
    speedCorrection = new PolarDeltaBase();
    speedCorrection.setDisplayAttributes("correction", "ref_boat", "correction");

    // residual
    residual = new PolarDeltaBase();
    residual.setDisplayAttributes("residual", "ref_ground", "residual");

    // Make reporting object for webApp
    reporter = new Reporter();

    // filter for current
    stability = 10 ** (options.doEstimate ? options.currentStability1 : options.currentStability2);
    const currentEstimator = new KalmanFilter({
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[1 , 0], [0, 1 ]], //measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1 / stability, 1 / stability],// process noise covariance matrix Q
        init: {
          mean: [[0], [0]],
          covariance: [[1 / stability, 0], [0, 1 / stability]]
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

    // Debug function to induce current in GPS data
    function addSome() {
      groundSpeed.addVector({ x: SI.fromKnots(0), y: SI.fromKnots(1) });
    }

    // Main function, estimates boatSpeed, leeway and current
    function calculate(timestamp) {
      // prepare iteration
      boatSpeedPolar.setVValue({ x: boatSpeed.value, y: 0 });
      groundSpeedStat.sample();
      currentStat.sample();
      boatSpeedStat.sample();
      heel = attitude.value.roll;
      speed = boatSpeed.value;
      theta = heading.value;
      if (!Number.isFinite(heel)) {
        app.debug("Heel is not a valid number, skipping calculation");
        return;
      }
      if (!Number.isFinite(speed)) {
        app.debug("Speed is not a valid number, skipping calculation");
        return;
      }
      if (!Number.isFinite(theta)) {
        app.debug("Heading is not a valid number, skipping calculation");
        return;
      }
      reporter.newReport();
      reporter.addOptions(options);
      reporter.addPolar( groundSpeed);
      reporter.addPolar( boatSpeedPolar);
      reporter.addAttitude( attitude);
      reporter.addDelta( heading);

      // update correction table
      if (options.doCorrect) {
        table.update(speed, heel, groundSpeedStat, currentStat, boatSpeedStat, theta);
      }
      reporter.addTable(table, speed, heel);

      // correct and estimate boat speed
      estimateBoatSpeed();

      if (!options.noCurrent) {
        // estimate current ;
        estimateCurrent();
      }
      calcResidual();

      // translate current into signalK data structure
      const c = current.getPValue();
      const cc = { drift: current.speed, setTrue: current.angle, setMagnetic: (current.angle - variance.value + Math.PI) % (2 * Math.PI) - Math.PI };
      currentDelta.setValue(cc);

      // Send calculated delta's
      if (options.doCurrent) DeltaBase.sendDeltas(app, plugin.id, [currentDelta]);
      if (options.doCorrect) PolarDeltaBase.sendDeltas(app, plugin.id, [correctedBoatSpeed]);

      // Save correction table 
      // periodically 
      if (new Date() - lastSave > 5 * 60 * 1000) {
        lastSave = saveTable(options, table);
      }
    }

    // estimates boat speed from observed boatSpeed and correction
    function estimateBoatSpeed() {
      cor = table.getKalmanCorrection(speed, heel);
      // app.debug(cor);
      correctedBoatSpeed.copyFrom(boatSpeedPolar);
      speedCorrection.setVValue(cor);

      reporter.addPolar(speedCorrection);
      correctedBoatSpeed.add(speedCorrection);
      const v = correctedBoatSpeed.getVValue();
      const observation = [v.x, v.y];
      boatSpeedEstimation = boatSpeedEstimator.filter({ previousCorrected: boatSpeedEstimation, observation });
      correctedBoatSpeed.setKValue(boatSpeedEstimation);
      reporter.addPolar(correctedBoatSpeed);
    }

    // estimates current from observed groundspeed and estimated boatspeed 
    function estimateCurrent() {
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      reporter.addPolar( boatSpeedRefGround);
      current.copyFrom(groundSpeed);
      current.substract(boatSpeedRefGround);
      reporter.addPolar( current);
      const v = current.getVValue();
      const observation = [v.x, v.y];
      currentEstimation = currentEstimator.filter({ previousCorrected: currentEstimation, observation });
      current.setKValue(currentEstimation);
      reporter.addPolar( current);
    }

    // Calculate what ground speed is observed that is not attributed to estimated boat speed or estimated current
    function calcResidual() {
      residual.copyFrom(groundSpeed);
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      residual.substract(boatSpeedRefGround);
      residual.substract(current);
      reporter.addPolar(residual);
    }

    // Make sure the table matches the settings
    function enforceConsistancy(row, col ) {
      // function is bugged due to IS units vs knots and degrees
      if (!options?.correctionTable) return false;
      const table = options.correctionTable;
      if (!table) return false;
      if (!table.row) return false;
      if (table.row.min != row.min) return false;
      if (table.row.max != row.max) return false;
      if (table.row.step != row.step) return false;
      if (table.col.min != col.min) return false;
      if (table.col.max != col.max) return false;
      if (table.col.step != col.step) return false;
      return true;
    }

    function loadTable(options) {
      const row = { min: 0, max: SI.fromKnots(options.maxSpeed), step: SI.fromKnots(options.speedStep) };
      const col = { min: -SI.fromDegrees(options.maxHeel), max: SI.fromDegrees(options.maxHeel), step: SI.fromDegrees(options.heelStep) };
      let table;
      if ( false && enforceConsistancy(row, col) && !options.doStartFresh) {
        table = CorrectionTable.fromJSON(options.correctionTable, options.correctionStability);
        app.debug("Correction table loaded");
        lastSave = new Date();
      }
      else {
        table = new CorrectionTable(row, col, options.correctionStability);
        app.debug("Correction table created");
        options.doStartFresh = false;
        lastSave = saveTable(options, table);
         app.debug(table.table.length);  
        app.debug(table.table[0].length);
      }
      table.setDisplayAttributes("correctionTable", "Speed / Heel");
      return table;
    }

    // compare floats
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

    residual = null;
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
