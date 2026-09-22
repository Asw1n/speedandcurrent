# Speed and Current — Signal K Plugin

## What it does

Most paddle wheel logs carry a systematic error that varies with boat speed and heel angle. A boat heeled at 20° with a fouled bottom at 6 knots may read 5% low; the same boat upright at 3 knots may read 2% high. Manual calibration with a single factor misses this structure entirely.

This plugin builds and maintains a **2-dimensional correction table** — indexed by speed and heel — that is populated automatically from real sailing observations. No calibration runs, no spreadsheets, no manual entry. Once the table has enough coverage the plugin applies per-point corrections to `navigation.speedThroughWater`, derives leeway from the lateral component of the correction, and estimates water current by subtracting the corrected boat speed vector from the GPS ground speed vector.

In the current implementation the plugin is also explicit about runtime state: if an input goes idle or stale, the webapp shows a warning and the handler resubscribes; when estimation is disabled or the plugin stops, the active output paths are cleared with `null` so downstream consumers do not keep stale values.

In broad terms the plugin:

- corrects paddle wheel speed using a learned, heel- and speed-aware correction table
- estimates leeway angle from the observed lateral correction
- estimates water current drift and set
- continuously refines all three as you sail

---

## Installation

Install the plugin from the Signal K App Store, or manually by placing it in your Signal K plugin directory and running `npm install`. After installation:

1. Enable the plugin in the Signal K Server admin UI (**Server → Plugin Config → Speed and Current → Active**).
2. Open the plugin webapp from the Signal K app list (**Apps → Speed and Current**).
3. The plugin creates a default correction table on first start. You do not need to create one manually.
4. Enable **Update Correction Table** to start learning.
5. After the table has some coverage, enable **Estimate Boat Speed**.

The plugin requires no further configuration in the Signal K admin UI. All settings are managed from its own webapp.

---

## Configuring Signal K source priorities

Signal K Server manages source priorities natively. When multiple devices publish the same path, the server delivers the highest-priority source to all subscribers — including this plugin. No per-path source selection is needed inside the plugin itself.

When **Estimate Boat Speed** is enabled the plugin publishes corrected `navigation.speedThroughWater` alongside the raw paddle wheel value. Signal K will deliver whichever source has the higher priority. To ensure the rest of your instrument system sees the *corrected* value:

1. Open the Signal K Server admin UI and navigate to **Server → Data Browser** (or the **Sources** page, depending on your server version).
2. Locate `navigation.speedThroughWater` and find the source published by this plugin (it is identified as `SpeedAndCurrent`).
3. Set that source to a higher priority than the raw paddle wheel source.

Once configured, all consumers on the Signal K bus — KIP, OpenCPN, Instrument displays — receive the corrected value automatically without any further configuration.

---

## Required Signal K paths

| Path | Role |
|------|------|
| `navigation.speedThroughWater` | Raw paddle wheel speed — the signal being corrected |
| `navigation.speedOverGround` | GPS ground speed magnitude |
| `navigation.courseOverGroundTrue` | GPS ground speed direction |
| `navigation.headingTrue` | True heading — used to rotate the boat-frame correction into the ground frame |
| `navigation.attitude` | Roll angle — provides the heel index into the correction table |

---

## Output paths

| Path | Unit | Description |
|------|------|-------------|
| `navigation.speedThroughWater` | m/s | Corrected speed through water. Source attribute identifies it as the plugin output. |
| `navigation.leewayAngle` | rad | Leeway angle (starboard positive). Derived from the lateral correction component. |
| `environment.current.drift` | m/s | Estimated current speed. |
| `environment.current.setTrue` | rad | Estimated current direction (the direction the water moves *toward*). |

A 60-second stabilisation period applies after startup. Corrected boatspeed may be published during this window, but current estimation and table learning wait until it ends.

---

## The webapp

The plugin is configured and monitored through its own webapp (Signal K Apps → **Speed and Current**). The sidebar has four sections: **Inputs**, **Boatspeed Estimation**, **Correction Table Learning**, and **Correction Table**. Settings changes take effect immediately without restarting.

### Warning indicators

Whenever a required signal is not available, the relevant section shows a **Warnings** panel listing each affected input and why:

| Reason | Meaning |
|--------|---------|
| *not subscribed to Signal K* | Subscription did not succeed. Try restarting the plugin. |
| *path not found in Signal K* | No device is publishing this path. Check instrument connections and your multiplexer configuration. |
| *waiting for first data* | The path is known but no value has arrived since the plugin started. Normal for a few seconds at startup. |
| *data is stale* | Data was arriving but has stopped. The instrument may have gone offline, or its update rate has dropped below the staleness threshold. |

---

## Inputs

The **Inputs** section shows live readings from the raw sensors as they arrive from Signal K, before any smoothing or correction. This is a useful first stop when diagnosing instrument problems.

