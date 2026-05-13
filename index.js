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
    SOGSource: ' ',
    attitudeSource: ' ',
    preventDuplication: true,
    tableName: 'correctionTable',
    smootherClass: 'MovingAverageSmoother',
    smootherTau: 3,
    smootherTimeSpan: 5,
    smootherSteadyState: 0.2,
    showStatistics: false,
    stalenessDetection: true
  };

  

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

  // only allow prevent duplication when correctedBoatSpeed is enabled, otherwise it would prevent any boat speed from being published at all
  const preventDuplication = () => {
    return options.preventDuplication && options.estimateBoatSpeed;
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
    minSpeed = table.step[0] / 2;
    if (reportFull) reportFull.setTables([table]);
  }

  let isRunning = false;
  let pluginStatus = 'Stopped';
  let smoothedHeading = null;
  let smoothedAttitude = null;
  let rawCurrent = null;
  let smoothedCurrent = null;
  let smoothedBoatSpeed = null;
  let correctedBoatSpeed = null;
  let lrnBoatSpeed = null;
  let boatSpeedRefGround = null;
  let smoothedGroundSpeed = null;
  let speedCorrection = null;
  let residual = null;
  let smoothedResidual = null;
  let reportFull = null;
  let table = null;

  let rawHeading = null;
  let rawAttitude = null;
  let noCurrent = null;
  let rawBoatSpeed = null;
  let rawGroundSpeed = null;
  let started = null;
  let minSpeed = 0;

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
    minSpeed = table.step[0] / 2;

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
    // The magnitude handler has a fixed value of 1 and is never subscribed, so its timestamp
    // stays null forever. Staleness detection on it would always force _stale=true, blocking
    // processChanges() from setting polar._ready=true on every heading delta.
    smoothedHeading.polar.magnitudeHandler.stalenessDetection = false;
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
    noCurrent.stalenessDetection = false; // noCurrent is a fixed zero-vector, never receives live data
    PolarSmoother.send(app, plugin.id, [noCurrent]);

    MessageHandler.setMeta(app, plugin.id, 'navigation.leewayAngle', {
      units: 'rad',
      description: 'Leeway Angle',
      displayUnits: {
        category: 'angle'
      }
    });

    // boatspeed
    smoothedBoatSpeed = createSmoothedHandler({
      app, pluginId: plugin.id,
      id: 'boatSpeed',
      path: 'navigation.speedThroughWater',
      source: options.boatSpeedSource,
      passOn: !preventDuplication(),
      subscribe: true,
      SmootherClass,
      smootherOptions
    });
    rawBoatSpeed = smoothedBoatSpeed.handler;

    // Learning polar — used for updating the correction table
    lrnBoatSpeed = new Polar(app, plugin.id, "lrnBoatSpeed");
    lrnBoatSpeed.configureMagnitude("navigation.speedThroughWater");
    lrnBoatSpeed.configureAngle("navigation.leewayAngle");
    lrnBoatSpeed.setMeta({ displayName: "Learning boat speed", plane: "Boat" });
    lrnBoatSpeed.setAngleRange('-piToPi');

    
    // corrected boatspeed holds both corrected boatspeed and estimated leeway
    correctedBoatSpeed = new Polar(app, plugin.id, "correctedBoatSpeed");
    correctedBoatSpeed.configureMagnitude("navigation.speedThroughWater");
    correctedBoatSpeed.configureAngle("navigation.leewayAngle");
    correctedBoatSpeed.setMeta({ displayName: "Corrected boatspeed / Leeway", plane: "Boat" });
    
    // boatspeed vector in ground frame, used for current estimation and residual calculation
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
    smoothedResidual = new PolarSmoother(residual, ExponentialSmoother, { tau: 30, timeSpan: 30 }); // id auto-derived: 'residual.smoothed'
    smoothedResidual.setAngleRange('0to2pi');

    //#endregion

    //#region Reporting
    reportFull = new Reporter();

    if (options.estimateBoatSpeed) {
      reportFull.addDelta(rawHeading);
      reportFull.addAttitude(rawAttitude);
      reportFull.addDelta(rawBoatSpeed);
      reportFull.addPolar(speedCorrection);
      reportFull.addPolar(boatSpeedRefGround);
      reportFull.addPolar(correctedBoatSpeed);
      reportFull.addPolar(rawGroundSpeed);
      reportFull.addPolar(smoothedCurrent);
      reportFull.addPolar(residual);
      reportFull.addPolar(smoothedResidual);
    }
    if (options.updateCorrectionTable) {
      reportFull.addDelta(smoothedHeading);
      reportFull.addAttitude(smoothedAttitude);
      reportFull.addDelta(smoothedBoatSpeed);
      reportFull.addPolar(smoothedGroundSpeed);
      if (options.assumeCurrent) {
        reportFull.addPolar(smoothedCurrent);
      }
    }
    reportFull.addTable(table);

    //#endregion

    // Apply staleness detection to all subscribed smoother instances.
    // noCurrent is intentionally excluded — it is a fixed zero-vector and never receives live data.
    // Only apply when sd = false: all smoothers already default to stalenessDetection = true.
    // Explicitly calling the setter with true at startup forces _stale = true on handlers that have
    // never received data, causing the first sample to be dropped (library side-effect).
    const sd = options.stalenessDetection ?? true;
    if (!sd) {
      for (const s of [smoothedHeading, smoothedAttitude, smoothedBoatSpeed, smoothedGroundSpeed, smoothedCurrent, smoothedResidual]) {
        if (s) s.stalenessDetection = false;
      }
    }

    isRunning = true;
    started = new Date();
    setStatus('Running');
    app.debug("Running");

    let lastSave = 0;
    smoothedBoatSpeed.onChange = () => {
      // Drain any pending option changes before calculating
      if (Object.keys(changedOptions).length) applyOptionChanges();

      const wellUnderway = started < new Date() - 60 * 1000;

      setStatus(wellUnderway ? 'Running' : 'Stabilizing');
      if (options.estimateBoatSpeed) correct(wellUnderway);
      if (options.updateCorrectionTable && wellUnderway) {
        updateTable();
        // Save correction table periodically
        const now = new Date();
        if (now - lastSave > 60 * 1000) {
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
        smoothedAttitude = smoothedAttitude?.terminate();
        rawCurrent = rawCurrent?.terminate();
        smoothedCurrent = smoothedCurrent?.terminate?.();
        smoothedBoatSpeed = smoothedBoatSpeed?.terminate();
        correctedBoatSpeed = correctedBoatSpeed?.terminate();
        lrnBoatSpeed = lrnBoatSpeed?.terminate();
        boatSpeedRefGround = boatSpeedRefGround?.terminate();
        smoothedGroundSpeed = smoothedGroundSpeed?.terminate();
        speedCorrection = speedCorrection?.terminate();
        residual = residual?.terminate();
        smoothedResidual = smoothedResidual?.terminate?.();
        reportFull = null;
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

  /**
   * Corrects and publishes boat speed. Handles SOG fallback and missing-input
   * silent fallback so that navigation.speedThroughWater is always written
   * when estimateBoatSpeed is on, as long as any usable speed source exists.
   *
   * Priority order:
   *   1. STW zero + sogFallback enabled + SOG available → publish SOG magnitude
   *   2. attitude/heading not ready → publish raw STW unchanged (silent fallback)
   *   3. All inputs ready → apply table correction; estimate current if wellUnderway
   *
   * @param {boolean} wellUnderway - Gates current estimation (requires 60 s settling).
   */
  function correct(wellUnderway) {
    // copy the boatspeed delta to polar
    correctedBoatSpeed.setVectorValue({ x: rawBoatSpeed.value, y: 0 }); 
    
    speedCorrection.setVectorValue({ x: 0, y: 0 });

    // Priority 1: SOG fallback when STW is stuck at zero
    // (onChange only fires when STW is ready, so a missing STW cannot reach here)
    if (options.sogFallback && rawGroundSpeed.ready && correctedBoatSpeed.magnitude === 0 && rawGroundSpeed.magnitude >= minSpeed) {
        correctedBoatSpeed.setVectorValue({ x: rawGroundSpeed.magnitude, y: 0 });
    }
    else if (rawAttitude.ready) {
      if (correctedBoatSpeed.magnitude > 0) {
        const { correction, variance } = table.getCorrection(correctedBoatSpeed.magnitude, rawAttitude.value?.roll);
        speedCorrection.setVectorValue(correction, variance);
        correctedBoatSpeed.add(speedCorrection);
      }
      // Current estimation and residual also require heading (to rotate into ground frame).
      // Also handle near-zero SOG where COG is unavailable: treat groundspeed as zero vector.
      const sogHandler = rawGroundSpeed.magnitudeHandler;
      const nearZeroGroundSpeed = !rawGroundSpeed.ready &&
        sogHandler.ready &&
        Number.isFinite(sogHandler.value) &&
        sogHandler.value < 0.3;
      if (rawHeading.ready && (rawGroundSpeed.ready || nearZeroGroundSpeed)) {
        boatSpeedRefGround.copyFrom(correctedBoatSpeed);
        boatSpeedRefGround.rotate(rawHeading.value);
        // Current estimation gated by wellUnderway (smoothers need to settle first)
        if (wellUnderway) {
          if (rawGroundSpeed.ready) {
            rawCurrent.copyFrom(rawGroundSpeed);
          } else {
            // COG unavailable but SOG is near-zero: boat is stationary, groundspeed treated as zero
            rawCurrent.setVectorValue({ x: 0, y: 0 });
          }
          rawCurrent.substract(boatSpeedRefGround);
          smoothedCurrent.sample();
        }
        // Residual requires full groundspeed (both SOG and COG)
        if (rawGroundSpeed.ready) {
          residual.copyFrom(rawGroundSpeed);
          residual.substract(boatSpeedRefGround);
          residual.substract(smoothedCurrent);
          smoothedResidual.sample();
        }
      }
    }
    // Implicit fallback: attitude not ready — correctedBoatSpeed = raw STW, no correction

    PolarSmoother.send(app, plugin.id, [smoothedCurrent, smoothedResidual]);

    Polar.send(app, plugin.id, [correctedBoatSpeed]);
  }

  /**
   * Updates the correction table from the current smoothed inputs.
   * Reads assumeCurrent and minSpeed from module-level options/state;
   * silently returns if any required input is not yet ready.
   */
  function updateTable() {
    lrnBoatSpeed.setVectorValue({ x: smoothedBoatSpeed.value, y: 0 }, { x: smoothedBoatSpeed.variance ?? 0, y: 0 });
    if (!smoothedAttitude.ready || !smoothedBoatSpeed.ready || !smoothedHeading.ready || !smoothedGroundSpeed.ready || (options.assumeCurrent ? !smoothedCurrent.ready : !noCurrent.ready)) return;
    
    // update correction table
    if (smoothedBoatSpeed.value > minSpeed) {
      table.update(smoothedBoatSpeed.value, smoothedAttitude.value?.roll, smoothedGroundSpeed, options.assumeCurrent ? smoothedCurrent : noCurrent, lrnBoatSpeed, smoothedHeading.value);
    }

  }

  /**
   * Loads or creates a correction table from disk.
   * If the file exists it is deserialized; otherwise a new table is created
   * with default dimensions and saved to disk.
   *
   * @param {Object} options - Plugin options (stability, tableName, and dimension defaults).
   * @param {string} filePath - Absolute path of the JSON file to read.
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
   * Saves the correction table to disk as JSON.
   *
   * @param {CorrectionTable} correctionTable - The correction table instance to save.
   * @param {string} filePath - Absolute path of the target JSON file.
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
        smoothedBoatSpeed.handler.source = value;
      } else if (smoothedGroundSpeed && key === 'SOGSource') {
        smoothedGroundSpeed.polar.magnitudeHandler.source = value;
      } else if (key === 'preventDuplication') {
        if (smoothedBoatSpeed) smoothedBoatSpeed.handler.passOn = !preventDuplication();
      } else if (key === 'estimateBoatSpeed' ) {
        if (smoothedBoatSpeed) smoothedBoatSpeed.handler.passOn = !preventDuplication();
      } else if (key === 'stalenessDetection') {
        const sdVal = Boolean(value);
        for (const s of [smoothedHeading, smoothedAttitude, smoothedBoatSpeed, smoothedGroundSpeed, smoothedCurrent, smoothedResidual]) {
          if (s) s.stalenessDetection = sdVal;
        }
        // noCurrent is always excluded from staleness detection
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
