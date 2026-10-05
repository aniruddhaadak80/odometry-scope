import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog } from './catalog.js'

const dirs: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'skills-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return root
}

const valid = (name: string) => `---
name: ${name}
description: A valid skill used by the catalog test suite.
metadata:
  version: 1.0.0
---
Body text.
`

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('loadCatalog', () => {
  it('loads a valid skill', () => {
    const root = fixture({ 'alpha/SKILL.md': valid('alpha') })
    const { skills, issues } = loadCatalog(root)
    expect(issues).toEqual([])
    expect(skills).toHaveLength(1)
    expect(skills[0]?.version).toBe('1.0.0')
  })

  it('reports a skill with no version instead of skipping it silently', () => {
    const root = fixture({
      'beta/SKILL.md': '---\nname: beta\ndescription: Missing a version entirely.\n---\nBody.\n',
    })
    const { skills, issues } = loadCatalog(root)
    expect(skills).toHaveLength(0)
    expect(issues.join('\n')).toContain('metadata.version')
  })

  it('reports malformed frontmatter with a location', () => {
    const root = fixture({ 'gamma/SKILL.md': 'no frontmatter here' })
    const { issues } = loadCatalog(root)
    expect(issues.join('\n')).toContain('gamma/SKILL.md')
  })

  it('reports a duplicate skill name', () => {
    const root = fixture({ 'one/SKILL.md': valid('same'), 'two/SKILL.md': valid('same') })
    const { skills, issues } = loadCatalog(root)
    expect(skills).toHaveLength(1)
    expect(issues.join('\n')).toContain('duplicate skill name')
  })

  it('returns empty for a missing skills directory', () => {
    expect(loadCatalog('no/such/dir')).toEqual({ skills: [], issues: [] })
  })
})
