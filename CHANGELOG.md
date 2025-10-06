# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [1.0.1] - 2025-1-27
### Added
- basic functionality to estimate speed, leeway and current using Kalman filters
- basic functionality for a webapp that shows what is going on

## [1.1.0] - 2025-8-20
### Changed
- Path names for current. It now is self.environment.current.setTrue and self.environment.current.drift
### Fixed
- Case error in filename that prevented the webapp from displaying the correction table
- Corrected speed through water is now calculated when the correction table is fixed

## [1.5.0] - 2025-10-06
### Changed
- Seperate loops for correcting speed and for updating correction factors
- Speed correction loop uses raw values
- Updating correction factors using moving averages 
- Unified cell rendering driven by "Show" selections; removed the previous Table style toggle
### Added
- Option to set the source for input paths
- Full integration of uncertainty estimations (variance) in estimations and corrections.
- Ability to resize the correction table whithout loosing all correction data.
- WebApp: "Show" multi-select to choose per-cell metrics (correction X/Y, factor, leeway, trace, N) for the correction table
- WebApp: Color mode options for the correction table
- WebApp: Persistence for speed unit, angle unit, color mode, and shown metrics via localStorage
### Fixed
- Angles are now reported in the appropriate range, 0 to 2 * PI or -PI to PI, depending on path

## [1.5.1] - 2025-10-06
### Fixed
- Bug preventing current to be displayed in KIP.

