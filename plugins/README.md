# Plugins

A plugin is a folder with a `plugin.json` manifest and an `index.js`. The registry validates
every manifest against a schema, resolves capability conflicts by priority, and reports **why**
each plugin was accepted, shadowed, disabled, or rejected. Nothing is dropped silently.

A plugin gets no privileged path. It registers behaviour through the same core registry every
other surface uses, and it does not bypass permission checks or validation. A plugin is also not
a way to add drift maths: the error envelope and the ablation live in the Python engine, and a
plugin may not reimplement them. The plugins here read a run document and comment on it.

## The shipped plugins

| Plugin                    | Capability              | Priority | What it is for                                                                |
| ------------------------- | ----------------------- | -------- | ----------------------------------------------------------------------------- |
| `tape-leak-detector`      | `diagnostics:tape-leak` | 70       | Wheel encoders that under-report distance against ground truth.               |
| `ground-truth-adapter`    | `ingest:ground-truth`   | 60       | Normalises an external ground-truth export into the engine's `truth` shape.   |
| `rate-bias-linter`        | `diagnostics:rate-bias` | 55       | Sensor weights that cannot support a meaningful ablation.                     |
| `tape-leak-detector-fast` | `diagnostics:tape-leak` | 40       | The same tape-leak measurement on a stride. **Shadowed** by the full checker. |

### `tape-leak-detector` — `diagnostics:tape-leak`

A wheel encoder counts wheel revolutions, so it can report less ground than the robot covered.
The causes are mechanical: a worn gearbox, a tyre that slips under load, an odometry scale
constant set too high.

This failure is invisible to the rest of the product, which is why it needs its own plugin. The
fused estimate and the ground truth stay together — the fusion is _believing_ the short reading
— so the error envelope never breaches and the ablation never blames anyone. A tape leak has to
be measured directly.

```js
import { check } from './index.js'

const report = check(run)
// a 40 s run at 2.0 m/s, with wheel_left slipping from 20 s onward:
// {
//   truthDistanceM: 80,
//   worstSensor: 'wheel_left',
//   findings: [
//     {
//       sensor: 'wheel_left',
//       verdict: 'suspect',
//       distanceRatio: 0.95,
//       encoderDistanceM: 76,
//       truthDistanceM: 80,
//       shortfallM: 4,
//       shortfallPct: 5,
//       earlyRatio: 1,
//       lateRatio: 0.8665,
//       causeHint: 'progressive-slip',
//     },
//     { sensor: 'wheel_right', verdict: 'ok', distanceRatio: 1, /* ... */ },
//   ],
//   issues: [],
// }
// the same sensor losing a flat 6% the whole run reports causeHint 'constant-scale'
// a run with no ground distance reports verdict 'insufficient-motion', not a ratio of 0
```

The shape of the loss across the run is what makes it useful rather than a bare number. A ratio
that is flat and low points at calibration or gearbox wear (`constant-scale`); a ratio that
decays across the run points at tyre slip or a failing bearing (`progressive-slip`).

Tunable through the second argument: `suspectBelow` (0.98), `leakingBelow` (0.9),
`minTruthDistanceM` (0.05), `progressiveDrop` (0.03).

It compares only where the two sides overlap. A truth track that starts late does not get
compared against held positions, and a run with no overlap fails with `NO_OVERLAP` rather than
reporting a confident wrong answer.

### `tape-leak-detector-fast` — `diagnostics:tape-leak` (shadowed)

The same measurement, walking the fused track on a stride (`stride`, default 8) and skipping
the per-run cause analysis. Roughly `stride` times less work.

It is also less truthful by construction: striding a curved path cuts corners, so its ground
distance is a slight under-count and its ratio is biased high. That is the trade, and it is why
this plugin ships below the full checker's priority and is shadowed by it.

### `rate-bias-linter` — `diagnostics:rate-bias`

The engine treats the sensor block as a weighted mean and ablates one sensor at a time. That
only means something when the weights are sane, and the engine is deliberately forgiving: a
missing weight silently becomes `1.0`, and any positive set of weights is accepted. So a run
document can load perfectly and still produce a meaningless attribution table.

```js
import { check } from './index.js'

const report = check(run)
// a run with wheel 0.6, imu -0.4 and gps unstated:
// {
//   ok: false,
//   errorCount: 1,
//   warningCount: 3,
//   totalWeight: 1.2,
//   shares: { wheel: 0.5, imu: -0.33333333333333337, gps: 0.8333333333333334 },
//   findings: [
//     { level: 'error',   code: 'weight-negative',   sensor: 'imu', message: '...' },
//     { level: 'warning', code: 'weight-negligible', sensor: 'imu', message: '...' },
//     { level: 'warning', code: 'weight-missing',    sensor: 'gps', message: '...' },
//     { level: 'warning', code: 'weight-dominant',   sensor: 'gps', message: '...' },
//   ],
// }
```

The checks, and why each one matters:

| Code                | Level   | Why it matters                                                                         |
| ------------------- | ------- | -------------------------------------------------------------------------------------- |
| `weight-missing`    | warning | The engine substitutes `1.0`, so this sensor can outvote an explicit weight of `0.4`.  |
| `all-zero-weights`  | error   | The engine rejects a non-positive weight sum; there is nothing to ablate.              |
| `weight-negative`   | error   | A negative weight inverts the sensor's contribution instead of weighting it.           |
| `weight-dominant`   | warning | One sensor holds >80%: ablating anything else cannot move the fused estimate.          |
| `weight-negligible` | warning | One sensor holds <2%: its low explained drift is an artefact of its weight, not proof. |
| `length-mismatch`   | error   | Catches the engine's later `LENGTH_MISMATCH` with the sensor and field named.          |
| `non-finite-sample` | error   | A NaN rate poisons the weighted mean silently.                                         |

