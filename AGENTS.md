# AGENTS.md

A **router**, not a manual. Read the file that owns the area before changing it.

| Area                                          | Read first                                                         |
| --------------------------------------------- | ------------------------------------------------------------------ |
| tool interface, registry, permissions, errors | `packages/core/src/`                                               |
| the product's domain vocabulary               | `packages/core/src/domain.ts`                                      |
| configuration schema                          | `packages/config/src/schema.ts`                                    |
| storage, migrations, the columnar run store   | `packages/memory/src/migrations.ts`, `packages/memory/src/runs.ts` |
| the drift envelope and its assumptions        | `docs/adr/0004-why-a-random-walk-envelope.md`                      |
| committed analyses and the web data tier      | `docs/adr/0005-committed-analyses-for-the-web-tier.md`             |
| skill format and authoring rules              | `skills/AGENTS.md`                                                 |
| plugin manifest contract                      | `docs/plugins.md`                                                  |
| MCP surface and tool naming                   | `docs/mcp.md`                                                      |
| the Python engine                             | `docs/adr/0002-python-engine-boundary.md`                          |
| CLI commands, flags, exit codes               | `docs/cli.md`                                                      |
| sample runs and how to regenerate them        | `scripts/generate-runs.py`                                         |
| the web app and design tokens                 | `apps/web/styles/tokens.css`                                       |
| CI jobs and gates                             | `docs/ci.md`                                                       |
| architectural decisions                       | `docs/adr/`                                                        |

## The footprint ladder

Where new capability goes, in order of preference. This ordering is binding — see hard rule 2:

1. **Extend an existing tool**
2. **Add a CLI command + a skill**
3. **Add a service-gated tool**
4. **Add a plugin**
5. **Add an MCP tool**
6. **Add a new core tool — last resort**

Every core tool is paid for in context window on every request, forever. Plugins are free. That
asymmetry is the entire reason for the ladder, and it is why reaching for `packages/core` first is
the most common review comment here. Read `docs/architecture.md` before adding anything.

## Hard rules

1. **The narrow waist holds.** One registry, one `Tool` interface. A surface is a transport,
   never a second implementation. A second code path is a bug even when it works.
2. **The footprint ladder is binding.** Extend an existing tool → CLI command + skill →
   service-gated tool → plugin → MCP tool → new core tool. Core is last, not first.
3. **No cross-package deep imports.** Only declared entry points. `check:boundaries` fails
   otherwise.
4. **Tokens only in `apps/web`.** No raw colour literal outside `styles/tokens.css`.
5. **Never edit a version in a PR.** The release workflow owns version bumps.
6. **Never edit an applied migration.** Append a new one.
7. **The engine is pure.** No clock, no network, no randomness, no filesystem.
8. **Bump `metadata.version` on any `SKILL.md` body change.**
9. **Never widen an envelope, tolerance, or test bound to make a failure go away.** The envelope's
   assumptions are stated in `docs/adr/0004-why-a-random-walk-envelope.md`, and a detection that
   fires on healthy hardware is worse than no detection. Change the engine, not the bound.
10. **Run the full gate before claiming done:** `npm run check`.

## Structural limits

A file over ~2000 lines, a function over ~300 lines, or a cyclomatic complexity over 30 is a
defect, not a style preference. Split it.

## Two decisions that look like bugs and are not

- **The envelope is a random walk, not a worst-case bound.** A worst-case bound reached 35,254,370 m
  on a 24-second run — it could never detect anything, so every run would come back `certified`.
  Because a systematic bias grows like `t` while the envelope grows like `sqrt(t)`, it escapes
  quickly, and **that escape is the signal**. See
  `docs/adr/0004-why-a-random-walk-envelope.md`.
- **The web tier renders committed analyses instead of calling the engine.** ADR 0003 forbids
  workspace dependencies in `apps/web` and a serverless filesystem is read-only.
  `packages/cli/src/runs.test.ts` recomputes every committed run through a live engine call and
  fails on drift. See `docs/adr/0005-committed-analyses-for-the-web-tier.md`.

## Definition of done

- [ ] `npm run check` exits 0
- [ ] tests cover the failure path, not only the happy path
- [ ] `CHANGELOG.md` has an `Unreleased` entry
- [ ] any user-visible change has a docs update (see the table in `docs/notes/`)
- [ ] if the engine's numerics changed, `python scripts/generate-runs.py` was re-run and its output
      committed (see ADR 0005)
- [ ] any command written into `README.md` was actually run, and its real output pasted

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
