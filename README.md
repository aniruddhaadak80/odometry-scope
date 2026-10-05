# Odometry Scope

**Which sensor is lying?** — a robot's fused pose estimate drifts, and Odometry Scope proves which
sensor caused it instead of leaving it to guesswork.

## The problem

A fused pose estimate drifts, and by the time you notice the robot is 30 cm off, nobody knows
whether the wheel encoders over-report, the IMU has a yaw bias, or the lidar is being
over-trusted. The usual answer is to disable one sensor, re-drive, and look — which costs a day
per hypothesis and proves nothing about the other two.

Odometry Scope inverts that. It takes the recorded run, compares the fused estimate against a
reference track **inside a propagated error envelope**, and then ablates each sensor in turn:
removing its contribution, renormalising the remaining fusion weights, and re-integrating. The
sensor whose removal collapses the drift is the one that explained it.

A sensor can come back **primary** (removing it fixes the drift), **masking** (its presence was
_hiding_ drift the rest of the stack would otherwise show), or **negligible**.

Every number in the verdict is arithmetic. No model call is used for anything numeric, which is
the whole point: an envelope you cannot re-derive by hand is not falsifiable, and a falsifiable
envelope is the only reason to trust the word "drift".

## Walkthrough

Requires Node 22.12+ and Python 3.11+. From a clone, install and build:

```bash
npm install
npm run build
```

The binary is `odoscope`. In a clone it is invoked through its built entry point:

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

`doctor` probes the Python engine by **actually calling it**, not by checking that a file exists.
A tree with a healthy Node and no reachable engine passes every other check and still cannot
answer a single question.

Confirm what this build can do:

```bash
node packages/cli/dist/bin.js version
```

```console
{
  "name": "odometry-scope",
  "version": "0.1.0",
  "node": "22.23.2",
  "platform": "win32",
  "tools": 10
}
```

```bash
node packages/cli/dist/bin.js tools
```

Ten tools, all reachable from the CLI, the web app and the MCP server. The authoritative capability
list, with descriptions truncated here for width — `odoscope tools` prints them in full:

```console
  analyze_run        [core]  The flagship operation: take one recorded run … and return everything the product can say about it …
  engine_attribute   [core]  Find which sensor is lying. Ablate one sensor at a time, renormalise the remaining fusion weights …
  engine_classify    [core]  Turn a divergence envelope and an attribution into a bounded verdict …
  engine_divergence  [core]  Measure how far a fused pose estimate drifts from a reference track …
  engine_integrate   [core]  Dead-reckon a pose series from a recorded rate series using RK4 with step-doubling error control …
  engine_normalize   [core]  Canonicalise a recorded sample log into typed channels (t, x, y, theta, v, omega) …
  engine_summarize   [core]  Aggregate a recorded run into the few numbers an operator reads first …
  health_check       [core]  Report whether this installation can actually do the work …
  list_plugins       [core]  List the resolved plugin registry, including plugins that were shadowed …
  list_skills        [core]  List the skill catalog with each skill name, version and description …
```

## The headline run

`wheel-scale-drift` is the case this product exists for: wheel encoders over-report by 2% and
carry a small yaw bias, while the pose estimate stays perfectly self-consistent with its own
fusion. Nothing looks wrong until it is compared against ground truth.

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

  RUN NOTES
    - wheel over-reports distance by 2% and adds +0.008 rad/s of yaw bias
    - imu over-reports by a smaller 0.4%
    - lidar is treated as ground-adjacent and is accurate
    - a systematic bias grows like t while the envelope grows like sqrt(t), so this is expected to escape the envelope within the first step or two
```

Read the strip. The top band is the **bound** — how far the drift is allowed to be, given the
sensor uncertainty stated in the run document. The line below is the **observed** drift, one
character per sampled step: `.` while it is inside the band, `x` once it has escaped. The
caret marks the first escape, at `t=0.05s`.

Peak observed drift is `0.2818 m` against a `0.0111 m` bound — a ratio of **25.28**. And the
ablation names the culprit: remove the wheels and the drift collapses from 0.2818 m to
0.0027 m, so the wheels explain **96.0%** of it. Note the two honest negatives as well: the IMU
and the lidar come back **masking** — with them removed the drift gets _worse_, which is exactly
what "not the culprit" looks like from the outside.

## The other two shipped runs

A tool that only ever reports drift is worthless — it sends people chasing healthy hardware. So
two more runs ship, and both are load-bearing.

`imu-yaw-bias`: every rate source is nearly right, but the IMU reads 0.9% high. The drift is
small enough in metres that eyeballing the trajectory hides it.

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/imu-yaw-bias.json
```

