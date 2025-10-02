# Speed Correction & Current Estimation Plugin

## Overview
This SignalK plugin estimates **corrected speed through water**, **leeway**, and **water current (drift)** in real-time using adaptive sensor fusion and statistical filtering. It continuously refines its estimates based on vessel speed, heading, ground speed, and heel angle. Its primary goal is to significantly improve paddle wheel speed (navigation.speedThroughWater), where raw errors of 10% or more are common. It does this automatically from real-world observations—no manual calibration required. Leeway (navigation.leewayAngle) is derived from observed dynamics rather than formulas, and current is estimated only after speed is corrected, using a slowly adapting filter.

## Quick Start
1. Install / enable the plugin in the Signal K Server admin UI.
2. Specify the dimensions of the correction table in the plugin settings.
3. Enable the plugin.
4. Open the plugin's WebApp from the Signal K App list.
5. Watch the corrected speed, leeway, and current fields begin populating as data arrives. Initial stabilization may take some sailing at varying speeds and heel angles.

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
- When the setting "Prevent duplication of boat speed" = true (default): plugin overwrites navigation.speedThroughWater with corrected value.
- When false: both raw and corrected updates exist under navigation.speedThroughWater with distinct source attributes (viewable in deltas / data browser) allowing comparison.

Current vector representation: Published as polar (drift + set). Set angle is the direction the water moves toward (oceanographic convention). Verify tooling expectations if it assumes FROM direction.


## The correction table
At the heart of the plugin is a correction table that provides a correction vector based on observed boat speed and heel. The correction table is built and maintained by the plugin itself, no user input is required. The plugin can even build a correction table on tidal waters, although this feature is experimental and may not work properly under all circumstances.

Every time the paddle wheel provides a measurement the plugin does two things. First it corrects boat speed and estimates leeway and current using the correction table. Second, using boat speed, ground speed and current estimation the correction table is updated. So the correction table is used and updated simultaneously.

## Configuration
All settings are managed from the Signal K Server plugin configuration UI.

### Core
| Setting | Default | Description | When to Change |
|---------|---------|-------------|----------------|
| Estimate Boat Speed | false | Enables speed correction, leeway and current estimation. | Normally on. |
| Update Correction Table | true | Learns / refines correction table. | Temporarily disable in abnormal conditions (heavy seas, abnormal current). |
| Start with new table | false | Discards existing table and starts fresh. | Only if you want to start all over with correcting. |

### Learning & Stability
| Setting | Default | Description | Guidance |
|---------|---------|-------------|----------|
| Correction Table Stability | 7 | Higher = slower changes (more conservative). | Increase once table broadly populated; lower briefly if you think the sensor error has changed. |
| Assume Current (experimental) | false | Learns table while assuming a current may be present. | Enable cautiously on tidal waters. |

### Table Definition
| Setting | Default | Description |
|---------|---------|-------------|
| Step size for speed | 1 kn | Speed increment for table rows. |
| Maximum speed in table | 9 kn | Upper speed coverage. |
| Step size for heel | 8° | Heel increment for table columns (positive & negative). |
| Maximum heel in table | 32° | Max absolute heel covered (± value). |

### Data Sources (optional overrides)
| Setting | Description |
|---------|-------------|
| Heading Source | Force a specific source for navigation.headingTrue. |
| Boat Speed Source | Force a specific source for navigation.speedThroughWater. |
| Course over ground (COG Source) | Source for navigation.courseOverGroundTrue. |
| Ground Speed Source (SOG Source) | Source for navigation.speedOverGround. |
| Attitude Source | Source for navigation.attitude (roll/heel). |

If there are multiple sources available for a single path, one should specify the preferred source for the plugin. Alternatively, one could set source priorities in the signalK server settings (under data sources).

### Output Behavior
| Setting | Default | Description | Notes |
|---------|---------|-------------|-------|
| Prevent duplication of boat speed | true | Overwrites navigation.speedThroughWater with corrected value. | Disable to compare raw vs corrected via distinct source attributes under same path. |

### Tips
1. Be patient with the correction table. Its corrections will improve over time. 
2. Once corrections stabilize, raise Stability to lock in values.
3. Freeze learning (disable Update Correction Table) before performance-sensitive events (e.g., racing) or in unstable conditions (waves, currents).
4. Changing table parameters will destroy the current table.
5. After paddle wheel cleaning or if fouling suspected: temporarily LOWER Stability (e.g., from 7 → 5) to let corrections adapt, then raise again; do not rebuild unless the grid itself must change.
6. The plugin will always estimate currents when Estimate boat speed is enabled. Even when Assume currents is disabled, as this setting is only used in updating the correction table.

## Persistence & Data Storage
The correction table is persisted inside the plugin configuration (saved approximately every 5 seconds while learning). It is reloaded automatically on restart.

Safety & backup:
- If you have a well-populated table, consider copying the plugin configuration JSON (via server backup) before major changes.

## Experimental Note
The "Assume Current" option is experimental. It works best on a stable correction table as it takes time for the plugin to properly distinguish currents from paddle wheel eerors. 

## WebApp Usage Guide
Open via Signal K Server: Apps → Speed and current.

### Layout & Elements
| Element | What You See | Notes |
|---------|--------------|-------|
| Graphical vector panel | Heading, raw & corrected boat speed, ground speed, current, correction, residual | Drawn with consistent color coding (see below). |
|Deltas| the different inputs and outputs to the plugin along with their uncertainty (trace)| For some paths also smoothed values are shown. The smoothed values are used to update the correction table| 
| Correction table grid | 2D heel (columns) × speed (rows) cells containing correction vectors | Displays interpolated usage & last-updated cell highlighting. |

- Labels and graphical vectors use corresponding colors.
- Green text (selectedCell): the most recently updated table cell.
- Blue background shading: cells contributing to the current interpolation. Deeper blue = higher interpolation weight.
- Empty cells: not yet populated by learning (appear without vector magnitude / direction details initially).
- Trace is an indication of the uncertainty of the measurement or estimatin. The higher the Trace the less reliable the corresponding value is.

### The menu
The menu allows you to:
- select the unit of choice for speed and angle
- select a polar(magnitude + angle)  or cartesion (x and y speed) based representation of the correction table.
- pause the regular updates

### Interpreting Vectors
- Corrected Speed vs Raw: Convergence occurs when their magnitudes diverge by a stable, plausible bias and the correction vector stops oscillating wildly. 
- The corrected speed includes leeway, it therefore is not aligned with the ships axis.
- Residual: This is the part of the observed speed that is not explained by the sensor error or current estimation. Should trend toward small values as learning progresses.

### Correction Table Health Checklist
- Leeway ≈ 0 at zero heel; increases logically with heel. Non‑zero leeway at zero heel may indicate heading offset.
- Correction vectors should be visually consistent with adjacent cells (direction & magnitude trend smoothly).
- Port / starboard symmetry: similar magnitudes at ± matching heel angles. Large asymmetry can indicate paddle wheel misalignment with the longitudal axis of the boat or off‑center mounting.



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


