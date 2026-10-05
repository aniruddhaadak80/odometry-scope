import { existsSync, readFileSync } from 'node:fs'
import { ConfigSchema, defaultConfig, type Config } from './schema.js'
import { ValidationError } from '@odometryscope/core'

export interface LoadOptions {
  readonly path?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Layered: defaults -> file -> env overlay. Unknown keys are dropped, not carried. */
export function loadConfig(options: LoadOptions = {}): Config {
  const env = options.env ?? process.env
  const path = options.path ?? env.PRODUCT_CONFIG_PATH ?? 'product.config.json'

  let fileData: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      fileData = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch (cause) {
      throw new ValidationError(`config at ${path} is not valid JSON`, { path, cause: String(cause) })
    }
  }

  const overlay: Record<string, unknown> = {}
  if (env.PRODUCT_ENV) overlay.productEnv = env.PRODUCT_ENV
  if (env.PRODUCT_DATA_DIR) overlay.dataDir = env.PRODUCT_DATA_DIR
  if (env.PRODUCT_LOG_LEVEL) overlay.logLevel = env.PRODUCT_LOG_LEVEL

  const parsed = ConfigSchema.safeParse({ ...fileData, ...overlay })
  if (!parsed.success) {
    throw new ValidationError('config failed schema validation', { issues: parsed.error.issues })
  }
  return parsed.data
}

export { defaultConfig }
