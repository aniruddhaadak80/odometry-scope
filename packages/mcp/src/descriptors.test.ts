import { describe, expect, it } from 'vitest'
import { ToolRegistry, type Tool } from '@odometryscope/core'
import { assertMcpSafeName, describeTools } from './descriptors.js'

function tool(name: string): Tool<unknown, unknown> {
  return {
    name,
    description: `Tool ${name} for the contract test.`,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'null' },
    permissions: [],
    surface: 'core',
    handler: async (input) => input,
  }
}

describe('describeTools', () => {
  it('derives descriptors from the core registry', () => {
    const registry = new ToolRegistry().register(tool('alpha')).register(tool('beta'))
    const descriptors = describeTools(registry)
    expect(descriptors.map((d) => d.name)).toEqual(['alpha', 'beta'])
    expect(descriptors[0]?.description).toContain('contract test')
  })

  it('returns nothing for an empty registry', () => {
    expect(describeTools(new ToolRegistry())).toEqual([])
  })
})

describe('assertMcpSafeName', () => {
  it('accepts a conforming name', () => {
    expect(() => assertMcpSafeName('scan_records')).not.toThrow()
  })

  it('rejects a name MCP cannot carry', () => {
    expect(() => assertMcpSafeName('fs.read')).toThrowError(/cannot be exposed over MCP/)
    expect(() => assertMcpSafeName('Upper')).toThrow()
    expect(() => assertMcpSafeName('')).toThrow()
  })
})
