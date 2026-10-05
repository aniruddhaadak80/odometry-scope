import { describe, expect, it } from 'vitest'
import { ValidationError } from '@odometryscope/core'
import { defaultConfig } from './schema.js'
import { loadConfig } from './load.js'

describe('loadConfig', () => {
  it('returns defaults when no file exists', () => {
    const config = loadConfig({ path: 'does/not/exist.json', env: {} })
    expect(config).toEqual(defaultConfig())
  })

  it('applies the env overlay above the file', () => {
    const config = loadConfig({ path: 'nope.json', env: { PRODUCT_LOG_LEVEL: 'debug' } })
    expect(config.logLevel).toBe('debug')
  })

  it('rejects an invalid value rather than coercing it', () => {
    expect(() => loadConfig({ path: 'nope.json', env: { PRODUCT_LOG_LEVEL: 'loud' } })).toThrowError(
      ValidationError,
    )
  })
})
