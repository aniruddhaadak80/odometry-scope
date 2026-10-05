/**
 * The narrow waist. Every capability in this product is a Tool, registered in exactly one
 * registry, reachable identically from the CLI, the web app, and the MCP server.
 */

export type JsonSchema = Record<string, unknown>

export type Permission = 'fs:read' | 'fs:write' | 'net:fetch' | 'proc:spawn' | 'env:read' | 'secrets:read'

export type ToolSurface = 'core' | 'plugin' | 'mcp'

/** Stateless context handed to every tool. Nothing here is a live connection. */
export interface ToolContext {
  readonly requestId: string
  readonly now: () => number
  readonly log: (level: LogLevel, message: string, fields?: Record<string, unknown>) => void
  readonly dataDir: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Tool<I = unknown, O = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly permissions: readonly Permission[]
  readonly surface: ToolSurface
  /** Pure with respect to the context: state lives in memory, never in the tool. */
  handler: (input: I, ctx: ToolContext) => Promise<O>
}
