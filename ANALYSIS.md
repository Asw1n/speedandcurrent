# SpeedAndCurrent Plugin — Pre-Overhaul Codebase Analysis

_Date: March 2026 — for use as context in separate focused chat sessions._

---

## 1. Repository Overview

| File | Role |
|------|------|
| `index.js` | Signal K plugin factory: schema, `start`, `stop`, HTTP routes |
| `correctionTable.js` | `CorrectionTable` (extends `Table2D`) + `CorrectionEstimator` (Kalman per-cell) |
| `leakyExtremes.js` | Standalone leaky-min/max utility — **not integrated yet** |
| `public/app.js` | WebApp polling `/getResults`, renders table + diagnostics |
| `public/vectors.js` | SVG vector visualisation, polls `/getVectors` |
| `public/TableRenderer.js` | DOM table renderer (heatmap, surface plot) |
| `public/index.html` | Entry point — no bundler, ES module `<script type="module">` |

External dependencies:
- **`signalkutilities`** — provides all base classes (`MessageHandler`, `MessageSmoother`, `Polar`, `PolarSmoother`, `Smoother*`, `Table2D`, `Reporter`, and the domain `Smoothed*` convenience classes).
  - Source: `C:\Develop\singalKutilities` (npm-linked; note folder name typo). Version **1.7.0**.
  - **API was updated in March 2026** — constructor signatures for `MessageHandler` and `Polar` changed (see §§ 3.1, 4.1). `index.js` has been migrated.
- **`kalman-filter`** — low-level Kalman state used inside `CorrectionEstimator`.

---

## 2. Settings — Current State and Problems

### 2.1 Current schema (flat, 17 properties, all in one JSON Schema block)

```
sogFallback           boolean   Allow SOG fallback
startWithNewTable     boolean   Reset table on next start
estimateBoatSpeed     boolean   Enable correction + output
updateCorrectionTable boolean   Enable learning
stability             number    Kalman process noise exponent (1–20)
assumeCurrent         boolean   Include current in table update observation
heelStep / maxHeel    number    Table column axis (degrees, user-facing)
speedStep / maxSpeed  number    Table row axis (knots, user-facing)
headingSource         string    Optional SK source filter
boatSpeedSource       string    Optional SK source filter
COGSource             string    Optional SK source filter (COG)
SOGSource             string    Optional SK source filter
attitudeSource        string    Optional SK source filter
preventDuplication    boolean   Suppress raw STW pass-through
correctionTable       object    ** Embedded serialized table (INTERNAL) **
```

### 2.2 Key problems

1. **Internal state mixed with user-facing settings.** `correctionTable` (the entire serialized Kalman table) lives inside `plugin.options` alongside human-editable knobs. The Signal K settings UI will display it. It is large (can be hundreds of kB).

2. **`startWithNewTable` is mutated during startup.** `loadTable()` sets `options.startWithNewTable = false` and calls `saveTable()` — a settings flag that controls behavior is cleared by the plugin itself. This is fragile.

3. **Unit mismatch between schema and runtime.** `maxSpeed`/`speedStep` are in **knots** in the schema; `maxHeel`/`heelStep` are in **degrees**. Internally everything is SI (m/s, radians). The conversion (`SI.fromKnots`, `SI.fromDegrees`) happens inside `loadTable()` — there is no dedicated conversion layer.

4. **No validation layer.** Values from settings go straight into arithmetic. `Number.isFinite` guards exist in hot-path functions but not on settings ingestion.

5. **Source selectors default to `" "` (a space) string** rather than `null` / `undefined`. The `MessageHandler` constructor strips whitespace (`source.replace(/\s+/g, "")`), so this becomes `""` — falsy — which happens to work but is unclear intent.

6. **`uiSchema['ui:order']` array must be kept manually in sync** with schema properties. No mechanism prevents ordering a property that doesn't exist or forgetting a new one.

7. **No grouping.** All 17 properties appear flat. A real settings overhaul would group: _Behavior flags_, _Sensor sources_, _Table shape_, _Advanced_.

### 2.3 What the overhaul should target

- Separate table persistence from user settings (e.g., store table in a side-file or via `app.savePluginOptions` with a dedicated key not surfaced in the UI).
- Create a `Settings` adapter class that validates and converts units on ingestion.
- Replace the `startWithNewTable` self-mutation pattern.
- Add schema `"ui:groups"` or use sections once Signal K admin UI supports it.

