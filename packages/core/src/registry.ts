import { ConflictError, PermissionError } from './errors.js'
import { isSatisfied } from './permissions.js'
import type { Tool, ToolContext, ToolSurface } from './types.js'

export interface RegisterOptions {
  readonly surface?: ToolSurface
  readonly source?: string
}

/**
 * The single registry. Duplicate names are a hard error naming both sources — never a
 * silent overwrite, because a silently replaced tool is an undebuggable product bug.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool<never, unknown>>()
  readonly #sources = new Map<string, string>()
  readonly #surfaces = new Map<string, ToolSurface>()

  register<I, O>(tool: Tool<I, O>, options: RegisterOptions = {}): this {
    const surface = options.surface ?? tool.surface
    const source = options.source ?? surface
    const existing = this.#sources.get(tool.name)

    if (existing !== undefined) {
      throw new ConflictError(`tool "${tool.name}" is already registered`, {
        tool: tool.name,
        existingSource: existing,
        incomingSource: source,
      })
    }

    this.#tools.set(tool.name, tool as unknown as Tool<never, unknown>)
    this.#sources.set(tool.name, source)
    this.#surfaces.set(tool.name, surface)
    return this
  }

  registerAll(tools: readonly Tool<never, unknown>[], options: RegisterOptions = {}): this {
    for (const tool of tools) this.register(tool, options)
    return this
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  get(name: string): Tool<never, unknown> {
    const tool = this.#tools.get(name)
    if (tool === undefined) {
      throw new ConflictError(`tool "${name}" is not registered`, { tool: name })
    }
    return tool
  }

  list(): readonly Tool<never, unknown>[] {
    return [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  names(): readonly string[] {
    return this.list().map((t) => t.name)
  }

  sourceOf(name: string): string | undefined {
    return this.#sources.get(name)
  }

  /** Which surface a tool came from: core, plugin, or mcp. Powers `doctor` and the CLI. */
  surfaceOf(name: string): ToolSurface | undefined {
    return this.#surfaces.get(name)
  }

  listBySurface(surface: ToolSurface): readonly Tool<never, unknown>[] {
    return this.list().filter((tool) => this.#surfaces.get(tool.name) === surface)
  }

  /** Refuses before invocation. Returns the tool's typed result. */
  async invoke(
    name: string,
    input: unknown,
    ctx: ToolContext,
    granted: readonly Tool['permissions'][number][] = [],
  ): Promise<unknown> {
    const tool = this.get(name)
    if (!isSatisfied(tool.permissions, granted)) {
      throw new PermissionError(`tool "${name}" requires permissions not granted`, {
        tool: name,
        required: tool.permissions,
        granted,
      })
    }
    return tool.handler(input as never, ctx)
  }

  get size(): number {
    return this.#tools.size
  }
}
