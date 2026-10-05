import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { isProductError, type Permission, type ToolContext, type ToolRegistry } from '@odometryscope/core'
import { assertMcpSafeName, describeTools } from './descriptors.js'

export const SERVER_NAME = 'odometry-scope'
export const SERVER_VERSION = '0.1.0'

/**
 * The permission ceiling for this server.
 *
 * The union of what the registered tools DECLARE. Running `mcp serve` is an explicit
 * operator action, so a tool is not additionally blocked for declaring what it needs — but
 * nothing is granted beyond a tool's own declaration, so a tool can never reach a capability
 * it did not declare. Narrow this with PRODUCT_MCP_PERMISSIONS if you want a tighter server.
 */
export function grantedPermissions(registry: ToolRegistry): readonly Permission[] {
  const override = process.env.PRODUCT_MCP_PERMISSIONS
  if (override !== undefined && override !== '') {
    return override
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean) as Permission[]
  }
  const union = new Set<Permission>()
  for (const tool of registry.list()) {
    for (const permission of tool.permissions) union.add(permission)
  }
  return [...union]
}

/**
 * An MCP server over stdio. Every tool is backed by the core registry — MCP adds a
 * transport, never a second implementation. Tools are stateless: all state lives in
 * packages/memory, addressed through the context.
 *
 * The tool list is derived from the registry and asserted MCP-safe at construction time, so
 * a name MCP cannot carry fails loudly here instead of silently disappearing.
 */
export function createServer(registry: ToolRegistry, context: ToolContext): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })

  const descriptors = describeTools(registry)
  for (const descriptor of descriptors) assertMcpSafeName(descriptor.name)

  const granted = grantedPermissions(registry)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: descriptors.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const value = await registry.invoke(name, args ?? {}, context, granted)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value ?? null, null, 2) }],
      }
    } catch (cause) {
      const code = isProductError(cause) ? cause.code : 'INTERNAL'
      const message = cause instanceof Error ? cause.message : String(cause)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${code}: ${message}` }],
      }
    }
  })

  return server
}

export async function serveStdio(registry: ToolRegistry, context: ToolContext): Promise<void> {
  const server = createServer(registry, context)
  await server.connect(new StdioServerTransport())
}
