import { ValidationError } from '@odometryscope/core'
import { BaseChannel } from './base.js'
import type { Outbound, ProbeResult } from './types.js'

export interface LocalChannelOptions {
  /** Injected so tests are deterministic and can force failures. */
  readonly failFirstN?: number
  readonly latencyMs?: number
}

/** A channel that writes to stdout. Useful for local development and as the test adapter. */
export class LocalChannel extends BaseChannel {
  readonly id = 'local'
  readonly displayName = 'Local stdout'
  readonly requiresNetwork = false

  readonly #sent: { target: string; text: string; idempotencyKey: string }[] = []
  readonly #failFirstN: number
  readonly #latencyMs: number

  constructor(options: LocalChannelOptions = {}) {
    super({ attempts: 3, baseDelayMs: 1, maxDelayMs: 4 })
    this.#failFirstN = options.failFirstN ?? 0
    this.#latencyMs = options.latencyMs ?? 0
  }

  get sent(): readonly { target: string; text: string; idempotencyKey: string }[] {
    return this.#sent
  }

  protected override async deliver(target: string, message: Outbound, attempt: number): Promise<void> {
    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs))
    }
    if (attempt <= this.#failFirstN) {
      throw new Error(`simulated transient failure on attempt ${attempt}`)
    }
    const duplicate = this.#sent.some((m) => m.idempotencyKey === message.idempotencyKey)
    if (duplicate) return
    this.#sent.push({ target, text: message.text, idempotencyKey: message.idempotencyKey })
    process.stdout.write(`[${this.id}] ${target}: ${message.text}\n`)
  }

  protected override probeImpl(): ProbeResult {
    return {
      channel: this.id,
      status: 'ok',
      detail: `local sink ready, ${this.#sent.length} delivered`,
    }
  }
}

export { ValidationError }