---

## 3. `MessageHandler` and `MessageSmoother` — How They Work

### 3.1 `MessageHandler` (`signalkutilities/src/signalk/MessageHandler.js`)

The fundamental subscription primitive.

```
MessageHandler(app, pluginId, id)       ← NEW: app+pluginId moved to constructor
  .id           string
  .path         SK path string (set via configure())
  .source       optional source filter
  .value        last received value (null until first message)
  .stale        boolean — set true when idlePeriod (4 s) elapses with no update
  .frequency    exponential moving average of update Hz
  .onChange     callback invoked on every new value
  .configure(path, source, passOn?, onChange?)  ← NEW: sets path/source; hot-resubscribes if already subscribed
  .subscribe()                          ← NEW: no arguments; uses path/source from configure()
  .terminate(clearCallback?)            ← CHANGED: no app argument; clearCallback=true by default
  static .send(app, pluginId, [{path, value}, …])
  static .sendMeta(app, pluginId, [{path, meta}, …])
  static .setMeta(app, pluginId, path, meta)   ← convenience single-path
```

> **Migration note:** Old signature was `new MessageHandler(id, path, source)` + `subscribe(app, pluginId, passOn, onIdle)`. The new design passes `app`/`pluginId` at construction and defers `path`/`source` to `configure()`, enabling hot source changes later.

### 3.2 `MessageSmoother` — the **decorator** for scalar/object handlers

`MessageSmoother(id, handler, SmootherClass, smootherOptions)` wraps a `MessageHandler`.  
Pattern: the raw handler calls `handler.onChange = () => smoother.sample()`.

```
MessageSmoother
  .handler       the wrapped MessageHandler
  .value         smoothed value (delegates to smoother)
  .variance      smoothed variance
  .stale         delegates to handler.stale
  .sample()      feeds handler.value into smoother, fires smoother.onChange
  .terminate()   delegates to handler.terminate()
  .report()      {id, value, variance, path, source, displayAttributes}
```

### 3.3 Smoother classes (strategy objects passed to decorators)

| Class | Description | Key options |
|-------|-------------|-------------|
| `BaseSmoother` | Pass-through (no smoothing) | — |
| `MovingAverageSmoother` | Time-windowed moving average | `timeSpan` (seconds) |
| `ExponentialSmoother` | Exponential moving average | `tau` / `timeConstant` (seconds) |
| `KalmanSmoother` | 1-D Kalman filter | `processVariance`, `measurementVariance` |

All share the same interface: `smoother.add(value, variance?)`, `smoother.estimate`, `smoother.variance`.

### 3.4 Domain-specific `Smoothed*` classes (in `commons.js`)

These are pre-wired decorator chains:

| Class | Base | Doubles as |
|-------|------|------------|
| `SmoothedAttitude` | `MessageSmoother` wrapping `Attitude(MessageHandler)` | smoothed roll/pitch/yaw |
| `SmoothedHeading` | `PolarSmoother` wrapping a unit-magnitude `Polar` on `navigation.headingTrue` | handles angle wraparound by smoothing x/y of unit vector |

The plugin currently uses `SmoothedHeading` and `SmoothedAttitude` directly. Raw access is via `.polar` (on PolarSmoother) or `.handler` (on MessageSmoother).

### 3.5 Wiring pattern in `index.js`

```js
smoothedHeading = new SmoothedHeading(app, plugin.id, settings.headingSource, true,
                                       MovingAverageSmoother, smootherOptions);
rawHeading = smoothedHeading.polar.angleHandler; // <-- reaches inside two layers
```

The `smoothedBoatSpeed.onChange` callback is the **master trigger** for the hot path:
```
STW sensor update
  → Polar.magnitudeHandler.onChange → polar.processChanges()
  → polar.onChange → PolarSmoother.sample()
  → PolarSmoother.onChange  ← plugin sets this to the main update function
```

### 3.6 Issues with current usage

- `rawHeading = smoothedHeading.polar.angleHandler` — reaching two levels deep is fragile; the layer abstraction is broken.
- `smoothedBoatSpeed.polar` is renamed `rawBoatSpeed` — naming implies it is a Polar but it is actually the inner Polar of a PolarSmoother. The distinction matters because its `.variance` values come from the smoother, not from sensor noise.
- `stability` module-level variable is declared but never assigned a meaningful class instance — it appears to be a leftover from a refactor.
- ~~`terminate()` in `stop()` passes `app` as an argument — new API takes no argument.~~ **Fixed March 2026.**

