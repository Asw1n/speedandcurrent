## AI Assistant Project Guidance

This repository contains a Signal K server plugin plus a lightweight browser WebApp served from `public/`.

Key points for automation:
1. Plugin entrypoint: `index.js` exports a factory returning a Signal K plugin object with `start`, `stop`, and optional `registerWithRouter`. The plugin registers HTTP routes `/getResults` and `/getVectors` under the plugin mount path (normally `/plugins/speedandcurrent`).
2. Runtime model: On `start(settings)` it (a) loads/persists a Kalman‑based correction table (`correctionTable.js`), (b) creates smoothed data handlers from `signalkutilities` (heading, attitude, STW, SOG, current), (c) wires periodic correction + learning when new STW samples arrive.
3. Data flow (simplified):
	Raw sensors (heading, attitude, STW, SOG, COG) -> smoothing wrappers -> correction table lookup/interpolation -> corrected STW + leeway -> current estimation (slow Kalman) -> residual -> reporter -> HTTP JSON for WebApp.
4. WebApp (`public/`): Pure static assets (no build step). `index.html` loads `app.js` and `vectors.js`; these poll JSON endpoints every second and render:
	- Vector tables (polar magnitudes/angles, traces) 
	- Deltas (single value + variance)
	- Attitude
	- Correction table heatmap via `TableRenderer.js` (neighbors shaded, last-updated cell highlighted).
5. Persistence: Correction table JSON stored inside plugin options via `saveTable()` roughly every 5s while learning. Table shape controlled by settings: `speedStep`, `maxSpeed`, `heelStep`, `maxHeel`; changing shape invalidates old table.
6. Correction logic: For each STW sample, `table.getCorrection(speed, heel)` does neighbor weighting (inverse distance + variance aware) to produce a correction vector (x longitudinal bias, y lateral). Corrected boat speed = raw + correction. When well underway (>60s, speed threshold), if learning enabled it updates each cell’s Kalman state with derived observation (`CorrectionEstimator`).
7. Current estimation: Difference between ground speed and corrected (heading-rotated) STW becomes a sampled current vector; smoothed via Kalman with very low process variance (slow drift).
8. Settings flags: `estimateBoatSpeed` toggles applying corrections & publishing outputs; `updateCorrectionTable` toggles learning; `assumeCurrent` decides whether to include current in per-cell error observation (otherwise a zero-current placeholder is used); `preventDuplication` controls whether raw STW is also forwarded.
9. Key classes/files: `correctionTable.js` (Kalman per-cell estimator + interpolation), `correctionTable LSQ.js` (legacy/experimental LSQ approach—currently unused by plugin start), `leakyExtremes.js` (independent utility, not yet integrated), `TableRenderer.js` (DOM table + optional surface plot), `vectors.js` (SVG vector visualisation), `kalmantest.js` (dev scratchpad; don’t depend on it).
10. External deps: `signalkutilities` provides smoothing abstractions (`SmoothedHeading`, `PolarSmoother`, etc.) and value sending (`Polar.send/PolarSmoother.send`). `kalman-filter` supplies general Kalman primitives used in correction cells.
11. Adding new output vectors: Instantiate a `Polar` (or smoother), set display attributes (`label`, `plane`), add to `Reporter` object (`reportFull` or `reportVector`), and ensure you call appropriate `send()` after updates.
12. Extending table logic: Favor enhancing `CorrectionEstimator.getFilterModel(stability)` for tuning rather than rewriting interpolation. Maintain JSON schema compatibility (`row`, `col`, `table`) to avoid breaking persisted data.
13. Error handling: Functions silently return when inputs invalid (NaN / non-finite); keep that pattern—avoid throwing inside hot update loops to prevent flooding Signal K logs.
14. Performance: Hot path is STW `onChange` handler. Keep per-sample work minimal (no synchronous heavy DOM or large allocations). Batch additional metrics inside existing handler if needed.
15. WebApp changes: No bundler—use ES module relative imports. Keep new scripts small and reference via `<script type="module">` to avoid adding a build pipeline unless absolutely necessary.

When authoring code:
- Do not introduce asynchronous waits inside the STW sample callback; it must remain synchronous.
- Preserve existing setting names to avoid breaking saved configs.
- Prefer adding new settings at end of `plugin.uiSchema['ui:order']` and schema properties block.
- Guard new math with `Number.isFinite` checks mirroring existing style.

Ready for enhancement tasks: (a) additional diagnostics vectors, (b) export/import of table JSON, (c) optional graphical smoothing parameters—ensure backward compatibility.

Please request clarification before refactoring cross-cutting data flow (correction + current estimation) or introducing a build step.

End of instructions.