### Live values

| Value | Signal K path |
|-------|--------------|
| Heading | `navigation.headingTrue` |
| Boat speed | `navigation.speedThroughWater` |
| Ground speed | `navigation.speedOverGround` + `navigation.courseOverGroundTrue` |
| Attitude (heel) | `navigation.attitude` (roll) |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Input staleness handling** | Built in | Inputs are marked stale when they stop updating, and the webapp displays a warning. `navigation.state` is an event path and is not treated as stale between state transitions. |

---

## Boatspeed Estimation

The **Boatspeed Estimation** section is enabled with the toggle in the panel header. When off, no corrected output is published; the raw paddle wheel value passes through to the SK bus unchanged.

### What it shows

The panel is organised into three groups:

**Inputs** — the raw sensor values used for correction: heading, boat speed, ground speed, and attitude. Warnings appear here if any are unavailable.

**Intermediates** — computed vectors that give insight into what the plugin is doing:
- *Speed correction* — the correction vector currently being applied (longitudinal + lateral components).
- *Boat speed over ground* — the corrected STW vector rotated into the ground frame using heading.
- *Residual* and *Smoothed residual* — the difference between ground speed and (corrected boat speed + estimated current). Ideally near zero; a persistent non-zero residual indicates remaining systematic error or a current the plugin has not yet picked up.

**Outputs** — what is being published to Signal K:
- *Corrected boatspeed / Leeway* — corrected STW magnitude and leeway angle.
- *Current* — estimated current drift and set.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Estimate Boat Speed** | Off | Master toggle. Apply the correction table and publish corrected STW, leeway, and current. Turn on once the table has reasonable coverage. |
| **Groundspeed Fallback** | Off | When the paddle wheel reads zero and SOG is above the current table speed-step threshold, publish SOG as boatspeed. Primarily intended for clogged or stuck paddle wheels where the instrument is physically present but not turning — giving the rest of the instrument system a usable boat speed until the wheel is cleared. |

---

## Correction Table Learning

The **Correction Table Learning** section has its own independent toggle. Learning and estimation are decoupled: you can learn without estimating (building the table during a passage before trusting it), and you can estimate without learning (freezing the table once you are satisfied with it).

### What it shows

The panel shows the **smoothed** sensor inputs used for table updates — heading, boat speed, ground speed, and attitude. These are the same signals as in the Estimation panel, but averaged over the smoother window before being fed into the learning algorithm. This averaging reduces the influence of short-term fluctuations on the table update.

Warnings appear here if any smoothed input is unavailable.

The panel also shows whether learning is currently active, suspended, or skipped for the latest observation. Learning is normally gated by SOG: observations below the current table speed-step threshold are skipped. When **Suspend on navigation.state = motoring** is enabled and `navigation.state` is known, `anchored`, `moored`, and `motoring` suspend learning; an unavailable or unknown state falls back to the SOG gate.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Update Correction Table** | On | Master toggle. Allow the table to update from current observations. |
| **Suspend on navigation.state = motoring** | Off | When enabled, suspend learning when a known `navigation.state` reports `anchored`, `moored`, or `motoring`. When disabled, `navigation.state` does not override the SOG-based moving check. |
| **Correction drift** | 0.3 knots/month | How quickly the correction may change over time (knots/month). 0.3 knots/month means the correction can typically change by about 0.3 knots over a month. Higher values adapt faster but may be less stable. Range: 0.0–3.0 knots/month. |
| **Show Statistics (σ)** | Off | Display standard deviation alongside each smoothed value. Useful for spotting noisy sensors. |

### Smoothing and learning cadence

Controls how raw sensor values are averaged before being used for table updates. These settings have no effect on the published corrected values — only on the inputs to the learning algorithm.

The smoother serves a second purpose beyond noise reduction: its output variance tells the plugin how much to trust each observation. A tight, stable signal (low variance) produces an observation that is weighted heavily in the Kalman update. A signal that has been varying rapidly — because the boat is turning, the sails are flogging, or conditions are rough — has high variance, and the resulting observation is trusted less and moves the cell estimate by a smaller amount. The smoother therefore acts as an automatic quality gate: the table learns most from steady, settled sailing.

| Setting | Default | Description |
|---------|---------|-------------|
| **Window size** | 5 s | Moving-average integration window. Larger = smoother but slower to respond. Minimum 5 s. |

A 5-second moving average window suits typical 1 Hz instrument update rates. Learning attempts occur every `window + 1 second`, leaving a one-second gap between observation windows. In rough conditions with high sensor noise, increasing the window to 8–10 seconds may improve table quality at the cost of temporal resolution. Older configurations that selected another smoother are silently converted to moving average; their valid window duration is retained and shorter values are clamped to 5 seconds.

---

## Correction Table