---

## 4. `Polar` and `PolarSmoother` — How They Work

### 4.1 `Polar` (`signalkutilities/src/signalk/Polar.js`)

A 2-D Cartesian vector that can optionally subscribe to two SK paths (magnitude + angle).

```
Polar(app, pluginId, id)                ← NEW: app+pluginId moved to constructor; no paths at construction
  .id
  .magnitudeHandler   MessageHandler
  .angleHandler       MessageHandler
  .pathMagnitude      getter → magnitudeHandler.path
  .pathAngle          getter → angleHandler.path
  .configureMagnitude(path, source?, passOn?)   ← NEW: sets magnitude path/source
  .configureAngle(path, source?, passOn?)       ← NEW: sets angle path/source
  .subscribe(magnitude?, angle?)        ← CHANGED: no app/pluginId arguments
  .terminate()                          ← CHANGED: no app argument
  .xValue / .yValue   internal Cartesian state
  .xVariance / .yVariance
  .magnitude, .angle  derived (read-only, angle formatted per angleRange)
  .x, .y              aliases to xValue/yValue
  .vector             [x, y]
  .stale              OR of both handler staleness flags
  .angleRange         '-piToPi' | '0to2pi'
  .setVectorValue({x,y}, {x?,y?})
  .copyFrom(polar)
  .add(polar), .substract(polar), .rotate(angle), .scale(factor)
  .onChange           callback set externally
  static .send(app, pluginId, [polars])
```

> **Migration note:** Old signature was `new Polar(id, pathMagnitude, pathAngle, sourceMagnitude, sourceAngle)` + `subscribe(app, pluginId, mag, angle, passOn)`. Paths are now set via `configureMagnitude()` / `configureAngle()` after construction.

When subscribed, sensor updates flow: `magnitudeHandler.onChange → Polar.processChanges()`, which recomputes `xValue/yValue` from magnitude×cos(angle) → fires `polar.onChange`.

Non-subscribed `Polar` instances are used as **computed output containers** (`correctedBoatSpeed`, `speedCorrection`, `residual`, `rawCurrent`, `boatSpeedRefGround`).

### 4.2 `PolarSmoother`

Wraps a `Polar`, smooths its `x` and `y` independently.

```
PolarSmoother(id, polar, SmootherClass, smootherOptions)
  .polar              the wrapped Polar
  .xSmoother / .ySmoother   smoother instances
  .x, .y, .magnitude, .angle    read from smoothers
  .xVariance, .yVariance    from smoother.variance
  .variance           {x, y}  (used by CorrectionEstimator)
  .sample()           feeds polar.x/y into smoothers, fires onChange
  .reset(xVal, yVal, xVar, yVar)
  .setAngleRange(range)
  .terminate()
  static .send(app, pluginId, [polarSmootherInstances])
```

### 4.3 `createSmoothedPolar` factory

Creates a `Polar` + wires `polar.onChange → smoother.sample()` in one call. Currently only used for the `noCurrent` placeholder.

### 4.4 Domain convenience classes (in `commons.js`)

| Instance | Input paths | Notes |
|----------|-------------|-------|
| `SmoothedGroundSpeed` | SOG + COG | `angleRange '0to2pi'` |
| `SmoothedSpeedThroughWater` | STW + leeway | `angleRange '-piToPi'`; leeway angle NOT subscribed (`angle: false`) |
| `SmoothedApparentWind` | AWA + AWS | |

In `index.js` these are instantiated but their inner `.polar` is stored in separate `rawBoatSpeed` / `rawGroundSpeed` variables to allow access to the pre-smoothed values.

### 4.5 Issues with current usage

