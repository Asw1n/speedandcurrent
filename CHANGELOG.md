# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [Unreleased]

### Fixed
- `signalk.appIcon` path corrected to `./public/icon.png` so the App Store CDN resolves the icon from the npm tarball instead of showing the monogram fallback.

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
