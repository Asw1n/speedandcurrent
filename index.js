const { SI, MessageHandler, MessageHandlerDamped, Polar, PolarDamped, Reporter, ExponentialSmoother, MovingAverageSmoother, KalmanSmoother, MessageSmoother, PolarSmoother, createSmoothedPolar, createSmoothedHandler } = require('signalkutilities');

const { CorrectionTable } = require('./correctionTable.js');
const { LeakyExtremes } = require('./LeakyExtremes.js');




module.exports = function (app) {

  let options = {};
  let isRunning = false;
  let corrTable = null;
  let lastSave = null;
  let heading = null;
  let stability = null;
  let attitude = null;
  let currentCalc = null;
  let current = null;
  let boatSpeedObserved = null;
  let boatSpeedCorrected = null;
  let boatSpeedRefGround = null;
  let groundSpeed = null;
  let speedCorrection = null;
  let residual = null;
  let reportFull = null;
  let reportVector = null;
  let table = null;

  const plugin = {};
  plugin.id = "SpeedAndCurrent";
  plugin.name = "Speed and current";
  plugin.description = "An experimental plugin that uses sensor fusion to get boat speed, current and leeway.";



  plugin.schema = {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "Plugin mode",
        description: "The mode of the plugin.",
        enum: ["Start with new correction table, no current",
          "Start with new correction table, with current",
          "Fresh correction table, no current",
          "Fresh correction table, with current",
          "Mature correction table, no current",
          "Mature correction table, with current",
          "Locked correction table",
          "Manual configuration"],
        default: "Start with new correction table, no current",
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

      headingSource: {
        type: "string",
        title: "Heading Source",
        description: "Source to use for navigation.heading (optional).",
        default: " "
      },

      boatSpeedSource: {
        type: "string",
        title: "Boat Speed Source",
        description: "Source to use for navigation.speedThroughWater (optional).",
        default: " "
      },

      COGSource: {
        type: "string",
        title: "Course over ground",
        description: "Source to use for navigation.courseOverGroundTrue (optional)",
        default: " "
      },

      SOGSource: {
        type: "string",
        title: "Ground Speed Source",
        description: "Source to use for navigation.speedOverGround (optional)",
        default: " "
      },

      attitudeSource: {
        type: "string",
        title: "Attitude Source",
        description: "Source to use for navigation.attitude (optional)",
        default: " "
      },

      preventDuplication: {
        type: "boolean",
        title: "Prevent duplication of boat speed",
        description: "Overwrite boat speed from sensor with corrected boat speed.",
        default: true,
      },

      updateCorrectionTable: {
        type: "boolean",
        title: "Update correction table",
        description: "Update estimations in the correction table.",
        default: true,
      },
      estimateBoatSpeed: {
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
      doStartFresh: {
        type: "boolean",
        title: "Empty correction table",
        description: "Restart with a fresh correction table. WARNING: all current corrections will be lost permanently!",
        default: false
      },
      assumeCurrent: {
        type: "boolean",
        title: "assume current",
        description: "The estimator assumes that there is current.",
        default: false,
      },
      estimateCurrent: {
        type: "boolean",
        title: "Estimate current",
        description: "Estimate water current.",
        default: true,
      },
      currentStability: {
        type: "number",
        title: "Stability of current estimation ",
        description: `The stability of the current estimation indicates how much the estimation is trusted 
        opposed to the calculation of current. Bigger values give more trust to the estimation and more sable estimations`,
        default: 5,
        minimum: 1,
        maximum: 8
      }
    }
  };

  plugin.uiSchema = {
    'ui:order': ["mode", "maxSpeed", "speedStep", "maxHeel", "heelStep", "headingSource", "boatSpeedSource", "COGSource", "SOGSource", "attitudeSource", "preventDuplication", "updateCorrectionTable", "estimateBoatSpeed", "correctionStability", "doStartFresh", "assumeCurrent", "estimateCurrent", "currentStability"],
    doStartFresh: {
      "ui:widget": "hidden",
    },
    heelStep: {
      "ui:widget": "updown",
    },
    maxHeel: {
      "ui:widget": "updown",
    },
    speedStep: {
      "ui:widget": "updown",
    },
    maxSpeed: {
      "ui:widget": "updown",
    },
    mode: {
      "ui:widget": "select",
    },
    updateCorrectionTable: {
      "ui:widget": "hidden",
    },
    estimateBoatSpeed: {
      "ui:widget": "hidden",
    },
    correctionStability: {
      "ui:widget": "hidden",
    },
    preventDuplication: {
      "ui:widget": "checkbox",
    },
    assumeCurrent: {
      "ui:widget": "hidden",
    },
    estimateCurrent: {
      "ui:widget": "hidden",
    },
    currentStability: {
      "ui:widget": "hidden",
    }
  };


  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');

    router.get('/getResults', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reportFull.report());
      }
    });

    router.get('/getVectors', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      }
      else {
        res.json(reportVector.report());
      }
    });

  }

  // ...existing code...

  function saveTable(options, correctionTable) {
    options.correctionTable = correctionTable.toJSON();
    app.savePluginOptions(options, () => { app.debug('Correction table saved') });
    return new Date();
  }


  plugin.start = (opts) => {
    app.setPluginStatus("starting");
    app.debug("plugin starting");
    let outputs = [];

    // make options survive to the stop function
    options = opts;
    let smootherOptions = { timeConstant: 1, processVariance: 1, measurementVariance: 20, timeSpan: 1 };
    loadPresets();

    // correction table
    table = loadTable(options);


    // heading
    heading = createSmoothedHandler({
      id: "heading",
      path: "navigation.headingTrue",
      source: opts.headingSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Heading" },
    });
    // stability of heading
    headingStability = new LeakyExtremes({ 
      initialMin: 0, 
      initialMax: Math.PI, 
      tau: 2,
      catchupTau: .2,
      isAngle: true,
      period: 2 * Math.PI
    });

    //attitude
    attitude = createSmoothedHandler({
      id: "attitude",
      path: "navigation.attitude",
      source: opts.attitudeSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Attitude" }
    });


    // current
    currentCalc = new Polar("current", "self.environment.current.drift", "self.environment.current.setTrue");
    currentCalc.setDisplayAttributes({ label: "current", plane: "Ground" });
    currentCalc.setAngleRange('0to2pi');
    current = new PolarSmoother("currentDamped", currentCalc, KalmanSmoother, { processVariance: 1, measurementVariance: 100000 });
    current.setAngleRange('0to2pi');
    current.setDisplayAttributes({ label: "current", plane: "Ground" });
    // Current should be initialised as no current
    currentCalc.setVectorValue({ x: 0, y: 0 });
    // There should be at least two samples, otherwise we can't calculate a valid speed
    current.sample();
    current.sample();

    // boat speed
    boatSpeedObserved = createSmoothedPolar({
      id: "boatSpeed",
      pathMagnitude: "navigation.speedThroughWater",
      pathAngle: null,
      subscribe: true,
      sourceMagnitude: opts.boatSpeedSource,
      sourceAngle: opts.boatSpeedSource,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Observed boat Speed", plane: "Boat" },
      passOn: !options.preventDuplication,
    });
   
    boatSpeedCorrected = new Polar("correctedBoatSpeed", "navigation.speedThroughWater", "navigation.leewayAngle");
    boatSpeedCorrected.setDisplayAttributes({ label: "corrected boat speed", plane: "Boat" });
 

    // TODO: Add navigation.speedThroughWaterTransverse and navigation.speedThroughWaterLongitudinal

    boatSpeedRefGround = new Polar("boatSpeedRefGround");
    boatSpeedRefGround.setDisplayAttributes("Boat speed over ground", "Ground");

    // ground speed
    groundSpeed = createSmoothedPolar({
      id: "groundSpeed",
      pathMagnitude: "navigation.speedOverGround",
      pathAngle: "navigation.courseOverGroundTrue",
      subscribe: true,
      sourceMagnitude: opts.SOGSource,
      sourceAngle: opts.COGSource,
      app,
      pluginId: plugin.id,
      SmootherClass: KalmanSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Ground Speed", plane: "Ground" },
      passOn: true,
      angleRange: '0to2pi'
    });
    // groundSpeed stability
    COGStability = new LeakyExtremes({
      initialMin: 0,
      initialMax: Math.PI,
      tau: 2,
      catchupTau: .2,
      isAngle: true,
      period: 2 * Math.PI
    });


    // correction vector
    speedCorrection = new Polar("speedCorrection");
    speedCorrection.setDisplayAttributes("speed correction", "Boat");
    speedCorrection.setDisplayAttributes({ label: "speed correction", plane: "Boat" });

    // residual
    residual = new Polar("residual");
    residual.setDisplayAttributes({ label: "residual", plane: "Ground" });

    // Make reporting object for webApp
    reportFull = new Reporter();
    reportFull.addDelta(heading);
    reportFull.addAttitude(attitude);
    reportFull.addPolar(groundSpeed);
    reportFull.addPolar(boatSpeedObserved);
    //reportFull.addPolar(boatSpeedStat);
    //reportFull.addPolar(groundSpeedStat);
    reportFull.addPolar(speedCorrection);
    reportFull.addPolar(boatSpeedCorrected);
    reportFull.addPolar(current);
    reportFull.addPolar(residual);
    reportFull.addTable(table);

    reportVector = new Reporter();
    reportVector.addDelta(heading);
    reportVector.addPolar(residual);
    reportVector.addPolar(speedCorrection);
    reportVector.addPolar(currentCalc);
    reportVector.addPolar(boatSpeedCorrected);
    reportVector.addPolar(boatSpeedObserved);
    reportVector.addPolar(groundSpeed);

    boatSpeedObserved.onChange = () => {
      calculate();
    };



    isRunning = true;
    app.setPluginStatus("Running");
    app.debug("Running");






    // Main function, estimates boatSpeed, leeway and current
    function calculate() {
      // prepare iteration
      const heel = attitude.value.roll;
      const speed = boatSpeedObserved.magnitude;
      const theta = heading.value;
      const COG = groundSpeed.angle;

      if (!Number.isFinite(heel) || !Number.isFinite(speed) || !Number.isFinite(theta) ) return;
      const stable = situationIsStable(theta, COG);



      // update correction table
      if (options.updateCorrectionTable  && stable && speed > 0) {
        table.update(speed, heel, groundSpeed, current, boatSpeedObserved, theta);
      }

      // correct and estimate boat speed
      estimateBoatSpeed(speed, heel);

      if (options.assumeCurrent) {
        // estimate current ;
        estimateCurrent(theta);
      }
      calcResidual(theta);


      // Send calculated delta's
      if (options.estimateCurrent) PolarSmoother.send(app, plugin.id, [current]);
      if (options.estimateBoatSpeed) Polar.send(app, plugin.id, [boatSpeedCorrected]);

      // Save correction table 
      // periodically 
      if (options.updateCorrectionTable && new Date() - lastSave > 5 * 60 * 1000) {
        lastSave = saveTable(options, table);
      }
    }

    // estimates boat speed from observed boatSpeed and correction
    function estimateBoatSpeed(speed, heel) {
      cor = table.getKalmanCorrection(speed, heel);
      boatSpeedCorrected.copyFrom(boatSpeedObserved);
      speedCorrection.setVectorValue(cor);
      boatSpeedCorrected.add(speedCorrection);
    }

    // estimates current from observed groundspeed and estimated boatspeed 
    function estimateCurrent(theta) {
      boatSpeedRefGround.copyFrom(boatSpeedCorrected);
      boatSpeedRefGround.rotate(theta);
      currentCalc.copyFrom(groundSpeed);
      currentCalc.substract(boatSpeedRefGround);
      current.sample();
    }

    // Calculate what ground speed is observed that is not attributed to estimated boat speed or estimated current
    function calcResidual(theta) {
      residual.copyFrom(groundSpeed);
      boatSpeedRefGround.copyFrom(boatSpeedCorrected);
      boatSpeedRefGround.rotate(theta);
      residual.substract(boatSpeedRefGround);
      residual.substract(current);
    }

    function situationIsStable( theta, COG) {
    // update stabilities
    headingStability.update(theta);
    COGStability.update(COG);
    let stable = true;
    if (headingStability.range > SI.fromDegrees(5)) {
      heading.setDisplayAttribute("unstable", true);
      stable = false;
    }
    else {
      heading.setDisplayAttribute("unstable", false);
    }
    if (COGStability.range > SI.fromDegrees(5)) {
      groundSpeed.setDisplayAttribute("unstable", true);
      stable = false;
    }
    else {
      groundSpeed.setDisplayAttribute("unstable", false);
    }
    return stable;
  }

    // Make sure the table matches the settings
    function enforceConsistancy(row, col) {
      // function is bugged due to IS units vs knots and degrees
      if (!options?.correctionTable) return false;
      table = options.correctionTable;
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
      if (enforceConsistancy(row, col) && !options.doStartFresh) {
        table = CorrectionTable.fromJSON(options.correctionTable, options.correctionStability);
        app.debug("Correction table loaded");
        lastSave = new Date();
      }
      else {
        table = new CorrectionTable("correctionTable", row, col, options.correctionStability);
        app.debug("Correction table created");
        options.doStartFresh = false;
        lastSave = saveTable(options, table);
      }
      table.setDisplayAttributes({ label: "correction table" });
      return table;
    }


    function loadPresets() {
      const modeEnum = plugin.schema.properties.mode.enum;
      app.debug("Loading presests for mode: " + options.mode);

      switch (modeEnum.indexOf(options.mode)) {
        case -1:
          app.debug("Invalid mode");
          app.debug(options);
          //options.mode = modeEnum[2]; 
          break;
        case 0:
          // new table, no current
          options.doStartFresh = true;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = false;
          options.assumeCurrent = false;
          options.estimateCurrent = false;
          options.correctionStability = 5;
          options.mode = modeEnum[2];
          break;
        case 1:
          // new table, with current
          options.doStartFresh = true;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = false;
          options.assumeCurrent = true;
          options.estimateCurrent = false;
          options.correctionStability = 5;
          options.currentStability = 7;
          options.mode = modeEnum[3];
          break;
        case 2:
          // fresh table, no current
          options.doStartFresh = false;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = false;
          options.assumeCurrent = false;
          options.estimateCurrent = false;
          options.correctionStability = 6;
          break;
        case 3:
          // fresh table, with current
          options.doStartFresh = false;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = false;
          options.assumeCurrent = true;
          options.estimateCurrent = false;
          options.correctionStability = 6;
          options.currentStability = 6;
          break;
        case 4:
          // mature table, no current
          options.doStartFresh = false;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = true;
          options.assumeCurrent = false;
          options.estimateCurrent = false;
          options.correctionStability = 10;
          break;
        case 5:
          // mature table, with current
          options.doStartFresh = false;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = true;
          options.assumeCurrent = true;
          options.estimateCurrent = true;
          options.correctionStability = 10;
          options.currentStability = 3;
          break;
        case 6:
          // locked table
          options.doStartFresh = false;
          options.updateCorrectionTable = false;
          options.estimateBoatSpeed = true;
          options.assumeCurrent = true;
          options.estimateCurrent = true;
          options.currentStability = 2;
          break;
        case 7:
          // all manual configuration;
          break;
      }
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
    return new Promise((resolve, reject) => {
      try {
        //corrTable.save(app);
        if (corrTable != null) {
          lastSave = saveTable(options, corrTable);
        }

        heading = heading?.terminate(app);
        stability = stability?.terminate(app);
        attitude = attitude?.terminate(app);
        currentCalc = currentCalc?.terminate(app);
        current = null;
        boatSpeedObserved = boatSpeedObserved?.terminate(app);
        boatSpeedStat = null;
        boatSpeedCorrected = boatSpeedCorrected?.terminate(app);
        boatSpeedRefGround = boatSpeedRefGround?.terminate(app);
        groundSpeed = groundSpeed?.terminate(app);
        groundSpeedStat = null;
        speedCorrection = speedCorrection?.terminate(app);
        residual = residual?.terminate(app);
        reportFull = null;
        reportVector = null;
        table = null;
        app.setPluginStatus("Stopped");
        app.debug("Stopped");

        isRunning = false;
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };
  return plugin;
};
