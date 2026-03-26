# Speed Correction & Current Estimation Plugin

## Overview
This SignalK plugin estimates **corrected speed through water**, **leeway**, and **water current (drift)** in real-time using adaptive sensor fusion and statistical filtering. It continuously refines its estimates based on vessel speed, heading, ground speed, and heel angle. Its primary goal is to significantly improve paddle wheel speed (navigation.speedThroughWater), where raw errors of 10% or more are common. It does this automatically from real-world observations—no manual calibration required. Leeway (navigation.leewayAngle) is derived from observed dynamics rather than formulas, and current is estimated only after speed is corrected, using a slowly adapting filter.

## Quick Start
1. Install / enable the plugin in the Signal K Server admin UI.
2. Open the plugin webapp (Signal K: Apps → Speed and Current).
3. Go to **Correction Table** and click **New** to create your first correction table (or use the default that was created for you).
4. Start learning by enabling **Correction Table Learning** in the webapp.
5. Once your correction table is filled enable **Boatspeed Estimation** in the webapp.
6. Watch the corrected speed, leeway, and current fields begin populating as data arrives. Initial stabilization may take some sailing at varying speeds and heel angles.

## Requirements & Data Inputs
The plugin automatically starts collecting and learning once enabled, but waits the first ~60 seconds before producing estimates to stabilize.

Required paths:
- navigation.speedThroughWater (raw paddle wheel speed)
- navigation.speedOverGround
- navigation.courseOverGroundTrue (true)
- navigation.headingTrue (true)
- navigation.attitude

## Output & Published Paths
After the initial ~60 second stabilization period the plugin starts sending the following Signal K paths:

| Purpose | Path(s) | Units | Notes |
|---------|---------|-------|-------|
| Corrected speed through water (magnitude) | navigation.speedThroughWater | m/s | navigation.speedThroughWater. Source attribute distinguishes plugin value from the original sensor. |
| Leeway angle | navigation.leewayAngle | rad | Angle (starboard positive) associated with corrected STW vector. |
| Water current speed | self.environment.current.drift | m/s | Magnitude of estimated water current over ground. |
| Water current set (direction) | self.environment.current.setTrue | rad | True direction (set) the current flows toward. |

Boat speed overwrite / duplication behavior:
- When the setting "Prevent speed duplication" = true (default): plugin overwrites navigation.speedThroughWater with corrected value.
- When false: both raw and corrected updates exist under navigation.speedThroughWater with distinct source attributes (viewable in deltas / data browser) allowing comparison.

Current vector representation: Published as polar (drift + set). Set angle is the direction the water moves toward (oceanographic convention). Verify tooling expectations if it assumes FROM direction.


## The correction table
At the heart of the plugin is a correction table that provides a correction vector based on observed boat speed and heel. The correction table is built and maintained by the plugin itself, no user input is required. The plugin can even build a correction table on tidal waters, although this feature is experimental and may not work properly under all circumstances.

Every time the paddle wheel provides a measurement the plugin does two things. First it corrects boat speed and estimates leeway and current using the correction table. Second, using boat speed, ground speed and current estimation the correction table is updated. So the correction table is used and updated simultaneously.

## Configuration
All settings are managed from the plugin webapp. The Signal K admin UI is not used for configuration.

### Core
| Setting | Default | Description | When to Change |
|---------|---------|-------------|----------------|
| Estimate Boat Speed | Off | Enables speed correction, leeway and current estimation. | Turn on after creating a correction table. |
| Update Correction Table | On | Learns / refines correction table. | Temporarily disable in abnormal conditions (heavy seas, abnormal current). |

### Learning & Stability
| Setting | Default | Description | Guidance |
|---------|---------|-------------|----------|
| Correction Table Stability | 7 | Higher = slower changes (more conservative). | Increase once table broadly populated; lower briefly if you think the sensor error has changed. |
| Assume Current (experimental) | Off | Learns table while assuming a current may be present. | Enable cautiously on tidal waters. |
| Show Statistics | Off | Displays σ (standard deviation) next to smoothed values. | Enable for debugging or to inspect signal quality. |

### Smoother
Controls how raw sensor signals are smoothed before being fed into the learning calculations. The smoother type and its parameter apply to heading, boat speed, ground speed, and attitude.

