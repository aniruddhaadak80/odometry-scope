# Architecture

## The narrow waist

Every capability is a `Tool` in one registry. Every surface is a thin transport over it.

```
   CLI ────────────▶┌───────────────┐
   Web ────────────▶│               │
   MCP server ─────▶│  ToolRegistry │──▶ services/engine  (pure Python, stdin/stdout)
   Channel ─────────▶└───────────────┘
```

The CLI, the web app, the MCP server and every channel adapter contain **no product logic**. If a
surface needs a behaviour, that behaviour belongs in a tool. There is exactly one
implementation of every capability, so a fix lands on every surface at once and two surfaces can
never disagree about what the product does.

Ten tools are registered. Six of them are thin, validated wrappers over one engine operation
(`engine_normalize`, `engine_integrate`, `engine_divergence`, `engine_attribute`,
`engine_classify`, `engine_summarize`); `analyze_run` composes four of those into the flagship
report; the remaining three are introspection (`list_skills`, `list_plugins`, `health_check`).

## Invariants

1. **Tools are stateless.** State lives in `packages/memory`, addressed through the context.
2. **Input is validated before the handler runs.** Never after, never partially.
3. **Permissions are declared, not assumed.** A call exceeding the granted set is refused before
   the handler executes. The engine tools declare `proc:spawn` because spawning Python is exactly
   what they do.
4. **Duplicate tool names throw**, naming both registrants. A silent overwrite is an undebuggable
   product bug.
5. **No cross-package deep imports.** Only declared entry points. Enforced by
   `check:boundaries`.
6. **Errors carry a stable code.** One taxonomy (`VALIDATION_FAILED`, `PERMISSION_DENIED`,
   `NOT_FOUND`, `CONFLICT`, `UPSTREAM_FAILED`, `TIMEOUT`, `UNSUPPORTED`) from which a CLI exit
   code, an MCP error envelope and an HTTP status are all derived.

## The deterministic engine

The parts that must be exactly right are code, not generation. They live in `services/engine`: a
dependency-free Python package called as a **pure function** over stdin/stdout.

```
stdin   {"op": "divergence", "input": {...}}
stdout  {"ok": true, "value": {...}, "durationMs": 4}
        {"ok": false, "error": {"code": "BOUND_VIOLATION", "message": "..."}, "durationMs": 4}
```

One JSON object in, one JSON object out, and **nothing else is ever written to stdout** —
diagnostics go to stderr, so a caller can parse stdout unconditionally.

No server, no port, no daemon, no persisted state, and no clock, network, randomness or
filesystem access. Two concurrent calls cannot interfere because there is no state to interleave,
and a failing call is reproducible because the same input always produces the same failure.

Six operations:

| Operation    | What it answers                                                              |
| ------------ | ---------------------------------------------------------------------------- |
| `normalize`  | what channels does this raw log actually contain, once aliases are resolved? |
| `integrate`  | where should the robot have been, given these rates?                         |
| `divergence` | how far did it drift, and did that exceed what the sensors allow?            |
| `attribute`  | which sensor explained the drift?                                            |
| `classify`   | is this verdict certified or unbounded?                                      |
| `summarize`  | what are the headline numbers for this run?                                  |

See [adr/0002-python-engine-boundary.md](adr/0002-python-engine-boundary.md).

## Why the engine is the only place numbers are computed

Every figure the product reports — the peak drift, the bound, the ratio, the explained fraction,
the severity — is produced by `services/engine` and nowhere else. The TypeScript side validates
shapes, marshals JSON and renders text; it never computes.

This is not stylistic. The value of the product is the claim _"this drift is outside what your
sensors can explain"_, and that claim is only worth anything if a reader can re-derive it. A
number computed by a language model, or by a heuristic in the renderer, is not a claim — it is an
assertion. Keeping the arithmetic in one auditable package is what makes the envelope
falsifiable, and falsifiability is the product's entire position.

The engine is held to `mypy --strict` and property-tested with `hypothesis`, because a numerical
claim nobody can check is a claim nobody should act on.

## Columnar storage

A run's samples are stored **columnar**: parallel arrays rather than one object per sample.

Every consumer in this repository sweeps a whole channel linearly — the divergence loop, the
integrator, the envelope accumulation, the ablation. Columnar layout turns a 200k-sample track
into six contiguous buffers instead of 200k objects to allocate, parse and walk. That is why the
divergence sweep stays cheap at bag-file sizes, and why `MAX_SERIES` can sit at 200,000 rather
than at whatever an object-per-sample layout can afford.

The same choice is carried through every tier rather than re-decided per tier:

- `packages/core/src/domain.ts` types the channels as `readonly number[]` per field.
- `services/engine` receives and returns parallel typed columns (`Channels` is a `TypedDict` of
  six `list[float]`).
