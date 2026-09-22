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

const {
  CorrectionTable,
  DEFAULT_CORRECTION_DRIFT_RATE,
  DEFAULT_PROCESS_NOISE_RATE,
  SECONDS_PER_MONTH,
  KNOT_TO_MPS
} = require('./correctionTable.js');

const LONG_STABILIZING_MS = 60 * 1000;
const MIN_SMOOTHING_WINDOW_SECONDS = 5;
const LEARNING_GAP_SECONDS = 1;
// navigation.state values that indicate the vessel is not moving. Only applied as an
// override (see isVesselMoving) when options.suspendLearningOnNavigationState is enabled.
const NOT_MOVING_NAVIGATION_STATES = new Set(['anchored', 'moored', 'motoring']);
const OBSOLETE_SMOOTHER_KEYS = new Set(['smootherClass', 'smootherTau', 'smootherSteadyState']);
const MAX_CORRECTION_DRIFT_RATE = 3;

function correctionDriftRateToProcessNoiseRate(driftRate) {
  const rate = Number.isFinite(Number(driftRate))
    ? Math.min(MAX_CORRECTION_DRIFT_RATE, Math.max(0, Number(driftRate)))
    : DEFAULT_CORRECTION_DRIFT_RATE;
  return (rate * KNOT_TO_MPS) ** 2 / SECONDS_PER_MONTH;
}

function legacyStabilityToCorrectionDriftRate(stability) {
  if (!Number.isFinite(Number(stability))) return DEFAULT_CORRECTION_DRIFT_RATE;
  return Math.sqrt((10 ** -Number(stability)) * SECONDS_PER_MONTH) / KNOT_TO_MPS;
}