The **Correction Table** section displays the active correction table. Rows are speed bins, columns are heel bins — port heel on the left (negative values), starboard on the right (positive values).

### Reading the table

Each cell that has received at least one observation shows its correction values. Cells participating in the latest estimate also show their normalized fusion weight as a blue bar along the bottom:

- **Speed factor** (e.g. `+3.2%` or `−1.5%`): how much faster or slower the true speed is compared to what the paddle wheel reads.
- **Leeway** (e.g. `+4°`): the observed lateral correction for that speed/heel combination. Positive is starboard.
- **Fusion weight**: the blue bar is that cell's normalized share of the current precision-weighted estimate. A full-width bar represents 100%, and the displayed weights sum to approximately 100%.

Cell backgrounds encode the speed factor: green means the paddlewheel reads slow and orange means it reads fast. When leeway is available, stripe angle encodes its direction.

Empty cells have not yet received any observations and show no correction.

### Active cell

The **active cell** — the one most recently updated by an incoming STW sample — is shown with a black border.

### Table management

| Action | Description |
|--------|-------------|
| **New** | Create a new table with specified speed and heel dimensions. The current table is replaced. |
| **Load** | Switch to a previously saved table. Tables are stored as JSON files in the plugin's data directory. |
| **Copy** | Save the current table under a new name without modifying it. |
| **Resize** | Change the speed/heel range or step size. Existing cell values are resampled onto the new grid — nothing is lost, but resampled cells benefit from a few more observations to consolidate on the new grid. |

Multiple tables can coexist on disk; only the active one is used. This makes it straightforward to keep separate tables for different configurations such as racing vs. cruising sails, or before and after antifouling.

### Correction-table file formats

The original format is schema version 1. It remains available as [`docs/correction-table-v1.schema.json`](docs/correction-table-v1.schema.json), while [`docs/correction-table.schema.json`](docs/correction-table.schema.json) is retained as the compatible legacy filename. New and saved tables use schema version 2, documented in [`docs/correction-table-v2.schema.json`](docs/correction-table-v2.schema.json). Version 2 adds a top-level `schemaVersion: 2`, the current serializable model descriptor, and `lastAcceptedAt` epoch milliseconds on every cell; empty cells use `null`.

Version 1 files, including older files without a version field, are migrated silently on load. Since individual legacy cell ages are unknown, the file modification time is assigned to every learned cell as a conservative approximation. If that timestamp is unavailable, load time is used and the fallback is written only to debug logging. Migration preserves table identity, dimensions, display attributes, means, covariance, and indices, and is persisted atomically only after the table has loaded successfully.

---

## Operating notes

**Be patient with the correction table.** A fresh table has no data and produces no corrections. Cover a range of speeds and heel angles over a few sails and the table fills in progressively. Upwind sailing covers the heel bins well; downwind and reaching fill the low-heel, varying-speed bins.

**The table learns while sailing normally.** No dedicated calibration runs are needed. Just sail with **Update Correction Table** on. Learning pauses automatically during startup stabilisation and when SOG or STW are below the current table speed-step threshold. If **Suspend on navigation.state = motoring** is enabled, a known `navigation.state` of `anchored`, `moored`, or `motoring` also pauses learning.

**Port and starboard are tracked independently.** Heel is signed: starboard positive, port negative. An asymmetric paddle wheel installation will show different corrections on each tack, and the table captures this naturally.

**Corrections improve in context.** A correction derived from rough seas with high GPS variance receives a small Kalman gain and moves the cell estimate less than a correction from flat water at steady speed. The table naturally weights calm, steady observations more heavily.

**Resizing the table is non-destructive.** The Resize function resamples existing cell values onto the new grid. Nothing is lost — resampled cells just need a few more observations to consolidate at the new resolution.

**Current estimation lags behind reality.** The slow Kalman smoother is intentional — it prevents GPS noise and short-term manoeuvres from corrupting the estimate. In rapidly changing tidal conditions the estimate will lag the actual current by several minutes. For precise tidal navigation use an independent current source.

---

## How it works — technical detail

### How corrections are applied

Each cell in the correction table holds a 2-dimensional correction vector **[x, y]** in the boat frame:
- **x** is the longitudinal component (along the centreline, positive = forward). This is the main speed error.
- **y** is the lateral component (positive = starboard). This becomes the leeway estimate.

When a new paddle wheel sample arrives the plugin:
1. Looks up the current speed and heel.
2. Retrieves an interpolated correction vector from the table.
3. Adds that vector to the raw STW vector.
4. The corrected magnitude is published as `navigation.speedThroughWater`; the lateral component divided by the corrected forward speed gives `navigation.leewayAngle`.

### Neighbour interpolation

The plugin combines learned cells using both their Kalman covariance and their distance from the requested speed and heel. Speed and heel distances are divided by their respective grid steps, so distance is measured in dimensionless cell units. A cell participates only when:

