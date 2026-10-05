# Adding a tool

1. Implement it in the package that owns the concern. If no package owns it, that is the
   signal to add a plugin rather than grow the core.
2. Declare `name`, `description`, `inputSchema`, `outputSchema`, `permissions`, `surface`.
3. Write the description for a model: what it does, when to use it, what it returns.
4. Validate input against `inputSchema` at the boundary. Do not trust the caller.
5. Register it. Expect a duplicate-name `ConflictError` if the name is taken — fix the name,
   do not bypass the check.
6. Add a test that asserts both the success path and the failure path.
7. If it is model-facing, add the CLI command and note it in `docs/cli.md`. Per the
   footprint ladder, a CLI command without an MCP tool is incomplete.
8. Bump `CHANGELOG.md` under `Unreleased`.