| Setting | Default | Description |
|---------|---------|-------------|
| Smoother type | Moving average (window) | Moving average (window), Exponential (τ), or Kalman filter. |
| Window (s) | 5 s | (Moving average) Integration window in seconds. Minimum 2 s. |
| Time constant τ (s) | 3 s | (Exponential) Exponential decay time constant in seconds. Minimum 1 s. |
| Steady-state gain | 0.2 | (Kalman) Kalman gain at steady state. Range 0.01–0.99. Lower = smoother but slower. |

### Table Dimensions
Table dimensions are set when creating or resizing a table via the webapp (New / Resize buttons). The parameters are:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Name | — | Identifier used as the filename on disk. |
| Max speed (kn) | 9 kn | Upper speed coverage. |
| Speed step (kn) | 1 kn | Speed increment for table rows. |
| Max heel (°) | 32° | Max absolute heel covered (± value). |
| Heel step (°) | 8° | Heel increment for table columns (positive & negative). |

### Data Sources (optional overrides)
| Setting | Description |
|---------|-------------|
| Heading Source | Force a specific source for navigation.headingTrue. |
| Boat Speed Source | Force a specific source for navigation.speedThroughWater. |
| Ground Speed Source (SOG Source) | Source for navigation.speedOverGround. |
| Attitude Source | Source for navigation.attitude (roll/heel). |

Leave a source blank or set to *(any)* to accept values from all sources. If multiple sources exist for a path, you can also set source priorities in the Signal K Server settings (under data sources).

### Output Behavior
| Setting | Default | Description | Notes |
|---------|---------|-------------|-------|
| Prevent speed duplication | On | Overwrites navigation.speedThroughWater with corrected value. | Disable to compare raw vs corrected via distinct source attributes under the same path. |
| Groundspeed fallback | Off | Copy navigation.speedOverGround (GPS) to navigation.speedThroughWater (Paddle wheel) if paddle wheel malfunction is detected. | Activates when navigation.speedThroughWater = 0 and navigation.speedOverGround > threshold. |

### Tips
1. Be patient with the correction table. Its corrections will improve over time.
2. Once corrections stabilize, raise Stability to lock in values.
3. Freeze learning (disable Update Correction Table) before performance-sensitive events (e.g., racing) or in unstable conditions (waves, currents).
4. After paddle wheel cleaning or if fouling suspected: temporarily LOWER Stability (e.g., from 7 → 5) to let corrections adapt, then raise again; do not rebuild unless the grid itself must change.
5. The plugin will always estimate currents when Estimate boat speed is enabled. Even when Assume currents is disabled, as this setting is only used in updating the correction table.

## Persistence & Data Storage
Each correction table is saved as a `.json` file in Signal K's plugin data directory (typically `~/.signalk/plugin-config-data/speedandcurrent/`). The active table name is stored in the plugin options and reloaded automatically on restart. While learning is active, the table is written to disk approximately every 5 seconds.

Safety & backup:
- Tables can be copied to a new name with the **Copy** button before experimenting.
- The data directory can be backed up directly; each table is a self-contained `.json` file.

## Experimental Note
The "Assume Current" option is experimental. It works best on a stable correction table as it takes time for the plugin to properly distinguish currents from paddle wheel errors. 

## WebApp Usage Guide
Open via Signal K Server: Apps → Speed and current.

The webapp has a collapsible sidebar with four sections, and a status message in the top-right of the nav bar (blue = stabilizing, amber = SOG fallback active, red = error or stopped). All settings changes take effect immediately — no plugin restart required.

### Inputs
The **Inputs** section contains two sub-sections:
- **Signal K Sources**: Drop-downs to pin specific Signal K sources for heading, boat speed, SOG, and attitude. Leave blank to accept any source.
- **Live Values**: Real-time display of the raw sensor values being fed into the plugin.

### Boatspeed Estimation
The **Boatspeed Estimation** section has an On/Off toggle at the top of the card and contains:
- **Settings**: `Groundspeed fallback` and `Prevent speed duplication`.
- **Inputs**: The raw signal values used for correction (heading, raw STW, SOG, attitude).
- **Intermediates**: Internally derived quantities including the speed correction vector, boat speed over ground, and residual.
- **Outputs**: Corrected boatspeed & leeway, and estimated current.

