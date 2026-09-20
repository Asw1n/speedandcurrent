'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// App shim helpers
// ---------------------------------------------------------------------------

/**
 * Minimal BaconJS-style reactive-stream bus mock.
 * Every chaining method returns `this`; onValue returns an unsubscribe no-op.
 * This satisfies the internal stream API used by signalkutilities.
 */
function createMockBus() {
  const bus = {};
  const chainMethods = [
    'onError', 'onEnd', 'skipDuplicates', 'map', 'filter', 'take', 'first',
    'toPromise', 'flatMap', 'flatMapLatest', 'merge', 'debounce',
    'debounceImmediate', 'throttle', 'delay', 'bufferWithTime', 'bufferWithCount',
    'combine', 'sampledBy', 'scan', 'fold', 'zip', 'awaiting', 'not', 'log',
    'doAction', 'doLog', 'doError', 'doEnd', 'withHandler', 'name',
    'withDescription', 'skip', 'slidingWindow', 'startWith', 'mapEnd',
    'skipWhile', 'takeWhile', 'takeUntil', 'errors', 'mapError', 'subscribe',
  ];
  for (const m of chainMethods) bus[m] = () => bus;
  bus.onValue = (_cb) => () => {};
  bus.push = () => {};
  bus.plug = () => () => {};
  bus.end = () => {};
  return bus;
}

/**
 * Create a minimal SignalK app shim that satisfies the speedandcurrent plugin.
 * A Proxy is used so that any method not explicitly stubbed returns a no-op
 * instead of throwing a TypeError.
 *
 * @returns {{ app: object, cleanup: () => void }}
 */
