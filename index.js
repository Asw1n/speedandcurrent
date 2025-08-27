const { MessageHandler, Polar, PolarDamped, SI, Reporter } = require('signalkutilities');
const { CorrectionTable } = require('./correctionTable.js');
const { KalmanFilter } = require('kalman-filter');




module.exports = function (app) {

  let options = {};
  let isRunning = false;
  let corrTable = null;
  let lastSave = null;
  reportFullheading = null;
  reportFullattitude = null;
  reportFullcurrent = null;
  reportFullcurrentStat = null;
  reportFullboatSpeed = null;
  reportFullboatSpeedStat = null;
  reportFullcorrectedBoatSpeed = null;
  reportFullboatSpeedRefGround = null;
  reportFullgroundSpeed = null;
  reportFullgroundSpeedStat = null;
  reportFullspeedCorrection = null;
  reportFullresidual = null;
  reportFullreportFull = null;
  var reportVector = null;
  var table = null;

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

    // make options survive to the stop function
    options = opts;
    loadPresets();

    // correction table
    table = loadTable(options);


    // heading
    heading = new MessageHandler("heading", "navigation.headingTrue", options.headingSource);
    heading.subscribe(app, plugin.id, true);
    heading.setDisplayAttributes({ label: "heading" });

    // attitude
    attitude = new MessageHandler("attitude", "navigation.attitude", options.attitudeSource);
    attitude.value = { pitch: 0, roll: 0, yaw: 0 }; //prevents errors when there is no attitude sensor
    attitude.setDisplayAttributes({ label: "attitude" });
    attitude.subscribe(app, plugin.id, true);

    // current
    current = new Polar("current", "self.environment.current.drift", "self.environment.current.setTrue");
    current.setDisplayAttributes({ label: "current", plane: "Ground" });
    current.setAngleRange('0to2pi');
    currentStat = new PolarDamped("currentDamped", current);
    currentStat.setAngleRange('0to2pi');
    currentStat.timeConstant = 60; // Set time constant for damping
    // Current should be initialised as no current
    current.setVectorValue({ x: 0, y: 0 });
    // There should be at least two samples, otherwise we can't calculate a valid speed
    currentStat.sample();
    currentStat.sample();

    // boat speed
    boatSpeed = new Polar("boatSpeed", "navigation.speedThroughWater", options.boatSpeedSource);
    boatSpeed.subscribe(app, plugin.id, true, false, !options.preventDuplication || !options.estimateBoatSpeed);
    boatSpeed.setDisplayAttributes({ label: "boat speed", plane: "Boat" });
    boatSpeedStat = new PolarDamped("boatSpeedDamped", boatSpeed);
    boatSpeedStat.setDisplayAttributes({ label: "boat speed (damped)", plane: "Boat" });

    correctedBoatSpeed = new Polar("correctedBoatSpeed", "navigation.speedThroughWater", "environment.wind.directionTruenavigation.leewayAngle");
    correctedBoatSpeed.setDisplayAttributes({ label: "corrected boat speed", plane: "Boat" });
    //const correctedBoatSpeedStat = new PolarDamped("correctedBoatSpeedDamped", correctedBoatSpeed);

    boatSpeedRefGround = new Polar("boatSpeedRefGround");
    boatSpeedRefGround.setDisplayAttributes("boat speed over ground", "Ground");

    // ground speed
    groundSpeed = new Polar("groundSpeed", "navigation.speedOverGround", "navigation.courseOverGroundTrue", options.SOGSource, options.COGSource);
    groundSpeed.subscribe(app, plugin.id, true, true, true);
    groundSpeed.setDisplayAttributes({ label: "ground speed", plane: "Ground" });
    groundSpeed.setAngleRange('0to2pi');
    groundSpeedStat = new PolarDamped("groundSpeedDamped", groundSpeed);
    groundSpeedStat.setDisplayAttributes({ label: "ground speed (damped)", plane: "Ground" });
    groundSpeedStat.setAngleRange('0to2pi');

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
    reportFull.addPolar(boatSpeed);
    //reportFull.addPolar(boatSpeedStat);
    //reportFull.addPolar(groundSpeedStat);
    reportFull.addPolar(speedCorrection);
    reportFull.addPolar(correctedBoatSpeed);
    reportFull.addPolar(current);
    reportFull.addPolar(residual);
    reportFull.addTable(table);

    reportVector = new Reporter();
    reportVector.addDelta(heading);
    reportVector.addPolar(residual);
    reportVector.addPolar(speedCorrection);
    reportVector.addPolar(current);
    reportVector.addPolar(correctedBoatSpeed);
    reportVector.addPolar(boatSpeed);
    reportVector.addPolar(groundSpeed);



    app.debug("Analyzing input data");
    let candidates = [heading, attitude, boatSpeed, groundSpeed];
    // wait for all to settle
    setTimeout(() => {
      //app.debug(groundSpeed.magnitudeHandler);
      //app.debug(groundSpeed.angleHandler);
      // Check if all candidates get input data
      candidates.forEach(candidate => {
        if (candidate.lackingInputData()) {
          app.setPluginStatus("Halted: insufficient input data");
          app.debug("Insufficient input data for " + candidate.displayAttributes.label  );
          return;
        }
      });

      // determing slowest input path and use this as a heartbeat for calculations
      candidates.sort((a, b) => (a.frequency || 0) - (b.frequency || 0));

     

      if (!candidates[0].lackingInputData()) {
        slowestInput = candidates[0];
        app.debug("Using " + slowestInput.displayAttributes.label + " as heartbeat for calculations ( " + Math.round(candidates[0].frequency) + " updates per second)");
        slowestInput.onChange = calculate;
        if (slowestInput == groundSpeed) {
          groundSpeed.onChange = () => {
            groundSpeedStat.sample();
            calculate();
          };
        }
        else {
          groundSpeed.onChange = () => {
            groundSpeedStat.sample();
          };
        }
        if (slowestInput == boatSpeed) {
          boatSpeed.onChange = () => {
            boatSpeedStat.sample();
            calculate();
          };
        }
        else {
          boatSpeed.onChange = () => {
            boatSpeedStat.sample();
          };
        }
        
        isRunning = true;
        app.setPluginStatus("Running");
        app.debug("Running");  
      }

    }, 5000);

    



    // Main function, estimates boatSpeed, leeway and current
    function calculate() {
      // prepare iteration
      heel = attitude.value.roll;
      speed = boatSpeed.magnitude;
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

      // update correction table
      if (options.updateCorrectionTable) {
        table.update(speed, heel, groundSpeedStat, currentStat, boatSpeedStat, theta);
      }

      // correct and estimate boat speed
      estimateBoatSpeed();

      if (options.assumeCurrent) {
        // estimate current ;
        estimateCurrent();
      }
      calcResidual();


      // Send calculated delta's
      updates = [];
      if (options.estimateCurrent) updates.push(current);
      if (options.estimateBoatSpeed) updates.push(correctedBoatSpeed);
      if (updates.length) Polar.send(app, plugin.id, updates);

      // Save correction table 
      // periodically 
      if (options.updateCorrectionTable && new Date() - lastSave > 5 * 60 * 1000) {
        lastSave = saveTable(options, table);
      }
    }

    // estimates boat speed from observed boatSpeed and correction
    function estimateBoatSpeed() {
      cor = table.getKalmanCorrection(speed, heel);
      correctedBoatSpeed.copyFrom(boatSpeed);
      speedCorrection.setVectorValue(cor);
      correctedBoatSpeed.add(speedCorrection);
    }

    // estimates current from observed groundspeed and estimated boatspeed 
    function estimateCurrent() {
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      current.copyFrom(groundSpeed);
      current.substract(boatSpeedRefGround);
      currentStat.sample();
      current.copyFrom(currentStat);
    }

    // Calculate what ground speed is observed that is not attributed to estimated boat speed or estimated current
    function calcResidual() {
      residual.copyFrom(groundSpeed);
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      residual.substract(boatSpeedRefGround);
      residual.substract(current);
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
          options.correctionStability = 8;
          break;
        case 5:
          // mature table, with current
          options.doStartFresh = false;
          options.updateCorrectionTable = true;
          options.estimateBoatSpeed = true;
          options.assumeCurrent = true;
          options.estimateCurrent = true;
          options.correctionStability = 8;
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

        heading = null;
        attitude = null;
        current = null;
        currentStat = null;
        boatSpeed = null;
        boatSpeedStat = null;
        correctedBoatSpeed = null;
        boatSpeedRefGround = null;
        groundSpeed = null;
        groundSpeedStat = null;
        speedCorrection = null;
        residual = null;
        reportFull = null;
        reportVector = null;
        table =
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
