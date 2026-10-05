---
name: prove-a-finding
description: Use when a drift result needs to become a statement someone else can check, because the envelope's assumptions are only as good as the ones you wrote down and stated.
metadata:
  version: 1.0.0
---

# Prove a finding

## When to use this

You have a result from `analyze_run` and you are about to write it down — in a PR, an issue, a
review, or a message to whoever owns the robot.

## State the assumptions before the conclusion

The envelope is certified **only with respect to the sigmas you supplied**. A finding that
quotes a drift figure without quoting its assumptions is not reproducible, and a reviewer cannot
tell whether you chose `rateSigma` from a datasheet or to make the run pass.

Every defensible statement carries four things:

1. **The assumptions.** `rateSigma`, `rateSigmaOmega`, and that the reference track is right.
2. **The bound.** The `maxBound` the run was measured against, not just the observed drift.
3. **The mechanism.** Which ablation row supports the claim, and why that row means it.
4. **The limit.** What the single run does not establish.

## The four checks

### 1. The run document is self-consistent

`fusionInconsistency` must be floating-point noise — the shipped fixtures report
`1.1102230246251565e-16`. If it is materially larger, the `estimate` block and the `sensors`
block describe different fusions, and every ablation number is conditional on which one is real.
Say so, or fix the document.

### 2. The bound was not tuned to fit

Re-run `engine_divergence` with `rateSigma` an order of magnitude smaller. If the verdict flips,
you have found an assumption rather than a defect — and the correct statement is "this drift is
unbounded under a sigma I can justify", not "this sensor is broken".

Never widen sigma until a run passes. That inverts the direction of the evidence.

### 3. Ablation supports the attribution, not just the drift

The claim "sensor X is lying" rests on X's ablation row, not on the escape happening. Check:

- `explainedFraction` >= 0.5 for `primary`. Below that, say "contributing", not "the cause".
- `driftWithout` for the `primary` sensor is near zero. `apps/web/data/runs/imu-yaw-bias.json`
  removes the IMU and terminal drift falls to `0.0000 m` — that is what a real culprit looks
  like. A `primary` sensor that still leaves 80% of the drift is only part of the story.
- The `masking` rows are consistent. Negative explained fractions mean those sensors were
  _cancelling_ the bad one. Two sensors masking is not a contradiction; it is the fusion working
  as designed while being wrong.

### 4. The result is not an artefact of one window

A single run is one manoeuvre. Before generalising:

- Re-run on a second recording of the same route. A scale factor should reproduce; a slip event
  will not.
- Check whether the escape time is consistent with the defect's growth. A wheel scale error
  compounds linearly in `t` against a `sqrt(t)` envelope, so it escapes early and keeps
  accelerating. `wheel-scale-drift.json` escapes at **t=0.05s**; `imu-yaw-bias.json` at
  **t=0.65s**. A defect that escapes only at the very end of a long run is equally consistent
  with a sigma you understated.
- If the run's `notes` describe how a defect was planted, check the reported sensor against
  them. That is the one case where you have ground truth about the cause.

## Claims you may not make

| Do not claim                      | Because                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| "the drift is 23 mm"              | it is 23 mm **against a 9.6 mm bound** under stated assumptions         |
| "the fusion is broken"            | one run shows one manoeuvre; say which route and when                   |
| "sensor X is broken"              | ablation shows X explains the drift, not that X is physically defective |
| "the envelope proves X is fine"   | a small `explainedFraction` can be an artefact of X's fusion `weight`   |
| "the IMU is fine"                 | a tape leak is invisible to drift; measure distance separately          |
| anything from a `sole-source` row | its explained fraction is `0.0` by construction and proves nothing      |
| a verdict without `confidence`    | `[DRIFT] unbounded` and `[DRIFT] certified` are opposite claims         |

## The `certified` / `unbounded` distinction is not optional

- `certified` — "under a 1% speed assumption, drift never exceeded 9.0 mm over 24 s". Bounded,
  quotable, falsifiable.
- `unbounded` — "drift escaped at step 12 (t=0.65s) and kept going". There is no bound left.
  The escape point is the fact, not the drift figure.

`severity: drifting` on its own is nearly contentless — it is a threshold on a ratio whose
denominator you chose. Report `confidence` with it, every time.

## Capture the evidence

`odoscope run <file> --strict` raises `BOUND_VIOLATION` naming the step, the timestamp, the
observed drift and the bound:

```
BOUND_VIOLATION (surfaced as UPSTREAM_FAILED): observed drift escaped the certified envelope
at step 1 (t=0.050000s, observed=0.281786m, bound=0.011147m); the drift is real and unbounded
by the stated sensor assumptions
```

That message plus the run document's `params` is enough for someone else to reproduce the
finding without re-deriving anything. Keep both. The engine is pure — no clock, no network, no
randomness — so the same inputs give bit-identical output tomorrow.

## Report shape that holds up

> On `corridor-loop-02` (24 s, 20 Hz, 22.4 m), assuming `rateSigma` 0.01 and
> `rateSigmaOmega` 0.005, fused drift escaped the certified envelope at t=0.05 s (step 1) and
> peaked at 0.2818 m against a 0.0111 m bound, ratio 25.28. Ablating `wheel` collapsed terminal
> drift to 0.0027 m (96.0% explained, `primary`); `imu` and `lidar` came back `masking`
> (-23.4%, -40.1%), so both were partially compensating. Verdict: `drifting`, `unbounded`.
> `fusionInconsistency` 1.1e-16, so the run document and its sensors block agree.
>
> Limit: one manoeuvre on one robot. A wheel scale factor should reproduce on a second run; I
> have not recorded one.

## Verify

The statement quotes a bound next to every observed figure, names its `confidence`, points at a
specific ablation row, and states what a second run would need to show.
