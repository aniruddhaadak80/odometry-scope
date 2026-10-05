---
name: judge-envelope
description: Use when a run's drift has to be called real or acceptable against a stated sensor uncertainty, because the envelope only certifies a claim under assumptions you wrote down.
metadata:
  version: 1.0.0
---

# Judge the error envelope

## When to use this

You have an estimate and a reference track, and you need to decide whether the disagreement is
inside what the sensors could plausibly explain — or whether it is a defect.

## What the bound actually is

The bound is not a constant confidence band. Each sample interval injects

```
hypot(rateSigma * |v|, rateSigmaOmega * |omega|) * span * (1 + |v| * span)
```

plus the integrator's own local truncation error, and those are accumulated as a **sum of
squares**. Three consequences you must internalise before quoting a number:

1. **The bound grows like `sqrt(steps)`, not like `t`.** That is the right model for independent
   per-step sensor noise, where errors average out.
2. **The `1 + |v| * span` factor widens the band with distance travelled, not with time.** A
   heading error rotates the velocity vector, so angular uncertainty converts into positional
   uncertainty. The same run at twice the speed gets a wider band per step.
3. **It is deliberately not a worst-case band.** A worst-case model compounds every step in the
   same direction, grows exponentially, and produces a bound so wide it can never detect
   anything. That would make the whole product theatre.

## Why bias escapes and noise does not

- **Systematic error** — a wheel scale factor, a constant yaw bias — does not average out. It
  compounds roughly linearly in `t`. Linear beats `sqrt`, so it crosses the band eventually and
  then keeps going. The escape is the signal.
- **Independent noise** — jitter with no consistent sign — partially cancels. Its observed
  drift grows like `sqrt(t)` too, and the band grows like `sqrt(t)` as well. Whether it escapes
  depends on whether the noise really is inside the sigma you stated.

So an escape early in the run means bias. An escape only after a long run, at a large drift, is
consistent with either a large bias or with a sigma you understated.

## Choosing `rateSigma` and `rateSigmaOmega`

Defaults are `rateSigma` 0.01 and `rateSigmaOmega` 0.005 — one percent relative uncertainty on
speed, half a percent on yaw rate. They live in the run document under `params`, and
`engine_divergence` accepts them as `params.rateSigma` / `params.rateSigmaOmega`.

1. Use the datasheet or a stationary bag, not a round number. Both defaults are honest for good
   hardware, and both are optimistic for cheap hardware.
2. State the number you used in the finding. A bound with unstated assumptions is not evidence.
3. **Sensitivity-check it.** Re-run with a sigma an order of magnitude smaller and see whether
   the finding survives. `apps/web/data/runs/clean-run.json` reports ratio 0.27 at
   `rateSigma` 0.01, ratio 2.72 at 0.001, and ratio 13.6 at 0.0002. That run's sub-0.1% scale
   errors are real; only the _first_ of those three settings is a claim the sensors support.
   If your verdict flips when you move the sigma, you have found an assumption, not a defect.
4. Never widen sigma until a run passes. The bound is a stated belief about the hardware; if it
   has to be widened to fit the data, the honest statement is that the run is unbounded.

## Reading `certified` vs `unbounded`

`engine_classify` returns a `confidence` field, and it is the part that matters most:

| `confidence` | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `certified`  | drift stayed inside the envelope for every step. Quote the bound.       |
| `unbounded`  | drift escaped. There is no bound left to quote — only the escape point. |

A `certified` verdict is a bounded claim: "under a 1% speed assumption, this run's drift never
exceeded 9.0 mm". An `unbounded` verdict is a different kind of claim entirely: "the drift left
the envelope at step 12", with nothing to compare it against beyond that point.

`severity` is separate and much weaker:

| `severity` | Condition         | What it means                           |
| ---------- | ----------------- | --------------------------------------- |
| `ok`       | ratio <= 1.0      | inside the bound, with margin           |
| `watch`    | 1.0 < ratio < 2.0 | escaped, but the overshoot is within 2x |
| `drifting` | ratio >= 2.0      | escaped by at least a factor of two     |

Never report `severity: drifting` without also reporting `confidence`. `[DRIFT] unbounded` and
`[DRIFT] certified` are both possible and mean opposite things about how much you may claim.

## When to use `--strict`

`--strict` on `odoscope run <file>`, or `params.strict` on `engine_divergence`, makes an escaped
bound raise `BOUND_VIOLATION` instead of returning a verdict. The CLI then exits 1 and prints

```
BOUND_VIOLATION (surfaced as UPSTREAM_FAILED): observed drift escaped the certified envelope
at step 1 (t=0.050000s, observed=0.281786m, bound=0.011147m); the drift is real and unbounded
by the stated sensor assumptions
```

Use it for:

- **CI gates.** A regression harness should fail on the escape, not parse the verdict and
  reimplement the threshold. `apps/web/data/runs/clean-run.json --strict` exits 0;
  `wheel-scale-drift.json --strict` exits 1.
- **Evidence capture.** The error names the step, the timestamp, the observed drift and the
  bound, so it is quotable without re-running anything.

Do not use it while exploring. You want the table first; the refusal comes after.

## The one thing the bound cannot do

The bound does not model a sensor that is _believing_ the wrong thing while every other sensor
stays self-consistent. A wheel under-reporting by 4% keeps the fused estimate and the reference
close together, because the fusion is trusting the short reading — the envelope never breaches
and ablation never blames anyone. A tape leak has to be measured directly, which is what the
`tape-leak-detector` plugin is for. Check `list_plugins` before concluding that a clean envelope
clears every sensor.

## Verify

`odoscope run <file> --strict` exits 0 when the drift stays inside the stated assumptions and 1
when it does not, and `odoscope run <file> --json` reports the `boundRatio` and
`firstExceedance` the verdict was derived from.