### Correction Table Learning
The **Correction Table Learning** section has an On/Off toggle and contains:
- **Settings**: Stability, Assume Current, and Show Statistics (σ display toggle).
- **Smoother**: Type selector (Moving average / Exponential / Kalman) and its single tuning parameter. Only the parameter relevant to the selected smoother is shown.
- **Inputs**: Smoothed values fed into the learning algorithm. When Show Statistics is on, σ values are shown.

### Correction Table
The **Correction Table** section shows the current correction table grid. Table management buttons appear top-right:
- **New** — create a new table, setting its name and grid dimensions.
- **Load** — switch to a previously saved table.
- **Copy** — duplicate the current table under a new name.
- **Resize** — resize the grid (existing cells are mapped to the new grid; some data may be lost).

Each populated cell shows:
- **Factor** (±%): how much the paddle wheel over- or under-reads at this speed and heel (green = reads slow, orange = reads fast).
- **Leeway** (°): the estimated sideways drift angle; also encoded visually as the stripe direction in the cell background.

Cell highlighting:
- **Blue outline**: the most recently updated table cell.
- **Dashed outline**: cells contributing to the current interpolation.
- **No content**: not yet populated by learning.

### Correction Table Health Checklist
- Leeway ≈ 0 at zero heel; increases logically with heel. Non-zero leeway at zero heel may indicate a heading offset.
- Speed corrections should trend consistently with adjacent cells (direction & magnitude smooth across the table).
- Port / starboard symmetry: similar magnitudes at ± matching heel angles. Large asymmetry can indicate a paddle wheel mounting offset.

### Interpreting Live Values
- **Corrected Speed vs Raw**: Stable, plausible separation between the two indicates the table is working.
- **Corrected speed** includes leeway and therefore is not aligned with the ship's axis.
- **Residual**: Remaining ground-speed discrepancy after applying corrected STW and estimated current. Should trend toward small values as learning progresses.
- **Trace**: Uncertainty indicator derived from internal variance (higher = less reliable). Shown alongside most values.



## How It Works


### 1. Speed Correction
- Vessel speed errors depend on **heel** and **speed** and are treated as locally constant within grid cells.
- The correction table stores a vector (magnitude & direction of sensor error) per (speed, heel) cell.
- A correction vector is computed by weighting (interpolation) of the nearest populated cells.
- The corrected speed-through-water vector = raw STW vector + correction vector (sign chosen so magnitude bias is reduced).

### 2. Leeway Estimation
- Leeway is derived from the angular difference between the corrected STW direction and the hull axis / heading reference.

### 3. Current Estimation
- The water current is estimated as a **slowly changing** ground-plane vector.
- A Kalman filter updates the current using residual between ground speed (GPS) and the heading-rotated corrected boat speed, weighted by estimated variances.
- ![current estimation model](https://github.com/Asw1n/speedandcurrent/raw/main/currentModel.png)

### 4. Correction Estimating
- Each populated cell maintains its own lightweight Kalman filter.
- For each incoming raw boat speed sample the instantaneous sensor error candidate is derived from boat speed, heel, heading, ground speed and (optionally) current.
- That error sample updates the cell’s Kalman state (mean correction vector + variance).
- Sensor and estimation variances are continuously updated; the displayed Trace in the webApp reflects confidence (higher = less reliable).
- ![correction model](https://github.com/Asw1n/speedandcurrent/raw/main/correctionModel.png)

## Glossary
- Set: Direction the water current flows toward (true angle).
- Drift: Magnitude (speed) of the water current over ground.
- Leeway: Lateral angular difference between boat’s heading axis and its actual movement through water (starboard positive).
- Residual: Remaining ground-speed vector difference after applying corrected STW and estimated current; indicator of modeling error and sensor noise.
- Stability (setting): Damps rate of change in learned corrections; higher = slower adaptation.
- Trace: Reported uncertainty indicator derived from internal variance (higher = less confidence in that vector/cell).
- Kalman filter: An adaptive algorithm that estimates the true value of a variable (such as speed or current) by combining noisy measurements and prior estimates, updating both the value and its uncertainty over time. Used here to refine correction vectors (cell-by-cell) and current estimates .

### Coordinate Frames
- Boat Plane: Vectors relative to hull axis (used for raw & corrected STW, leeway angle computation).
- Ground Plane: Vectors in earth-referenced frame (used for GPS ground speed, current, residual).


---


