# Plugins

## Contract

| Field          | Type     | Rule                                                 |
| -------------- | -------- | ---------------------------------------------------- |
| `name`         | string   | `^[a-z0-9][a-z0-9-]*$`                               |
| `version`      | string   | `\d+\.\d+\.\d+$`                                     |
| `description`  | string   | at least 10 characters                               |
| `enabled`      | boolean  | default `true`                                       |
| `priority`     | 0–100    | default `50`; decides capability conflicts           |
| `capabilities` | string[] | the names this plugin claims                         |
| `engines`      | record   | exact version matches; a mismatch rejects the plugin |

## Resolution

Plugins are sorted by priority descending, then by name. A plugin claiming a capability an
already-accepted plugin holds is **shadowed** and reported — not dropped. Ties break on name,
so resolution is deterministic.

## Inspect

```bash
odoscope plugins --json
```

The output separates `active`, `disabled`, and `rejected`, and every rejection carries the
reason — an invalid manifest names the failing field, and a version mismatch names both the
required and the running version.

## A plugin gets no privileged path

A plugin registers tools through the same core registry every other surface uses. There is no
plugin-only API that bypasses permission checks or validation.
