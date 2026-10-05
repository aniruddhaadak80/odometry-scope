import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRegistry } from './registry.js'

const dirs: string[] = []

function plugin(root: string, name: string, body: Record<string, unknown>): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(body), 'utf8')
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugins-'))
  dirs.push(root)
  return root
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const base = { version: '1.0.0', description: 'A plugin used in the registry tests.' }

describe('buildRegistry', () => {
  it('accepts a valid plugin', () => {
    const root = fixture()
    plugin(root, 'alpha', { ...base, name: 'alpha', capabilities: ['scan'] })
    const result = buildRegistry(root)
    expect(result.rejected).toHaveLength(0)
    expect(result.active.map((p) => p.manifest.name)).toEqual(['alpha'])
  })

  it('rejects an invalid manifest and says why', () => {
    const root = fixture()
    plugin(root, 'bad', { name: 'Bad_Name', version: 'nope' })
    const result = buildRegistry(root)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.issues.join(' ')).toMatch(/name|version/)
  })

  it('resolves a capability conflict by priority and reports the loser', () => {
    const root = fixture()
    plugin(root, 'weak', { ...base, name: 'weak', priority: 10, capabilities: ['scan'] })
    plugin(root, 'strong', { ...base, name: 'strong', priority: 90, capabilities: ['scan'] })
    const result = buildRegistry(root)
    expect(result.active.map((p) => p.manifest.name)).toEqual(['strong'])
    expect(result.active[0]?.shadowed).toContain('weak')
  })

  it('keeps a disabled plugin out of active but still reports it', () => {
    const root = fixture()
    plugin(root, 'off', { ...base, name: 'off', enabled: false, capabilities: [] })
    const result = buildRegistry(root)
    expect(result.active).toHaveLength(0)
    expect(result.disabled.map((p) => p.manifest.name)).toEqual(['off'])
  })

  it('rejects a plugin whose engine range does not match', () => {
    const root = fixture()
    plugin(root, 'p', { ...base, name: 'p', engines: { '@x/core': '^2.0.0' } })
    const result = buildRegistry(root, { '@x/core': '1.0.0' })
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.issues.join(' ')).toContain('requires ^2.0.0')
  })
})