function createAppShim() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedandcurrent-test-'));
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(tmpDir, 'SpeedAndCurrent.json');

  const base = {
    // Logging
    debug: () => {},
    error: () => {},

    // Plugin status
    setPluginStatus: () => {},
    setPluginError: () => {},

    // Delta output
    handleMessage: () => {},

    // Data access
    getSelfPath: () => undefined,
    getPath: () => undefined,
    getMetadata: () => undefined,
    putSelfPath: (_p, _v, cb) => { if (cb) cb({ state: 'COMPLETED' }); },
    putPath: (_p, _v, cb) => { if (cb) cb({ state: 'COMPLETED' }); },

    // Plugin config persistence
    readPluginOptions: () => {
      try { return JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch { return {}; }
    },
    savePluginOptions: (config, cb) => {
      fs.writeFileSync(configFile, JSON.stringify(config));
      if (cb) cb();
    },
    getPluginOptions: () => ({}),
    getDataDirPath: () => dataDir,

    // Subscription infrastructure
    registerDeltaInputHandler: () => () => {},
    registerPutHandler: () => () => {},

    streambundle: {
      getSelfBus: () => createMockBus(),
      getBus: () => createMockBus(),
      getSelfStream: () => createMockBus(),
      getAvailablePaths: () => [],
    },

    subscriptionmanager: {
      subscribe: (_msg, unsubscribes, _errorCb, _deltaCb) => {
        const unsub = () => {};
        if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
      },
    },

    // Event emitter API
    on: () => {},
    once: () => {},
    emit: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},

    // Server identity
    selfId: 'urn:mrn:signalk:uuid:00000000-0000-0000-0000-000000000000',
    selfType: 'vessels',
    selfContext: 'vessels.urn:mrn:signalk:uuid:00000000-0000-0000-0000-000000000000',

    config: {
      configPath: tmpDir,
      appPath: tmpDir,
      version: '2.24.0',
      name: 'signalk-server',
      basePath: '/signalk/v1',
      defaults: {},
    },

    reportOutputMessages: () => {},

    wrappedEmitter: {
      bindMethodsById: () => ({ on: () => {}, removeListener: () => {} }),
    },
  };

  // Proxy: any property not found in base returns a no-op function so unstubbed
  // accesses from signalkutilities don't throw.
  const app = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
  });

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { app, cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('module export', () => {
  it('exports a factory function', () => {
    const factory = require('../index.js');
    assert.strictEqual(typeof factory, 'function', 'module.exports must be a function');
  });
});

describe('plugin object shape', () => {
  let plugin;
  let cleanup;

  before(() => {
    const shim = createAppShim();
    cleanup = shim.cleanup;
    plugin = require('../index.js')(shim.app);
  });

  after(() => cleanup());

  it('has a non-empty string id', () => {
    assert.strictEqual(typeof plugin.id, 'string');
    assert.ok(plugin.id.length > 0, 'plugin.id must not be empty');
  });

  it('has a non-empty string name', () => {
    assert.strictEqual(typeof plugin.name, 'string');
    assert.ok(plugin.name.length > 0, 'plugin.name must not be empty');
  });

  it('has a string description', () => {
    assert.strictEqual(typeof plugin.description, 'string');
  });

  it('exposes a valid JSON Schema object', () => {
    assert.strictEqual(typeof plugin.schema, 'object', 'plugin.schema must be an object');
    assert.ok(plugin.schema !== null);
    assert.strictEqual(plugin.schema.type, 'object', 'schema.type must be "object"');
    assert.strictEqual(typeof plugin.schema.properties, 'object', 'schema.properties must be an object');
  });

  it('has start and stop functions', () => {
    assert.strictEqual(typeof plugin.start, 'function', 'plugin.start must be a function');
    assert.strictEqual(typeof plugin.stop, 'function', 'plugin.stop must be a function');
  });

  it('has a registerWithRouter function', () => {
    assert.strictEqual(typeof plugin.registerWithRouter, 'function', 'plugin.registerWithRouter must be a function');
  });
});

describe('registerWithRouter', () => {
  it('registers the expected routes', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const registered = [];
      const mockRouter = {
        get:  (p) => registered.push(`GET ${p}`),
        put:  (p) => registered.push(`PUT ${p}`),
        post: (p) => registered.push(`POST ${p}`),
      };
      plugin.registerWithRouter(mockRouter);

      assert.ok(registered.includes('GET /api/report'),          'missing GET /api/report');
      assert.ok(registered.includes('GET /api/meta'),            'missing GET /api/meta');
      assert.ok(registered.includes('GET /api/status'),          'missing GET /api/status');
      assert.ok(registered.includes('GET /api/settings'),        'missing GET /api/settings');
      assert.ok(registered.includes('PUT /api/settings'),        'missing PUT /api/settings');
      assert.ok(registered.includes('GET /api/tables'),          'missing GET /api/tables');
      assert.ok(registered.includes('POST /api/tables/create'),  'missing POST /api/tables/create');
      assert.ok(registered.includes('POST /api/tables/load'),    'missing POST /api/tables/load');
      assert.ok(registered.includes('POST /api/tables/copy'),    'missing POST /api/tables/copy');
      assert.ok(registered.includes('POST /api/tables/resize'),  'missing POST /api/tables/resize');
    } finally {
      cleanup();
    }
  });

  it('GET /api/settings returns options with expected default keys', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);

      let response = null;
      routes['GET /api/settings']({}, { json: (d) => { response = d; } });

      assert.ok(response !== null, 'GET /api/settings returned no response');
      assert.ok('estimateBoatSpeed'     in response, 'missing estimateBoatSpeed');
      assert.ok('updateCorrectionTable' in response, 'missing updateCorrectionTable');
      assert.ok('suspendLearningOnNavigationState' in response, 'missing suspendLearningOnNavigationState');
      assert.ok(!('minSogForLearning' in response), 'obsolete minSogForLearning should not be exposed');
      assert.ok('smootherClass'         in response, 'missing smootherClass');
      assert.ok('stability'             in response, 'missing stability');
    } finally {
      cleanup();
    }
  });

  it('PUT /api/settings rejects blocked key "tableName" with 400', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);

      let statusCode = null;
      let response = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (d) => { response = d; },
      };
      routes['PUT /api/settings']({ body: { tableName: 'hack' } }, res);

      assert.strictEqual(statusCode, 400, 'should respond 400 for blocked key "tableName"');
      assert.ok(response && typeof response.error === 'string', 'should return an error message');
    } finally {
      cleanup();
    }
  });

  it('PUT /api/settings rejects blocked key "correctionTable" with 400', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);

      let statusCode = null;
      let response = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (d) => { response = d; },
      };
      routes['PUT /api/settings']({ body: { correctionTable: {} } }, res);

      assert.strictEqual(statusCode, 400, 'should respond 400 for blocked key "correctionTable"');
      assert.ok(response && typeof response.error === 'string', 'should return an error message');
    } finally {
      cleanup();
    }
  });

  it('PUT /api/settings accepts valid settings and reflects them back', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);

      let response = null;
      const res = { json: (d) => { response = d; } };
      routes['PUT /api/settings']({ body: { estimateBoatSpeed: true } }, res);

      assert.ok(response !== null, 'PUT /api/settings returned no response');
      assert.strictEqual(response.estimateBoatSpeed, true, 'response should reflect the updated value');
    } finally {
      cleanup();
    }
  });

  it('POST /api/tables/load keeps the active table when the requested table is malformed', () => {
    const { app, cleanup } = createAppShim();
    let plugin;
    try {
      app.savePluginOptions({ tableName: 'correctionTable' });
      plugin = require('../index.js')(app);
      plugin.start();
      fs.writeFileSync(
        path.join(app.getDataDirPath(), 'broken.json'),
        JSON.stringify({ row: {}, col: {}, table: [null] })
      );

      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);

      let statusCode = null;
      let response = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { response = data; },
      };
      routes['POST /api/tables/load']({ body: { name: 'broken' } }, res);

      assert.strictEqual(statusCode, 422);
      assert.match(response.error, /load rejected/);
      assert.strictEqual(app.readPluginOptions().tableName, 'correctionTable');
    } finally {
      if (plugin) plugin.stop();
      cleanup();
    }
  });

  it('GET /api/status returns isRunning and status fields', () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);

      let response = null;
      routes['GET /api/status']({}, { json: (d) => { response = d; } });

      assert.ok(response !== null, 'GET /api/status returned no response');
      assert.ok('isRunning' in response, 'missing isRunning field');
      assert.ok('status'    in response, 'missing status field');
      assert.ok('learningState' in response, 'missing learningState field');
      assert.strictEqual(response.isRunning, false, 'plugin should not be running before start()');
    } finally {
      cleanup();
    }
  });
});