- `packages/memory` persists one `pose_columns` row per (run, channel), with the six sample
  buffers packed little-endian into `Float64Array` blobs written through `DataView`. The explicit
  little-endian flag makes the round trip exact on any host endianness rather than exact by
  accident.
- `apps/web` reads the same committed shape.

`packages/memory` also validates every value on the way in and writes through
`store.transaction(...)`. A store that accepted a ragged or non-finite column would hand back a
sweep that silently reads past the end of a buffer.

## Why the envelope is a random walk and not worst-case

The bound is **not** a worst-case Lipschitz bound, and that is a deliberate decision with a
measured justification rather than a preference.

The rejected model treats every interval as erring in the same direction at once, so each step's
error is re-amplified by the heading-rotation factor `(1 + |v|·h)`. Accumulated error therefore
compounds as `(1 + |v|·h)^k`. Computed on the shipped `wheel-scale-drift` run (480 intervals,
24.0 s, peak observed drift 0.2818 m), that model yields a bound of **35,254,370 m** — about
35 million metres, roughly 125 million times the drift it is supposed to detect. A bound that wide
can never detect anything, so every run would come back `certified` and the tool would be
theatre.

What ships instead accumulates the injected per-step uncertainty as a **sum of squares**:

```
bound ← sqrt(bound² + step_noise²)
```

so the bound grows like `sqrt(steps)`. This models _independent_ per-step sensor noise, which is
what per-step rate uncertainty actually is, and it stays tight enough to be falsified — the same
run yields a peak bound of **0.0111 m** against 0.2818 m of observed drift, a ratio of 25.28.

The trade is stated plainly rather than hidden: this does **not** model correlated worst-case
error. It is a random-walk bound, so it is not a guarantee.

That trade is also exactly what makes the product useful. Independent noise averages out and
stays near `sqrt(t)`. A _systematic_ bias — a wheel scale factor, a constant yaw bias — does not
average out: it accumulates like `t`. So it escapes a `sqrt(t)` envelope almost immediately, and
**that escape is the detection signal**, not a defect in the bound. On `wheel-scale-drift` the
drift escapes at `t=0.05s`; on the milder `imu-yaw-bias` it escapes at `t=0.65s`.

This is why `rateSigma` is a stated, user-supplied assumption rather than a fitted constant: the
bound only certifies a claim under assumptions somebody wrote down, and those assumptions must be
visible to whoever reads the verdict.

See [adr/0004-why-a-random-walk-envelope.md](adr/0004-why-a-random-walk-envelope.md).

## Packages

| Package         | Responsibility                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `core`          | the `Tool` interface, the registry, permissions, the error taxonomy, the domain vocabulary. No I/O. |
| `config`        | layered config; the schema is the source of truth                                                   |
| `memory`        | columnar SQLite storage, numbered migrations, FTS5 search                                           |
| `skills`        | `SKILL.md` discovery, frontmatter parsing, catalog validation                                       |
| `plugins`       | manifest loading, schema validation, priority conflict resolution                                   |
| `channels`      | one `Channel` interface; retry and queueing live in the base class                                  |
| `providers`     | one `Provider` interface — **no adapters ship** (see deliberate omissions)                          |
| `mcp`           | MCP server (stdio) and MCP client, both over the core registry                                      |
| `engine-client` | typed subprocess bridge to the Python engine                                                        |
| `cli`           | commander CLI; `run` is the flagship command, `doctor` the diagnostic one                           |
| `sdk`           | the public facade — the stable surface and nothing else                                             |

## Deliberate omissions

### No LLM providers

`packages/providers` ships the interface and zero adapters. A model in the loop would make the
error envelope unfalsifiable, and falsifiability is the one property this product exists to
protect. There is nothing a model could add that a number cannot, and a great deal it would
obscure.

### No chat interface

The output is a verdict and an envelope plot, not a conversation. A chat surface rewards a fluent
"looks fine" over an arithmetic "the bound was exceeded at step 1" — it invites precisely the
unsupported confidence the engine is built to refuse.

### `apps/web` has no workspace-package dependencies

The deployed bundle is self-contained, removing build-order coupling between the monorepo and the
deployment target. The cost is that the web app reads its own data layer and committed analyses
rather than importing `packages/memory` or calling the engine at request time. See
[adr/0003-web-app-self-contained.md](adr/0003-web-app-self-contained.md) and
[adr/0005-committed-analyses-for-the-web-tier.md](adr/0005-committed-analyses-for-the-web-tier.md).

## The footprint ladder

Where new capability goes, in order of preference:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool
4. Add a plugin
5. Add an MCP server tool
6. Add a new core tool — last resort

Every core tool is paid for in context window on every request, forever. Plugins are free. That
asymmetry is the whole reason for the ladder, and it is why adding to `packages/core` first is the
most common review comment here.
