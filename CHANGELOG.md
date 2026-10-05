# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

## [0.1.0] - 2026-01-01

### Added

#### The product

- **Odometry Scope** — determines which sensor caused a robot's pose estimate to drift, by
  comparing the fused estimate against a reference track inside a propagated error envelope and
  then ablating each sensor in turn: removing its contribution, renormalising the remaining fusion
  weights, re-integrating, and reporting how much drift it explained.
- Sensor verdicts of `primary`, `contributing`, `negligible`, `masking` and `sole-source`. A
  **negative** explained fraction is a real outcome, not a bug: it means the sensor was *masking*
  drift that the rest of the stack would otherwise have shown.
- `odoscope run <file>` — the flagship command. Prints the envelope strip, the ablation table and a
  verdict, with `--json`, `--strict` and `--max-steps <n>`.
- Three shipped sample runs, each carrying the planted defect in its own `notes` so a reader can
  check the finding against the input:
  - `wheel-scale-drift` — `drifting` / `unbounded`, peak 0.2818 m against a 0.0111 m bound, ratio
    25.28, `wheel` explains 96.0%.
  - `imu-yaw-bias` — `drifting` / `unbounded`, peak 0.0230 m against a 0.0096 m bound, ratio
    2.40, `imu` explains 100.0%.
  - `clean-run` — `ok` / `certified`, ratio 0.29, nothing escapes. This is the case that proves the
    tool does not manufacture findings.
- `python scripts/generate-runs.py` — regenerates the runs **and** their committed analyses by
  running the real engine. Deterministic: two runs produce byte-identical output.

#### The deterministic engine

- `services/engine`, a dependency-free Python package invoked as a **pure function** over
  stdin/stdout. No server, no port, no daemon, no clock, no network, no randomness, no filesystem.
  `mypy --strict` clean, property-tested with `hypothesis`.
- Six operations, each a pure function:
  - `normalize` — canonicalise a raw log into typed channels, accepting common field aliases
    (`yaw` for `theta`, `time` for `t`, `speed` for `v`) and sorting by time.
  - `integrate` — dead-reckon a pose from rates with **RK4 plus step-doubling error control**.
  - `divergence` — measure drift against a propagated error envelope, reporting per-step
    observed-versus-bound, the first exceedance and the worst ratio. With `strict`, raises
    `BOUND_VIOLATION` instead of quoting a confidence the numerics did not earn.
  - `attribute` — ablate one sensor at a time and report how much drift it explained.
  - `classify` — turn an envelope and an attribution into a bounded verdict, keeping `certified`
    and `unbounded` distinct.
  - `summarize` — reduce a run to the numbers an operator reads first.
- **Columnar storage end to end** — samples are parallel arrays, not one object per sample, so a
  200k-sample track is six contiguous buffers and every consumer sweeps a channel linearly.
- **A random-walk error envelope**, accumulating injected per-step uncertainty as a sum of squares so
  the bound grows like `sqrt(steps)`. Because a systematic bias grows like `t`, it escapes almost
  immediately, and that escape is the detection signal. See
  [ADR 0004](docs/adr/0004-why-a-random-walk-envelope.md).

#### The surfaces

- **The narrow waist** — one `Tool` interface and one `ToolRegistry`, reachable from the CLI, the
  web app, the MCP server and every channel. Ten tools; a surface is a transport, never a second
  implementation.
- `odoscope doctor` — subsystem probes with a fix hint per failing row. The Python engine is probed
  by **actually calling it**, not by checking that a file exists. Exit codes are `0` ok, `1` runtime
  failure, `2` usage error.
- `odoscope tools`, `odoscope version`, `odoscope mcp serve`, `odoscope mcp call <tool> '<json>'`.
- An MCP server exposing all ten tools over stdio, plus an MCP client. Tool descriptors are derived
  from the core registry, so there is no second list to drift.
- `packages/mcp/dist/stdio-proof.js` — a real MCP client driving the real server over real stdio:
  handshake, tool listing, an `analyze_run` call that reaches the Python engine, an assertion that
  the wheel is named, and a deliberately invalid call proving the error envelope survives the round
  trip.
- Four skills loaded from disk: `triage-drift`, `judge-envelope`, `ingest-recording`,
  `prove-a-finding`. An invalid skill is reported with a file and a line, never silently skipped.
- The plugin registry with manifest validation and priority conflict resolution; a shadowed plugin
  is reported rather than dropped.
- SQLite storage with WAL, numbered migrations, FTS5 search, and a columnar run store writing
  little-endian `Float64Array` blobs through `DataView` so the round trip is exact on any host
  endianness.
- A server-rendered web observatory that imports no workspace package.

#### Documentation and gates

- Six policy gates, run by `npm run check`: `check:skill-version`, `check:no-secrets`,
  `check:theme-tokens`, `check:boundaries`, `check:public-hygiene`, `check:readme-commands`.
- `check:readme-commands` is the anti-rot gate for this file: it fails if any `npm run` in the
  README is not a real script, or if a declared binary is never mentioned. Every command in the
  README was run to produce the output shown there.
- [ADR 0004](docs/adr/0004-why-a-random-walk-envelope.md) — why the envelope is a random walk, with
  the measured worst-case comparison (0.011147 m shipped against 35,254,370 m for `(1+v·h)^k`).
- [ADR 0005](docs/adr/0005-committed-analyses-for-the-web-tier.md) — why the web tier renders
  committed analyses, and how `packages/cli/src/runs.test.ts` recomputes every run through a live
  engine call to keep the deployed site honest.

### Deliberately omitted

Stated rather than accidental, because an omission with no reason is indistinguishable from
unfinished work:

- **No LLM providers.** `packages/providers` ships the interface and zero adapters. A model in the
  loop would make the error envelope unfalsifiable, and falsifiability is the one property this
  product exists to protect.
- **No chat interface.** The output is a verdict and an envelope plot, not a conversation. A chat
  box would invite exactly the unsupported confidence the engine is built to refuse.

[Unreleased]: https://github.com/aniruddhaadak80/odometry-scope/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aniruddhaadak80/odometry-scope/releases/tag/v0.1.0