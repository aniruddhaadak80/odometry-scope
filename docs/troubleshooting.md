# Troubleshooting

Real failure modes, with the actual output each one produces.

## The Python engine is unreachable

**Symptom.** `doctor` shows a failing row, or every engine call exits `1`:

```console
odometry-scope doctor
  [PASS] node           v22.23.2
  [PASS] package        odometry-scope@0.1.0
  [PASS] skills         0 skills, 0 invalid
  [PASS] plugins        0 active, 0 disabled
  [WARN] config         no product.config.json — using defaults
         fix: run with defaults, or create product.config.json
  [FAIL] python engine  Error: spawn python ENOENT
         fix: check that python is on PATH and services/engine is installed
  [WARN] sample runs    no committed analyses under apps/web/data/runs
         fix: run `python scripts/generate-runs.py` from the repository root

one or more checks failed
```

`doctor` exits `1` here. Reproduced by running the CLI from a directory that is not the repository
root — which is also the most common cause, because the bridge resolves the engine relative to the
current working directory.

`ENOENT` here means the _interpreter_ could not be spawned. A different detail — for example
`engine exited 1: ModuleNotFoundError: No module named 'odometry_scope'` — means the interpreter
ran but could not import the engine, which is a path problem rather than a missing Python.

**Why it is worth its own check.** The engine is the product. A tree with healthy Node and no
reachable Python passes every other row and still cannot answer a single question, so `doctor`
probes it by _actually calling it_ with a two-sample probe rather than by checking that a file
exists.

**Causes, in order of likelihood.**

1. **You are not in the repository root.** The bridge resolves the engine relative to
   `process.cwd()`, so running the CLI from anywhere else loses both the engine and the skills and
   plugin directories. This also produces the `0 skills, 0 invalid` and `0 active, 0 disabled`
   rows seen above. Run every command from the repository root.
2. `python` is not on `PATH`, or the default `python` is Python 2. Check with `python --version` —
   it must be 3.11 or newer (`.python-version` pins 3.12).
3. You have not built the TypeScript side. The engine is called through a subprocess bridge that
   loads from `packages/*/dist/`. Run `npm run build`.

**Confirm it directly:**

```bash
node packages/cli/dist/bin.js doctor --json
python -m pytest services/engine -q
```

If pytest works but `doctor` does not, the problem is the bridge or the build, not Python.

## `BOUND_VIOLATION`

**Symptom.** With `--strict`:

```console
BOUND_VIOLATION (surfaced as UPSTREAM_FAILED): observed drift escaped the certified envelope at step 1 (t=0.050000s, observed=0.281786m, bound=0.011147m); the drift is real and unbounded by the stated sensor assumptions
```

**This is not a crash. It is the answer.** The observed drift exceeded the bound propagated from
the sensor uncertainty you stated, so the drift cannot be explained by the noise those assumptions
allow — there is a systematic fault somewhere in the fusion. Exit code `1` is deliberate.

Without `--strict` the same run is reported as a result rather than an error, and the verdict says
`unbounded` instead of `certified`.