```console
odoscope — Loading dock loop — 0.9% IMU speed bias

  361 samples · 18.0s · 20.0 Hz · 16.70 m path

  DRIFT ENVELOPE
  |================================================================| bound
  |..xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx    | observed  (. inside, x escaped)
  |  ^ first escape at t=0.65s
  peak observed 0.0230 m against a 0.0096 m bound

  SENSOR ABLATION
    imu     drift without it 0.0000 m      explained  100.0%  primary
    lidar   drift without it 0.0238 m      explained  -25.0%  masking
    wheel   drift without it 0.0345 m      explained  -81.8%  masking

  VERDICT
    [DRIFT] unbounded
    drift escaped the certified envelope at step 12 (peak 0.023m against a 0.010m bound, ratio 2.40); sensor 'imu' explains the most of it

  RUN NOTES
    - imu over-reports speed by 0.9% with no yaw error at all
    - wheel and lidar are both exact, which is what makes the IMU identifiable
```

`clean-run`: a healthy drive with sub-0.1% scale errors, far inside the stated 1% rate
uncertainty. Drift never escapes the envelope, so the verdict stays **certified** — the tool
reports nothing, which is the correct answer.

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/clean-run.json
```

```console
odoscope — Warehouse aisle — no detectable drift

  321 samples · 16.0s · 20.0 Hz · 14.80 m path

  DRIFT ENVELOPE
  |================================================================| bound
  |................................................................| observed  (. inside, x escaped)
  peak observed 0.0027 m against a 0.0090 m bound

  SENSOR ABLATION
    imu     drift without it 0.0031 m      explained  -32.9%  masking
    lidar   drift without it 0.0034 m      explained  -42.9%  masking
    wheel   drift without it 0.0006 m      explained   76.6%  primary

  VERDICT
    [ok  ] certified
    drift stayed inside the certified envelope for the whole run (peak 0.003m against a 0.009m bound); sensor 'wheel' explains the most of it

  RUN NOTES
    - sub-0.1% scale errors only, far inside the stated 1% rate uncertainty
    - expected verdict: severity ok, confidence certified
```

Note what the clean run does _not_ have: no caret line, because nothing escaped. There is a test
asserting exactly that, because a strip that always draws a breach is a strip nobody reads.

## Using it as a gate

`--strict` turns an escaped bound from a reported result into a hard failure, so drift can fail
CI instead of being smoothed into a confidence:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/wheel-scale-drift.json --strict
```

```console
BOUND_VIOLATION (surfaced as UPSTREAM_FAILED): observed drift escaped the certified envelope at step 1 (t=0.050000s, observed=0.281786m, bound=0.011147m); the drift is real and unbounded by the stated sensor assumptions
```

That exits `1`. Run the same flag against the healthy run and it exits `0`, printing the
ordinary report — so the gate passes on good hardware and fails on bad.

`--json` gives the whole analysis as one document, for a dashboard or a script:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/clean-run.json --json
```

```json
{
  "severity": "ok",
  "confidence": "certified",
  "boundRatio": 0.29456162054808005,
  "firstExceedanceStep": null,
  "dominantSensor": "wheel",
  "withinEnvelope": true,
  "summary": "drift stayed inside the certified envelope for the whole run (peak 0.003m against a 0.009m bound); sensor 'wheel' explains the most of it"
}
```

## Quickstart

```bash
npm install
npm run build
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js run apps/web/data/runs/wheel-scale-drift.json
```

That is the whole first run: confirm the engine is reachable, then read one verdict.

## Architecture

**The narrow waist.** Every capability is a `Tool` in one registry, and every surface is a thin
transport over it. There is no second implementation of anything, so a fix lands everywhere at
once.

```
   CLI ────────────▶┌───────────────┐
   Web ────────────▶│               │
   MCP server ─────▶│  ToolRegistry │──▶ services/engine  (pure Python, stdin/stdout)
   Channel ─────────▶└───────────────┘
