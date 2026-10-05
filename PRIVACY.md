# Privacy

## What this product stores

Everything, and it stays on your machine:

- SQLite records in `dataDir` (default `.data/`)
- Skill and plugin metadata read from the repository
- Logs written to stdout/stderr

## What leaves your machine

Only what you explicitly configure:

- If you configure a hosted model provider, your prompts and the context assembled for them
  are sent to that provider, under **their** privacy policy. This product does not proxy,
  log, or retain them.
- Nothing else. There is no telemetry in the default build.

## Telemetry

**Off by default.** `TELEMETRY_ENABLED` defaults to unset, and `/api/health` reports
`warn` with a fix hint while it is off.

If you enable it, it sends anonymous aggregate counters only: command name, exit code, and
duration. No arguments, no paths, no content, no identifiers.

## Third parties

Vercel serves the web app and receives standard request metadata (IP, user agent) as any web
host does. GitHub serves the repository.

## Deletion

Delete `dataDir` and the product has no remaining state. There is no server-side copy,
because there is no server.
