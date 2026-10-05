import { describe, expect, it } from 'vitest'
import { TimeoutError, ValidationError } from '@odometryscope/core'
import { LocalChannel } from './local.js'

const msg = (text: string, key = 'k1') => ({ text, idempotencyKey: key })

describe('LocalChannel', () => {
  it('delivers and reports attempts', async () => {
    const channel = new LocalChannel()
    await channel.start()
    const receipt = await channel.send('alice', msg('hello'))
    expect(receipt.attempts).toBe(1)
    expect(receipt.channel).toBe('local')
    expect(channel.sent).toHaveLength(1)
  })

  it('retries a transient failure and succeeds', async () => {
    const channel = new LocalChannel({ failFirstN: 2 })
    const receipt = await channel.send('alice', msg('retry me'))
    expect(receipt.attempts).toBe(3)
    expect(channel.sent).toHaveLength(1)
  })

  it('throws after exhausting retries', async () => {
    const channel = new LocalChannel({ failFirstN: 99 })
    await expect(channel.send('alice', msg('doomed'))).rejects.toBeInstanceOf(TimeoutError)
  })

  it('is idempotent on idempotencyKey', async () => {
    const channel = new LocalChannel()
    await channel.send('alice', msg('once', 'same-key'))
    await channel.send('alice', msg('once', 'same-key'))
    expect(channel.sent).toHaveLength(1)
  })

  it('rejects empty outbound text before any transport work', async () => {
    const channel = new LocalChannel()
    await expect(channel.send('alice', msg('   '))).rejects.toBeInstanceOf(ValidationError)
  })

  it('probes ok when constructed', async () => {
    await expect(new LocalChannel().probe()).resolves.toMatchObject({ status: 'ok' })
  })
})
