---
name: ingest-recording
description: Use when a recorded robot log is not yet a run document, because the engine accepts common field aliases but a run needs estimate, truth and per-sensor blocks before it can name a liar.
metadata:
  version: 1.0.0
---

# Ingest a recording

## When to use this

You have a log — a bag export, a CSV, a JSON array of samples from a real recorder — and you
need it in the shape `analyze_run` accepts.

## Samples are columnar

The engine stores a sample series as **parallel arrays**, not as one object per sample:

```json
{ "t": [...], "x": [...], "y": [...], "theta": [...], "v": [...], "omega": [...] }
```

This is deliberate: every consumer sweeps a whole channel linearly, so a 200k-sample track is
six contiguous buffers instead of 200k objects to allocate, parse and walk. It is why the
divergence sweep stays cheap at bag-file sizes.

It also means every column in a block must be **the same length**. `engine_divergence` rejects a
block whose columns disagree with `LENGTH_MISMATCH` naming each column's length.

## Step 1 — canonicalise the raw log

Call `engine_normalize` with `samples` set to the raw sample objects. It accepts the field
aliases real recorders use, so nothing has to be hand-edited first:

| Canonical | Accepted aliases                        |
| --------- | --------------------------------------- |
| `t`       | `t`, `time`, `stamp`                    |
| `x`       | `x`, `px`                               |
| `y`       | `y`, `py`                               |
| `theta`   | `theta`, `yaw`, `heading`               |
| `v`       | `v`, `speed`, `linear_velocity`         |
| `omega`   | `omega`, `yaw_rate`, `angular_velocity` |

Keys are matched case-insensitively and unrecognised keys are ignored, so extra metadata in a
row is harmless. From the CLI:

```bash
odoscope mcp call engine_normalize '{"samples":[{"time":0,"px":0,"py":0,"heading":0,"speed":1.2,"angular_velocity":0}]}'
```

Read four fields of the result before going further:

- `channels` — the canonical columnar block to build the run from.
- `presentFields` — which channels the log actually carried. Compare this against what you need.
- `reordered` — `true` when the log arrived out of time order and `normalize` sorted it. It is
  reported on its own rather than in `issues`, because it describes how the input arrived rather
  than what the data is. Sorting again is idempotent.
- `rateHz` and `durationS` — a sanity check that you loaded the window you meant to. A rate of
  `0.0` means fewer than two samples, which no later operation can use.

## Step 2 — fill the missing channels

`normalize` does not invent channels. Later operations do, and they report it:

- A pose block with `x` and `y` but no `v` gets `v` derived by differentiating the position
  series. The result's `issues` reads `derived 'v' from the position columns`.
- A pose block with `theta` but no `omega` gets `omega` derived from the unwrapped heading.
- A rate block with neither `x` nor `y` **cannot be completed**. `engine_divergence` raises
  `MISSING_FIELD: the estimate track needs 'x' and 'y' columns to drift`. There is no fallback,
  because a track that cannot drift is not analysable.

Headings are unwrapped before anything else touches them. A wrapped series integrated directly
produces 2*pi teleports that would dominate every downstream drift figure.

## Step 3 — assemble the run document

`isRunDocument` requires exactly this, and nothing less:

| Field      | Required | Meaning                                                                    |
| ---------- | -------- | -------------------------------------------------------------------------- |
| `id`       | yes      | slug, e.g. `corridor-loop-02`                                              |
| `name`     | yes      | the human title                                                            |
| `summary`  | expected | one paragraph on what the run demonstrates                                 |
| `rateHz`   | expected | the recording rate                                                         |
| `params`   | optional | `rateSigma`, `rateSigmaOmega`, `strict`, `maxSteps` — see `judge-envelope` |
| `notes`    | optional | how the defect was planted, so a reader can check the finding              |
| `estimate` | yes      | the fused pose estimate: `t`, `x`, `y`, `theta` (plus `v`, `omega`)        |
| `truth`    | yes      | the reference track: `t`, `x`, `y`, and `theta` if available               |
| `sensors`  | yes      | per-sensor `{ v, omega, weight? }`, keyed by sensor name                   |

Two details that catch people:

- **`sensors.<name>.v` and `.omega` must have exactly as many samples as `estimate.t`.** The
  engine rejects a mismatch with `LENGTH_MISMATCH: sensors.imu has 10/120 samples but the fused
track has 120`.
- **A missing `weight` silently becomes `1.0`.** A sensor with no stated weight can outvote one
  carrying an explicit `weight` of `0.4`. State every weight explicitly. The
  `rate-bias-linter` plugin flags this case, along with one sensor holding most of the weight and
  one holding almost none.

Keep the sensors block honest. `fusionInconsistency` is the gap between `estimate.v`/`omega` and
the weighted mean of `sensors.*.v`/`omega`, and it is what tells a reader whether the two
descriptions of the fusion agree.

## Step 4 — check it before analysing

```bash
odoscope run <run.json> --json
```

Also worth running:

- `engine_summarize` on the estimate alone, for `count`, `durationS`, `rateHz`, `pathLength`,
  `meanSpeed`, `maxSpeed`, `maxYawRate` and `terminalPose`. Use it to describe the run and to
  decide whether it is worth analysing at all.
- `list_plugins`. If `ground-truth-adapter` is active, an external ground-truth export can be
  normalised into the `truth` block instead of hand-converted — it resolves column aliases,
  converts degrees to radians, rescales millimetres, and shifts the time base to start at zero.

## Verify

`odoscope run <run.json>` prints the envelope strip, the ablation table and the verdict. If it
raises `VALIDATION_FAILED` naming `run`, the document is missing `id`, `name`, `estimate`,
`truth` or `sensors`.
