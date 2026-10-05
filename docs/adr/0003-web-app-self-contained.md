# ADR 0003 — The web app has no workspace dependencies

- **Status:** Accepted
- **Date:** 2026-01-01

## Context

The web app is the only part of this repository deployed to Vercel. The rest is a
multi-package monorepo built with turbo, so the workspace dependency graph creates a coupling
between the deployment target and the local build order.

## Decision

`apps/web` depends on **no** workspace package. It has its own typed data layer in
`apps/web/lib/` and reads only what it needs.

## Consequences

**Good**

- The Vercel build cannot break because a workspace build reordered or failed.
- `vercel --prod` works from a bare checkout of `apps/web`.
- The deployed bundle is inspectable and has a small, known dependency set.

**Bad**

- `packages/memory` is not reachable from the web app, so server-rendered product routes
  read from the local data layer instead. If that layer ever needs to become the real store,
  this ADR is revisited.
- Some types are restated in `apps/web/lib/product.ts`. They are small and stable; a
  generated client would be the fix if they grew.

## Alternatives rejected

**Import workspace packages directly.** Rejected after the failure mode was made concrete: a
turbo cache miss or a workspace build failure becomes a deploy failure, and the fix is not
local to the deploy.

**Deploy the whole monorepo with the web app at the root.** Rejected: it pulls the Python
engine and every package into the deployment image for no benefit.
