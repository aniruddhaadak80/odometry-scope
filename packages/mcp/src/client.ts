import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface ServerConfig {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly enabled: boolean
  readonly env?: Record<string, string>
}

export interface RemoteTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** Reads the server registry from config. Disabled servers are listed but not launched. */
export function enabledServers(configs: readonly ServerConfig[]): readonly ServerConfig[] {
  return configs.filter((config) => config.enabled)
}

/**
 * process.env is Record<string, string | undefined>, but the transport wants only strings.
 * Passing undefined values through is a type error under exactOptionalPropertyTypes and a
 * real spawn failure at runtime, so they are dropped here rather than at the call site.
 */
export function sanitisedEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') base[key] = value
  }
  return extra === undefined ? base : { ...base, ...extra }
}

export class McpClient {
  readonly #client = new Client({ name: 'odometry-scope-client', version: '0.1.0' }, { capabilities: {} })

  async connect(config: ServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      ...(config.env === undefined ? {} : { env: sanitisedEnv(config.env) }),
    })
    await this.#client.connect(transport)
  }

  async listTools(): Promise<readonly RemoteTool[]> {
    const response = await this.#client.listTools()
    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    }))
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const response = (await this.#client.callTool({ name, arguments: args })) as {
      content?: unknown
      isError?: boolean
    }

    const parts = Array.isArray(response.content)
      ? (response.content as { type?: string; text?: string }[])
      : []
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')

    if (response.isError === true) throw new Error(text === '' ? 'tool call failed' : text)
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  async close(): Promise<void> {
    await this.#client.close()
  }
}
