# Speed and Current — Signal K Plugin

## What it does

Most paddle wheel logs carry a systematic error that varies with boat speed and heel angle. A boat heeled at 20° with a fouled bottom at 6 knots may read 5% low; the same boat upright at 3 knots may read 2% high. Manual calibration with a single factor misses this structure entirely.

This plugin builds and maintains a **2-dimensional correction table** — indexed by speed and heel — that is populated automatically from real sailing observations. No calibration runs, no spreadsheets, no manual entry. Once the table has enough coverage the plugin applies per-point corrections to `navigation.speedThroughWater`, derives leeway from the lateral component of the correction, and estimates water current by subtracting the corrected boat speed vector from the GPS ground speed vector.

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

A 60-second stabilisation period applies after startup. No output is published during this window; the status bar shows **Stabilizing**.

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

### Source selection

For each path you can pin the plugin to a specific Signal K source. This is useful when multiple devices publish the same path — for example two GPS receivers, or a fluxgate and a satellite compass both publishing `navigation.headingTrue`. Leave a source blank or select **(any)** to accept values from all sources. This is independent of the Signal K server's global source priority settings.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Staleness Detection** | On | Mark an input as unavailable when it stops updating. Disable when testing the plugin with simulated or replayed data, where timing is irregular and would otherwise trigger spurious warnings. |

---

## Boatspeed Estimation

The **Boatspeed Estimation** section is enabled with the toggle in the panel header. When off, no corrected output is published; the raw paddle wheel value passes through to the SK bus unchanged (subject to the Prevent Speed Duplication setting).

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
| **Prevent Speed Duplication** | On | Replace the raw sensor value on the SK bus with the corrected value. When off, both raw and corrected exist under `navigation.speedThroughWater` with different source attributes — useful for comparing before and after. |
| **Groundspeed Fallback** | Off | When the paddle wheel reads zero and SOG is above a minimum threshold, publish SOG as boatspeed. Primarily intended for clogged or stuck paddle wheels where the instrument is physically present but not turning — giving the rest of the instrument system a usable boat speed until the wheel is cleared. |

---

## Correction Table Learning

The **Correction Table Learning** section has its own independent toggle. Learning and estimation are decoupled: you can learn without estimating (building the table during a passage before trusting it), and you can estimate without learning (freezing the table once you are satisfied with it).

### What it shows

The panel shows the **smoothed** sensor inputs used for table updates — heading, boat speed, ground speed, and attitude. These are the same signals as in the Estimation panel, but averaged over the smoother window before being fed into the learning algorithm. This averaging reduces the influence of short-term fluctuations on the table update.

When **Assume Current** is enabled, the smoothed current estimate is also shown as a learning input.

Warnings appear here if any smoothed input is unavailable.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Update Correction Table** | On | Master toggle. Allow the table to update from current observations. Disable temporarily in conditions you do not want recorded — motoring, surf sailing, very confused seas. |
| **Stability (1–20)** | 7 | How quickly the correction table adapts to new observations. Higher = slower, more conservative. Lower = faster but noisier. See the technical section for detail. |
| **Assume Current (experimental)** | Off | Include the running current estimate in the table update calculation. Only enable once the current estimate has had time to stabilise and tidal conditions are relatively steady. |
| **Show Statistics (σ)** | Off | Display standard deviation alongside each smoothed value. Useful for spotting noisy sensors. |

### Smoother settings

Controls how raw sensor values are averaged before being used for table updates. These settings have no effect on the published corrected values — only on the inputs to the learning algorithm.

The smoother serves a second purpose beyond noise reduction: its output variance tells the plugin how much to trust each observation. A tight, stable signal (low variance) produces an observation that is weighted heavily in the Kalman update. A signal that has been varying rapidly — because the boat is turning, the sails are flogging, or conditions are rough — has high variance, and the resulting observation is trusted less and moves the cell estimate by a smaller amount. The smoother therefore acts as an automatic quality gate: the table learns most from steady, settled sailing.

| Setting | Default | Description |
|---------|---------|-------------|
| **Smoother Type** | Moving average | Moving Average (window), Exponential decay (τ), or Kalman filter. Moving average is the most predictable. |
| **Window size** | 5 s | (Moving average) Integration window. Larger = smoother but slower to respond. Minimum 2 s. |
| **Time constant (τ)** | 3 s | (Exponential) Decay time constant. Larger = smoother. Minimum 1 s. |
| **Kalman gain** | 0.2 | (Kalman) Steady-state gain. Lower = smoother / slower. Range 0.01–0.99. |

A 5-second moving average window suits typical 1 Hz instrument update rates. In rough conditions with high sensor noise, increasing it to 8–10 seconds may improve table quality at the cost of temporal resolution.

---

## Correction Table

The **Correction Table** section displays the active correction table. Rows are speed bins, columns are heel bins — port heel on the left (negative values), starboard on the right (positive values).

### Reading the table

Each cell that has received at least one observation shows two values:

- **Speed factor** (e.g. `+3.2%` or `−1.5%`): how much faster or slower the true speed is compared to what the paddle wheel reads. **Green** = paddle wheel reads slow (the correction adds speed). **Orange** = paddle wheel reads fast (the correction reduces speed). Colour intensity scales with the magnitude of the factor relative to the largest factor in the table.
- **Leeway** (e.g. `+4°`): the observed lateral correction for that speed/heel combination. Positive is starboard. When leeway is non-zero the cell background shows diagonal stripes; the stripe angle encodes the leeway direction visually.

Empty cells have not yet received any observations and show no correction.

### Active cell and neighbours

