const { createSmoothedHandler } = require('signalkutilities');

class AttitudeInput {
  constructor({ app, pluginId, SmootherClass, smootherOptions, onDelta, onIdle, onStale }) {
    this.app = app;
    this.pluginId = pluginId;
    this.onDelta = onDelta;
    this.onIdle = onIdle;
    this.onStale = onStale;
    this.enabled = false;
    this.idle = false;
    this.source = null;
    this.legacyRollTime = null;
    this.configuring = false;
    const settings = { app, pluginId, SmootherClass, smootherOptions, subscribe: false };
    this.legacy = createSmoothedHandler({
      ...settings, id: 'attitude', path: 'navigation.attitude',
      onDelta: () => {
        const incoming = this.legacy.handler.value;
        if (incoming === null || incoming?.roll === null) this.legacyRollTime = null;
        else if (Number.isFinite(incoming?.roll)) this.legacyRollTime = Date.now();
        this._updated(Number.isFinite(incoming?.roll) ? this.legacy : null);
      },
      onIdle: () => { if (!this.ready) this.onIdle?.(); },
      onStale: () => this._unavailable()
    });
    this.primary = createSmoothedHandler({
      ...settings, id: 'attitude.roll', path: 'navigation.attitude.roll',
      onDelta: () => {
        if (this.primary.ready && Number.isFinite(this.primary.value)) this.idle = false;
        this._updated(this.primary);
        this._syncLegacy();
      },
      onIdle: () => {
        this.idle = true;
        this._syncLegacy();
        this._updated();
        if (!this.ready) this.onIdle?.();
      },
      onStale: () => this._unavailable()
    });
    this.primary.handler.onStale = () => {
      this.primary.invalidate();
      this._unavailable();
    };
    // Keep the existing object-shaped raw report and correction input without
    // exposing the underlying subscription as a second independently owned input.
    const input = this;
    this.raw = {
      id: 'attitude',
      get path() { return input.path; },
      get value() { return input._value(true); },
      get ready() { return !!input._selected(); },
      get stale() { return input.stale; },
      get meta() { return input._meta(true); },
      get state() { return input._state(true); },
      report() { return input._report(true); }
    };
  }

  _selected() {
    if (!this.enabled) return null;
    if (this.primary.handler.ready && Number.isFinite(this.primary.handler.value)) return this.primary;
    if (this.idle && this.legacy.handler.ready &&
        this.legacyRollTime !== null &&
        Date.now() - this.legacyRollTime < this.legacy.handler.stalePeriod &&
        Number.isFinite(this.legacy.handler.value?.roll)) return this.legacy;
    return null;
  }

  _updated(input = null) {
    if (this.configuring) return;
    const selected = this._selected();
    const path = selected?.handler.path ?? null;
    const changed = path !== this.source;
    if (changed) {
      this.source = path;
      const source = selected === this.legacy ? `legacy object ${path}`
        : path ? `individual path ${path}` : 'unavailable (waiting for fresh data)';
      this.app.debug(`[${this.pluginId}] attitude roll source: ${source}`);
    }
    if (changed || (input && input === selected)) this.onDelta?.();
  }

  _unavailable() {
    this._updated();
    if (!this.ready) this.onStale?.();
  }

  _syncLegacy() {
    if (this.enabled && this.idle) {
      if (!this.legacy.subscribed) {
        this.legacyRollTime = null;
        this.legacy.subscribe();
      }
    } else if (this.legacy.subscribed) {
      this.legacy.unsubscribe();
      this.legacyRollTime = null;
    }
  }

  _value(raw = false) {
    const selected = this._selected();
    if (!selected || (!raw && !selected.ready)) return {};
    const value = raw ? selected.handler.value : selected.value;
    const roll = selected === this.legacy ? value?.roll : value;
    return Number.isFinite(roll) ? { roll } : {};
  }

  _meta(raw = false) {
    const handler = raw ? this.primary.handler : this.primary;
    return { ...handler.meta, id: raw ? 'attitude' : this.id, path: this.path };
  }

  _state(raw = false) {
    const selected = this._selected();
    const handler = selected ?? this.primary;
    return {
      ...(raw ? handler.handler.state : handler.state),
      id: raw ? 'attitude' : this.id,
      subscribed: this.enabled,
      ready: Number.isFinite(this._value(raw).roll),
      isStale: this.stale,
      selectedPath: selected?.handler.path ?? null,
      legacyFallback: selected === this.legacy,
      idle: this.idle
    };
  }

  _report(raw = false) {
    const selected = this._selected();
    const variance = raw ? selected?.handler.variance : selected?.variance;
    return {
      id: raw ? 'attitude' : this.id, path: this.path,
      value: this._value(raw),
      variance: selected === this.legacy ? { roll: variance?.roll } : { roll: variance },
      state: this._state(raw)
    };
  }

  get id() { return 'attitude.smoothed'; }
  get path() { return 'navigation.attitude.roll'; }
  get value() { return this._value(); }
  get ready() { return Number.isFinite(this.value.roll); }
  get stale() { return this.enabled && !this.ready && this.primary.handler.stale; }
  get meta() { return this._meta(); }
  get state() { return this._state(); }
  report() { return this._report(); }

  subscribe() {
    if (this.enabled) return;
    this.enabled = true;
    this.idle = false;
    this.source = null;
    this.app.debug(`[${this.pluginId}] attitude input enabled: preferring individual path navigation.attitude.roll; waiting for fresh data`);
    this.primary.subscribe();
  }

  configureSmoother(SmootherClass, smootherOptions) {
    this.configuring = true;
    try {
      for (const handler of [this.primary, this.legacy]) {
        handler.setSmootherOptions(smootherOptions);
        handler.setSmootherClass(SmootherClass);
        handler.invalidate();
        if (handler.subscribed && handler.handler.ready) handler.sample();
      }
    } finally {
      this.configuring = false;
    }
  }

  terminate() {
    this.enabled = false;
    this.primary.terminate();
    this.legacy.terminate();
    return null;
  }
}

module.exports = { AttitudeInput };
