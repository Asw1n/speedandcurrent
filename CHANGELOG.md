# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## Unreleased

### Added
- Correction-table files now use version 2 with per-cell update timestamps, capped time-based aging, and silent migration of existing version-1 files.
- The webapp now polls at the plugin's actual sample rate instead of a fixed 1s interval, reported via a new `pollIntervalMs` field on `/api/report`.
- Correction estimates now fuse mature nearby table cells using their full covariance and normalized distance, with an automatically estimated spatial variance, a two-cell search radius, and fusion-weight diagnostics in the webapp.

### Changed
- Correction interpolation now includes mature cells within 2.5 normalized grid-cell units.
- Correction learning now always uses a moving-average window of at least 5 seconds, with a one-second gap between observation windows. Older smoother selections migrate silently.
- Cells become eligible after one accepted observation; the explicit maturity gate remains in place at zero for future tuning.

### Fixed
- The boat-speed estimation inputs now prioritize Boatspeed unless groundspeed fallback is selected, and the correction table marks its most recently updated cell with a thin black border reflected in the legend.
- The learning status Reason row is now hidden when the last observation was accepted, instead of showing a redundant "Observation recorded" message.
- `navigation.state` no longer misreports as "not ready" a few seconds after each update; it is an event path that only publishes on transition, so the generic telemetry staleness timer no longer applies to it. The Inputs tab now also displays its current value.
- Learning and leeway are now gated on the vessel's own SOG-based moving/not-moving state, rather than solely on `navigation.state` freshness. Previously, an infrequent `navigation.state` update could go stale within seconds, silently letting learning continue while anchored or moored. `navigation.state`, when known and `suspendLearningOnNavigationState` is enabled, can still override to "not moving" (anchored/moored/motoring), but can no longer force "moving" against the vessel's own SOG.
- Webapp report parsing failures now remain visible and still refresh plugin status instead of aborting the polling tick.
- Disabled current estimation no longer publishes a zero-current value during plugin startup.
- Malformed correction tables now recover safely at startup, while explicit loads reject invalid files without replacing the active table.
- The correction-table Kalman filter now uses each observation's own measurement-noise covariance (already computed from live sensor variances) instead of a fixed identity matrix, so anisotropic and rotated observation uncertainty is correctly reflected in cell covariances. Persisted tables store a serializable model descriptor rather than the runtime model; existing table files still load unchanged.

## [2.3.4] - 2026-09-17

### Fixed
- Boat-speed startup now preserves synchronously replayed cached values, avoids restart errors, and keeps current estimation behind the startup stabilization period regardless of table-learning settings.
- Attitude roll handling now treats incomplete or stale values as invalid during correction-table learning, preventing fabricated heel-based corrections while the input is not yet usable.
- Webapp values and warnings now share per-path lifecycle status, distinguish subscribed and computed data, report polar magnitude and angle independently, and show stale raw inputs consistently across all pages.

## [2.3.3] - 2026-09-06

### Fixed
- `navigation.leewayAngle` no longer reports a correction-table artifact when the vessel is stationary. The lateral component of the table correction is now suppressed below the table speed step and while `navigation.state` is `anchored` or `moored`, so leeway is published as 0 instead of an angle derived from a near-zero speed. The longitudinal speed correction, and leeway while motoring, are unaffected.
- Updated `signalkutilities` to 3.1.2, which completes the 3.1.1 recovery fix for polar-backed inputs. Smoothed heading and the ground-speed vector are built on `Polar`/`PolarSmoother`, where the idle timer was still cleared rather than re-armed on each delta, so those inputs did not recover after going silent following a healthy start.

## [2.3.2] - 2026-09-04

### Fixed
- Updated `signalkutilities` to 3.1.1, so an input that goes silent *after* having delivered data is now detected and resubscribed. Previously recovery only ran for subscriptions that had never received a delta, meaning an upstream outage after a healthy start could leave the plugin dead until it was restarted.

## [2.3.1] - 2026-08-18

### Fixed
- Signal K admin styling now loads from standalone CSS records in current Vite manifests while retaining support for entry-associated CSS and older server fallbacks.

## [2.3.0] - 2026-08-16

### Added
- Learning status now distinguishes between active learning and observations that were skipped, rejected, or invalid, and the webapp reports the current reason more clearly.

### Changed
- Correction-table learning now uses automatic gates based on `navigation.state`, with `anchored` and `moored` always suspending learning when available and `motoring` optionally suspending it.
- The learning threshold for both STW and SOG now follows the active table speed-step size.
- The webapp no longer exposes a separate minimum-SOG learning setting.

### Fixed
- When learning is off or suspended, the webapp no longer keeps showing a stale previous observation result.

## [2.2.1] - 2026-08-14

### Fixed
- Input subscriptions now recover automatically after idle or stale periods, and the webapp exposes lifecycle warnings for affected paths.
- Corrected output paths are now explicitly cleared with `null` when estimation is disabled or when the plugin stops, preventing stale values from lingering on the Signal K bus.
- The webapp-facing status and report endpoints now reflect the plugin's current runtime state more directly.
- SOG fallback now checks raw STW (`rawBoatSpeed`) directly when detecting a zero paddlewheel reading, avoiding dependence on the derived corrected speed value.

## [2.1.2] - 2026-07-23

### Fixed
- App Store icon was missing (monogram fallback shown): added `icon.png` at the package root so the App Store CDN can fetch it from the npm tarball via unpkg.com. The runtime `signalk.appIcon: ./icon.png` path is unchanged - the server still serves it from `public/icon.png` via the webapp mount.
- Updated `signalkutilities` to 3.0.1, fixing continuous 401 log flooding on SK servers with security enabled and anonymous read access disabled.