- **`rawBoatSpeed = smoothedBoatSpeed.polar`** — refers to the inner `Polar` of a `PolarSmoother`. When `correct()` reads `rawBoatSpeed.magnitude` it gets the instantaneous unsmoothed value. When `updateTable()` reads `smoothedBoatSpeed.magnitude` it gets the smoothed value. This is intentional but the naming doesn't make it clear.
- ~~`boatSpeedRefGround.setDisplayAttributes("Boat speed over ground", "Ground")` — wrong call signature; two strings instead of `{label, plane}` object.~~ **Fixed March 2026.**
- `PolarSmoother.send()` is used for `smoothedCurrent` but `Polar.send()` is used for `correctedBoatSpeed` — the difference being that `PolarSmoother.send` calls `.report()` on its smoothers. The inconsistency could cause stale data to be emitted.
- `noCurrent` is created with `createSmoothedPolar` but then `PolarSmoother.send(app, plugin.id, [noCurrent])` is called once at startup and never again. The purpose is to initialize the SK path with a zero current value; it is not subsequently subscribed.
- ~~`SmoothedSpeedThroughWater` and `SmoothedGroundSpeed` were called with `passOn=true` (hardcoded) and the `preventDuplication` flag as an unused 7th arg.~~ **Fixed March 2026** — 4th arg (`passOn`) is now `!settings.preventDuplication`.

---

## 5. `CorrectionTable` and `CorrectionEstimator`

### 5.1 Class hierarchy

```
Table2D  (signalkutilities)
  └── CorrectionTable  (correctionTable.js)
        └── table cells: CorrectionEstimator[][]
```

`Table2D` provides: 2D grid construction, `getCell()`, `getIndex()`, `findNeighbours()` (4 bilinear), `findClosest()` (N nearest by normalized distance), `toJSON()`.

`CorrectionTable` adds:
- Overrides `getCorrection(speed, heel)` — weighted average of up to 5 nearest cells using inverse-distance × N/variance weighting. Returns `{correction: {x,y}, variance: {x,y}}`.
- `getKalmanCorrection()` — alternative bilinear interpolation (currently not used in the hot path).
- `update(speed, heel, groundSpeed, current, boatSpeed, heading)` — delegates to the nearest cell's `CorrectionEstimator.update()`.
- `report()` — serializes full table for WebApp (includes `factor`, `leeway`, `trace`, `normWeight`).
- `static resample()` / `resampleFromJSON()` — migrates an old table to new grid dimensions.

`CorrectionEstimator` holds one 2×2 Kalman filter per cell (x=longitudinal correction, y=lateral correction):
- `update(groundSpeed, current, boatSpeed, heading)` — rotates all vectors into boat frame, computes observation = `groundSpeed - current - boatSpeed` (= expected sensor error), propagates covariance through rotation, calls Kalman `filter()`.
- `getFilterModel(stability)` — process noise = `1/10^stability` diagonal. The `stability` parameter is the main tuning knob.
- State accessors: `.x`, `.y`, `.N` (= filterState.index, i.e. update count), `.covariance`.

### 5.2 Persistence

`loadTable()` / `saveTable()` in `index.js` serialize the full table via `table.toJSON()` and store it inside `plugin.options.correctionTable`. `app.savePluginOptions()` is called every 5 seconds while learning is active.

The `resample` logic is triggered when the grid shape (min/max/step) changes between saves — the old values seed the new grid with conservative variance floors.

### 5.3 Issues

- **Table JSON stored inside `plugin.options`** — causes the admin settings page to show a giant opaque object. Should be stored separately.
- `enforceConsistancy` [sic] mutates `table = options.correctionTable` as a side-effect — confusing.
- `loadTable` is responsible for both reading saved state AND constructing new state — these could be separate concerns.

---

## 6. Data Flow — Full Picture

