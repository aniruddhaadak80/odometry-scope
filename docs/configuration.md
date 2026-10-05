# Configuration

Layered, later wins:

```
defaults  →  product.config.json  →  environment
```

The zod schema in `packages/config/src/schema.ts` is the **single source of truth**. The
settings UI derives its form from `z.toJSONSchema()` — that JSON Schema is never hand-written,
so the two cannot drift.

## Keys

| Key                | Type    | Default       | Meaning                                  |
| ------------------ | ------- | ------------- | ---------------------------------------- |
| `productEnv`       | enum    | `development` | one of development, test, production     |
| `dataDir`          | string  | `.data`       | where SQLite and caches live             |
| `engine.python`    | string  | `python`      | interpreter for the deterministic engine |
| `engine.timeoutMs` | integer | `10000`       | hard ceiling on one engine call          |
| `providers`        | record  | `{}`          | per-provider overrides                   |
| `channels`         | record  | `{}`          | per-channel `enabled` flags              |
| `logLevel`         | enum    | `info`        | one of debug, info, warn, error          |

## Environment overlay

| Variable              | Maps to              |
| --------------------- | -------------------- |
| `PRODUCT_ENV`         | `productEnv`         |
| `PRODUCT_DATA_DIR`    | `dataDir`            |
| `PRODUCT_LOG_LEVEL`   | `logLevel`           |
| `PRODUCT_CONFIG_PATH` | the config file path |

## An invalid value is an error, never a coercion

Unknown keys are dropped rather than carried forward, and a value that fails validation
raises a `ValidationError` naming the failing field. Silently coercing `"loud"` to a log
level is how a typo becomes a debugging session.

## Secrets

Only `.env.example` is committed, and every value in it is empty.
`npm run check:no-secrets` fails if a `.env` with values is ever tracked.
