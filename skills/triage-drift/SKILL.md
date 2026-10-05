---
name: triage-drift
description: Use when a recorded run's fused pose estimate has drifted and the user needs to know which sensor is responsible, because ablation names the liar instead of leaving it to guesswork.
metadata:
  version: 1.0.0
---

# Triage a drifting run

## When to use this

A recorded run's fused pose estimate visibly disagrees with where the robot actually was, and
the question is which sensor in the fusion is lying.

## The one rule

**Read the envelope first, then check `fusionInconsistency`, then read the ablation table.**
The ablation table is the answer, but it is only an answer if the run document is internally
consistent. Skipping straight to the table is how you report a confident finding about a run
whose `fused` block was never produced by the fusion you are ablating.

## Steps

1. `odoscope run <file>` — one human-readable report: the envelope strip, the ablation table,
   and the verdict. Read it before touching any flag.
2. Read the **DRIFT ENVELOPE** strip.
   - The `=` row is the propagated bound. It grows like `sqrt(steps)`, because the bound is an
     accumulation of independent per-step rate noise, not a worst case.
   - `.` means the observed drift stayed inside the band at that column. `x` means it escaped.
   - `^ first escape at t=…s` is the moment the finding starts. A run whose strip is `xxx…`
     from the first column is a large systematic error, not accumulated noise.
   - Read the last line: `peak observed … against a … bound`. That ratio is the finding's
     magnitude.
3. Read `fusionInconsistency` from `odoscope run <file> --json`. This is the largest gap between
   the `estimate.v`/`estimate.omega` series in the run document and the weighted mean of the
   per-sensor `v`/`omega` series the ablation actually uses.
   - On a self-consistent document it is floating-point noise — the shipped fixtures report
     `1.1102230246251565e-16`.
   - If it is larger than the sensor noise you are claiming to have measured, the run document
     and its sensors describe different fusions. **Stop.** Fix the document, or say plainly that
     the finding is conditional on the sensors block being the real fusion.
4. Read the **SENSOR ABLATION** table. Each row is one sensor removed, the remaining weights
   renormalised, the track re-integrated, and terminal drift compared against the reference.
   - `primary` (explained >= 50%) — removing it collapses the drift. This is the liar.
   - `contributing` (10–50%) — real, but not the whole story.
   - `negligible` (-10% to 10%) — removing it changes almost nothing.
   - `masking` (<= -10%) — **its presence was hiding drift.** `drift without it` is _larger_
     than `baselineDrift`. A negative explained fraction is not a rounding artefact; it means
     that sensor was pulling the fused estimate back toward the truth and partly cancelling
     another sensor's error.
5. Choose the finding from the table, not from the verdict line.
   - One `primary` and the rest `masking` is the healthy shape: the accurate sensors were
     compensating, the bad one was winning.
   - Several `masking` rows and no `primary` means the run's drift is smaller than any single
     sensor's contribution can explain — look at `baselineDrift` before claiming a culprit.
   - `sole-source` means the sensor holds all the weight. Ablating it leaves no estimate at
     all, so its explained fraction is reported as `0.0` by construction and proves nothing.
6. Read the **VERDICT** line and carry `confidence` into every downstream sentence.

## Worked examples from the shipped fixtures

Run `apps/web/data/runs/wheel-scale-drift.json` and you will see a 2% wheel over-report with a
+0.008 rad/s yaw bias. The strip is `x` from the first column, the peak is 0.2818 m against an
0.0111 m bound (ratio 25.28), `wheel` is `primary` at 96.0% explained, and both `imu` and
`lidar` come back `masking` at -23.4% and -40.1%. That is a textbook systematic bias: it grows
like `t` while the envelope grows like `sqrt(t)`, so it escapes immediately.

Run `apps/web/data/runs/imu-yaw-bias.json` and the same defect is 0.9% on the IMU instead. The
strip is `..` then `x` from t=0.65s, the peak is only 0.0230 m, and `imu` is `primary` at 100%.
The finding is just as real and about 12 times smaller in metres — which is exactly the case
eyeballing a trajectory misses.

## When to escalate

- `fusionInconsistency` is materially non-zero — see step 3.
- Every row is `negligible` or `masking` and `baselineDrift` is small — the run may simply be
  short. Lengthen the window before concluding anything.
- The run has no `truth` block — nothing here can be analysed. Use `ingest-recording`.

## Verify

`odoscope run <file> --json` returns `fusionInconsistency` at floating-point noise, exactly one
sensor marked `primary`, and a `verdict.confidence` you can quote.

## Related

- `judge-envelope` for choosing `rateSigma` and reading a `certified` vs `unbounded` verdict.
- `ingest-recording` for getting an arbitrary log into a run document.
- `prove-a-finding` for turning this into a statement you can defend.
