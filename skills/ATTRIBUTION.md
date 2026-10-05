# Skill attribution

Skills in this catalog ship into users' agent directories, so their provenance must be
explicit and auditable.

## Rules

1. A skill authored for this project needs no entry here.
2. A skill adapted from another project **must**:
   - declare `metadata.upstream` and `metadata.upstreamUrl` in its frontmatter,
   - add a row below naming the source, the upstream licence, and what changed,
   - appear in `NOTICE`.
3. `npm run check:skill-version` fails when a skill body changes without a
   `metadata.version` bump — an unbumped skill is an update users never receive.

## Current entries

| Skill        | Upstream | Upstream licence | Changes |
| ------------ | -------- | ---------------- | ------- |
| _(none yet)_ |          |                  |         |

Copyright 2026 aniruddhaadak80.
