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

