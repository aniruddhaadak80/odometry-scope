import { spawn } from 'node:child_process'
import { TimeoutError, UpstreamError } from '@odometryscope/core'

export interface EngineRequest {
  readonly op: string
  readonly input: unknown
}

export interface EngineResponse<T = unknown> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
  readonly durationMs: number
}

export interface BridgeOptions {
  readonly python?: string
  /** Absolute or cwd-relative path to a runnable engine script. */
  readonly enginePath?: string
  /** Module form, e.g. `waveform_transpile`. Preferred: the package uses relative imports. */
  readonly module?: string
  readonly timeoutMs?: number
  readonly cwd?: string
}

interface ResolvedBridgeOptions {
  readonly python: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly cwd: string | undefined
}

/**
 * The Python engine is a pure function over stdin/stdout — no server, no port, no daemon.
 * Every write is therefore atomic, and two concurrent calls can never interleave state.
 *
 * The module form is preferred because the engine package uses relative imports, which only
 * resolve when it is imported as a package (`python -m pkg`) rather than run as a file.
 */
export class EngineBridge {
  readonly #options: ResolvedBridgeOptions

  constructor(options: BridgeOptions) {
    if (options.module === undefined && options.enginePath === undefined) {
      throw new UpstreamError('bridge needs either a "module" or an "enginePath"', {
        received: Object.keys(options),
      })
    }
    this.#options = {
      python: options.python ?? 'python',
      args: options.module !== undefined ? ['-m', options.module] : [options.enginePath as string],
      timeoutMs: options.timeoutMs ?? 10_000,
      cwd: options.cwd,
    }
  }

  async call<T = unknown>(request: EngineRequest): Promise<T> {
    const response = await this.invoke(request)
    if (!response.ok) {
      throw new UpstreamError(response.error?.message ?? 'engine returned an unknown error', {
        op: request.op,
        code: response.error?.code,
      })
    }
    return response.value as T
  }

  async invoke(request: EngineRequest): Promise<EngineResponse> {
    const started = Date.now()
    const payload = JSON.stringify(request)

    return await new Promise<EngineResponse>((resolve) => {
      const child = spawn(this.#options.python, [...this.#options.args], {
        cwd: this.#options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (value: EngineResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }

      const timer = setTimeout(() => {
        child.kill()
        finish({
          ok: false,
          error: { code: 'TIMEOUT', message: `engine timed out after ${this.#options.timeoutMs}ms` },
          durationMs: Date.now() - started,
        })
      }, this.#options.timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))

      child.on('error', (cause) => {
        finish({
          ok: false,
          error: { code: 'SPAWN_FAILED', message: String(cause) },
          durationMs: Date.now() - started,
        })
      })

      child.on('close', (code) => {
        if (code !== 0) {
          finish({
            ok: false,
            error: {
              code: 'NONZERO_EXIT',
              message: `engine exited ${code}: ${stderr.trim() || 'no stderr'}`,
            },
            durationMs: Date.now() - started,
          })
          return
        }
        try {
          finish(JSON.parse(stdout.trim()) as EngineResponse)
        } catch (cause) {
          finish({
            ok: false,
            error: { code: 'BAD_OUTPUT', message: `engine produced invalid JSON: ${String(cause)}` },
            durationMs: Date.now() - started,
          })
        }
      })

      child.stdin.end(payload)
    })
  }
}

export { TimeoutError }