```
[Sensors]
  navigation.headingTrue     → SmoothedHeading      → smoothedHeading (PolarSmoother)
  navigation.attitude        → SmoothedAttitude     → smoothedAttitude (MessageSmoother)
  navigation.speedThroughWater → SmoothedSTW.polar  → rawBoatSpeed (Polar, subscribed)
                               → SmoothedSTW        → smoothedBoatSpeed (PolarSmoother)
  navigation.speedOverGround → SmoothedGS.polar     → rawGroundSpeed (Polar, subscribed)
                             → SmoothedGS           → smoothedGroundSpeed (PolarSmoother)

[Hot path — triggered by smoothedBoatSpeed.onChange]
  ↓
  SOG fallback check  →  if STW stale & SOG available: emit SOG as correctedBoatSpeed, return

  correct() [if estimateBoatSpeed]
    heel = rawAttitude.value.roll
    speed = rawBoatSpeed.magnitude          ← INSTANTANEOUS (raw)
    theta = rawHeading.value                ← SMOOTHED heading angle
    {correction, variance} = table.getCorrection(speed, heel)
    speedCorrection ← correction
    correctedBoatSpeed = rawBoatSpeed + speedCorrection
    Polar.send([correctedBoatSpeed])
    if wellUnderway && !rawGroundSpeed.stale:
      boatSpeedRefGround = correctedBoatSpeed rotated by theta
      rawCurrent = rawGroundSpeed - boatSpeedRefGround
      smoothedCurrent.sample()
    PolarSmoother.send([smoothedCurrent])

  updateTable() [if updateCorrectionTable && wellUnderway]
    heel = smoothedAttitude.value.roll      ← SMOOTHED
    speed = smoothedBoatSpeed.magnitude     ← SMOOTHED
    theta = smoothedHeading.value           ← SMOOTHED
    if speed > minSpeed && inputs not stale:
      table.update(speed, heel, smoothedGroundSpeed,
                   assumeCurrent ? smoothedCurrent : noCurrent,
                   smoothedBoatSpeed, theta)
    residual = smoothedGroundSpeed - correctedBoatSpeed.rotated(theta) - smoothedCurrent

  saveTable every 5 s
```

**Key asymmetry:** `correct()` uses raw (instantaneous) STW for applying corrections, while `updateTable()` uses smoothed STW for learning. This is intentional: corrections applied to data should reflect the actual instantaneous measurement noise, while learning should be based on more stable averages.

---

## 7. HTTP API and WebApp

### 7.1 Routes

| Route | Returns |
|-------|---------|
| `GET /plugins/speedandcurrent/getResults` | `reportFull.report()` — full diagnostics inc. table |
| `GET /plugins/speedandcurrent/getVectors` | `reportVector.report()` — vectors for SVG view |

`Reporter.report()` returns `{deltas, polars, tables, attitudes}` — arrays of `.report()` results from each registered object.

### 7.2 WebApp (`public/`)

- Pure static ES modules, polled at 1 Hz.
- `app.js` handles unit conversions (`vSpeed`, `vAngle`), table rendering via `TableRenderer.js`, delta display (value + variance), attitude.
- The `/getResults` response drives the main page; `/getVectors` drives `vectors.html`.
- Display metric selection (correction cartesian X/Y, factor, leeway, trace, N) is persisted in `localStorage`.
- **No build step** — directly referenced via relative ES module imports.

---

## 8. Candidate Areas for the Overhaul

The user's stated focus is three subjects. Here is the pre-overhaul status of each:

### 8.1 Settings management

**Current:** flat JSON schema, units mixed (knots/degrees in schema, SI internally), no grouping, table blob embedded in options, `startWithNewTable` self-clearing flag.

**Target:** Separate user-facing settings from internal state (table). Unit adapter class. Possibly separate source-selector section. Consider a `PluginSettings` module that owns validation, unit conversion, defaults, and schema generation.

### 8.2 Polar classes

**Current:** Correct pattern exists in `signalkutilities` but `index.js` reaches deep into internals (`smoothedBoatSpeed.polar`, `smoothedHeading.polar.angleHandler`). Non-subscribed `Polar` instances used as output containers work well. The `noCurrent` / `createSmoothedPolar` usage is redundant. `boatSpeedRefGround.setDisplayAttributes(string, string)` is a bug (wrong signature).

**Target:** Use `Polar` and `PolarSmoother` through their public API only. Introduce a derived class or wiring function for output-only polars that have SK output paths.

**March 2026 progress:** `index.js` migrated to new `Polar(app, pluginId, id)` + `configureMagnitude/Angle()` API throughout. All `setDisplayAttributes()` calls fixed to object form. `preventDuplication` now correctly wired to `passOn`.

### 8.3 `MessageHandler` classes and decorators for smoothing

**Current:** The `Smoothed*` convenience classes in `commons.js` are already the decorator pattern. The plugin uses them but also reaches through them. Smoother options are a single shared `smootherOptions` object repeated for all sensors — different sensors might benefit from different smoothing parameters. No per-sensor smoothing configuration is currently surfaced in settings.

**Target:** Expose per-sensor smoothing options (or at minimum separate fast/slow time constants) in settings. Ensure `onChange` chains are correctly wired and not bypassed. `terminate()` cleanup should be consistent.

---

