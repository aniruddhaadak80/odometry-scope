import { describe, expect, it } from 'vitest'
import { ValidationError } from '@odometryscope/core'
import { LocalProvider } from './local.js'
import { ProviderRegistry } from './registry.js'

describe('LocalProvider', () => {
  const provider = new LocalProvider()

  it('completes without network or credentials', async () => {
    const result = await provider.complete({ model: 'local-1', prompt: '  hello  ', maxOutputTokens: 100 })
    expect(result.text).toBe('hello')
    expect(result.costUsd).toBe(0)
    expect(result.provider).toBe('local')
  })

  it('rejects an empty prompt', async () => {
    await expect(
      provider.complete({ model: 'local-1', prompt: '   ', maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('reports a model list', async () => {
    await expect(provider.listModels()).resolves.toHaveLength(1)
  })
})

describe('ProviderRegistry', () => {
  it('rejects a duplicate provider id', () => {
    const registry = new ProviderRegistry().register(new LocalProvider())
    expect(() => registry.register(new LocalProvider())).toThrowError(/already registered/)
  })

  it('throws a conflict error for an unknown provider', () => {
    expect(() => new ProviderRegistry().get('nope')).toThrowError(/not registered/)
  })
})
