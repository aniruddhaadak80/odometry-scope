import { describe, expect, it } from 'vitest'
import { ToolRegistry, isProductError, loadCatalog } from './index.js'

describe('sdk facade', () => {
  it('re-exports the narrow waist', () => {
    expect(typeof ToolRegistry).toBe('function')
    expect(typeof isProductError).toBe('function')
    expect(typeof loadCatalog).toBe('function')
  })

  it('constructs a working registry through the public entry point', () => {
    const registry = new ToolRegistry()
    expect(registry.size).toBe(0)
    expect(registry.names()).toEqual([])
  })
})