```text
cell index > 0
cell distance <= 2.5
```

For each participating cell, distance is converted into additional uncertainty:

```text
effective covariance = cell covariance + q * distance² * identity matrix
```

The inverse effective covariance is the cell's precision. The correction and its covariance are obtained by full 2×2 precision fusion:

```text
combined precision = sum(inverse(effective covariance))
correction covariance = inverse(combined precision)
correction = correction covariance
			 * sum(inverse(effective covariance) * cell correction)
```

This gives nearby, mature cells the greatest influence. A fresh table borrows information more broadly because cell covariance is still large; a mature table becomes more local as its cell covariance falls. If no eligible cell exists, the plugin applies zero correction rather than extrapolating beyond the configured radius.

#### Automatic spatial variance (`q`)

`q` describes how much genuine correction variation is expected between adjacent cells, in correction variance per squared cell. It is calculated without user input from horizontal and vertical pairs where both cells have an index greater than 0. A cell with one accepted observation is therefore eligible while the explicit maturity threshold remains available for future tuning. For each adjacent pair:

```text
pair q = (
	squared distance between the two correction vectors
	- trace(cell covariance 1 + cell covariance 2)
) / 2
```

The table uses the median pair estimate, which limits the effect of isolated rough or immature cells. At least three eligible adjacent pairs and a positive median are required. A zero or negative estimate means the observed differences do not resolve spatial variation above the cells' estimated uncertainty; because using zero would disable distance weighting, the plugin then uses a conservative fallback of `0.002 (m/s)²` per squared cell. `q` is calculated when a table is loaded and recalculated after every 600 accepted learning observations. The applied `q`, raw estimate, source, and supporting pair count are runtime diagnostics and are not saved in the correction-table file.

### How the correction table is populated

Each cell is an independent **2-dimensional Kalman filter** tracking the correction vector [x, y] for that speed/heel bin, with a 2×2 covariance matrix expressing confidence in each axis.

Every time conditions are right — plugin running for >60 seconds, smoothers settled, speed above minimum threshold — the plugin computes an **observation** of what the correction should be:

```text
observation = R(ψ)⁻¹ · V_SOG − R(ψ)⁻¹ · V_current − V_STW
```

where `R(ψ)` rotates from ground frame to boat frame using true heading `ψ`. In plain terms: rotate GPS velocity into the boat frame, subtract the raw paddle wheel velocity. The residual is the implied sensor error for the current speed and heel.

The Kalman update combines this observation with the cell's existing belief:

```text
K = P · (P + R_obs)⁻¹
x_new = x_old + K · (observation − x_old)
```

where P is the cell's current covariance and R_obs is the observation covariance derived from the measurement uncertainty of all contributing signals (SOG variance + STW variance, rotated appropriately). It also includes heading uncertainty in radians squared. For $u = R(-heading)(groundSpeed - current)$, the heading contribution is $J \sigma_h^2 J^T$, where $J = [u_y, -u_x]^T$. This is applied once to the combined ground-speed-minus-current vector because both vectors share the same heading error. **Noisy observations produce a smaller gain and move the cell estimate less.**

### Time-scaled aging and correction drift

Each cell has a small **process-noise rate** that allows it to drift slowly over time, reflecting that a paddle wheel's error can change. For an elapsed interval `dt`, the process covariance added to each diagonal is:

```text
effectiveDt = min(dt, 90 days)
Q(dt) = Q_rate × effectiveDt × I
```

The user-facing `Correction drift` value is expressed in knots per month, using a 30-day month. Internally, it is converted to the SI process-noise rate in $(m/s)^2/s$. The default 0.3 knots/month corresponds to approximately $9.2 × 10^{-9}\ (m/s)^2/s$. Offline time counts toward aging, but aging stops after the internal 90-day cap. Aged covariance is calculated when gating, filtering, interpolation, spatial-q estimation, and reporting; stored covariance is not mutated by reads. Rejected observations do not advance timestamps; accepted observations store the posterior covariance and current UTC epoch-millisecond timestamp.

In practical terms: a lower correction-drift rate trusts accumulated history more; a higher rate allows the table to adapt more quickly to long-term sensor changes.

### How current is estimated

Current is estimated as:

```text
V_current = V_SOG − R(ψ) · V_STW_corrected
```

The corrected STW vector is rotated into the ground frame using heading, then subtracted from the GPS velocity. The residual is the water velocity.

This raw estimate is fed into a **Kalman smoother with very low process noise** (process variance ≈ 10⁻⁶), so it changes very slowly, integrating over many minutes rather than chasing individual GPS fluctuations. At startup the estimate is strongly initialised to zero.

Current estimation requires an accurate boat speed, so it is gated by the 60-second stabilisation period and only runs when **Estimate Boat Speed** is enabled.
