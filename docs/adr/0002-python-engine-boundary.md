# ADR 0002 — The deterministic engine is a pure Python function

- **Status:** Accepted
- **Date:** 2026-01-01

## Context

Parts of this product must be exactly right: they are arithmetic, graph, and state logic where
a model's output is plausible but wrong. Those parts need property tests, deterministic
replay, and the ability to run with no network and no API key.

## Decision

Those parts live in `services/engine`, a dependency-free Python package, invoked as a
**pure function over stdin/stdout**. No server, no port, no daemon, no persisted state.

- Input: one JSON object `{"op": "...", "input": ...}` on stdin.
- Output: one JSON object on stdout. Diagnostics on stderr only.
- No clock reads, no randomness, no network, no filesystem. Time and entropy are arguments.

## Consequences

**Good**

- Every operation is property-testable in isolation with `hypothesis`.
- Two concurrent calls cannot interfere — there is no state to interleave.
- A failing call is reproducible: same input, same failure.
- `mypy --strict` over a small dependency-free package is a genuinely strong gate.
- The whole product is exercisable offline, which is what makes the local test suite fast.

**Bad**

- Process spawn per call adds latency. For a CLI this is irrelevant; for a hot loop it is not,
  and the right answer there is a long-lived process — a separate ADR when it is needed.
- Two languages to maintain.

## Alternatives rejected

**TypeScript engine.** Rejected: the ecosystem for property-based testing and numeric
verification is stronger in Python, and the language split is what makes the boundary
_visible_ rather than incidental.

**A local HTTP service.** Rejected: adds lifecycle, port allocation, and a failure mode where
the service is not running. A subprocess cannot leak state between calls.
