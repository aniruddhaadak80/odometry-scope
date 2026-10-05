# odometry_scope

The deterministic engine for [odometry-scope](../README.md).

## Why Python

The parts of this product that must be exactly right are code, not generation. Keeping
them in a separate, dependency-free Python package means they can be property-tested in
isolation and called as a pure function — no server, no port, no daemon, no shared state.

## Protocol

One JSON object on stdin, one on stdout:

```console
$ echo '{"op":"summarize","input":{"records":[]}}' | python -m odometry_scope
{"ok":true,"value":{"total":0,"byKind":{},"oldest":0,"newest":0},"durationMs":0}
```

Errors never raise a traceback. They come back as
`{"ok": false, "error": {"code": "...", "message": "..."}}` so the host can map a stable
code to an exit code or an HTTP status.

## Operations

| op          | purpose                                                 |
| ----------- | ------------------------------------------------------- |
| `normalize` | flatten records into a stable, sorted, comparable shape |
| `diff`      | minimal structural diff between two record sets         |
| `summarize` | aggregate counts without discarding anything            |

## Rules for anything added here

1. Pure. No clock, no network, no randomness, no filesystem.
2. Time and entropy are arguments, never reads.
3. Typed input and output via `TypedDict` or dataclasses.
4. One named operation per entry point, registered in `OPERATIONS`.
5. `mypy --strict` clean.

## Development

```bash
python -m pytest services/engine -q        # tests, including property tests
python -m mypy services/engine/src        # type gate
python -m ruff check services/engine      # lint gate
```

Copyright 2026 aniruddhaadak80. Licensed under the Apache License 2.0.
