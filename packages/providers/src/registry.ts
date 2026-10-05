import { ConflictError } from '@odometryscope/core'
import type { Provider } from './types.js'

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>()

  register(provider: Provider): this {
    if (this.#providers.has(provider.id)) {
      throw new ConflictError(`provider "${provider.id}" is already registered`, {
        provider: provider.id,
      })
    }
    this.#providers.set(provider.id, provider)
    return this
  }

  get(id: string): Provider {
    const provider = this.#providers.get(id)
    if (provider === undefined) {
      throw new ConflictError(`provider "${id}" is not registered`, { provider: id })
    }
    return provider
  }

  list(): readonly Provider[] {
    return [...this.#providers.values()].sort((a, b) => a.id.localeCompare(b.id))
  }
}