Tunable: `dominantShare` (0.8), `negligibleShare` (0.02), `impliedWeight` (1.0).

### `ground-truth-adapter` — `ingest:ground-truth`

The engine wants `{ t, x, y, theta }`: metres, seconds, heading in radians, ascending. Real
trackers write `timestamp,easting,northing,heading` in degrees, in millimetres, starting at an
epoch. Fed straight in, that gives a drift number wrong by orders of magnitude that still looks
plausible.

```js
import { apply, check } from './index.js'

const { run: fixed, report } = apply(document, csv)
// csv:
//   timestamp,easting,northing,heading
//   1712000000,482010.5,4423011.2,91.5
//   1712000001,482012.5,4423011.3,91.7
//   1712000002,482014.5,4423011.3,92.0
//
// report.truth:
//   { t: [0, 1, 2],
//     x: [482010.5, 482012.5, 482014.5],
//     y: [4423011.2, 4423011.3, 4423011.3],
//     theta: [1.5969762655748114, 1.6004669240788003, 1.6057029118347832] }
// report.source === 'text', headingUnit === 'deg', timeBase === 'relative'
```

It resolves column aliases to the canonical four, converts headings to radians, rescales
positions from millimetres or centimetres, shifts the time base to zero, sorts by time, and
drops incomplete rows while reporting the count.

Options: `headingUnit` (`'rad' | 'deg' | 'auto'`, default auto — any heading beyond ±2π is
degrees), `unitScale` (0.001 for millimetres), `absoluteTime` (keep the source time base),
`dropIncomplete` (default true).

## Conflict resolution

Plugins are sorted by priority descending, then by name ascending. A plugin claiming a
capability an already-accepted plugin holds is **shadowed**: it is reported on the winner's
`shadowed` list and takes no part in the run. Nothing is dropped without a reason attached.

Exactly one plugin provides a capability at a time. Ties break on name, so resolution is
deterministic and does not depend on directory listing order.

Two plugins claiming `diagnostics:tape-leak`:

- `tape-leak-detector` at priority **70** is accepted first.
- `tape-leak-detector-fast` at priority **40** clashes on that capability, so it is shadowed by
  `tape-leak-detector`.

The shadowed plugin is what the rule is for. Both measure the same thing, but the fast one is
biased high on curved paths and cannot tell a worn gearbox from a slipping tyre. Shipping it
by default would mean silently trading a correct diagnosis for a faster one. To use it for a
specific run, raise its `priority` above `70` in its manifest.

Note that a shadowed plugin appears only inside the winner's `shadowed` list. It is not in
`active`, `disabled`, or `rejected` — there is nothing wrong with it, it simply lost.

## Inspecting the resolved state

```bash
npm run build
node packages/cli/dist/bin.js mcp call list_plugins '{}'
```

```json
{
  "active": [
    {
      "name": "tape-leak-detector",
      "version": "0.1.0",
      "capabilities": ["diagnostics:tape-leak"],
      "shadowed": ["tape-leak-detector-fast"]
    }
  ],
  "disabled": [],
  "rejected": []
}
```

`disabled` lists plugins with `"enabled": false`. `rejected` lists plugins the registry could
not use, each with the reason: an invalid manifest names the failing field, and an engine
mismatch names both the required and the running version.

## Manifest contract

| Field          | Type     | Rule                                                 |
| -------------- | -------- | ---------------------------------------------------- |
| `name`         | string   | `^[a-z0-9][a-z0-9-]*$`                               |
| `version`      | string   | `\d+\.\d+\.\d+$`                                     |
| `description`  | string   | at least 10 characters                               |
| `enabled`      | boolean  | default `true`                                       |
| `priority`     | 0–100    | default `50`; decides capability conflicts           |
| `capabilities` | string[] | the names this plugin claims                         |
| `engines`      | record   | exact version matches; a mismatch rejects the plugin |

`engines` values are **exact**, not semver ranges. `packages/plugins/package.json` is the
package these plugins bind to, so a plugin declares:

```json
"engines": {
  "@odometryscope/plugins": "0.1.0"
}
```

Bump that string when the workspace version moves, or the plugin is rejected by name with both
versions in the message.

## Authoring one

1. `mkdir plugins/<name>` — the folder name is not read; `name` in the manifest is the identity.
2. Write `plugin.json` against the contract above. `description` is read by a person deciding
   whether to enable it, so say what the plugin is for and not that it exists.
3. Claim capabilities in the existing `namespace:verb` form. Claim one another plugin already
   claims only if you intend to replace it, and expect to lose to a higher priority.
4. Write `index.js` as ESM exporting a named `check(input, options)` plus `manifest` and
   `capability`. Keep it pure — no clock, no network, no filesystem, no randomness. It reads a
   run document and returns a report; it does not move the robot or mutate the run.
5. Throw an `Error` with a `code` property for a bad input (`BAD_SHAPE`, `MISSING_FIELD`,
   `LENGTH_MISMATCH`, `NON_FINITE`, `NO_OVERLAP`, `TOO_FEW_SAMPLES`) and reserve `issues` in the
   returned report for problems that do not stop the check.
6. `npx prettier --write plugins`, then confirm the plugin appears and any conflict resolves the
   way you intended with the `list_plugins` call above.
