# ADR 0004 — The drift envelope is a random walk, not a worst-case bound

- **Status:** Accepted
- **Date:** 2026-01-01

## Context

The product's claim is that a robot's pose estimate has drifted by more than its sensors can
explain. To make that claim falsifiable, the drift has to be compared against a **bound**: a number
derived from the stated sensor uncertainty that says how far the drift is _allowed_ to be. Inside
the bound, the estimate is as good as its sensors permit. Outside it, something systematic is
wrong and the tool says so.

There are two defensible ways to build that bound, and they differ by many orders of magnitude.

**Worst-case (Lipschitz) propagation.** Treat the integration ODE's error constant as a hard bound
and propagate it forward: if the per-step relative error is amplified by the heading-rotation
factor `(1 + |v|·h)`, then after `k` intervals the worst case compounds as

```
(1 + |v|·h)^k
```

This is the textbook construction, and it is genuinely a _guarantee_: no admissible sensor
behaviour can push the estimate outside it.

**Random-walk propagation.** Assume the per-step sensor noise is **independent** across steps, and
accumulate the injected uncertainty as a sum of squares:

```
bound ← sqrt(bound² + step_noise²)
```

so the bound grows like `sqrt(steps)` rather than exponentially.

The two were measured on the shipped `wheel-scale-drift` run (480 intervals, 24.0 s, peak observed
drift **0.2818 m**), using the run's own stated assumptions (`rateSigma` 0.01, `rateSigmaOmega`
0.005):

| Model                                               | Peak bound       | vs observed drift |
| --------------------------------------------------- | ---------------- | ----------------- |
| Random walk (shipped)                               | **0.011147 m**   | ratio 25.28       |
| Worst-case, product-sum `(1+v·h)` per new injection | 0.254 m          | ratio 0.90        |
| Worst-case, full amplification `(1+v·h)^k`          | **35,254,370 m** | ratio 125,110,614 |

The full-amplification worst case lands at roughly **35 million metres** — about 125 million times
the drift it is supposed to detect.

## Decision

Accumulate the injected per-step uncertainty **as a sum of squares**, modelling independent
per-step sensor noise. The envelope grows like `sqrt(steps)`.

The reasoning that decides it is the last row of that table. A worst-case bound of 35 million
metres is not a conservative bound; it is a **useless** one. It cannot detect anything, ever. Every
run would come back `certified`, including a run with a 30 cm wheel-scale error, and the tool
would be indistinguishable from a program that always prints "looks fine". A bound that can never
be violated carries no information, and shipping it would make the entire product theatre.

A `sqrt(t)` bound stays tight enough to be falsified, which is the only property that makes a
verdict worth acting on.

## Consequences

**Good**

- The bound stays informative on real data. On `wheel-scale-drift` it certifies 0.0111 m against
  0.2818 m of observed drift and flags the run immediately.
- The model matches the physics it is claiming. Independent per-step rate noise really does
  accumulate in quadrature; that is what a random walk _is_.
- The bound is a statement about _stated assumptions_, so a reader can disagree with the
  assumption rather than having to distrust the arithmetic.

**Bad — and this is the honest part**

- **This is not a worst-case bound.** It does not model correlated error. If every step errs in
  the same direction simultaneously — a real possibility for a systematic fault — the true error
  can exceed this bound while the tool still reports `certified`. Anyone deploying this must
  understand that `certified` means "consistent with independent per-step noise", **not** "cannot
  possibly be worse".
- The bound therefore cannot be used as a safety limit, a tolerance, or a guarantee of any kind. It
  is a detector, not a guarantee.
- Correlated error is exactly the class of fault this product is trying to find, so the model is
  weakest precisely where it matters. It is a real limitation, accepted because the alternative
  detects nothing at all.

## Why this is not a contradiction

The apparent tension — "a model that misses systematic error, used to find systematic error" —
resolves because of **how the two growth rates compare**, and it is the load-bearing consequence
of this decision:

- Independent noise accumulates like `sqrt(t)`.
- A systematic bias — a wheel scale factor, a constant yaw bias — does not average out. It
  accumulates like `t`.

So a systematic error grows _faster_ than the envelope and **escapes it almost immediately**, and
that escape is the detection signal. It is not a gap in the model; it is the model working as
intended.

Measured, on the two drifting runs:

| Run                 | First escape | Ratio |
| ------------------- | ------------ | ----- |
| `wheel-scale-drift` | `t=0.05s`    | 25.28 |
| `imu-yaw-bias`      | `t=0.65s`    | 2.40  |
| `clean-run`         | none         | 0.29  |

The healthy run never escapes, because sub-0.1% scale errors really are consistent with a 1% rate
uncertainty. That is the correct answer, and it is why `clean-run` ships: a detector that fires on
healthy hardware is worse than no detector, because it sends people chasing good sensors.

## Alternatives rejected

**Worst-case Lipschitz propagation, `(1+v·h)^k`.** Rejected on measurement: 35,254,370 m on a
24-second run. It cannot detect anything.

**Worst-case propagation without re-amplifying accumulated error** (a product-sum bound). Less
bad at 0.254 m, and still useless — it lands _below_ the observed drift on the run it exists to
catch, so it fails open on exactly the case that matters.

**A tuned percentile envelope.** Rejected: choosing the multiplier so the shipped runs pass is
fitting the detector to its own test data. The multiplier here comes from the run's stated
`rateSigma`, which a reader can inspect and challenge.

**Letting a model judge plausibility.** Rejected for the same reason as everywhere else in this
product: a bound a model produced cannot be re-derived by hand, and a bound that cannot be
re-derived is not falsifiable. See [architecture.md](../architecture.md).

## Revisit if

- The engine gains a long-lived mode where per-step residuals are available, at which point the
  independence assumption could be tested rather than asserted.
- Correlated-error modelling becomes tractable — a latent-bias state in the envelope recursion
  would absorb a constant yaw bias explicitly instead of relying on its growth rate to escape.
- The bound is ever proposed for a safety or tolerance purpose. It is a detector, and this ADR
  forbids that use.