**What to do next.** Do not widen the envelope to make it go away — that trades a finding for
silence. Run the ablation to name the sensor:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/wheel-scale-drift.json
```

**If you are seeing it on a run you believe is clean**, the most likely cause is the next item.

## The bound is too wide to detect anything

**Symptom.** Real drift is present, the trajectory visibly diverges — and the verdict comes back
`ok` / `certified` with a low ratio.

**Cause.** `params.rateSigma` (or `rateSigmaOmega`) is larger than your sensors actually are. The
bound is only ever as tight as the assumption you wrote down. Two runs, same 4 cm of real drift:

```console
rateSigma 0.01, rateSigmaOmega 0.005  ->  maxObserved=0.040000  maxBound=0.003391  ratio=11.80  exceeded=true
rateSigma 0.5,   rateSigmaOmega 0.25   ->  maxObserved=0.040000  maxBound=0.169552  ratio=0.24   exceeded=false
```

The second line still contains 4 cm of genuine drift and reports nothing, because the bound was
declared wide enough to absorb it.

**Fix.** State the real 1-sigma uncertainty of your rate channels. The shipped runs use
`rateSigma: 0.01` and `rateSigmaOmega: 0.005`. A deliberately generous assumption is legitimate
for a sensor whose spec you genuinely do not know — but then say so in the verdict, because the
bound certifies nothing beyond the assumption.

If the _ratio_ is suspiciously close to `1.00` on every run regardless of the data, suspect the
assumptions rather than the robot.

## The run has no position columns

**Symptom.** `MISSING_FIELD` from `divergence`:

```console
MISSING_FIELD (surfaced as UPSTREAM_FAILED): the estimate track needs 'x' and 'y' columns to drift
```

**Why it is refused.** Drift is a statement about two poses. With no position on the estimate there
is nothing to compare, and inventing a pose would be the whole product lying. A rate track without
a pose track is not usable here.

**`summarize` is the exception** — it tolerates a rates-only log and says so rather than inventing:

```console
pathLength=0  terminalPose={"x":0,"y":0,"theta":0}  issues=["no position columns; reported rates only"]
```

The `issues` array exists for exactly this: a zero that is _reported_ as zero is honest, a zero
that looks computed is not.

**Fix.** Supply `x` and `y`, or use the `ingest-recording` skill to shape a raw log into a run
document. Note that `v` and `omega` _are_ derivable from a position track, but not the reverse.

## The committed analyses are stale

**Symptom.** `packages/cli/src/runs.test.ts` fails:

```console
committed sample runs > wheel-scale-drift: committed analysis matches a live engine run
```

**Why it happens.** `apps/web` renders committed analysis files rather than calling the engine at
request time (ADR 0003 and ADR 0005), so the website's honesty depends on those files matching
what the engine computes today. That test recomputes every run through a live engine call and
fails on any drift — which is exactly the point: an integrator change must not silently leave the
deployed site quoting stale numbers.

**Fix.** Regenerate both the runs and their analyses:

```bash
python scripts/generate-runs.py
```

The generator runs the real engine, so the committed files are by construction what the engine
computes. It is deterministic — running it twice produces byte-identical output, which is what
lets the test make this assertion at all.

**If regenerating produces no diff and the test still fails**, the engine and the committed file
disagree at a precision the test checks (`toBeCloseTo(..., 12)`). Inspect
`apps/web/data/runs/<id>.analysis.json` against a live `--json` run and reconcile before touching
either.

## `npm run pytest` fails in `test_a_track_matching_its_reference_never_exceeds_its_bound`

**Symptom.**

```console
FAILED services/engine/tests/test_analysis.py::TestDivergence::test_a_track_matching_its_reference_never_exceeds_its_bound
E       assert True is False
E       Failing test case: test_a_track_matching_its_reference_never_exceeds_its_bound(
E           speed=2.225073858507203e-309, rate=1.75, count=3,
E       )
```

**What is happening.** This is a `hypothesis` property test, and the value it found is a
**subnormal** speed — `2.2e-309`, effectively zero. In that regime the envelope accumulation
underflows: `sqrt(bound² + step_noise²)` squares values around `1e-311`, which in float64
underflows to `0.0`, so the bound stays exactly zero. Meanwhile the observed drift comes out as
`5e-324`, the smallest representable subnormal. The comparison `5e-324 > 0.0` is therefore true
and the test's invariant is violated.

Reproduced directly, outside pytest:

```console
speed=2.225073858507203e-309 rate=1.75 count=3
maxObserved     = 5e-324
maxBound        = 0.0
exceeded        = True
```

**Why it is intermittent.** The property test passes or fails depending on whether `hypothesis`
happens to generate a subnormal float. It **passed** on a cold run and **failed** on the next one,
after which `hypothesis` cached the counterexample in `.hypothesis/` (which is self-ignored, so it
is never committed) and replays it on every subsequent run. If it is currently failing for you,
that cache is why, and it will keep failing until it is cleared.

**Scope.** It is a genuine floating-point edge case in the bound accumulation, not a corrupted
environment — but the magnitude involved, `5e-324 m`, is about 300 orders of magnitude below any
physically meaningful drift, and it requires a robot that is both effectively stationary and not
yawing at all. It is a real defect in the underflow behaviour and it is documented here rather
than worked around, because the fix belongs in the engine (accumulating in a form that does not
square subnormals), not in the test.

**To get a green run while you work on something else:**

```bash
python -m pytest services/engine -q -k "not test_a_track_matching_its_reference_never_exceeds_its_bound"
```

To clear the cached counterexample, delete the `.hypothesis` directory.

Do **not** commit a widened tolerance to make this go away. Every other gate in this repository
exists to stop a real numerical defect being smoothed into a passing test.

## `odoscope: command not found`

`npm install` does not link this CLI into `node_modules/.bin`, because `@odometryscope/cli` is a
leaf workspace package that nothing depends on. Invoke it through its built entry point:

```bash
node packages/cli/dist/bin.js doctor
```

If you get `ENOENT` on `packages/cli/dist/bin.js`, you have not built yet — run `npm run build`.

## `mcp call` says the input is not valid JSON

**Symptom.**

```console
error: input is not valid JSON — SyntaxError: Expected property name or '}' in JSON at position 1
```

The JSON is probably fine and your shell mangled it. Node's argument parser on Windows strips
unescaped double quotes, so `{"channels":...}` arrives as `{channels:...}`.

On PowerShell 5.1, escape the inner quotes:

```bash
node packages/cli/dist/bin.js mcp call engine_summarize '{\"channels\":{\"t\":[0,0.5,1.0],\"v\":[0.5,0.6,0.5]}}'
```

In `bash`, `zsh`, or any POSIX shell, plain single quotes are correct:

```bash
odoscope mcp call engine_summarize '{"channels":{"t":[0,0.5,1.0],"v":[0.5,0.6,0.5]}}'
```

Both deliver the identical argument. If you hit this on a long run document, write the JSON to a
file and pipe it into a script that spawns the binary — much easier to debug than a quoting
problem.

## The MCP server will not start

The most common cause is a tool name MCP cannot carry. Names must match
`^[a-z][a-z0-9_]{0,63}$`; the server refuses to start rather than renaming silently, and names the
offending tool.

If it starts and immediately dies, check you have run `npm run build` — the server is loaded from
`packages/cli/dist/`, and the stdio proof and client config both spawn that path.

Prove the protocol works in isolation:

```bash
node packages/mcp/dist/stdio-proof.js
```

## `doctor` is failing on something else

Read the **fix** line under the failing row — it names the remedy. `doctor` never throws; a failing
subsystem becomes a row with a status, a detail and a hint.

```bash
node packages/cli/dist/bin.js doctor --json
```

- **`skills`** — an invalid `SKILL.md`. The detail names the file; `npm run check:skill-version`
  will tell you whether a body changed without a `metadata.version` bump.
- **`plugins`** — a rejected manifest. `list_plugins` shows which, and why.
- **`sample runs`** — no committed analyses. Run `python scripts/generate-runs.py`.

A `warn` row does **not** fail `doctor`. The `config` warning on a fresh clone is expected.

## A run file parses but is not a run document

```console
VALIDATION_FAILED: "run" must be a run document with id, name, estimate, truth and sensors
```

Exit code `1`. A run document needs `id`, `name`, `estimate` (with `t`, `x`, `y`), `truth`, and a
non-empty `sensors` map. See the skeleton in [getting-started.md](getting-started.md).