function normalizeNavigationState(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function getShortStabilizingMs(options = {}) {
  return Math.max(MIN_SMOOTHING_WINDOW_SECONDS, Number(options.smootherTimeSpan) || MIN_SMOOTHING_WINDOW_SECONDS) * 1000;
}

function getSmoothingWindowSeconds(options = {}) {
  return Math.max(MIN_SMOOTHING_WINDOW_SECONDS, Number(options.smootherTimeSpan) || MIN_SMOOTHING_WINDOW_SECONDS);
}

function getLearningIntervalMs(options = {}) {
  return (getSmoothingWindowSeconds(options) + LEARNING_GAP_SECONDS) * 1000;
}

function migrateCorrectionTableData(data, { filePath, statSync = fs.statSync, now = Date.now(), debug = () => {} } = {}) {
  if (!data || (data.schemaVersion !== undefined && data.schemaVersion !== 1) || data.schemaVersion === 2) {
    return { data, migrated: false };
  }

  let lastAcceptedAt;
  try {
    const stat = statSync(filePath);
    lastAcceptedAt = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : null;
  } catch (err) {
    lastAcceptedAt = null;
  }
  if (!Number.isFinite(lastAcceptedAt)) {
    lastAcceptedAt = now;
    debug(`Correction table migration used load time for ${filePath}: file modification time unavailable`);
  }

  return {
    migrated: true,
    data: {
      ...data,
      schemaVersion: 2,
      table: data.table.map(row => row.map(cell => ({
        ...cell,
        lastAcceptedAt: cell?.state ? lastAcceptedAt : null
      })))
    }
  };
}

function isCogOverrideActive(groundSpeedPolar, speedThreshold) {
  const sogHandler = groundSpeedPolar?.magnitudeHandler;
  return !groundSpeedPolar?.ready
    && sogHandler?.ready
    && Number.isFinite(sogHandler.value)
    && sogHandler.value < speedThreshold;
}

/**
 * The vessel's own "moving" state, derived from SOG. When navigation.state is known
 * (has ever delivered a value) and the suspend-on-navigation-state setting is enabled,
 * it can additionally force "not moving" (anchored/moored/motoring) — but it can never
 * force "moving" when SOG says otherwise, since navigation.state can go stale or wrong
 * without a way to verify it independently.
 */
function isVesselMoving({ sogMagnitude, speedThreshold, navigationStateHandler, gateEnabled }) {
  const ownMoving = Number.isFinite(sogMagnitude) && sogMagnitude >= speedThreshold;
  if (!ownMoving || !gateEnabled) return ownMoving;
  const state = navigationStateHandler?.state;
  const navigationKnown = state?.pathKnown === true && state?.hasDelta === true;
  if (!navigationKnown) return true;
  return !NOT_MOVING_NAVIGATION_STATES.has(normalizeNavigationState(navigationStateHandler.value));
}

/**
 * Leeway is the angle of the corrected boatspeed vector, so a small lateral
 * correction divided by a near-zero magnitude yields a large, meaningless angle.
 */
function isLeewayValid(speed, speedThreshold, vesselMoving) {
  if (!(speed >= speedThreshold)) return false;
  return vesselMoving;
}

function evaluateLearningMode({ options = {}, vesselMoving = true, stabilizingUntil = 0, stabilizingReason = null, now = Date.now() }) {
  if (!options.updateCorrectionTable) {
    return { state: 'off', reason: 'manual' };
  }

  if (!vesselMoving) {
    return { state: 'suspended', reason: 'not_moving' };
  }

  if (now < stabilizingUntil) {
    return { state: 'stabilizing', reason: stabilizingReason || 'startup' };
  }

  return { state: 'active', reason: null };
}

function evaluateObservationGate({
  learningMode,
  inputsReady,
  stw,
  sog,
  speedThreshold,
}) {
  if (learningMode.state === 'off') {
    return { state: 'skipped', reason: 'learning_off' };
  }
  if (learningMode.state === 'suspended') {
    return { state: 'skipped', reason: learningMode.reason === 'cog_override' ? 'cog_override_active' : 'not_moving_blocked' };
  }
  if (learningMode.state === 'stabilizing') {
    return { state: 'skipped', reason: 'stabilizing' };
  }
  if (!inputsReady) {
    return { state: 'invalid', reason: 'missing_input' };
  }
  if (!(stw > speedThreshold)) {
    return { state: 'skipped', reason: 'stw_below_threshold' };
  }
  if (!(sog >= speedThreshold)) {
    return { state: 'skipped', reason: 'sog_below_threshold' };
  }
  return { state: 'pending', reason: null };
}

function buildNavigationStateStatus(handler, gateEnabled) {
  if (!handler) {
    return {
      enabled: !!gateEnabled,
      path: 'navigation.state',
      pathKnown: false,
      ready: false,
      value: null,
      blocking: false
    };
  }

  const state = handler.state;
  const value = handler.value ?? null;
  const normalized = normalizeNavigationState(value);
  const known = state.pathKnown === true && state.hasDelta === true;
  return {
    enabled: !!gateEnabled,
    path: handler.path,
    pathKnown: state.pathKnown,
    ready: state.ready,
    isStale: state.isStale,
    value,
    blocking: !!gateEnabled && known && NOT_MOVING_NAVIGATION_STATES.has(normalized)
  };
}

function getDerivedObservationStatus(learningMode, lastState, lastReason) {
  if (learningMode.state === 'off') {
    return { state: 'skipped', reason: 'learning_off' };
  }
  if (learningMode.state === 'stabilizing') {
    return { state: 'skipped', reason: 'stabilizing' };
  }
  if (learningMode.state === 'suspended') {
    return { state: 'skipped', reason: learningMode.reason === 'cog_override' ? 'cog_override_active' : 'not_moving_blocked' };
  }
  return { state: lastState, reason: lastReason };
}

module.exports = function (app) {

  const DEFAULT_DIMS = { maxSpeed: 10, speedStep: 1, maxHeel: 24, heelStep: 6 };

  let options = {};
  let changedOptions = {};
  const defaultOptions = {
    sogFallback: true,
    estimateBoatSpeed: false,
    updateCorrectionTable: true,
    correctionDriftRate: DEFAULT_CORRECTION_DRIFT_RATE,
    suspendLearningOnNavigationState: false,
    tableName: 'correctionTable',
    configVersion: 3,
    smootherTimeSpan: 5,
    showStatistics: false
  };

  

  function readOptions() {
    const stored = app.readPluginOptions();
    const raw = stored && stored.configuration ? stored.configuration : (stored || {});
    // Strip embedded table — stored separately on disk
    const { correctionTable: _drop, ...rest } = raw;
    options = { ...defaultOptions, ...rest };
    if (!('correctionDriftRate' in rest) && Number.isFinite(Number(rest.stability))) {
      options.correctionDriftRate = legacyStabilityToCorrectionDriftRate(rest.stability);
    }
    delete options.stability;
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
   * Strips obsolete source-selection fields from the persisted config and
   * writes it back if anything changed. Called once on every start().
   */
  function migrateConfig() {
    const obsoleteKeys = [
      'headingSource', 'boatSpeedSource', 'SOGSource', 'attitudeSource',
      'preventDuplication', 'minSogForLearning', 'stability', 'smootherClass',
      'smootherTau', 'smootherSteadyState', 'assumeCurrent'
    ];
    const hadObsolete = obsoleteKeys.some(k => k in options);
    for (const k of obsoleteKeys) delete options[k];
    const previousWindow = options.smootherTimeSpan;
    options.smootherTimeSpan = getSmoothingWindowSeconds(options);
    const windowChanged = previousWindow !== options.smootherTimeSpan;
    if (hadObsolete || windowChanged || (options.configVersion || 0) < 4) {
      options.configVersion = 4;
      saveOptions();
      app.debug('Config migrated to v3: standardized correction-table learning smoothing');
    }
  }

  /** Returns the fixed smoother used for all learning inputs. */
  function resolveSmootherConfig() {
    return {
      SmootherClass: MovingAverageSmoother,
      smootherOptions: { timeSpan: getSmoothingWindowSeconds(options) }
    };
  }

  function swapTable(newTable) {
    table = newTable;
    minSpeed = table.step[0];
    if (reportFull) reportFull.setTables([table]);
    lastSave = Date.now(); // explicit table operations already save; defer next periodic save
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
  let calculationIntervalSmoother = null;
  let lastCalculationTime = null;
  let lastLearningAttemptTime = null;

  let rawHeading = null;
  let rawAttitude = null;
  let noCurrent = null;
  let rawBoatSpeed = null;
  let rawGroundSpeed = null;
  let minSpeed = 0;
  let lastSave = 0;
  let navigationStateHandler = null;
  let lastNavigationStateValue = null;
  let learningStabilizingUntil = 0;
  let learningStabilizingReason = 'startup';
  let lastObservationState = null;
  let lastObservationReason = null;
  let lifecycleWarningMap = new Map();
  let lifecycleWarnings = [];

  function setObservationStatus(state, reason = null) {
    lastObservationState = state;
    lastObservationReason = reason;
    if (table) {
      table.lastUpdateResult = state;
      table.lastUpdateReason = reason;
    }
  }

  function resetLearningStabilization(reason, durationMs) {
    const delay = Math.max(0, Number(durationMs) || 0);
    learningStabilizingUntil = Date.now() + delay;
    learningStabilizingReason = reason;
  }

  function handleNavigationStateDelta() {
    const normalized = normalizeNavigationState(navigationStateHandler?.value);
    if (normalized === lastNavigationStateValue) return;
    if (lastNavigationStateValue !== null) {
      resetLearningStabilization('nav_state_change', LONG_STABILIZING_MS);
    }
    lastNavigationStateValue = normalized;
  }

  function getLearningStatePayload() {
    const navigationState = buildNavigationStateStatus(navigationStateHandler, options.suspendLearningOnNavigationState);
    const vesselMoving = isVesselMoving({
      sogMagnitude: smoothedGroundSpeed?.magnitude,
      speedThreshold: minSpeed,
      navigationStateHandler,
      gateEnabled: options.suspendLearningOnNavigationState
    });
    const learningMode = evaluateLearningMode({
      options,
      vesselMoving,
      stabilizingUntil: learningStabilizingUntil,
      stabilizingReason: learningStabilizingReason,
      now: Date.now()
    });
    if (learningMode.state === 'active' && isCogOverrideActive(rawGroundSpeed, minSpeed)) {
      learningMode.state = 'suspended';
      learningMode.reason = 'cog_override';
    }
    const observation = getDerivedObservationStatus(learningMode, lastObservationState, lastObservationReason);

    return {
      state: learningMode.state,
      reason: learningMode.reason,
      observationState: observation.state,
      observationReason: observation.reason,
      minStwForLearning: minSpeed,
      minSogForLearning: minSpeed,
      vesselMoving,
      navigationState
    };
  }

  function setLifecycleWarning(id, status, path) {
    const safePath = path || 'unknown path';
    const message = status === 'idle'
      ? `Input ${id} is idle on ${safePath}; resubscribing`
      : status === 'incomplete'
      ? `Input ${id} is missing ${safePath}`
      : `Input ${id} is stale on ${safePath}`;
    lifecycleWarningMap.set(id, {
      id,
      status,
      path: safePath,
      message,
      updatedAt: Date.now()
    });
    lifecycleWarnings = Array.from(lifecycleWarningMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function clearLifecycleWarning(id) {
    if (!lifecycleWarningMap.has(id)) return;
    lifecycleWarningMap.delete(id);
    lifecycleWarnings = Array.from(lifecycleWarningMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function buildLifecycleCallbacks(id, getPath, resubscribe) {
    return {
      onDelta: () => {
        clearLifecycleWarning(id);
      },
      onStale: () => {
        if (!isRunning) return;
        const path = getPath();
        app.debug(`[${plugin.id}] stale input ${id} on ${path}`);
        setLifecycleWarning(id, 'stale', path);
      },
      onIdle: () => {
        if (!isRunning) return;
        const path = getPath();
        app.debug(`[${plugin.id}] idle input ${id} on ${path}; resubscribing`);
        setLifecycleWarning(id, 'idle', path);
        try {
          resubscribe();
        } catch (e) {
          app.debug(`[${plugin.id}] resubscribe failed for ${id}: ${e.message}`);
        }
      }
    };
  }

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
        const payload = reportFull.report();
        payload.lifecycleWarnings = lifecycleWarnings;
        payload.learningState = getLearningStatePayload();
        payload.pollIntervalMs = calculationIntervalSmoother?.estimate
          ? calculationIntervalSmoother.estimate * 1000
          : 1000;
        res.json(payload);
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
      res.json({ status: pluginStatus, isRunning, lifecycleWarnings, learningState: getLearningStatePayload() });
    });

    // --- Settings API ---
    router.get('/api/settings', (req, res) => {
      const active = { ...options, ...changedOptions };
      for (const key of OBSOLETE_SMOOTHER_KEYS) delete active[key];
      res.json(active);
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
      const accepted = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'stability' && !OBSOLETE_SMOOTHER_KEYS.has(key)));
      if ('correctionDriftRate' in accepted) {
        const driftRate = Number(accepted.correctionDriftRate);
        if (Number.isFinite(driftRate)) {
          accepted.correctionDriftRate = Math.min(MAX_CORRECTION_DRIFT_RATE, Math.max(0, driftRate));
        } else {
          delete accepted.correctionDriftRate;
        }
      }
      if ('smootherTimeSpan' in accepted) {
        accepted.smootherTimeSpan = getSmoothingWindowSeconds(accepted);
      }
      changedOptions = { ...changedOptions, ...accepted };
      const active = { ...options, ...changedOptions };
      for (const key of OBSOLETE_SMOOTHER_KEYS) delete active[key];
      res.json(active);
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
      const newTable = new CorrectionTable(name, row, col, correctionDriftRateToProcessNoiseRate(options.correctionDriftRate));
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
      if (!fileData) {
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: `Table '${name}' not found` });
        const message = `Correction table load rejected for ${name}: file could not be read`;
        app.error(message);
        app.debug(message);
        return res.status(422).json({ error: message });
      }
      try {
        const loadedTable = CorrectionTable.fromJSON(fileData, correctionDriftRateToProcessNoiseRate(options.correctionDriftRate));
        loadedTable.setDisplayAttributes({ label: name }); // Table2D API unchanged
        if (isRunning) swapTable(loadedTable);
        saveTableName(name);
        res.json({ name });
      } catch (err) {
        const message = `Correction table load rejected for ${name}: ${err.message}`;
        app.error(message);
        app.debug(message);
        res.status(422).json({ error: message });
      }
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
      const copiedTable = CorrectionTable.fromJSON(data, correctionDriftRateToProcessNoiseRate(options.correctionDriftRate));
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
      const resized = CorrectionTable.resampleFromJSON(table.toJSON(), newRow, newCol, correctionDriftRateToProcessNoiseRate(options.correctionDriftRate), 1e-4);
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
    lifecycleWarningMap = new Map();
    lifecycleWarnings = [];
    readOptions(); // pick up any saves since registerWithRouter ran
    migrateConfig(); // strip obsolete fields from persisted config
    const tableName = options.tableName || 'correctionTable';
    const tableFilePath = path.join(app.getDataDirPath(), tableName + '.json');
    table = loadTable(options, tableFilePath);
    minSpeed = table.step[0];
    calculationIntervalSmoother = new ExponentialSmoother({ tau: 10 });
    lastCalculationTime = null;
    lastLearningAttemptTime = null;

    //#region Handler and Polar Initialization
    const { SmootherClass, smootherOptions } = resolveSmootherConfig();

    // heading
    smoothedHeading = new SmoothedAngle(app, plugin.id, 'heading', 'navigation.headingTrue', {
      angleRange: '0to2pi',
      meta: { displayName: 'Heading', plane: 'Ground' },
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'heading.angle',
        () => smoothedHeading?.handler?.path || 'navigation.headingTrue',
        () => { smoothedHeading?.unsubscribe(); smoothedHeading?.subscribe(false, true); }
      )
    });
    rawHeading = smoothedHeading.handler;

    // attitude
    smoothedAttitude = createSmoothedHandler({
      app, pluginId: plugin.id,
      id: 'attitude',
      path: 'navigation.attitude',
      subscribe: true,
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'attitude.smoothed',
        () => smoothedAttitude?.handler?.path || 'navigation.attitude',
        () => { smoothedAttitude?.unsubscribe(); smoothedAttitude?.subscribe(); }
      )
    });
    rawAttitude = smoothedAttitude.handler;

    navigationStateHandler = new MessageHandler(app, plugin.id, 'navigationState');
    navigationStateHandler.configure('navigation.state');
    // navigation.state is an event path — it is only sent on transition, not on a regular
    // period — so the generic telemetry staleness timer (which would otherwise mark it
    // stale, and therefore not `ready`, within a few seconds of silence) does not apply.
    navigationStateHandler.stalePeriod = 0;
    navigationStateHandler.onDelta = () => {
      handleNavigationStateDelta();
    };
    navigationStateHandler.subscribe();


    // current
    // send metadata for current
    MessageHandler.setMeta(app, plugin.id, "environment.current.drift", {units: "m/s", type: "number", description: "Speed of the current"});
    MessageHandler.setMeta(app, plugin.id, "environment.current.setTrue", { units: "rad", type: "number", description: "Direction of the current" });
    rawCurrent = new Polar(app, plugin.id, "current");
    rawCurrent.configureMagnitude("environment.current.drift");
    rawCurrent.configureAngle("environment.current.setTrue");
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
      pathMagnitude: "environment.current.drift",
      pathAngle: "environment.current.setTrue",
      subscribe: false,
      app,
      pluginId: plugin.id,
      SmootherClass: BaseSmoother,
      smootherOptions: smootherOptions,
      meta: { displayName: "NoCurrent", plane: "Ground" },
    });
    noCurrent.xSmoother.reset(0,0);
    noCurrent.ySmoother.reset(0,0);

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
      subscribe: false,
      SmootherClass,
      smootherOptions,
      onDelta: () => {
        clearLifecycleWarning('boatSpeed.smoothed');
        const now = Date.now();
        if (lastCalculationTime !== null) {
          const interval = (now - lastCalculationTime) / 1000;
          if (interval > 0) calculationIntervalSmoother.add(interval);
        }
        lastCalculationTime = now;
        // Drain any pending option changes before calculating
        if (Object.keys(changedOptions).length) applyOptionChanges();

        const learningMode = evaluateLearningMode({
          options,
          vesselMoving: isVesselMoving({
            sogMagnitude: smoothedGroundSpeed?.magnitude,
            speedThreshold: minSpeed,
            navigationStateHandler,
            gateEnabled: options.suspendLearningOnNavigationState
          }),
          stabilizingUntil: learningStabilizingUntil,
          stabilizingReason: learningStabilizingReason,
          now: Date.now()
        });

        const wellUnderway = Date.now() >= learningStabilizingUntil;
        setStatus(learningMode.state === 'stabilizing' ? 'Stabilizing' : 'Running');
        if (options.estimateBoatSpeed) correct(wellUnderway);
        updateTable();
        if (lastObservationState === 'accepted' && options.updateCorrectionTable) {
          const now = Date.now();
          if (now - lastSave > 60_000) {
            if (!isTableEmpty(table)) {
              saveTable(table, path.join(app.getDataDirPath(), table.id + '.json'));
            }
            lastSave = now;
          }
        }
      }
      ,
      onIdle: () => {
        if (!isRunning) return;
        const path = smoothedBoatSpeed?.handler?.path || 'navigation.speedThroughWater';
        app.debug(`[${plugin.id}] idle input boatSpeed.smoothed on ${path}; resubscribing`);
        setLifecycleWarning('boatSpeed.smoothed', 'idle', path);
        smoothedBoatSpeed?.unsubscribe();
        smoothedBoatSpeed?.subscribe();
      },
      onStale: () => {
        if (!isRunning) return;
        const path = smoothedBoatSpeed?.handler?.path || 'navigation.speedThroughWater';
        app.debug(`[${plugin.id}] stale input boatSpeed.smoothed on ${path}`);
        setLifecycleWarning('boatSpeed.smoothed', 'stale', path);
      }
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
      angleRange: '0to2pi',
      meta: { displayName: 'Groundspeed', plane: 'Ground' },
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'groundSpeed.smoothed',
        () => `${smoothedGroundSpeed?.polar?.pathMagnitude || 'navigation.speedOverGround'}, ${smoothedGroundSpeed?.polar?.pathAngle || 'navigation.courseOverGroundTrue'}`,
        () => { smoothedGroundSpeed?.unsubscribe(); smoothedGroundSpeed?.subscribe(true, true); }
      )
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
    // Smoothed learning inputs are always subscribed regardless of updateCorrectionTable,
    // so always add them to the report — otherwise warnings never clear when
    // learning was disabled at startup and later toggled on.
    reportFull.addDelta(smoothedHeading);
    reportFull.addAttitude(smoothedAttitude);
    reportFull.addDelta(smoothedBoatSpeed);
    reportFull.addPolar(smoothedGroundSpeed);
    reportFull.addTable(table);

    //#endregion

    isRunning = true;
    lastSave = 0;
    lastObservationState = null;
    lastObservationReason = null;
    lastNavigationStateValue = normalizeNavigationState(navigationStateHandler?.value);
    resetLearningStabilization('startup', LONG_STABILIZING_MS);
    setStatus('Running');
    smoothedBoatSpeed.subscribe();
    app.debug("Running");

  }

  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        if (table && !isTableEmpty(table)) {
          saveTableSync(table, path.join(app.getDataDirPath(), table.id + '.json'));
        }
        // Clear all active output paths from the SK bus before teardown.
        if (smoothedCurrent) PolarSmoother.clear(app, plugin.id, [smoothedCurrent]);
        if (options.estimateBoatSpeed && correctedBoatSpeed) Polar.clear(app, plugin.id, [correctedBoatSpeed]);
        smoothedHeading = smoothedHeading?.terminate();
        smoothedAttitude = smoothedAttitude?.terminate();
        rawCurrent = rawCurrent?.terminate();
        smoothedCurrent = smoothedCurrent?.terminate?.();
        navigationStateHandler = navigationStateHandler?.terminate();
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
        lastNavigationStateValue = null;
        learningStabilizingUntil = 0;
        learningStabilizingReason = 'startup';
        lastObservationState = null;
        lastObservationReason = null;
        app.setPluginStatus("Stopped");
        app.debug("Stopped");

        pluginStatus = 'Stopped';
        isRunning = false;
        lifecycleWarningMap = new Map();
        lifecycleWarnings = [];
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
    if (options.sogFallback && rawGroundSpeed.ready && rawBoatSpeed.ready && rawBoatSpeed.value === 0 && rawGroundSpeed.magnitude >= minSpeed) {
        correctedBoatSpeed.setVectorValue({ x: rawGroundSpeed.magnitude, y: 0 });
    }
    else if (rawAttitude.ready && Number.isFinite(rawAttitude.value?.roll)) {
      clearLifecycleWarning('attitude.roll');
      if (correctedBoatSpeed.magnitude > 0) {
        const { correction, variance } = table.getCorrection(correctedBoatSpeed.magnitude, rawAttitude.value?.roll);
        const vesselMoving = isVesselMoving({
          sogMagnitude: rawGroundSpeed?.magnitude,
          speedThreshold: minSpeed,
          navigationStateHandler,
          gateEnabled: options.suspendLearningOnNavigationState
        });
        const leewayValid = isLeewayValid(correctedBoatSpeed.magnitude, minSpeed, vesselMoving);
        speedCorrection.setVectorValue(
          { x: correction.x, y: leewayValid ? correction.y : 0 },
          { x: variance.x, y: leewayValid ? variance.y : 0 }
        );
        correctedBoatSpeed.add(speedCorrection);
      }
      // Current estimation and residual also require heading (to rotate into ground frame).
      // Also handle near-zero SOG where COG is unavailable: treat groundspeed as zero vector.
      const nearZeroGroundSpeed = isCogOverrideActive(rawGroundSpeed, minSpeed);
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
    // Implicit fallback: attitude not ready or missing roll — correctedBoatSpeed = raw STW, no correction
    else if (rawAttitude.ready) {
      setLifecycleWarning('attitude.roll', 'incomplete', 'navigation.attitude.roll');
    }

    PolarSmoother.send(app, plugin.id, [smoothedCurrent]);

    Polar.send(app, plugin.id, [correctedBoatSpeed]);
  }

  /**
   * Updates the correction table from the current smoothed inputs.
    * Reads minSpeed from module-level state;
   * silently returns if any required input is not yet ready.
   */
  function updateTable() {
    const now = Date.now();
    if (lastLearningAttemptTime !== null && now - lastLearningAttemptTime < getLearningIntervalMs(options)) return;
    lrnBoatSpeed.setVectorValue({ x: smoothedBoatSpeed.value, y: 0 }, { x: smoothedBoatSpeed.variance ?? 0, y: 0 });
    const learningMode = evaluateLearningMode({
      options,
      vesselMoving: isVesselMoving({
        sogMagnitude: smoothedGroundSpeed.magnitude,
        speedThreshold: minSpeed,
        navigationStateHandler,
        gateEnabled: options.suspendLearningOnNavigationState
      }),
      stabilizingUntil: learningStabilizingUntil,
      stabilizingReason: learningStabilizingReason,
      now: Date.now()
    });
    if (learningMode.state === 'active' && isCogOverrideActive(rawGroundSpeed, minSpeed)) {
      learningMode.state = 'suspended';
      learningMode.reason = 'cog_override';
    }
    const inputsReady = smoothedAttitude.ready && Number.isFinite(smoothedAttitude.value?.roll)
      && smoothedBoatSpeed.ready && smoothedHeading.ready && smoothedGroundSpeed.ready;
    const observationGate = evaluateObservationGate({
      learningMode,
      inputsReady,
      stw: smoothedBoatSpeed.value,
      sog: smoothedGroundSpeed.magnitude,
      speedThreshold: minSpeed
    });

    if (observationGate.state !== 'pending') {
      if (observationGate.state === 'invalid') {
        setObservationStatus('rejected', observationGate.reason);
        resetLearningStabilization('observation_reset', getShortStabilizingMs(options));
      }
      return;
    }

    lastLearningAttemptTime = now;
    table.update(
      smoothedBoatSpeed.value,
      smoothedAttitude.value?.roll,
      smoothedGroundSpeed,
      noCurrent,
      lrnBoatSpeed,
      smoothedHeading.value,
      smoothedHeading.variance
    );
    if (table.lastUpdateResult === 'accepted') {
      setObservationStatus('accepted', 'accepted');
    } else if (table.lastUpdateResult === 'rejected') {
      setObservationStatus('rejected', 'estimator_outlier');
      resetLearningStabilization('observation_reset', getShortStabilizingMs(options));
    }
  }

  /**
   * Loads or creates a correction table from disk.
   * If the file exists it is deserialized; otherwise a new table is created
   * with default dimensions and saved to disk.
   *
  * @param {Object} options - Plugin options (correctionDriftRate, tableName, and dimension defaults).
   * @param {string} filePath - Absolute path of the JSON file to read.
   * @returns {CorrectionTable} The loaded or newly created CorrectionTable instance.
   */
  function loadTable(options, filePath) {
    const processNoiseRate = correctionDriftRateToProcessNoiseRate(options.correctionDriftRate);
    let fileData = Table2D.readFromFile(filePath);
    if (fileData) {
      try {
        const migration = migrateCorrectionTableData(fileData, {
          filePath,
          debug: message => app.debug(message)
        });
        const table = CorrectionTable.fromJSON(migration.data, processNoiseRate);
        table.setDisplayAttributes({ label: table.id }); // Table2D API unchanged
        if (migration.migrated) saveMigratedTable(table, filePath);
        app.debug("Correction table loaded: " + (fileData.id || filePath));
        return table;
      } catch (err) {
        return recoverTable(`could not deserialize ${filePath}: ${err.message}`);
      }
    }

    if (fs.existsSync(filePath)) {
      return recoverTable(`could not read ${filePath}`);
    }

    const table = createDefaultTable(options.tableName || 'correctionTable', processNoiseRate);
    app.debug("Correction table created: " + table.id);
    return table;
  }

  function createDefaultTable(name, processNoiseRate = DEFAULT_PROCESS_NOISE_RATE) {
    const row = { min: 0, max: SI.fromKnots(DEFAULT_DIMS.maxSpeed), step: SI.fromKnots(DEFAULT_DIMS.speedStep) };
    const col = { min: -SI.fromDegrees(DEFAULT_DIMS.maxHeel), max: SI.fromDegrees(DEFAULT_DIMS.maxHeel), step: SI.fromDegrees(DEFAULT_DIMS.heelStep) };
    const table = new CorrectionTable(name, row, col, processNoiseRate);
    table.setDisplayAttributes({ label: name }); // Table2D API unchanged
    return table;
  }

  function recoverTable(reason) {
    const recoveryName = `correctionTable-${new Date().toISOString().slice(0, 10)}`;
    const recoveryPath = path.join(app.getDataDirPath(), recoveryName + '.json');
    const table = createDefaultTable(recoveryName, correctionDriftRateToProcessNoiseRate(options.correctionDriftRate));
    const message = `Correction table recovery: ${reason}; loaded empty table ${recoveryName}`;
    app.error(message);
    app.debug(message);
    saveTableSync(table, recoveryPath);
    saveTableName(recoveryName);
    return table;
  }

  /**
   * Saves the correction table to disk as JSON (async, via library).
   *
   * @param {CorrectionTable} correctionTable - The correction table instance to save.
   * @param {string} filePath - Absolute path of the target JSON file.
   */
  function saveTable(correctionTable, filePath) {
    correctionTable.saveToFile(filePath);
  }

  /**
   * Saves the correction table synchronously. Used in stop() and when learning
   * is toggled off, to ensure the write completes before the process can exit
   * or the plugin be restarted.
   */
  function saveTableSync(correctionTable, filePath) {
    try {
      const data = JSON.stringify(correctionTable.toJSON(), null, 2);
      fs.writeFileSync(filePath, data);
    } catch (err) {
      app.error(`Error saving correction table: ${err.message}`);
    }
  }

  function saveMigratedTable(correctionTable, filePath) {
    const temporaryPath = `${filePath}.migration-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(correctionTable.toJSON(), null, 2));
      fs.renameSync(temporaryPath, filePath);
      app.debug(`Correction table migrated to schema v2: ${filePath}`);
    } catch (err) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      app.debug(`Correction table migration could not be persisted for ${filePath}: ${err.message}`);
    }
  }

  /**
   * Returns true if every cell in the table has N === 0 (no learned data).
   * Used to guard against overwriting a good on-disk file with an empty table.
   */
  function isTableEmpty(correctionTable) {
    return correctionTable.table.every(row => row.every(cell => cell.N === 0));
  }

  /**
   * Drains changedOptions into options and hot-applies each change where possible.
   * Flag changes take effect immediately since onChange reads from options.* directly.
   */
  function applyOptionChanges() {
    const changedKeys = Object.keys(changedOptions);
    for (const key of changedKeys) {
      const value = changedOptions[key];
      options[key] = value;

      if (key === 'updateCorrectionTable') {
        if (!value && table && !isTableEmpty(table)) {
          // Learning switched off — persist current state before periodic saves stop
          saveTableSync(table, path.join(app.getDataDirPath(), table.id + '.json'));
          app.debug('Correction table saved: learning switched off');
        } else if (value && table && isTableEmpty(table)) {
          // Learning switched on and in-memory table is empty — reload from disk
          // to recover from a failed load at startup
          const filePath = path.join(app.getDataDirPath(), table.id + '.json');
          const fileData = Table2D.readFromFile(filePath);
          if (fileData) {
            const reloaded = CorrectionTable.fromJSON(fileData, correctionDriftRateToProcessNoiseRate(options.correctionDriftRate));
            reloaded.setDisplayAttributes({ label: reloaded.id });
            if (!isTableEmpty(reloaded)) {
              swapTable(reloaded);
              app.debug('Correction table reloaded from disk: learning switched on (was empty in memory)');
            }
          }
        }
      }
      // All other keys (sogFallback, estimateBoatSpeed, correctionDriftRate,
      // and smootherTimeSpan) are read
      // directly from options.* so no extra action needed.
      if (key === 'estimateBoatSpeed' && !value && correctedBoatSpeed) {
        Polar.clear(app, plugin.id, [correctedBoatSpeed]);
        PolarSmoother.clear(app, plugin.id, [smoothedCurrent]);
      }

      delete changedOptions[key];
    }

    if (changedKeys.includes('correctionDriftRate') && table) {
      table.setProcessNoiseRate(correctionDriftRateToProcessNoiseRate(options.correctionDriftRate));
    }

    // Hot-apply the learning window to all user-tuned smoothers.
    if (changedKeys.includes('smootherTimeSpan')) {
      options.smootherTimeSpan = getSmoothingWindowSeconds(options);
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

module.exports._test = {
  normalizeNavigationState,
  getShortStabilizingMs,
  getSmoothingWindowSeconds,
  getLearningIntervalMs,
  correctionDriftRateToProcessNoiseRate,
  legacyStabilityToCorrectionDriftRate,
  migrateCorrectionTableData,
  isVesselMoving,
  evaluateLearningMode,
  isCogOverrideActive,
  isLeewayValid,
  evaluateObservationGate,
  getDerivedObservationStatus,
  buildNavigationStateStatus,
  NOT_MOVING_NAVIGATION_STATES,
  LONG_STABILIZING_MS,
};
