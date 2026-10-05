import type { ToolRegistry } from '@odometryscope/core'

export interface McpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/**
 * The single source of truth for what this product exposes over MCP.
 *
 * Both the server (which registers these with the SDK) and the contract test read from
 * here, so a tool cannot drift between the two. Descriptors are derived from the core
 * registry — there is no second list of tools to keep in sync.
 */
export function describeTools(registry: ToolRegistry): readonly McpToolDescriptor[] {
  return registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

/**
 * MCP tool names must match this pattern. A core tool named `fs.read` cannot be exposed
 * over MCP without an explicit mapping, so this throws rather than silently renaming.
 */
export const MCP_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

export function assertMcpSafeName(name: string): void {
  if (!MCP_TOOL_NAME.test(name)) {
    throw new Error(`tool "${name}" cannot be exposed over MCP: names must match ${MCP_TOOL_NAME}`)
  }
}