The **active cell** — the one most recently updated by an incoming STW sample — is highlighted with a bold border and blue text. The **neighbour cells** contributing to the current interpolation are shown with a faint tint. Watching these as you sail shows exactly which part of the table is being applied and updated at any moment.

### Table management

| Action | Description |
|--------|-------------|
| **New** | Create a new table with specified speed and heel dimensions. The current table is replaced. |
| **Load** | Switch to a previously saved table. Tables are stored as JSON files in the plugin's data directory. |
| **Copy** | Save the current table under a new name without modifying it. |
| **Resize** | Change the speed/heel range or step size. Existing cell values are resampled onto the new grid — nothing is lost, but resampled cells benefit from a few more observations to consolidate on the new grid. |

Multiple tables can coexist on disk; only the active one is used. This makes it straightforward to keep separate tables for different configurations such as racing vs. cruising sails, or before and after antifouling.

---

## Operating notes

**Be patient with the correction table.** A fresh table has no data and produces no corrections. Cover a range of speeds and heel angles over a few sails and the table fills in progressively. Upwind sailing covers the heel bins well; downwind and reaching fill the low-heel, varying-speed bins.

**The table learns while sailing normally.** No dedicated calibration runs are needed. Just sail with **Update Correction Table** on.

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

Rather than bi-linear interpolation the plugin uses **inverse-distance weighting** over the five nearest cells in speed/heel space:

$$w_i = \frac{1}{d_i + \epsilon}$$

where $d_i$ is the Euclidean distance from the query point to cell centre $i$ in normalised speed/heel space. Only cells that have received at least one observation ($N > 0$) contribute.

The final correction is the normalised weighted average:

$$\hat{x} = \frac{\sum_i w_i \cdot x_i}{\sum_i w_i}, \quad \hat{y} = \frac{\sum_i w_i \cdot y_i}{\sum_i w_i}$$

The variance of each axis is propagated through the same weighting, so cells with low confidence (high covariance) influence the result less. If only one or two cells have data, the correction extrapolates gradually to nearby conditions. As more cells fill in, the correction becomes tighter and more local.

### How the correction table is populated

Each cell is an independent **2-dimensional Kalman filter** tracking the correction vector $[x, y]$ for that speed/heel bin, with a 2×2 covariance matrix expressing confidence in each axis.

Every time conditions are right — plugin running for >60 seconds, smoothers settled, speed above minimum threshold — the plugin computes an **observation** of what the correction should be:

$$\text{observation} = R(\psi)^{-1} \cdot \vec{V}_{SOG} - R(\psi)^{-1} \cdot \vec{V}_{current} - \vec{V}_{STW}$$

where $R(\psi)$ rotates from ground frame to boat frame using true heading $\psi$. In plain terms: rotate GPS velocity into the boat frame, subtract the current estimate (also rotated), subtract the raw paddle wheel velocity. The residual is the implied sensor error for the current speed and heel.

The Kalman update combines this observation with the cell's existing belief:

$$K = P \cdot (P + R_{obs})^{-1}$$
$$x_{new} = x_{old} + K \cdot (\text{observation} - x_{old})$$

where $P$ is the cell's current covariance and $R_{obs}$ is the observation covariance derived from the measurement uncertainty of all contributing signals (SOG variance + current variance + STW variance, rotated appropriately). **Noisy observations produce a smaller gain and move the cell estimate less.**

### The stability setting in detail

Each cell has a small **process noise** that allows it to drift slowly over time, reflecting that a paddle wheel's error can change with fouling, recalibration, or crew weight distribution. Process noise is:

$$Q = 10^{-\text{stability}}$$

With stability = 7 (default), $Q = 10^{-7}$, making the cell very resistant to change — it effectively averages hundreds of observations before settling. Stability 4–5 makes the table react faster to recent conditions; stability 10–12 is appropriate for a well-characterised boat that changes rarely.

In practical terms: high stability = trust the accumulated history; low stability = trust recent observations more.

### How current is estimated

Current is estimated as:

$$\vec{V}_{current} = \vec{V}_{SOG} - R(\psi) \cdot \vec{V}_{STW, corrected}$$

The corrected STW vector is rotated into the ground frame using heading, then subtracted from the GPS velocity. The residual is the water velocity.

This raw estimate is fed into a **Kalman smoother with very low process noise** (process variance $\approx 10^{-6}$), so it changes very slowly, integrating over many minutes rather than chasing individual GPS fluctuations. At startup the estimate is strongly initialised to zero.

Current estimation requires an accurate boat speed, so it is gated by the 60-second stabilisation period and only runs when **Estimate Boat Speed** is enabled.

### Current and table learning

Current estimation always runs alongside speed correction — it is a direct byproduct of comparing the GPS velocity with the corrected STW vector. You cannot have one without the other.

For table *learning*, however, current can be left out of the equation without significant harm. When a boat sails different headings over time — tacking, gybing, reaching — any steady current appears as an error in one direction on one heading and the opposite direction on another. These errors cancel in the long-term average, so the table converges on the correct speed correction regardless. This is why the default (**Assume Current** off) uses a zero-current placeholder rather than the live estimate.

Including the current estimate (**Assume Current** on) would be more accurate in principle, but it introduces a dependency: the current estimate is only as good as the speed correction that produced it. Early in the table's life, when corrections are rough, the current estimate is also rough, and feeding it back into learning can amplify rather than reduce error. There is also a circularity: better speed correction → better current estimate → better speed correction. Enabling this before the table has had time to settle can cause the two to pull each other in the wrong direction, particularly in changing tidal conditions. Use it only once the table is reasonably well populated and current conditions are stable.
