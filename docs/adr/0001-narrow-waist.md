# ADR 0001 — One registry, one interface, four transports

- **Status:** Accepted
- **Date:** 2026-01-01

## Context

This product is reachable from a CLI, a web app, an MCP server, and one or more messaging
channels. The obvious implementation grows a parallel code path per surface: the CLI gets a
command, the web app gets a route handler, the MCP server gets a tool, and each drifts.

## Decision

Every capability is a `Tool` registered in exactly one `ToolRegistry`. Each surface is a
transport that adapts a request into a registry invocation and adapts the result back out.

## Consequences

**Good**

- A capability added once is available on every surface immediately.
- Behaviour cannot diverge between surfaces, because there is only one implementation.
- Permissions and validation are enforced in one place.
- Testing the registry tests the product.

**Bad**

- The registry is load-bearing, so it must stay small and dependency-free. That is why
  `packages/core` has no runtime dependencies at all.
- Every surface pays a translation cost. That cost is paid once, in an adapter.

## Alternatives rejected

**A shared service layer.** Every surface calls HTTP. Rejected: it adds a network hop to
local operation, makes the offline path a second implementation, and turns a latency
optimisation into an infrastructure problem.

**Code generation per surface.** Rejected: generated adapters drift from hand-edited ones,
and the drift is invisible until a user hits it.