```

- **`packages/core`** — the `Tool` interface, the registry, permissions, the error taxonomy, and
  the domain vocabulary (`RunDocument`, `RunAnalysis`). No I/O.
- **`services/engine`** — the _only_ place a number is computed. A dependency-free Python package
  called as a pure function over stdin/stdout: one JSON object in, one JSON object out, nothing on
  stdout but the answer. No clock, no network, no randomness, no filesystem.
- **Columnar storage** — samples are parallel arrays, not one object per sample. Every consumer
  sweeps whole channels linearly, so a 200k-sample track is six contiguous buffers instead of
  200k objects to allocate and walk. That is why the divergence sweep stays cheap at bag-file
  sizes.
- **The engine is `mypy --strict` clean** and property-tested with `hypothesis`, because a
  numerical claim nobody can check is a claim nobody should act on.

Six engine operations, each a pure function: `normalize` canonicalises a raw log, `integrate`
dead-reckons with RK4 plus step-doubling error control, `divergence` measures drift against the
propagated envelope, `attribute` ablates one sensor at a time, `classify` turns the pair into a
bounded verdict, `summarize` reduces a run to its headline numbers.

Full detail in [docs/architecture.md](docs/architecture.md).

## CLI reference

| Command                             | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `odoscope doctor`                   | probe every subsystem, with a fix hint per failing row   |
| `odoscope tools`                    | list the registered tools — the authoritative list       |
| `odoscope run <file>`               | analyse a run; prints the verdict, envelope and ablation |
| `odoscope version`                  | version and runtime information as JSON                  |
| `odoscope mcp serve`                | run the MCP server over stdio                            |
| `odoscope mcp call <tool> '<json>'` | invoke one tool directly, without a protocol round trip  |

`run` accepts `--json`, `--strict` and `--max-steps <n>`. `doctor` and `tools` accept `--json`.
Exit codes are `0` ok, `1` runtime failure, `2` usage error. Full reference in
[docs/cli.md](docs/cli.md).

## MCP

Odometry Scope is both an MCP client and an MCP **server**, which makes it a tool provider for
other agents. Point a client at it:

```json
{
  "mcpServers": {
    "odometry-scope": {
      "command": "node",
      "args": ["/absolute/path/to/odometry-scope/packages/cli/dist/bin.js", "mcp", "serve"]
    }
  }
}
```

The ten tools are derived from the core registry — there is no second list to keep in sync. The
protocol is proven by a real client driving the real server over real stdio, including one
deliberately invalid call to prove the error envelope survives the round trip:

```bash
node packages/mcp/dist/stdio-proof.js
```

```console
connecting to `odoscope mcp serve` over stdio
handshake                  initialize + initialized complete
server                     odometry-scope v0.1.0
tools/list                 10 tools: analyze_run, engine_attribute, engine_classify, engine_divergence, engine_integrate, engine_normalize, engine_summarize, health_check, list_plugins, list_skills
tools/call analyze_run     drifting / unbounded
  peak observed            0.2818 m
  certified bound          0.0111 m
  ablation imu             masking (-23.4%)
  ablation lidar           masking (-40.1%)
  ablation wheel           primary (96.0%)
tools/call invalid         isError=true · VALIDATION_FAILED: "estimate" must be an object

