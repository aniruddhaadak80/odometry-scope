# CLAUDE.md

This file is a **pointer**. It exists because different agents look for different filenames.
It deliberately contains no duplicated rules — duplicated agent instructions drift.

**Read `AGENTS.md` first.** It is the single source of truth for the hard rules, the routing
table, the footprint ladder, and the definition of done.

The only thing worth repeating here, because it is the most common way to break this
codebase:

> Adding capability to `packages/core` is the **last** option, not the first. Try, in order:
> extend an existing tool, add a CLI command plus a skill, add a service-gated tool, add a
> plugin, add an MCP tool. Only reach for a new core tool when none of those fit, and say why
> in the PR description.
