# Authoring skills

A skill is a folder under `skills/` containing a `SKILL.md`.

## HARDLINE standards

These are not preferences. A change that violates them does not merge.

1. **Frontmatter is required and valid.** The file starts with `---`. Keys: `name`
   (kebab-case, unique across the catalog), `description` (one sentence, says when to
   use it), `metadata.version` (semver).
2. **Bump `metadata.version` on every body change.** Not only on breaking changes — on
   any change a user would want to receive.
3. **The body is instructions to an agent, not prose about the project.** Second person,
   imperative, numbered steps, no marketing.
4. **Name the exact commands.** `odoscope doctor`, not "run the diagnostic".
5. **Declare provenance.** Anything adapted from elsewhere sets `metadata.upstream*` and
   gets an `ATTRIBUTION.md` row.
6. **No secrets, no absolute paths, no machine-specific assumptions.**

## Shape

```markdown
---
name: example-skill
description: Use when the user asks to <specific thing>, because <reason>.
metadata:
  version: 1.0.0
---

# Example skill

## When to use this

<one line>

## Steps

1. `<command>` — <what it does>
2. `<command>` — <what it does>

## Verify

<how to confirm it worked>
```

## Checklist before opening a PR

- [ ] `name` is kebab-case and unique
- [ ] `description` says when to use it, not what it is
- [ ] `metadata.version` bumped
- [ ] every command was actually run
- [ ] `odoscope doctor` still passes