MCP stdio proof passed.
```

You can also call a tool without a protocol round trip, which is the fastest way to explore:

```bash
node packages/cli/dist/bin.js mcp call engine_summarize '{"channels":{"t":[0,0.5,1.0],"v":[0.5,0.6,0.5]}}'
```

```console
{
  "count": 3,
  "durationS": 1,
  "rateHz": 2,
  "pathLength": 0,
  "meanSpeed": 0.5333333333333333,
  "maxSpeed": 0.6,
  "maxYawRate": 0,
  "terminalPose": {
    "x": 0,
    "y": 0,
    "theta": 0
  },
  "maxLocalError": 0,
  "issues": [
    "no position columns; reported rates only"
  ]
}
```

The `issues` array is not decoration — it says the run had no position columns, so path length
and terminal pose are reported as zero rather than invented. Full surface in [docs/mcp.md](docs/mcp.md).

## Skills catalog

Four skills, loaded from disk and validated on load. An invalid skill is reported with a file and
a line, never silently skipped.

| Skill              | Use it when                                                                             |
| ------------------ | --------------------------------------------------------------------------------------- |
| `triage-drift`     | a fused pose estimate has drifted and someone needs to know which sensor is responsible |
| `judge-envelope`   | a run's drift has to be called real or acceptable against a _stated_ sensor uncertainty |
| `ingest-recording` | a recorded log is not yet a run document, so the engine cannot name a liar yet          |
| `prove-a-finding`  | a drift result must become a statement another engineer can independently check         |

```bash
node packages/cli/dist/bin.js mcp call list_skills '{}'
```

## The three shipped runs

| Run                 | Verdict                | Peak observed | Bound    | Ratio | Dominant sensor |
| ------------------- | ---------------------- | ------------- | -------- | ----- | --------------- |
| `wheel-scale-drift` | `drifting` / unbounded | 0.2818 m      | 0.0111 m | 25.28 | `wheel` (96.0%) |
| `imu-yaw-bias`      | `drifting` / unbounded | 0.0230 m      | 0.0096 m | 2.40  | `imu` (100.0%)  |
| `clean-run`         | `ok` / certified       | 0.0027 m      | 0.0090 m | 0.29  | `wheel` (76.6%) |

They are synthetic but physical, and each carries the planted defect in its own `notes` so you can
check the finding against the input. They are regenerated deterministically — running the
generator twice produces byte-identical files:

```bash
python scripts/generate-runs.py
```

```console
wrote wheel-scale-drift: drifting/unbounded ratio=25.28 dominant=wheel
wrote imu-yaw-bias: drifting/unbounded ratio=2.40 dominant=imu
wrote clean-run: ok/certified ratio=0.29 dominant=wheel
```

## What is deliberately not here

An omission with no stated reason is indistinguishable from unfinished work, so both omissions
in this product are argued rather than accidental.

**No LLM providers.** `packages/providers` ships the interface and not a single adapter. A model
in the loop would make the error envelope unfalsifiable — and the one property this product exists
to protect is that its verdict is arithmetic. There is nothing a model could add that a number
cannot, and a great deal it would obscure.

**No chat interface.** The output is a verdict and an envelope plot, not a conversation. A chat
box would invite exactly the unsupported confidence the engine is built to refuse, because a
conversational surface rewards a fluent "looks fine" over an arithmetic "the bound was exceeded
at step 1".

## Development

```bash
npm run build        # turbo build across every package
npm run typecheck    # tsc --noEmit
npm test             # vitest, every package
npm run lint         # eslint
npm run format       # prettier --write
npm run pytest       # the Python engine, including hypothesis property tests
npm run check        # everything CI runs, in order
```

The Python engine has its own gates:

```bash
python -m pytest services/engine -q
python -m mypy --strict services/engine/src
python -m ruff check services/engine
```

And six policy gates, which are also what stop this README from rotting:

```bash
node scripts/check-skill-version.mjs
node scripts/check-no-secrets.mjs
node scripts/check-theme-tokens.mjs
node scripts/check-boundaries.mjs
node scripts/check-public-hygiene.mjs
node scripts/check-readme-commands.mjs
```

`check:readme-commands` is the one worth knowing about: it fails if any `npm run` in this file is
not a real script, or if a declared binary is never mentioned. Every command above was run to
produce the output shown here.

Architecture rules that are not negotiable live in [AGENTS.md](AGENTS.md); the reasoning behind
each decision lives in [docs/adr/](docs/adr/). If something here is wrong, that is a bug in the
documentation — say so.

## Documentation

| Page                                       | Read it when                              |
| ------------------------------------------ | ----------------------------------------- |
| [getting-started](docs/getting-started.md) | you have just cloned this                 |
| [architecture](docs/architecture.md)       | you need the map before changing anything |
| [cli](docs/cli.md)                         | you are scripting the CLI                 |
| [mcp](docs/mcp.md)                         | you are connecting an agent               |
| [skills](docs/skills.md)                   | you are writing or editing a skill        |
| [plugins](docs/plugins.md)                 | you are adding an extension               |
| [configuration](docs/configuration.md)     | you are changing behaviour                |
| [ci](docs/ci.md)                           | you are adding a gate                     |
| [troubleshooting](docs/troubleshooting.md) | something is broken                       |
| [adr/](docs/adr/)                          | you want the reasoning behind a decision  |

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
