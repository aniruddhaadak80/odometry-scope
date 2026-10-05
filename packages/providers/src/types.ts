import type { ValidationError } from '@odometryscope/core'

/**
 * One interface, N adapters. Callers never branch on which provider is configured.
 * Every call is: validate -> capability check -> cost accounting -> retry -> normalise.
 */
export interface Provider {
  readonly id: string
  readonly label: string
  readonly requiresNetwork: boolean
  listModels(): Promise<readonly ModelInfo[]>
  complete(request: CompletionRequest): Promise<CompletionResult>
}

export interface ModelInfo {
  readonly id: string
  readonly contextWindow: number
  readonly inputPerMTokUsd: number
  readonly outputPerMTokUsd: number
}

export interface CompletionRequest {
  readonly model: string
  readonly prompt: string
  readonly maxOutputTokens: number
  readonly signal?: AbortSignal
}

export interface CompletionResult {
  readonly model: string
  readonly provider: string
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly latencyMs: number
}

export interface ProviderHealth {
  readonly provider: string
  readonly status: 'ok' | 'warn' | 'fail'
  readonly detail: string
  readonly fix?: string
}

export type { ValidationError }
