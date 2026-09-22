# Correction-table learning model

## Smoothing cadence

Learning inputs always use `MovingAverageSmoother`. The configurable `smootherTimeSpan` is the observation-window duration and is clamped to a minimum of 5 seconds. The learning interval is:

```text
learningInterval = smootherTimeSpan + 1 second
```

The extra second separates observation windows. Legacy exponential/Kalman smoother selections and their obsolete parameters are removed silently; a valid legacy window is retained and shorter windows become 5 seconds.

## Cell aging

Each learned cell stores the UTC epoch-millisecond timestamp of its last accepted observation. Its persisted posterior covariance is never changed by a read. At time `t`, the covariance used by the learner is aged by:

```text
effectiveDt = min((t - lastAcceptedAt) / 1000, 90 days)
Q(dt) = Q_rate * effectiveDt * I
```

The 90-day value is an internal constant. Offline time counts toward `effectiveDt`; once the cap is reached, additional offline time has no effect. The aged covariance is used consistently for Mahalanobis gating, Kalman filtering, interpolation, reporting, and spatial-q estimation. A rejected observation leaves the timestamp unchanged. An accepted observation stores the posterior covariance and current timestamp.

## Eligibility and spatial q

`MIN_CELL_INDEX` remains an explicit maturity gate and is currently zero. A cell is eligible only when `cell.N > MIN_CELL_INDEX`, so one accepted observation is sufficient. The same condition is used by interpolation and spatial-q pair selection. The index remains persisted and exposed in diagnostics.
The user-facing process-noise setting is **Correction drift**, expressed in knots per month. A month is defined as 30 days. Internally the value is converted to the SI `processNoiseRate` in `(m/s)^2` per second. The default is 0.3 knots/month; the UI range is 0.0 to 3.0 in 0.1 increments.

## File compatibility

Schema version 1 is the historical format and is preserved in `correction-table-v1.schema.json`; the existing `correction-table.schema.json` filename remains a compatibility alias. Schema version 2 adds `schemaVersion: 2`, per-cell `lastAcceptedAt` timestamps, and the serializable current model descriptor, including the SI `processNoiseRate`. The former `stability` descriptor is accepted only for compatibility with older files and is not written by new tables.

Legacy files without a discriminator and files marked version 1 are migrated on load. Every learned legacy cell receives the file's `mtimeMs`, because individual cell ages are unavailable. This is a conservative estimate. Empty cells receive `null`. If filesystem metadata is unavailable, load time is used and the fallback is recorded through debug logging. The original file is replaced only after successful deserialization and validation, using an atomic temporary-file rename. Loading an existing version-2 file never rewrites its timestamps.
