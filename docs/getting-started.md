# Getting started

## Requirements

- **Node 22.12 or newer** — `.nvmrc` pins `22.12.0`, and `doctor` fails below it
- **Python 3.11 or newer** — only for the deterministic engine. `doctor` probes it by actually
  running it, not by checking that a file exists.

The engine is a dependency-free Python package, so there is nothing to `pip install`: it is
invoked as a module from `services/engine/src`.

## Install

Clone the repository, then from the repository root:

```bash
npm install
npm run build
```

`npm run build` is required before anything else: the CLI, the MCP server and the stdio proof all
load from `packages/*/dist/`, not from source.

## Verify the install

```bash
node packages/cli/dist/bin.js doctor
```

```console
odometry-scope doctor
  [PASS] node           v22.23.2
  [PASS] package        odometry-scope@0.1.0
  [PASS] skills         4 skills, 0 invalid
  [PASS] plugins        3 active, 0 disabled
  [WARN] config         no product.config.json — using defaults
         fix: run with defaults, or create product.config.json
  [PASS] python engine  reachable, 2-sample probe ok
  [PASS] sample runs    3 analysed runs committed

all required checks passed
```

Read the row that matters most: `python engine reachable, 2-sample probe ok`. That is a real round
trip through the subprocess bridge. If it says `fail`, nothing in this product will work, and the
row carries the fix hint.

The `config` warning is expected on a fresh clone — everything works on defaults. It is a warning,
not a failure, and `doctor` still exits `0`.

The binary is named `odoscope`, but because the CLI is a leaf workspace package `npm install` does
not link it into `node_modules/.bin`. That is why the examples use
`node packages/cli/dist/bin.js`. If you install the CLI package as a dependency, `odoscope` is the
same program.

## Your first run

Three sample runs ship with the repository. Start with the one this product was built for — the
wheel encoders are lying:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/wheel-scale-drift.json
```

```console
odoscope — Corridor circuit — 2% wheel over-report

  481 samples · 24.0s · 20.0 Hz · 22.44 m path

  DRIFT ENVELOPE
  |================================================================| bound
  |xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx    | observed  (. inside, x escaped)
  |^ first escape at t=0.05s
  peak observed 0.2818 m against a 0.0111 m bound

  SENSOR ABLATION
    imu     drift without it 0.0828 m      explained  -23.4%  masking
    lidar   drift without it 0.0940 m      explained  -40.1%  masking
    wheel   drift without it 0.0027 m      explained   96.0%  primary

  VERDICT
    [DRIFT] unbounded
    drift escaped the certified envelope at step 1 (peak 0.282m against a 0.011m bound, ratio 25.28); sensor 'wheel' explains the most of it
```

Now run the healthy one, because a tool that only ever reports drift is worthless:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/clean-run.json
```

That one comes back `[ok] certified`, with no caret line, because nothing escaped the envelope.

## What you are looking at

- **The top band** is the **bound**: how far the drift is allowed to be, given the sensor
  uncertainty stated in the run document's `params`.
- **The line below it** is the **observed** drift, one character per sampled step. `.` while
  inside the band, `x` once it has escaped.
- **The caret** marks the first escape and its timestamp.
- **The ablation table** removes each sensor in turn, renormalises the remaining fusion weights,
  re-integrates, and reports the drift left. A large positive number means that sensor explained
  the drift. A **negative** number means it was _masking_ drift — with it removed, things got
  worse.
- **The verdict** carries both a severity and a confidence. `certified` means the drift stayed
  inside the envelope and the bound still holds. `unbounded` means it escaped, and there is no
  longer a bound to quote.

## Use it as a gate

`--strict` makes an escaped bound a failure, so drift can break CI instead of being smoothed into
a confidence:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/wheel-scale-drift.json --strict
```

Exits `1`. Run it against `clean-run.json` and it exits `0`.

## Analyse your own run

A run document needs three blocks: the fused `estimate`, the `truth` reference track, and
`sensors` — a map of per-sensor `v`/`omega` series with a fusion `weight`. Columnar parallel
arrays, not one object per sample.

```json
{
  "id": "my-run",
  "name": "Dock approach",
  "rateHz": 20,
  "params": { "rateSigma": 0.01, "rateSigmaOmega": 0.005 },
  "estimate": { "t": [], "x": [], "y": [], "theta": [], "v": [], "omega": [] },
  "truth": { "t": [], "x": [], "y": [], "theta": [] },
  "sensors": {
    "wheel": { "v": [], "omega": [], "weight": 0.5 },
    "imu": { "v": [], "omega": [], "weight": 0.5 }
  }
}
```

Then point `run` at it. Use `list_skills`' `ingest-recording` skill if your raw log is not yet in
this shape — the engine accepts common field aliases (`yaw`, `time`, `speed`), but a run document
still needs the three blocks before it can name a liar.

`params.rateSigma` is the assumed 1-sigma relative uncertainty in the speed channel (default
`0.01`), and it is the assumption your verdict rests on. State it deliberately.

## Explore the tools

```bash
node packages/cli/dist/bin.js tools
node packages/cli/dist/bin.js mcp call list_skills '{}'
```

## Run the tests

```bash
npm test              # TypeScript, every package
npm run pytest        # the Python engine, including hypothesis property tests
```

If you only need one side, `python -m pytest services/engine -q` and `python -m mypy --strict
services/engine/src` are fast. See [troubleshooting.md](troubleshooting.md) if the property tests
disagree with you.

## Connect an agent

```bash
node packages/cli/dist/bin.js mcp serve
```

Client configuration and the full tool surface are in [mcp.md](mcp.md). To check the protocol
end-to-end:

```bash
node packages/mcp/dist/stdio-proof.js
```

## Regenerate the sample runs

```bash
python scripts/generate-runs.py
```

This rebuilds all three run documents **and** their committed analyses by running the real engine.
It is deterministic: running it twice produces byte-identical files.