## [2.1.1] - 2026-07-20

### Fixed
- Sidebar toggler was unreachable on mobile viewports.

### Changed
- Updated `signalkutilities` dependency to `^3.0.0` (removes `PolarTable` from the shared library; no behaviour change for this plugin).

## [2.1.0] - 2026-07-10

### Added
- `null` is written to corrected boat speed (`navigation.speedThroughWater`, `navigation.leewayAngle`) and current (`environment.current.drift`, `environment.current.setTrue`) paths when `estimateBoatSpeed` is toggled off.
- `null` is written to all active output paths (current, corrected boat speed) when the plugin stops, preventing stale values on the SK bus.

## [2.0.2] - 2026-6-18
### Fixed
- The plugin icon was not displayed in the Signal K App Store because the icon path in the package metadata was incorrect.
- Test files are no longer included in the published npm package.

## [2.0.1] - 2026-6-17
### Fixed
- Correction table reporting was doing unnecessary work on every update, causing higher CPU use especially on low-power hardware such as a Raspberry Pi.
- The variance values used for interpolating between correction table cells were calculated with an incorrect formula, causing them to be overestimated. This made the Kalman outlier gate slightly less accurate.

## [2.0.0] - 2026-6-17
### Changed
- Moving average smoother is now O(1) in both CPU and memory: it no longer slows down or uses more memory as the window size grows.

- **Breaking:** Requires `signalkutilities` v2.0.0. Source-selection and pass-through machinery has been removed from the library; Signal K Server now handles source priorities natively.
- Per-path source settings (`headingSource`, `boatSpeedSource`, `SOGSource`, `attitudeSource`) have been removed. Use Signal K Server's built-in source priority configuration instead.
- The **Prevent Speed Duplication** setting has been removed. The server's `excludeSelf` behaviour and source priorities replace it.

### Removed
- Source dropdowns in the webapp Inputs section.
- Source-related fields from persisted plugin configuration. A one-time migration strips these fields automatically on first start with the new version.

### Added
- Documentation explaining how to configure Signal K source priorities so that the corrected `navigation.speedThroughWater` is delivered to all consumers.

## [1.7.10] - 2026-5-14
### Fixed
- Removed incorrect `self.` prefix from Signal K paths.

## [1.7.9] - 2026-5-14
### Added
- Learning status indicator in the webapp showing whether the correction table is active, stabilising, or off, and whether the last observation was accepted, rejected, invalid, or below threshold.
- Outlier rejection using Mahalanobis distance: bad observations are discarded before being fed into the Kalman filter, preventing a single bad sample from corrupting a cell.

### Fixed
- Smoothed learning inputs are now always registered in the reporter regardless of whether `updateCorrectionTable` is enabled, so warnings clear correctly when learning is toggled on at runtime.

## [1.7.8] - 2026-5-14
### Added
- Legend below the correction table explaining factor / leeway values, background colour coding, stripe direction, active cell, and neighbour cell indicators.

### Fixed
- Correction table learning never started when `assumeCurrent` is off.
- Active cell highlighting (most recently updated cell) was not visible.

## [1.7.7] - 2026-5-13
### Added
- Optional staleness detection for inputs.
- Precise warnings on state of inputs.

## [1.7.5] - 2025-11-19
### Added
- New webApp.
- WebApp allows to change plugin configuration while the plugin is running.
- Support for multiple correction tables (new, copy, delete).
- Support for altering the dimensions of a correction table (alter).
- Better edge case handling.
- User selectable options for smoothing method and smoothing parameters.
- Support for unitPreferences.

### Fixed
- Bug where navigation.speedThroughWater was removed from the signalk bus.

### Removed
- Possibility to set options via the signalk plugin configuration.

## [1.6.0] - 2025-11-19
### Added
- Option to copy navigation.speedOverGround to navigation.speedThroughWater when speedThroughWater is not properly measured. Thanks to Jean-Laurent Girod for the suggestion.

## [1.5.1] - 2025-10-06
### Fixed
- Bug preventing current to be displayed in KIP.

## [1.5.0] - 2025-10-06
### Changed
- Separate loops for correcting speed and for updating correction factors.
- Speed correction loop uses raw values.
- Updating correction factors using moving averages.
- Unified cell rendering driven by "Show" selections; removed the previous Table style toggle.

### Added
- Option to set the source for input paths.
- Full integration of uncertainty estimations (variance) in estimations and corrections.
- Ability to resize the correction table without losing all correction data.
- WebApp: "Show" multi-select to choose per-cell metrics (correction X/Y, factor, leeway, trace, N) for the correction table.
- WebApp: Color mode options for the correction table.
- WebApp: Persistence for speed unit, angle unit, color mode, and shown metrics via localStorage.

### Fixed
- Angles are now reported in the appropriate range, 0 to 2 * PI or -PI to PI, depending on path.

## [1.1.0] - 2025-8-20
### Changed
- Path names for current. It now is self.environment.current.setTrue and self.environment.current.drift.

### Fixed
- Case error in filename that prevented the webapp from displaying the correction table.
- Corrected speed through water is now calculated when the correction table is fixed.

## [1.0.1] - 2025-1-27
### Added
- Basic functionality to estimate speed, leeway and current using Kalman filters.
- Basic functionality for a webapp that shows what is going on.
