# Changes that need a matching update

The single highest-leverage table in this repository. It converts "remember to update the
docs" from a memory test into a lookup.

| Change                          | Also required                                                            |
| ------------------------------- | ------------------------------------------------------------------------ |
| A tool's schema or description  | `docs/mcp.md` tool list, and a CHANGELOG entry                           |
| A new tool that is model-facing | a CLI command, and a row in `docs/cli.md`                                |
| A config key                    | `docs/configuration.md` table (generated from the schema where possible) |
| A `SKILL.md` body               | `metadata.version` bump, or `check:skill-version` fails                  |
| A skill adapted from elsewhere  | `metadata.upstream*`, an `ATTRIBUTION.md` row, `NOTICE`                  |
| A new plugin field              | the plugin manifest schema and `docs/plugins.md`                         |
| A new package                   | a row in `docs/architecture.md`                                          |
| A user-visible behaviour change | `CHANGELOG.md` under `Unreleased`                                        |
| A dependency added              | the licence row in `THIRD_PARTY_NOTICES.md`                              |
| An architectural decision       | a new ADR in `docs/adr/`                                                 |
| A release                       | the version bump is done by the release workflow, never in a PR          |
