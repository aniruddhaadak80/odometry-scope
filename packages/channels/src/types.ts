export interface Outbound {
  readonly text: string
  readonly replyTo?: string
  readonly idempotencyKey: string
}

export interface DeliveryReceipt {
  readonly channel: string
  readonly target: string
  readonly deliveredAt: number
  readonly attempts: number
}

export type ProbeStatus = 'ok' | 'warn' | 'fail'

export interface ProbeResult {
  readonly channel: string
  readonly status: ProbeStatus
  readonly detail: string
  readonly fix?: string
}

/**
 * One interface, many adapters. Adapters differ only in transport and auth — retry,
 * rate limiting, and the outbound queue all live in the base class.
 */
export interface Channel {
  readonly id: string
  readonly displayName: string
  readonly requiresNetwork: boolean
  start(): Promise<void>
  stop(): Promise<void>
  send(target: string, message: Outbound): Promise<DeliveryReceipt>
  probe(): Promise<ProbeResult>
}
