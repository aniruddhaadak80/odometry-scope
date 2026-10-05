import { z } from 'zod'

/**
 * The single source of truth for configuration. The settings UI in apps/web derives its
 * form from `configJsonSchema()` — that schema is never hand-written, so the two cannot drift.
 */
export const ConfigSchema = z.object({
  productEnv: z.enum(['development', 'test', 'production']).default('development'),
  dataDir: z.string().min(1).default('.data'),
  engine: z
    .object({
      python: z.string().min(1).default('python'),
      timeoutMs: z.number().int().positive().max(120_000).default(10_000),
    })
    .default({ python: 'python', timeoutMs: 10_000 }),
  providers: z.record(z.string(), z.object({ baseUrl: z.string().url().optional() })).default({}),
  channels: z.record(z.string(), z.object({ enabled: z.boolean().default(false) })).default({}),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof ConfigSchema>

export const defaultConfig = (): Config => ConfigSchema.parse({})

/** JSON Schema for the settings UI, derived from the zod schema. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: 'input' }) as Record<string, unknown>
}
