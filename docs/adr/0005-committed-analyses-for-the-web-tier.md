# ADR 0005 — Committed analyses for the web tier

- **Status:** Accepted
- **Date:** 2026-01-01

## Context

Two earlier decisions collide with the web app's need to render real numbers.

[ADR 0003](0003-web-app-self-contained.md) keeps `apps/web` free of **all** workspace
dependencies. It has its own typed data layer and must not import `packages/*`, so the Vercel
deploy cannot break because a turbo build reordered or failed.

[ADR 0002](0002-python-engine-boundary.md) puts every computed number in `services/engine`, a
Python package invoked as a pure function over stdin/stdout — a **subprocess**.

The collision: the web app wants to display drift envelopes, ablation tables and verdicts. Those
numbers come from Python. And a serverless filesystem is **read-only**, so it cannot generate them
at request time even if it could spawn the engine.

So the web tier needs committed numbers, and that immediately raises the obvious danger. A website
that quotes hard-coded figures can drift away from what the code actually computes and still look
perfect. For a product whose entire claim is _"trust these numbers"_, a deployed site quoting stale
ones is the worst available failure.

## Decision

`scripts/generate-runs.py` **runs the real engine** and commits its output as
`apps/web/data/runs/*.analysis.json`, alongside the `*.json` run documents themselves.

- The generator imports `odometry_scope.analysis` directly and calls `summarize`, `divergence`,
  `attribute` and `classify`. Nothing is pre-baked or hand-written.
- It is **deterministic**: same inputs, byte-identical files. Verified by running it twice and
  comparing SHA-256 of every output.
- The web app reads the committed analysis. It never calls the engine at request time.

The anti-rot guard is `packages/cli/src/runs.test.ts`, which for **every** committed run:

1. reads the committed `<id>.analysis.json`,
2. recomputes the analysis through a **live engine call** (a real subprocess spawn), and
3. fails on any drift.

```ts
expect(live.maxObserved).toBeCloseTo(committed.maxObserved as number, 12)
expect(live.boundRatio).toBeCloseTo(committed.boundRatio as number, 9)
expect(live.firstExceedance).toBe(committed.firstExceedance)
expect(live.exceeded).toBe(committed.exceeded)
expect(live.dominantSensor).toBe(committed.dominantSensor)
expect(live.verdict).toEqual(committed.verdict)
expect(live.attribution).toEqual(committed.attribution)
```

Without this test, an integrator change would silently leave the deployed site quoting numbers the
engine no longer produces — and nothing else in the repository would notice.

`doctor` also reports the count as a row (`3 analysed runs committed`), so a tree with no committed
analyses is visible at a glance.

## Consequences

**Good**

- The web deploy stays self-contained and fast: static reads, no Python at request time.
- The deployed figures are **provably** current, because CI recomputes them against the live engine
  on every change.
- The generator is the only writer, so there is no second code path for producing an analysis.

**Bad**

- The site _can_ in principle quote stale numbers — for one commit, between an integrator change
  landing and the generator being re-run. The test makes this loud rather than silent, but it does
  not make it impossible.
- Analyses must be regenerated whenever the engine's numerics change, which couples a source change
  to a data change in the same commit.
- Run documents are generated, not hand-authored, so editing one directly is pointless — the next
  generator run discards it.

## Alternatives rejected

**Run Python in a serverless function.** Rejected: `analyze_run` needs four engine operations, so
each page view would spawn **four** processes (`npm run check` already shows how expensive process
spawn is). It also requires a portable Python runtime in the deploy image, which is a large new
dependency for a page that renders three committed records.

**Ship a JSON API from another host.** Rejected: it makes a static, inspectable deploy depend on a
service being up, and adds auth, versioning and an availability story to a product whose numbers
never change between releases.

**Compute a summary at build time and commit that.** Rejected: same staleness risk as this ADR for
no benefit — the full analysis is what makes the site worth reading, and committing it is no larger
than committing a summary.

**Let `apps/web` import `@odometryscope/core` for the types only.** Rejected as a violation of
ADR 0003's boundary, even though types alone would not add a runtime dependency. The value of that
ADR is that the rule has no exceptions to remember.

## Revisit if

- The run count grows past the point where committing analyses is unwieldy, or analyses become
  large enough that a data store beats files in the repository.
- The engine gains a long-lived mode (the deferred alternative in
  [ADR 0002](0002-python-engine-boundary.md)), which would make a server-side call cheap enough to
  reconsider.
- Per-view run selection arrives, at which point the deployed bundle would need to carry every run
  rather than three committed examples.
