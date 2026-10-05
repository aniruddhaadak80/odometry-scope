import { ValidationError } from '@odometryscope/core'
import type { CompletionRequest, CompletionResult, ModelInfo, Provider } from './types.js'

/**
 * A deterministic offline provider. It exists so the product is fully exercisable with no
 * network and no API key — the deterministic engine is what makes that possible.
 */
export class LocalProvider implements Provider {
  readonly id = 'local'
  readonly label = 'Local deterministic (no network)'
  readonly requiresNetwork = false

  async listModels(): Promise<readonly ModelInfo[]> {
    return [{ id: 'local-1', contextWindow: 32_768, inputPerMTokUsd: 0, outputPerMTokUsd: 0 }]
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (request.prompt.trim().length === 0) {
      throw new ValidationError('prompt must not be empty', { field: 'prompt' })
    }
    const started = Date.now()
    const text = request.prompt.trim()
    return {
      model: request.model,
      provider: this.id,
      text,
      inputTokens: Math.ceil(text.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      costUsd: 0,
      latencyMs: Date.now() - started,
    }
  }
}
