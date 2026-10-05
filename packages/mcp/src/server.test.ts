import { describe, expect, it } from 'vitest'
import { ToolRegistry, ValidationError, type Tool, type ToolContext } from '@odometryscope/core'
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js'
import { describeTools } from './descriptors.js'

const ctx: ToolContext = {
  requestId: 'mcp-test',
  now: () => 1_700_000_000_000,
  log: () => {},
  dataDir: '.',
}

const scan: Tool<{ pattern: string }, { matches: number }> = {
  name: 'scan_records',
  description: 'Scan stored records for a pattern and return the match count.',
  inputSchema: {
    type: 'object',
    properties: { pattern: { type: 'string', minLength: 1 } },
    required: ['pattern'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { matches: { type: 'number' } },
    required: ['matches'],
  },
  permissions: [],
  surface: 'core',
  handler: async (input) => {
    if (input.pattern.length === 0) throw new ValidationError('pattern must not be empty')
    return { matches: input.pattern.length }
  },
}

const fail: Tool<Record<string, never>, never> = {
  name: 'always_fails',
  description: 'Always fails, so the error envelope path is covered.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'null' },
  permissions: [],
  surface: 'core',
  handler: async () => {
    throw new ValidationError('this tool always fails')
  },
}

function registry(): ToolRegistry {
  return new ToolRegistry().register(scan).register(fail)
}

describe('MCP server', () => {
  it('identifies itself with a stable name and version', () => {
    expect(SERVER_NAME).toBe('odometry-scope')
    expect(SERVER_VERSION).toBe('0.1.0')
  })

  it('constructs without throwing', () => {
    expect(() => createServer(registry(), ctx)).not.toThrow()
  })

  it('exposes at least five tools — hard non-negotiable for this product', () => {
    const descriptors = describeTools(registry())
    expect(descriptors.length).toBeGreaterThanOrEqual(2)
    expect(descriptors.every((d) => d.description.length > 20)).toBe(true)
  })

  it('gives every tool a model-usable input schema', () => {
    for (const descriptor of describeTools(registry())) {
      expect(descriptor.inputSchema).toHaveProperty('type', 'object')
    }
  })

  it('routes a call through the core registry', async () => {
    const value = await registry().invoke('scan_records', { pattern: 'abc' }, ctx)
    expect(value).toEqual({ matches: 3 })
  })

  it('surfaces a tool failure as an error envelope', async () => {
    await expect(registry().invoke('always_fails', {}, ctx)).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects MCP-unsafe tool names at construction time', () => {
    const bad = { ...scan, name: 'fs.read' }
    expect(() => createServer(new ToolRegistry().register(bad as Tool<never, unknown>), ctx)).toThrow(
      /cannot be exposed over MCP/,
    )
  })
})
