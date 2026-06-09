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
      assert.strictEqual(response.isRunning, false, 'plugin should not be running before start()');
    } finally {
      cleanup();
    }
  });
});

describe('plugin lifecycle', () => {
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
