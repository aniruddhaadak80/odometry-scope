# Skills

A skill is markdown instructions for an agent, shipped into the user's agent directory.

## Layout

```
skills/
  ATTRIBUTION.md          provenance for anything adapted from elsewhere
  AGENTS.md              the authoring standard
  <skill-name>/
    SKILL.md
```

## Frontmatter contract

```yaml
---
name: kebab-case-unique # required
description: One sentence, saying WHEN to use it.
metadata:
  version: 1.0.0 # required, semver — bump on ANY body change
  upstream: optional-name # required if adapted from another project
  upstreamUrl: https://... # required if adapted from another project
---
```

## Why the version gate

These files ship into users' agent directories. A body change without a version bump is an
update that is never offered. So `npm run check:skill-version` fails the build when a
`SKILL.md` body changes and `metadata.version` does not.

## Validation

`odoscope skills --json` reports every issue with a file and a line:

- missing or unparseable frontmatter
- a `name` that is not kebab-case, or that collides with another skill
- a `description` that is missing or too short to be useful
- a `metadata.version` that is absent or not semver

Invalid skills are **reported, never silently skipped**. A skill that fails to load is a
product bug the user needs to see.
