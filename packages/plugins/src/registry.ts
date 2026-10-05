import type { PluginManifest } from './manifest.js'
import { loadPlugins, type LoadedPlugin } from './manifest.js'

export interface ResolvedPlugin {
  readonly manifest: PluginManifest
  readonly path: string
  readonly shadowed: readonly string[]
}

export interface RegistryResult {
  readonly active: readonly ResolvedPlugin[]
  readonly disabled: readonly ResolvedPlugin[]
  readonly rejected: readonly { path: string; issues: readonly string[] }[]
}

/**
 * Deterministic conflict resolution: a plugin may claim a capability only if its priority
 * exceeds every other claimant. The loser is reported, never dropped without explanation.
 */
export function buildRegistry(root = 'plugins', engineVersions: Record<string, string> = {}): RegistryResult {
  const loaded: LoadedPlugin[] = loadPlugins(root)
  const rejected: { path: string; issues: readonly string[] }[] = []
  const valid: ResolvedPlugin[] = []

  for (const plugin of loaded) {
    if (plugin.issues.length > 0) {
      rejected.push({ path: plugin.path, issues: plugin.issues })
      continue
    }
    const incompatibilities = Object.entries(plugin.manifest.engines)
      .filter(([pkg, range]) => {
        const actual = engineVersions[pkg]
        return actual !== undefined && actual !== range
      })
      .map(([pkg, range]) => `${pkg}: requires ${range}, running ${engineVersions[pkg]}`)
    if (incompatibilities.length > 0) {
      rejected.push({ path: plugin.path, issues: incompatibilities })
      continue
    }
    valid.push({ manifest: plugin.manifest, path: plugin.path, shadowed: [] })
  }

  valid.sort(
    (a, b) => b.manifest.priority - a.manifest.priority || a.manifest.name.localeCompare(b.manifest.name),
  )

  const claims = new Map<string, ResolvedPlugin>()
  const active: ResolvedPlugin[] = []
  for (const plugin of valid) {
    const clashes = plugin.manifest.capabilities.filter((c) => claims.has(c))
    if (clashes.length > 0) {
      const winner = claims.get(clashes[0] as string)
      ;(winner?.shadowed as string[]).push(plugin.manifest.name)
      continue
    }
    for (const capability of plugin.manifest.capabilities) claims.set(capability, plugin)
    if (plugin.manifest.enabled) active.push(plugin)
  }

  return { active, disabled: valid.filter((p) => !p.manifest.enabled), rejected }
}