describe('learning gate helpers', () => {
  const pluginFactory = require('../index.js');
  const helpers = pluginFactory._test;

  it('suspends learning when the vessel is not moving', () => {
    const result = helpers.evaluateLearningMode({
      options: { updateCorrectionTable: true },
      vesselMoving: false,
      stabilizingUntil: 0,
      now: 10,
    });

    assert.strictEqual(result.state, 'suspended');
    assert.strictEqual(result.reason, 'not_moving');
  });

  it('keeps learning active when the vessel is moving', () => {
    const result = helpers.evaluateLearningMode({
      options: { updateCorrectionTable: true },
      vesselMoving: true,
      stabilizingUntil: 0,
      now: 10,
    });

    assert.strictEqual(result.state, 'active');
  });

  it('marks missing inputs as invalid', () => {
    const learningMode = { state: 'active' };
    const result = helpers.evaluateObservationGate({
      learningMode,
      inputsReady: false,
      assumeCurrent: false,
      currentReady: true,
      stw: 3,
      sog: 3,
      speedThreshold: 1,
    });

    assert.deepStrictEqual(result, { state: 'invalid', reason: 'missing_input' });
  });

  it('skips observations below the speed-step SOG threshold', () => {
    const learningMode = { state: 'active' };
    const result = helpers.evaluateObservationGate({
      learningMode,
      inputsReady: true,
      assumeCurrent: false,
      currentReady: true,
      stw: 3,
      speedThreshold: 1,
      sog: 0.2,
    });

    assert.deepStrictEqual(result, { state: 'skipped', reason: 'sog_below_threshold' });
  });

  it('returns pending when an observation may proceed to estimator update', () => {
    const learningMode = { state: 'active' };
    const result = helpers.evaluateObservationGate({
      learningMode,
      inputsReady: true,
      assumeCurrent: true,
      currentReady: true,
      stw: 3,
      speedThreshold: 1,
      sog: 3,
      speedThreshold: 1,
    });

    assert.deepStrictEqual(result, { state: 'pending', reason: null });
  });

  it('detects COG override when COG is absent and SOG is below the speed threshold', () => {
    const result = helpers.isCogOverrideActive({
      ready: false,
      magnitudeHandler: { ready: true, value: 0.4 }
    }, 0.5);

    assert.strictEqual(result, true);
  });

  it('derives skipped observation when learning is off', () => {
    const result = helpers.getDerivedObservationStatus({ state: 'off' }, 'accepted', 'accepted');

    assert.deepStrictEqual(result, { state: 'skipped', reason: 'learning_off' });
  });
});

