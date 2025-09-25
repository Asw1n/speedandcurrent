const { SI, MessageHandler, MessageHandlerDamped, Polar, Reporter, BaseSmoother, MovingAverageSmoother, KalmanSmoother, PolarSmoother, createSmoothedPolar, createSmoothedHandler } = require('signalkutilities');

const { CorrectionTable } = require('./correctionTable.js');

module.exports = function (app) {

  let _settings = {};
  let isRunning = false;
  let lastSave = null;
  let smoothedHeading = null;
  let stability = null;
  let smoothedAttitude = null;
  let rawCurrent = null;
  let smoothedCurrent = null;
  let smoothedBoatSpeed = null;
  let correctedBoatSpeed = null;
  let boatSpeedRefGround = null;
  let smoothedGroundSpeed = null;
  let speedCorrection = null;
  let residual = null;
  let reportFull = null;
  let reportVector = null;
  let table = null;

  const plugin = {};
  plugin.id = "SpeedAndCurrent";
  plugin.name = "Speed and current";
  plugin.description = "A plugin that uses sensor fusion to get boat speed, current and leeway.";

  plugin.schema = {
    type: "object",
    properties: {
      startWithNewTable: {
        type: "boolean",
        title: "Start with new table",
        description: "Start with a new correction table (overrides existing table).",
        default: false
      },
      estimateBoatSpeed: {
        type: "boolean",
        title: "Estimate Boat Speed",
        description: "Enable estimation of boat speed.",
        default: false
      },
      updateCorrectionTable: {
        type: "boolean",
        title: "Update Correction Table",
        description: "Enable updating of the correction table.",
        default: true
      },
      stability: {
        type: "number",
        title: "Correction Table Stability",
        description: "Stability of the corrections (higher means that corrections are changed at a slower rate).",
        default: 7,
        minimum: 1,
        maximum: 20
      },
      assumeCurrent: {
        type: "boolean",
        title: "Assume Current",
        description: "Assume there is a current present when updating the correction table.",
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
        default: true
      }
    }
  };

  plugin.uiSchema = {
    'ui:order': [
      "estimateBoatSpeed",
      "updateCorrectionTable",
      "assumeCurrent",
      "startWithNewTable",
      "stability",
      "maxSpeed",
      "speedStep",
      "maxHeel",
      "heelStep",
      "headingSource",
      "boatSpeedSource",
      "COGSource",
      "SOGSource",
      "attitudeSource",
      "preventDuplication"
    ],
    startWithNewTable: {
      "ui:widget": "checkbox"
    },
    estimateBoatSpeed: {
      "ui:widget": "checkbox"
    },
    updateCorrectionTable: {
      "ui:widget": "checkbox"
    },
    stability: {
      "ui:widget": "updown"
    },
    assumeCurrent: {
      "ui:widget": "checkbox"
    },
    heelStep: {
      "ui:widget": "updown"
    },
    maxHeel: {
      "ui:widget": "updown"
    },
    speedStep: {
      "ui:widget": "updown"
    },
    maxSpeed: {
      "ui:widget": "updown"
    },
    mode: {
      "ui:widget": "select"
    },
    preventDuplication: {
      "ui:widget": "checkbox"
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

  plugin.start = (settings) => {
    app.setPluginStatus("Starting");
    app.debug("Starting");
  
    // get settings to a wider scope so it can be used in the stop function
    _settings = settings;
    let smootherOptions = { timeConstant: 1, processVariance: 1, measurementVariance: 20, timeSpan: 5 };
    table = loadTable(settings);

    //#region Handler and Polar Initialization
    // heading
    smoothedHeading = createSmoothedHandler({
      id: "heading",
      path: "navigation.headingTrue",
      source: settings.headingSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: MovingAverageSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Heading (smoothed)" },
    });
    rawHeading = smoothedHeading.handler;
    rawHeading.setDisplayAttributes({ label: "Heading" });


    //attitude
    smoothedAttitude = createSmoothedHandler({
      id: "attitude",
      path: "navigation.attitude",
      source: settings.attitudeSource,
      subscribe: true,
      app,
      pluginId: plugin.id,
      SmootherClass: MovingAverageSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Attitude (smoothed)" }
    });
    rawAttitude = smoothedAttitude.handler;
    rawAttitude.setDisplayAttributes({ label: "Attitude" });


    // current
    rawCurrent = new Polar("current", "self.environment.current.drift", "self.environment.current.setTrue");
    rawCurrent.setDisplayAttributes({ label: "current", plane: "Ground" });
    rawCurrent.setAngleRange('0to2pi');
    smoothedCurrent = new PolarSmoother("currentDamped", rawCurrent, KalmanSmoother, { processVariance: 0.000001, measurementVariance: 0.01 });
    smoothedCurrent.setAngleRange('0to2pi');
    smoothedCurrent.setDisplayAttributes({ label: "Current", plane: "Ground" });
    // Current should be initialised as no current
    rawCurrent.setVectorValue({ x: 0, y: 0 });
    // Strongly assume no current at start
    smoothedCurrent.xSmoother.reset(0, 0.00000001);
    smoothedCurrent.ySmoother.reset(0, 0.00000001);
    // no current
    noCurrent = createSmoothedPolar({
      id: "boatSpeed",
      pathMagnitude: "self.environment.current.drift",
      pathAngle: "self.environment.current.setTrue",
      subscribe: false,
      app,
      pluginId: plugin.id,
      SmootherClass: BaseSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "NoCurrent", plane: "Ground" },
    });
    noCurrent.xSmoother.reset(0,0);
    noCurrent.ySmoother.reset(0,0);

    // boat speed
    smoothedBoatSpeed = createSmoothedPolar({
      id: "boatSpeed",
      pathMagnitude: "navigation.speedThroughWater",
      pathAngle: null,
      subscribe: true,
      sourceMagnitude: settings.boatSpeedSource,
      sourceAngle: settings.boatSpeedSource,
      app,
      pluginId: plugin.id,
      SmootherClass: MovingAverageSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Observed boat Speed (smoothed)", plane: "Boat" },
      passOn: !_settings.preventDuplication,
    });
    rawBoatSpeed = smoothedBoatSpeed.polar;
    rawBoatSpeed.setDisplayAttributes({ label: "Observed boat Speed", plane: "Boat" });
   
    correctedBoatSpeed = new Polar("correctedBoatSpeed", "navigation.speedThroughWater", "navigation.leewayAngle");
    correctedBoatSpeed.setDisplayAttributes({ label: "corrected boat speed", plane: "Boat" });
 

    // TODO: Add navigation.speedThroughWaterTransverse and navigation.speedThroughWaterLongitudinal

    boatSpeedRefGround = new Polar("boatSpeedRefGround");
    boatSpeedRefGround.setDisplayAttributes("Boat speed over ground", "Ground");

    // ground speed
    smoothedGroundSpeed = createSmoothedPolar({
      id: "groundSpeed",
      pathMagnitude: "navigation.speedOverGround",
      pathAngle: "navigation.courseOverGroundTrue",
      subscribe: true,
      sourceMagnitude: settings.SOGSource,
      sourceAngle: settings.COGSource,
      app,
      pluginId: plugin.id,
      SmootherClass: MovingAverageSmoother,
      smootherOptions: smootherOptions,
      displayAttributes: { label: "Ground Speed (smoothed)", plane: "Ground" },
      passOn: true,
      angleRange: '0to2pi'
    });
    rawGroundSpeed = smoothedGroundSpeed.polar;
    rawGroundSpeed.setDisplayAttributes({ label: "Ground Speed", plane: "Ground" });



    // correction vector
    speedCorrection = new Polar("speedCorrection");
    speedCorrection.setDisplayAttributes("speed correction", "Boat");
    speedCorrection.setDisplayAttributes({ label: "speed correction", plane: "Boat" });

    // residual
    residual = new Polar("residual");
    residual.setDisplayAttributes({ label: "residual", plane: "Ground" });

    //#endregion

    //#region Reporting
    reportFull = new Reporter();

    if (settings.estimateBoatSpeed) {
      reportFull.addDelta(rawHeading);
      reportFull.addAttitude(rawAttitude);
      reportFull.addPolar(rawBoatSpeed);
      reportFull.addPolar(speedCorrection);
      reportFull.addPolar(correctedBoatSpeed);
      reportFull.addPolar(rawGroundSpeed);
      reportFull.addPolar(smoothedCurrent);
    }
    if (settings.updateCorrectionTable) {
      reportFull.addDelta(smoothedHeading);
      reportFull.addAttitude(smoothedAttitude);
      reportFull.addPolar(smoothedBoatSpeed);
      reportFull.addPolar(smoothedGroundSpeed);

        if (settings.assumeCurrent) {
          reportFull.addPolar(boatSpeedRefGround);
          reportFull.addPolar(smoothedCurrent);
        }
      reportFull.addPolar(speedCorrection);
      reportFull.addPolar(residual);
    }
    reportFull.addTable(table);

    // Make reporting object for webApp


    reportVector = new Reporter();
    reportVector.addDelta(rawHeading);
    reportVector.addPolar(residual);
    reportVector.addPolar(speedCorrection);
    if (settings.assumeCurrent) reportVector.addPolar(smoothedCurrent);
    reportVector.addPolar(correctedBoatSpeed);
    reportVector.addPolar(rawBoatSpeed);
    reportVector.addPolar(rawGroundSpeed);
    //#endregion

    isRunning = true;
    started = new Date();
    app.setPluginStatus("Running");
    app.debug("Running");

    smoothedBoatSpeed.onChange = () => {
      const wellUnderway = started < new Date() - smootherOptions.timeSpan * 1000;
      const minSpeed = SI.fromKnots(settings.speedStep / 2);
      if (settings.estimateBoatSpeed) correct(wellUnderway);
      if (settings.updateCorrectionTable && wellUnderway) updateTable(settings.assumeCurrent, minSpeed);
    };
  }

  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        if (table != null) {
          saveTable(_settings, table);
        }

        smoothedHeading = smoothedHeading?.terminate(app);
        stability = stability?.terminate(app);
        smoothedAttitude = smoothedAttitude?.terminate(app);
        rawCurrent = rawCurrent?.terminate(app);
        smoothedCurrent = null;
        smoothedBoatSpeed = smoothedBoatSpeed?.terminate(app);
        boatSpeedStat = null;
        correctedBoatSpeed = correctedBoatSpeed?.terminate(app);
        boatSpeedRefGround = boatSpeedRefGround?.terminate(app);
        smoothedGroundSpeed = smoothedGroundSpeed?.terminate(app);
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

 
  /**
   * Estimates and applies corrections to boat speed, leeway, and current.
   *
   * This function uses the current attitude, boat speed, and heading to compute a correction
   * vector from the correction table, applies it to the observed boat speed, and sends the
   * corrected value. If the vessel is well underway, it also estimates the current vector
   * by comparing the corrected boat speed (rotated to heading) with the ground speed.
   *
   * @param {boolean} wellUnderway - True if the vessel is considered underway and current estimation should be performed.
   */
  function correct(wellUnderway) {
    // prepare iteration
    const heel = rawAttitude.value.roll;
    const speed = rawBoatSpeed.magnitude;
    const theta = rawHeading.value;
    //app.debug(`Heel: ${SI.toDegrees(heel).toFixed(1)}°, Speed: ${SI.toKnots(speed).toFixed(2)} kn, Heading: ${SI.toDegrees(theta).toFixed(1)}°`);
    if (!Number.isFinite(heel) || !Number.isFinite(speed) || !Number.isFinite(theta)) {
      //app.debug("Invalid input data");
      return;
    }

    correctedBoatSpeed.copyFrom(rawBoatSpeed);
    speedCorrection.setVectorValue({ x: 0, y: 0 }) ;
    if (speed > 0) {
      const { correction, variance } = table.getCorrection(speed, heel);
      speedCorrection.setVectorValue(correction, variance);
      correctedBoatSpeed.add(speedCorrection);
    }
    Polar.send(app, plugin.id, [correctedBoatSpeed]);
    // estimate current
    if (wellUnderway) {
      boatSpeedRefGround.copyFrom(correctedBoatSpeed);
      boatSpeedRefGround.rotate(theta);
      rawCurrent.copyFrom(rawGroundSpeed);
      rawCurrent.substract(boatSpeedRefGround);
      smoothedCurrent.sample();
    }
    PolarSmoother.send(app, plugin.id, [smoothedCurrent]);
  }

  /**
   * Updates the correction table and calculates the residual error.
   *
   * This function uses the current smoothed attitude, boat speed, and heading to update the correction table
   * if the boat speed exceeds the specified minimum. It also calculates the residual between the measured ground speed
   * and the expected ground speed (corrected boat speed plus current). The correction table is periodically saved.
   *
   * @param {boolean} [assumeCurrent=false] - If true, uses the smoothed current for correction; otherwise, assumes no current.
   * @param {number} [minSpeed=0] - The minimum speed threshold (in SI units) required to update the correction table.
   */
  function updateTable(assumeCurrent = false, minSpeed = 0) {
    // prepare iteration
    const heel = smoothedAttitude.value.roll;
    const speed = smoothedBoatSpeed.magnitude;
    const theta = smoothedHeading.value;

    if (!Number.isFinite(heel) || !Number.isFinite(speed) || !Number.isFinite(theta)) return;

    // update correction table
    if (speed > minSpeed) {
      table.update(speed, heel, smoothedGroundSpeed, assumeCurrent ? smoothedCurrent : noCurrent, smoothedBoatSpeed, theta);
    }

    // calculate residual
    residual.copyFrom(smoothedGroundSpeed);
    boatSpeedRefGround.copyFrom(correctedBoatSpeed);
    boatSpeedRefGround.rotate(theta);
    residual.substract(boatSpeedRefGround);
    residual.substract(smoothedCurrent);

    // Save correction table periodically 
    if (new Date() - lastSave > 5 * 60 * 1000) {
      lastSave = saveTable(_settings, table);
    }


  }
  

  /**
   * Checks if the correction table in settings matches the expected row and column configuration.
   *
   * This function compares the min, max, and step values of the row and column definitions
   * in the current correction table against the provided row and col objects. Returns true
   * if all values match, otherwise false. If the table is missing or not properly structured,
   * returns false.
   *
   * @param {Object} row - The expected row configuration ({ min, max, step }).
   * @param {Object} col - The expected column configuration ({ min, max, step }).
   * @returns {boolean} True if the table matches the configuration, false otherwise.
   */
  function enforceConsistancy(row, col) {
    if (!_settings?.correctionTable) return false;
    table = _settings.correctionTable;
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

  /**
   * Loads or creates a correction table based on the provided options.
   *
   * This function checks if the correction table in the options matches the expected row and column configuration.
   * If so, it loads the table from JSON; otherwise, it creates a new correction table with the specified parameters.
   * The table is labeled and, if newly created, saved to the plugin options.
   *
   * @param {Object} options - The plugin options containing correction table settings and parameters.
   * @returns {CorrectionTable} The loaded or newly created CorrectionTable instance.
   */
  function loadTable(options) {
    const row = { min: 0, max: SI.fromKnots(options.maxSpeed), step: SI.fromKnots(options.speedStep) };
    const col = { min: -SI.fromDegrees(options.maxHeel), max: SI.fromDegrees(options.maxHeel), step: SI.fromDegrees(options.heelStep) };
    let table;
    const stability = (options.stability !== undefined) ? options.stability : 6;
    if (enforceConsistancy(row, col) && !options.startWithNewTable) {
      table = CorrectionTable.fromJSON(options.correctionTable, stability);
      app.debug("Correction table loaded");
      lastSave = new Date();
    }
    else {
      table = new CorrectionTable("correctionTable", row, col, stability);
      app.debug("Correction table created");
      // doStartFresh is not user-settable, so no need to reset it here
      options.startWithNewTable = false;
      lastSave = saveTable(options, table);
    }
    table.setDisplayAttributes({ label: "correction table" });
    return table;
  }


  /**
   * Saves the correction table to the plugin options and logs the save event.
   *
   * This function serializes the provided correction table, updates the options object,
   * and triggers the plugin's save mechanism. It returns the current date/time to indicate
   * when the save occurred.
   *
   * @param {Object} options - The plugin options object to update.
   * @param {CorrectionTable} correctionTable - The correction table instance to save.
   * @returns {Date} The date and time when the table was saved.
   */
  function saveTable(options, correctionTable) {
    options.correctionTable = correctionTable.toJSON();
    app.savePluginOptions(options, () => { app.debug('Correction table saved') });
    return new Date();
  }

  return plugin;
};
