const path = require('path');
const fs = require('fs');

const {
  SmoothedAngle,
  SI,
  MessageHandler,
  Polar,
  Reporter,
  BaseSmoother,
  MovingAverageSmoother,
  ExponentialSmoother,
  KalmanSmoother,
  PolarSmoother,
  createSmoothedPolar,
  createSmoothedHandler,
  Table2D
} = require('signalkutilities');

const { CorrectionTable } = require('./correctionTable.js');

module.exports = function (app) {

  const DEFAULT_DIMS = { maxSpeed: 9, speedStep: 1, maxHeel: 32, heelStep: 8 };

  let options = {};
  let changedOptions = {};
  const defaultOptions = {
    sogFallback: true,
    estimateBoatSpeed: false,
    updateCorrectionTable: true,
    stability: 7,
    assumeCurrent: false,
    headingSource: ' ',
    boatSpeedSource: ' ',
    COGSource: ' ',
    SOGSource: ' ',
    attitudeSource: ' ',
    preventDuplication: true,
    tableName: 'correctionTable',
    smootherClass: 'MovingAverageSmoother',
    smootherTau: 3,
    smootherTimeSpan: 5,
    smootherSteadyState: 0.2,
    showStatistics: false
  };

  const isReadyAndFresh = (input) => !!input && input.ready === true && !input.stale;


  function readOptions() {
    const stored = app.readPluginOptions();
    const raw = stored && stored.configuration ? stored.configuration : (stored || {});
    // Strip embedded table — stored separately on disk
    const { correctionTable: _drop, ...rest } = raw;
    options = { ...defaultOptions, ...rest };
  }

  function saveOptions() {
    app.savePluginOptions({ ...options }, (err) => {
      if (err) app.error(`Error saving plugin options: ${err.message}`);
    });
  }

  function saveTableName(name) {
    options.tableName = name;
    saveOptions();
  }

  /**
   * Derives { SmootherClass, smootherOptions } from the current options.
   * Enforces minimums so the smoother always has at least two observations for
   * variance to be meaningful:
   *   - MovingAverageSmoother: timeSpan >= 2 s  (≥ 2 samples at typical 1 Hz)
   *   - ExponentialSmoother:   tau        >= 1 s
   *   - KalmanSmoother:        steadyState in [0.01, 0.99]
   */
  function resolveSmootherConfig() {
    const cls = options.smootherClass || 'MovingAverageSmoother';
    if (cls === 'ExponentialSmoother') {
      return {
        SmootherClass: ExponentialSmoother,
        smootherOptions: { timeConstant: Math.max(1, Number(options.smootherTau) || 3) }
      };
    }
    if (cls === 'KalmanSmoother') {
      const K = Math.min(0.99, Math.max(0.01, Number(options.smootherSteadyState) || 0.2));
      return {
        SmootherClass: KalmanSmoother,
        smootherOptions: { steadyState: K }
      };
    }
    // Default: MovingAverageSmoother
    return {
      SmootherClass: MovingAverageSmoother,
      smootherOptions: { timeSpan: Math.max(2, Number(options.smootherTimeSpan) || 5) }
    };
  }

  function swapTable(newTable) {
    table = newTable;
    if (reportFull) reportFull.setTables([table]);
  }

  let isRunning = false;
  let pluginStatus = 'Stopped';
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

  // add missing declarations
  let rawHeading = null;
  let rawAttitude = null;
  let noCurrent = null;
  let rawBoatSpeed = null;
  let rawGroundSpeed = null;
  let started = null;

  const plugin = {};
  plugin.id = "SpeedAndCurrent";
  plugin.name = "Speed and current";
  plugin.description = "A plugin that uses sensor fusion to get boat speed, current and leeway.";

  plugin.schema = {
    type: "object",
    description: "Speed and Current is configured through its own webapp. Open it from the Signal K app list.",
    properties: {}
  };


  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');
    readOptions(); // pre-load so /api/settings works before start()

    router.get('/api/report', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        res.json(reportFull.report());
      }
    });

    router.get('/api/meta', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        res.json(reportFull.meta());
      }
    });

    router.get('/getVectors', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        res.json(reportVector.report());
      }
    });

    router.get('/api/status', (req, res) => {
      res.json({ status: pluginStatus, isRunning });
    });

    // --- Settings API ---
    router.get('/api/settings', (req, res) => {
      res.json({ ...options, ...changedOptions });
    });

    router.put('/api/settings', (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'JSON body required' });
      }
      // Reject keys managed by the table manager
      const blocked = ['correctionTable', 'tableName'];
      for (const k of blocked) {
        if (k in body) {
          return res.status(400).json({ error: `Key '${k}' is managed via the table manager` });
        }
      }
      changedOptions = { ...changedOptions, ...body };
      res.json({ ...options, ...changedOptions });
    });

    // --- Correction Table Manager API ---

    // List all table files in dataDir
    router.get('/api/tables', (req, res) => {
      const dataDir = app.getDataDirPath();
      let files;
      try { files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')); }
      catch (e) { return res.json([]); }
      const activeName = options.tableName || 'correctionTable';
      const tables = [];
      for (const file of files) {
        try {
          const data = Table2D.readFromFile(path.join(dataDir, file));
          if (data && data.row && data.col && Array.isArray(data.table)) {
            const name = file.replace(/\.json$/, '');
            tables.push({ name, active: name === activeName });
          }
        } catch (e) { /* skip non-table files */ }
      }
      res.json(tables);
    });

    // Create a new table and hot-swap it
    router.post('/api/tables/create', (req, res) => {
      const body = req.body || {};
      const name = (body.name || '').trim();
      if (!name || !/^[\w-]+$/.test(name))
        return res.status(400).json({ error: 'Name must be alphanumeric (underscores and hyphens allowed)' });
      const dims = ['maxSpeed', 'speedStep', 'maxHeel', 'heelStep'];
      for (const f of dims) {
        if (!Number.isFinite(body[f]) || body[f] <= 0)
          return res.status(400).json({ error: `Invalid or missing field: ${f}` });
      }
      const row = { min: 0, max: body.maxSpeed, step: body.speedStep };
      const col = { min: -body.maxHeel, max: body.maxHeel, step: body.heelStep };
      const newTable = new CorrectionTable(name, row, col, options.stability || 7);
      newTable.setDisplayAttributes({ label: name }); // Table2D API unchanged
      saveTable(newTable, path.join(app.getDataDirPath(), name + '.json'));
      if (isRunning) swapTable(newTable);
      saveTableName(name);
      res.json({ name });
    });

    // Load a saved table and make it active
    router.post('/api/tables/load', (req, res) => {
      const body = req.body || {};
      const name = (body.name || '').trim();
      if (!name || !/^[\w-]+$/.test(name))
        return res.status(400).json({ error: 'Invalid table name' });
      const filePath = path.join(app.getDataDirPath(), name + '.json');
      const fileData = Table2D.readFromFile(filePath);
      if (!fileData) return res.status(404).json({ error: `Table '${name}' not found` });
      const loadedTable = CorrectionTable.fromJSON(fileData, options.stability || 7);
      loadedTable.setDisplayAttributes({ label: name }); // Table2D API unchanged
      if (isRunning) swapTable(loadedTable);
      saveTableName(name);
      res.json({ name });
    });

    // Copy active table under a new name and hot-swap to it
    router.post('/api/tables/copy', (req, res) => {
      if (!isRunning || !table) return res.status(503).json({ error: 'Plugin is not running' });
      const body = req.body || {};
      const newName = (body.newName || '').trim();
      if (!newName || !/^[\w-]+$/.test(newName))
        return res.status(400).json({ error: 'Name must be alphanumeric (underscores and hyphens allowed)' });
      const data = table.toJSON();
      data.id = newName;
      const copiedTable = CorrectionTable.fromJSON(data, options.stability || 7);
      copiedTable.setDisplayAttributes({ label: newName }); // Table2D API unchanged
      saveTable(copiedTable, path.join(app.getDataDirPath(), newName + '.json'));
      swapTable(copiedTable);
      saveTableName(newName);
      res.json({ name: newName });
    });

    // Resize the active table (resamples onto new grid, preserves name)
    router.post('/api/tables/resize', (req, res) => {
      if (!isRunning || !table) return res.status(503).json({ error: 'Plugin is not running' });
      const body = req.body || {};
      const dims = ['maxSpeed', 'speedStep', 'maxHeel', 'heelStep'];
      for (const f of dims) {
        if (!Number.isFinite(body[f]) || body[f] <= 0)
          return res.status(400).json({ error: `Invalid or missing field: ${f}` });
      }
      const newRow = { min: 0, max: body.maxSpeed, step: body.speedStep };
      const newCol = { min: -body.maxHeel, max: body.maxHeel, step: body.heelStep };
      const resized = CorrectionTable.resampleFromJSON(table.toJSON(), newRow, newCol, options.stability || 7, 1e-4);
      resized.setDisplayAttributes({ label: resized.id }); // Table2D API unchanged
      saveTable(resized, path.join(app.getDataDirPath(), resized.id + '.json'));
      swapTable(resized);
      res.json({ name: resized.id });
    });

  }

  function setStatus(msg) {
    pluginStatus = msg;
    app.setPluginStatus(msg);
  }

  plugin.start = (settings) => {
    setStatus('Starting');
    app.debug("Starting");
    readOptions(); // pick up any saves since registerWithRouter ran
    const tableName = options.tableName || 'correctionTable';
    const tableFilePath = path.join(app.getDataDirPath(), tableName + '.json');
    table = loadTable(options, tableFilePath);

    //#region Handler and Polar Initialization
    const { SmootherClass, smootherOptions } = resolveSmootherConfig();

    // heading
    smoothedHeading = new SmoothedAngle(app, plugin.id, 'heading', 'navigation.headingTrue', {
      source: options.headingSource,
      passOn: true,
      angleRange: '0to2pi',
      meta: { displayName: 'Heading', plane: 'Ground' },
      SmootherClass,
      smootherOptions
    });
    rawHeading = smoothedHeading.handler;

    //attitude
    smoothedAttitude = createSmoothedHandler({
      app, pluginId: plugin.id,
      id: 'attitude',
      path: 'navigation.attitude',
      source: options.attitudeSource,
      passOn: true,
      subscribe: true,
      SmootherClass,
      smootherOptions
    });
    rawAttitude = smoothedAttitude.handler;


    // current
    // send metadata for current
    MessageHandler.setMeta(app, plugin.id, "environment.current.drift", {units: "m/s", type: "number", description: "Speed of the current"});
    MessageHandler.setMeta(app, plugin.id, "environment.current.setTrue", { units: "rad", type: "number", description: "Direction of the current" });
    rawCurrent = new Polar(app, plugin.id, "current");
    rawCurrent.configureMagnitude("self.environment.current.drift");
    rawCurrent.configureAngle("self.environment.current.setTrue");
    rawCurrent.setMeta({ displayName: "Current", plane: "Ground" });
    rawCurrent.setAngleRange('0to2pi');
    smoothedCurrent = new PolarSmoother(rawCurrent, KalmanSmoother, { processVariance: 0.000001, measurementVariance: 0.01 }); // id auto-derived: 'current.smoothed'
    smoothedCurrent.setAngleRange('0to2pi');
    // Current should be initialised as no current
    rawCurrent.setVectorValue({ x: 0, y: 0 });
    // Strongly assume no current at start
    smoothedCurrent.xSmoother.reset(0, 0.00000001);
    smoothedCurrent.ySmoother.reset(0, 0.00000001);
    // no current
    noCurrent = createSmoothedPolar({
      id: "noCurrent",
      pathMagnitude: "self.environment.current.drift",
      pathAngle: "self.environment.current.setTrue",
      subscribe: false,
      app,
      pluginId: plugin.id,
      SmootherClass: BaseSmoother,
      smootherOptions: smootherOptions,
      meta: { displayName: "NoCurrent", plane: "Ground" },
    });
    noCurrent.xSmoother.reset(0,0);
    noCurrent.ySmoother.reset(0,0);
    PolarSmoother.send(app, plugin.id, [noCurrent]);

    MessageHandler.setMeta(app, plugin.id, 'navigation.leewayAngle', {
      units: 'rad',
      description: 'Leeway Angle',
      displayUnits: {
        category: 'angle'
      }
    });


    // boat speed — STW magnitude is optionally forwarded; leeway angle passOn is always false
    const rawBoatSpeedPolar = new Polar(app, plugin.id, 'boatSpeed');
    rawBoatSpeedPolar.configureMagnitude('navigation.speedThroughWater', options.boatSpeedSource, !options.preventDuplication);
    rawBoatSpeedPolar.configureAngle('navigation.leewayAngle', options.boatSpeedSource, false);
    rawBoatSpeedPolar.setMeta({ displayName: 'Boat speed', plane: 'Boat' });
    rawBoatSpeedPolar.setAngleRange('-piToPi');
    rawBoatSpeedPolar.subscribe(true, false);
    smoothedBoatSpeed = new PolarSmoother(rawBoatSpeedPolar, SmootherClass, smootherOptions);
    rawBoatSpeedPolar.onChange = () => { smoothedBoatSpeed.sample(); };
    rawBoatSpeed = rawBoatSpeedPolar;
    correctedBoatSpeed = new Polar(app, plugin.id, "correctedBoatSpeed");
    correctedBoatSpeed.configureMagnitude("navigation.speedThroughWater");
    correctedBoatSpeed.configureAngle("navigation.leewayAngle");
    correctedBoatSpeed.setMeta({ displayName: "Corrected boatspeed / Leeway", plane: "Boat" });
    boatSpeedRefGround = new Polar(app, plugin.id, "boatSpeedRefGround");
    boatSpeedRefGround.setMeta({ displayName: "Boat speed over ground", plane: "Ground" });

    // ground speed
    smoothedGroundSpeed = createSmoothedPolar({
      app, pluginId: plugin.id,
      id: 'groundSpeed',
      pathMagnitude: 'navigation.speedOverGround',
      pathAngle: 'navigation.courseOverGroundTrue',
      source: options.SOGSource,
      passOn: true,
      angleRange: '0to2pi',
      meta: { displayName: 'Groundspeed', plane: 'Ground' },
      SmootherClass,
      smootherOptions
    });
    rawGroundSpeed = smoothedGroundSpeed.polar;

    // correction vector
    speedCorrection = new Polar(app, plugin.id, "speedCorrection");
    speedCorrection.setMeta({ displayName: "Speed correction", plane: "Boat" });

    // residual
    residual = new Polar(app, plugin.id, "residual");
    residual.setMeta({ displayName: "Residual", plane: "Ground" });

    //#endregion

    //#region Reporting
    reportFull = new Reporter();

    if (options.estimateBoatSpeed) {
      reportFull.addDelta(rawHeading);
      reportFull.addAttitude(rawAttitude);
      reportFull.addPolar(rawBoatSpeed);
      reportFull.addPolar(speedCorrection);
      reportFull.addPolar(boatSpeedRefGround);
      reportFull.addPolar(correctedBoatSpeed);
      reportFull.addPolar(rawGroundSpeed);
      reportFull.addPolar(smoothedCurrent);
    }
    if (options.updateCorrectionTable) {
      reportFull.addDelta(smoothedHeading);
      reportFull.addAttitude(smoothedAttitude);
      reportFull.addPolar(smoothedBoatSpeed);
      reportFull.addPolar(smoothedGroundSpeed);
      if (options.assumeCurrent) {
        reportFull.addPolar(smoothedCurrent);
      }
      reportFull.addPolar(residual);
    }
    reportFull.addTable(table);

    // Make reporting object for webApp
    reportVector = new Reporter();
    reportVector.addDelta(rawHeading);
    reportVector.addPolar(residual);
    reportVector.addPolar(speedCorrection);
    if (options.assumeCurrent) reportVector.addPolar(smoothedCurrent);
    reportVector.addPolar(correctedBoatSpeed);
    reportVector.addPolar(rawBoatSpeed);
    reportVector.addPolar(rawGroundSpeed);
    //#endregion

    isRunning = true;
    started = new Date();
    setStatus('Running');
    app.debug("Running");

    let lastSave = 0;
    smoothedBoatSpeed.onChange = () => {
      // Drain any pending option changes before calculating
      if (Object.keys(changedOptions).length) applyOptionChanges();

      const wellUnderway = started < new Date() - 60 * 1000;
      const minSpeed = table.step[0] / 2;

      if (options.sogFallback && fallingBackToSog(minSpeed)) {
        setStatus('Falling back to Speed Over Ground');
        app.debug("Falling back");
        return;
      }
      if (!wellUnderway) {
        setStatus('Stabilizing');
      } else {
        setStatus('Running');
      }
      if (options.estimateBoatSpeed) correct(wellUnderway);
      if (options.updateCorrectionTable && wellUnderway) {
        updateTable(options.assumeCurrent, minSpeed);
        // Save correction table periodically
        const now = new Date();
        if (now - lastSave > 5 * 1000) {
          saveTable(table, path.join(app.getDataDirPath(), table.id + '.json'));
          lastSave = now;
        }
      }
    };
  }

  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        smoothedHeading = smoothedHeading?.terminate();
        stability = stability?.terminate?.();
        smoothedAttitude = smoothedAttitude?.terminate();
        rawCurrent = rawCurrent?.terminate();
        smoothedCurrent = smoothedCurrent?.terminate?.();
        smoothedBoatSpeed = smoothedBoatSpeed?.terminate();
        correctedBoatSpeed = correctedBoatSpeed?.terminate();
        boatSpeedRefGround = boatSpeedRefGround?.terminate();
        smoothedGroundSpeed = smoothedGroundSpeed?.terminate();
        speedCorrection = speedCorrection?.terminate();
        residual = residual?.terminate();
        reportFull = null;
        reportVector = null;
        table = null;
        rawHeading = null;
        rawAttitude = null;
        noCurrent = null;
        rawBoatSpeed = null;
        rawGroundSpeed = null;
        started = null;
        app.setPluginStatus("Stopped");
        app.debug("Stopped");

        pluginStatus = 'Stopped';
        isRunning = false;
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };

  function fallingBackToSog( minSpeed) {
    if (!rawBoatSpeed.stale && rawBoatSpeed.magnitude > 0) return false;
    if (rawGroundSpeed.stale || rawGroundSpeed.magnitude < minSpeed) return false;
    // Fallback to SOG
    correctedBoatSpeed.setVectorValue({ x: rawGroundSpeed.magnitude, y: 0 });
    Polar.send(app, plugin.id, [correctedBoatSpeed]);
    return true;
  }

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
    if (!isReadyAndFresh(rawAttitude) || !isReadyAndFresh(rawBoatSpeed) || !isReadyAndFresh(rawHeading)) return;
    const heel = rawAttitude.value?.roll;
    const speed = rawBoatSpeed.magnitude;
    const theta = rawHeading.value;
    //app.debug(`Heel: ${SI.toDegrees(heel).toFixed(1)}°, Speed: ${SI.toKnots(speed).toFixed(2)} kn, Heading: ${SI.toDegrees(theta).toFixed(1)}°`);
    
    correctedBoatSpeed.copyFrom(rawBoatSpeed);
    speedCorrection.setVectorValue({ x: 0, y: 0 }) ;
    if (speed > 0 ) {
      const { correction, variance } = table.getCorrection(speed, heel);
      speedCorrection.setVectorValue(correction, variance);
      correctedBoatSpeed.add(speedCorrection);
    }
    Polar.send(app, plugin.id, [correctedBoatSpeed]);
    // estimate current
    if (wellUnderway && isReadyAndFresh(rawGroundSpeed)) {
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
    if (!isReadyAndFresh(smoothedAttitude) || !isReadyAndFresh(smoothedBoatSpeed) || !isReadyAndFresh(smoothedHeading) || !isReadyAndFresh(smoothedGroundSpeed)) return;
    // prepare iteration
    const heel = smoothedAttitude.value.roll;
    const speed = smoothedBoatSpeed.magnitude;
    const theta = smoothedHeading.value;

        // update correction table
    if (speed > minSpeed ) {
      table.update(speed, heel, smoothedGroundSpeed, assumeCurrent ? smoothedCurrent : noCurrent, smoothedBoatSpeed, theta);
    }

    // calculate residual
    residual.copyFrom(smoothedGroundSpeed);
    boatSpeedRefGround.copyFrom(correctedBoatSpeed);
    boatSpeedRefGround.rotate(theta);
    residual.substract(boatSpeedRefGround);
    residual.substract(smoothedCurrent);

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
  function enforceConsistancy(data, row, col) {
    if (!data) return false;
    if (!data.row) return false;
    if (data.row.min != row.min) return false;
    if (data.row.max != row.max) return false;
    if (data.row.step != row.step) return false;
    if (data.col.min != col.min) return false;
    if (data.col.max != col.max) return false;
    if (data.col.step != col.step) return false;
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
  function loadTable(options, filePath) {
    const stability = (options.stability !== undefined) ? options.stability : 6;
    const fileData = Table2D.readFromFile(filePath);
    let table;
    if (fileData) {
      table = CorrectionTable.fromJSON(fileData, stability);
      app.debug("Correction table loaded: " + (fileData.id || filePath));
    } else {
      const name = options.tableName || 'correctionTable';
      const row = { min: 0, max: SI.fromKnots(DEFAULT_DIMS.maxSpeed), step: SI.fromKnots(DEFAULT_DIMS.speedStep) };
      const col = { min: -SI.fromDegrees(DEFAULT_DIMS.maxHeel), max: SI.fromDegrees(DEFAULT_DIMS.maxHeel), step: SI.fromDegrees(DEFAULT_DIMS.heelStep) };
      table = new CorrectionTable(name, row, col, stability);
      app.debug("Correction table created: " + name);
    }
    table.setDisplayAttributes({ label: table.id }); // Table2D API unchanged
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
  function saveTable(correctionTable, filePath) {
    correctionTable.saveToFile(filePath);
  }

  /**
   * Drains changedOptions into options and hot-applies each change where possible.
   * Source changes are applied in-place on existing handlers; flag changes take
   * effect immediately since onChange reads from options.* directly.
   */
  function applyOptionChanges() {
    const changedKeys = Object.keys(changedOptions);
    for (const key of changedKeys) {
      const value = changedOptions[key];
      options[key] = value;

      // Hot-apply source changes by mutating handler references in-place
      if (smoothedHeading && key === 'headingSource') {
        smoothedHeading.handler.source = value;
      } else if (smoothedAttitude && key === 'attitudeSource') {
        smoothedAttitude.handler.source = value;
      } else if (smoothedBoatSpeed && key === 'boatSpeedSource') {
        smoothedBoatSpeed.polar.magnitudeHandler.source = value;
      } else if (smoothedGroundSpeed && key === 'SOGSource') {
        smoothedGroundSpeed.polar.magnitudeHandler.source = value;
      } else if (key === 'preventDuplication') {
        if (smoothedBoatSpeed) smoothedBoatSpeed.polar.magnitudeHandler.passOn = !value;
      }
      // All other keys (sogFallback, estimateBoatSpeed, updateCorrectionTable,
      // assumeCurrent, stability, startWithNewTable, COGSource) are read
      // directly from options.* so no extra action needed.

      delete changedOptions[key];
    }

    // Hot-apply smoother class / parameter changes to all user-tuned smoothers.
    // (noCurrent and smoothedCurrent keep their own fixed Kalman settings.)
    const SMOOTHER_KEYS = ['smootherClass', 'smootherTau', 'smootherTimeSpan', 'smootherSteadyState'];
    if (changedKeys.some(k => SMOOTHER_KEYS.includes(k))) {
      const { SmootherClass: SC, smootherOptions: so } = resolveSmootherConfig();
      for (const s of [smoothedHeading, smoothedBoatSpeed, smoothedGroundSpeed]) {
        if (s) { s.setSmootherClass(SC); s.setSmootherOptions(so); }
      }
      if (smoothedAttitude) { smoothedAttitude.setSmootherClass(SC); smoothedAttitude.setSmootherOptions(so); }
    }

    saveOptions();
  }

  return plugin;
};