describe('vessel-moving gate', () => {
  const helpers = require('../index.js')._test;
  const known = (value) => ({ state: { pathKnown: true, hasDelta: true }, value });
  const unknown = { state: { pathKnown: false, hasDelta: false }, value: null };

  it('is moving when SOG is at or above the speed-step threshold and gate is disabled', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 0.5, speedThreshold: 0.5, navigationStateHandler: null, gateEnabled: false }), true);
  });

  it('is not moving when SOG is below the speed-step threshold', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 0.04, speedThreshold: 0.5, navigationStateHandler: null, gateEnabled: false }), false);
  });

  it('is not moving for non-finite SOG', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: NaN, speedThreshold: 0.5, navigationStateHandler: null, gateEnabled: true }), false);
  });

  it('navigation.state overrides to not-moving when known and the gate is enabled', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 2, speedThreshold: 0.5, navigationStateHandler: known('anchored'), gateEnabled: true }), false);
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 2, speedThreshold: 0.5, navigationStateHandler: known('Moored'), gateEnabled: true }), false);
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 2, speedThreshold: 0.5, navigationStateHandler: known('motoring'), gateEnabled: true }), false);
  });

  it('navigation.state does not override when the gate is disabled', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 2, speedThreshold: 0.5, navigationStateHandler: known('anchored'), gateEnabled: false }), true);
  });

  it('navigation.state cannot force "moving" when SOG says otherwise', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 0.1, speedThreshold: 0.5, navigationStateHandler: known('sailing'), gateEnabled: true }), false);
  });

  it('falls back to SOG when navigation.state is unknown, even with the gate enabled', () => {
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 2, speedThreshold: 0.5, navigationStateHandler: unknown, gateEnabled: true }), true);
    assert.strictEqual(helpers.isVesselMoving({ sogMagnitude: 2, speedThreshold: 0.5, navigationStateHandler: null, gateEnabled: true }), true);
  });
});

describe('leeway gate', () => {
  const helpers = require('../index.js')._test;

  it('suppresses leeway below the speed-step threshold', () => {
    assert.strictEqual(helpers.isLeewayValid(0.04, 0.5, true), false);
  });

  it('allows leeway at or above the speed-step threshold when the vessel is moving', () => {
    assert.strictEqual(helpers.isLeewayValid(0.5, 0.5, true), true);
  });

  it('suppresses leeway when the vessel is not moving even above the speed threshold', () => {
    assert.strictEqual(helpers.isLeewayValid(2, 0.5, false), false);
  });

  it('suppresses leeway for non-finite speed', () => {
    assert.strictEqual(helpers.isLeewayValid(NaN, 0.5, true), false);
  });
});

