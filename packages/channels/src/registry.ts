import { ConflictError } from '@odometryscope/core'
import type { Channel } from './types.js'

export class ChannelRegistry {
  readonly #channels = new Map<string, Channel>()

  register(channel: Channel): this {
    if (this.#channels.has(channel.id)) {
      throw new ConflictError(`channel "${channel.id}" is already registered`, { channel: channel.id })
    }
    this.#channels.set(channel.id, channel)
    return this
  }

  get(id: string): Channel {
    const channel = this.#channels.get(id)
    if (channel === undefined) {
      throw new ConflictError(`channel "${id}" is not registered`, { channel: id })
    }
    return channel
  }

  list(): readonly Channel[] {
    return [...this.#channels.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Backs `doctor`. Never throws — a failing channel must not break the report. */
  async probeAll(): Promise<readonly { channel: string; status: string; detail: string; fix?: string }[]> {
    const results = await Promise.all(
      this.list().map(async (channel) => {
        try {
          const probe = await channel.probe()
          return {
            channel: probe.channel,
            status: probe.status,
            detail: probe.detail,
            ...(probe.fix ? { fix: probe.fix } : {}),
          }
        } catch (cause) {
          return {
            channel: channel.id,
            status: 'fail',
            detail: String(cause),
            fix: `check the ${channel.displayName} configuration`,
          }
        }
      }),
    )
    return results
  }
}
