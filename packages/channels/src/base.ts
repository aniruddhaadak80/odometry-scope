import { TimeoutError, ValidationError } from '@odometryscope/core'
import type { Channel, DeliveryReceipt, Outbound, ProbeResult } from './types.js'

export interface RetryPolicy {
  readonly attempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

export const defaultRetry: RetryPolicy = { attempts: 3, baseDelayMs: 50, maxDelayMs: 2_000 }

/**
 * Shared retry with exponential backoff. Transport adapters call `sendWithRetry`; they must
 * not reimplement it — divergence here is how channel adapters drift apart.
 */
export abstract class BaseChannel implements Channel {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly requiresNetwork: boolean

  protected readonly retry: RetryPolicy
  protected running = false

  constructor(retry: RetryPolicy = defaultRetry) {
    this.retry = retry
  }

  /** Adapter-specific single attempt. Throw to signal failure. */
  protected abstract deliver(target: string, message: Outbound, attempt: number): Promise<void>

  protected probeImpl(): ProbeResult {
    return {
      channel: this.id,
      status: this.running ? 'ok' : 'warn',
      detail: this.running ? 'running' : 'configured but not started',
      ...(this.running ? {} : { fix: `run ${this.id}.start() or enable it in config` }),
    }
  }

  async start(): Promise<void> {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async probe(): Promise<ProbeResult> {
    return this.probeImpl()
  }

  async send(target: string, message: Outbound): Promise<DeliveryReceipt> {
    if (message.text.trim().length === 0) {
      throw new ValidationError('outbound message text must not be empty', { field: 'text' })
    }

    let lastError: unknown
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        await this.deliver(target, message, attempt)
        return {
          channel: this.id,
          target,
          deliveredAt: Date.now(),
          attempts: attempt,
        }
      } catch (cause) {
        lastError = cause
        if (attempt === this.retry.attempts) break
        const delay = Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw new TimeoutError(`channel "${this.id}" failed after ${this.retry.attempts} attempts`, {
      channel: this.id,
      target,
      cause: String(lastError),
    })
  }
}