describe('attitude guard clauses (missing spec sub-property)', () => {
  /**
   * App shim variant that tracks per-path subscribers so tests can push deltas,
   * mirroring the pattern used in advancedWind's test suite.
   */
  function createDeliveringShim(pluginOptions = {}) {
    const { app: base, cleanup } = createAppShim();
    const subscribers = new Map();

    const app = new Proxy(base, {
      get(target, prop) {
        if (prop === 'subscriptionmanager') {
          return {
            subscribe(msg, unsubscribes, _err, deltaCb) {
              for (const s of (msg.subscribe || [])) {
                if (!subscribers.has(s.path)) subscribers.set(s.path, new Set());
                subscribers.get(s.path).add(deltaCb);
              }
              const unsub = () => {
                for (const s of (msg.subscribe || [])) subscribers.get(s.path)?.delete(deltaCb);
              };
              if (Array.isArray(unsubscribes)) unsubscribes.push(unsub);
            },
          };
        }
        if (prop === 'readPluginOptions') return () => ({ configuration: pluginOptions });
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return () => {};
      },
    });

    return { app, cleanup, subscribers };
  }

  function deliverDelta(subscribers, values, source = 'test') {
    const delta = { updates: [{ $source: source, values }] };
    for (const entry of values) {
      const cbs = subscribers.get(entry.path);
      if (cbs) for (const cb of [...cbs]) cb(delta);
    }
  }

  it('skips speed correction and rejects the learning observation when attitude.roll was never sampled', () => {
    const { app, cleanup, subscribers } = createDeliveringShim({
      estimateBoatSpeed: true,
      updateCorrectionTable: true,
    });
    let plugin;
    // The plugin opens a 60s startup stabilization window on start(). Shift Date.now()
    // forward (after start() computes it) so updateTable() sees learning as active,
    // without actually waiting 60s of real time.
    const realDateNow = Date.now.bind(Date);
    let shiftMs = 0;
    Date.now = () => realDateNow() + shiftMs;
    try {
      plugin = require('../index.js')(app);
      plugin.start();
      shiftMs = 61_000;

      const routes = {};
      plugin.registerWithRouter({
        get: (p, h) => { routes[`GET ${p}`] = h; },
        put: (p, h) => { routes[`PUT ${p}`] = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      });

      // Attitude delta never includes roll — pitch/yaw arrive, roll never does.
      deliverDelta(subscribers, [{ path: 'navigation.attitude', value: { pitch: 0.01, yaw: 0.02 } }]);
      deliverDelta(subscribers, [{ path: 'navigation.headingTrue', value: 1.0 }]);
      deliverDelta(subscribers, [{ path: 'navigation.speedOverGround', value: 3.0 }]);
      deliverDelta(subscribers, [{ path: 'navigation.courseOverGroundTrue', value: 1.0 }]);
      deliverDelta(subscribers, [{ path: 'navigation.speedThroughWater', value: 3.0 }]);

      // The rejected observation opens its own short (default 5s) stabilizing cooldown,
      // which would otherwise mask the display as 'skipped'/'stabilizing'. Shift past it too.
      shiftMs += 6_000;

      let statusResponse = null;
      routes['GET /api/status']({}, { json: (d) => { statusResponse = d; } });

      assert.ok(statusResponse, 'expected a /api/status response');
      const rollWarning = statusResponse.lifecycleWarnings.find(w => w.id === 'attitude.roll');
      assert.ok(rollWarning, 'expected a lifecycle warning for missing attitude.roll');

      assert.strictEqual(statusResponse.learningState.observationState, 'rejected');
      assert.strictEqual(statusResponse.learningState.observationReason, 'missing_input');
    } finally {
      Date.now = realDateNow;
      if (plugin) plugin.stop?.();
      cleanup();
    }
  });
});

describe('plugin lifecycle', () => {
  it('does not publish current when estimation is disabled', () => {
    const { app, cleanup } = createAppShim();
    const messages = [];
    app.handleMessage = (...args) => messages.push(args);
    let plugin;
    try {
      plugin = require('../index.js')(app);
      plugin.start();

      const currentValues = messages.flatMap(([, message]) =>
        (message?.updates || []).flatMap(update => update.values || [])
      ).filter(({ path }) => path === 'environment.current.drift' || path === 'environment.current.setTrue');

      assert.deepStrictEqual(currentValues, [], 'disabled estimation must not publish current');
    } finally {
      if (plugin) plugin.stop();
      cleanup();
    }
  });

  it('start() completes without throwing', () => {
    const { app, cleanup } = createAppShim();
    let plugin;
    try {
      plugin = require('../index.js')(app);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must not throw');
    } finally {
      if (plugin) plugin.stop();
      cleanup();
    }
  });

  it('recovers from a malformed table with a date-named default table', () => {
    const { app, cleanup } = createAppShim();
    let plugin;
    try {
      app.savePluginOptions({ tableName: 'broken' });
      fs.writeFileSync(
        path.join(app.getDataDirPath(), 'broken.json'),
        JSON.stringify({ row: {}, col: {}, table: [null] })
      );

      plugin = require('../index.js')(app);
      assert.doesNotThrow(() => plugin.start(), 'plugin.start() must recover from malformed table data');

      const recoveryName = `correctionTable-${new Date().toISOString().slice(0, 10)}`;
      const recoveryPath = path.join(app.getDataDirPath(), recoveryName + '.json');
      const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
      const savedOptions = app.readPluginOptions();
      const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should be close to ${expected}`);

      assert.strictEqual(savedOptions.tableName, recoveryName, 'recovery table must become active');
      assert.strictEqual(recovery.id, recoveryName);
      closeTo(recovery.row.max, 10 * 0.5144456333854638);
      closeTo(recovery.row.step, 0.5144456333854638);
      closeTo(recovery.col.min, -24 * Math.PI / 180);
      closeTo(recovery.col.max, 24 * Math.PI / 180);
      closeTo(recovery.col.step, 6 * Math.PI / 180);
      assert.strictEqual(recovery.table.length, 11);
      assert.strictEqual(recovery.table[0].length, 9);
      assert.ok(recovery.table.flat().every(cell => cell.state === null), 'recovery table must be empty');
    } finally {
      if (plugin) plugin.stop();
      cleanup();
    }
  });

  it('stop() resolves cleanly after start()', async () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      plugin.start();
      await assert.doesNotReject(
        () => plugin.stop(),
        'plugin.stop() must resolve without rejection'
      );
    } finally {
      cleanup();
    }
  });

  it('can be restarted (start → stop → start → stop)', async () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      plugin.start();
      await plugin.stop();
      assert.doesNotThrow(() => plugin.start(), 'second start() must not throw');
      await assert.doesNotReject(() => plugin.stop(), 'second stop() must resolve');
    } finally {
      cleanup();
    }
  });

  it('survives a cached speed value replayed synchronously during start and restart', async () => {
    const { app: base, cleanup } = createAppShim();
    const cachedValue = 3;
    const app = new Proxy(base, {
      get(target, prop) {
        if (prop === 'subscriptionmanager') {
          return {
            subscribe(msg, unsubscribes, _errorCb, deltaCb) {
              if (Array.isArray(unsubscribes)) unsubscribes.push(() => {});
              for (const entry of msg.subscribe || []) {
                if (entry.path === 'navigation.speedThroughWater') {
                  deltaCb({
                    context: 'vessels.self',
                    updates: [{ values: [{ path: entry.path, value: cachedValue }] }],
                  });
                }
              }
            },
          };
        }
        return target[prop];
      },
    });

    try {
      const plugin = require('../index.js')(app);
      assert.doesNotThrow(() => plugin.start(), 'first start() must not throw');
      await plugin.stop();
      assert.doesNotThrow(() => plugin.start(), 'second start() must not throw');
      await assert.doesNotReject(() => plugin.stop(), 'second stop() must resolve');
    } finally {
      cleanup();
    }
  });

  it('GET /api/status reports isRunning=true after start()', async () => {
    const { app, cleanup } = createAppShim();
    try {
      const plugin = require('../index.js')(app);
      const routes = {};
      const mockRouter = {
        get:  (p, h) => { routes[`GET ${p}`]  = h; },
        put:  (p, h) => { routes[`PUT ${p}`]  = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
      };
      plugin.registerWithRouter(mockRouter);
      plugin.start();

      let response = null;
      routes['GET /api/status']({}, { json: (d) => { response = d; } });
      assert.strictEqual(response.isRunning, true, 'plugin should be running after start()');

      await plugin.stop();
    } finally {
      cleanup();
    }
  });
});