## 9. Class Inventory (Quick Reference)

### From `signalkutilities`

| Name | Type | Purpose |
|------|------|---------|
| `MessageHandler` | base | SK path subscription, staleness, frequency |
| `MessageSmoother` | decorator | adds smoothing to a `MessageHandler` |
| `Polar` | base | 2D vector, optional dual SK path subscription |
| `PolarSmoother` | decorator | smooths `Polar` x/y independently |
| `createSmoothedPolar` | factory | Polar + PolarSmoother wired together |
| `createSmoothedHandler` | factory | MessageHandler + MessageSmoother wired together |
| `BaseSmoother` | strategy | pass-through (no smoothing) |
| `MovingAverageSmoother` | strategy | time-windowed moving average |
| `ExponentialSmoother` | strategy | EMA with time constant |
| `KalmanSmoother` | strategy | 1-D Kalman |
| `SmoothedHeading` | domain | unit-vector trick for angle smoothing |
| `SmoothedAttitude` | domain | smoothed roll/pitch/yaw object |
| `SmoothedGroundSpeed` | domain | SOG + COG as smoothed Polar |
| `SmoothedSpeedThroughWater` | domain | STW as smoothed Polar |
| `SmoothedApparentWind` | domain | AWA + AWS as smoothed Polar |
| `Table2D` | base | generic 2D Kalman/cell grid with interpolation |
| `Reporter` | output | collects polars/deltas/tables for HTTP report |
| `SI` | util | unit conversions (knots↔m/s, degrees↔radians) |

### From `correctionTable.js`

| Name | Type | Purpose |
|------|------|---------|
| `CorrectionTable` | extends `Table2D` | speed/heel correction table with interpolation and resample |
| `CorrectionEstimator` | cell type | 2×2 Kalman filter tracking (x,y) correction |

### Plugin-local variables (module scope in `index.js`)

```
smoothedHeading       SmoothedHeading   (PolarSmoother subclass)
smoothedAttitude      SmoothedAttitude  (MessageSmoother subclass)
rawHeading            MessageHandler    smoothedHeading.polar.angleHandler
rawAttitude           MessageHandler    smoothedAttitude.handler  [NOT used — plugin uses .value.roll directly]
rawBoatSpeed          Polar             smoothedBoatSpeed.polar
smoothedBoatSpeed     SmoothedSpeedThroughWater (PolarSmoother subclass)
rawGroundSpeed        Polar             smoothedGroundSpeed.polar
smoothedGroundSpeed   SmoothedGroundSpeed (PolarSmoother subclass)
rawCurrent            Polar             output container (no subscription)
smoothedCurrent       PolarSmoother     wraps rawCurrent
noCurrent             PolarSmoother     constant zero, used as current placeholder
correctedBoatSpeed    Polar             output container (emitted on SK)
boatSpeedRefGround    Polar             intermediate computation container
speedCorrection       Polar             output container (correction vector)
residual              Polar             output container (diagnostic)
table                 CorrectionTable
reportFull / reportVector  Reporter
stability             (declared but never assigned — orphan variable)
```

---

## 10. Known Bugs / Inconsistencies

1. ~~`boatSpeedRefGround.setDisplayAttributes("Boat speed over ground", "Ground")` — wrong signature.~~ **Fixed March 2026.**
2. `stability` variable is declared in module scope but never assigned (dead code).
3. `rawAttitude` is assigned `smoothedAttitude.handler` but then never used — `correct()` and `updateTable()` read `rawAttitude.value?.roll` and `smoothedAttitude.value.roll` respectively; only the smoothed one is used.
4. ~~`terminate()` in `stop()` passes `app` argument — new API takes no argument.~~ **Fixed March 2026.**
5. Source settings default to `" "` (space) rather than `null`/`""` — works because `MessageHandler.configure()` strips whitespace, but is misleading.
6. `PolarSmoother.send()` vs `Polar.send()` — `PolarSmoother.send` reads `ps.magnitude`/`ps.angle` from the smoother; `Polar.send` reads directly from the polar. Both emit correct values for their respective types, but the pattern is inconsistent.
7. ~~`SmoothedSpeedThroughWater`/`SmoothedGroundSpeed` called with `passOn=true` (hardcoded), `preventDuplication` silently ignored.~~ **Fixed March 2026** — `passOn = !settings.preventDuplication`.
