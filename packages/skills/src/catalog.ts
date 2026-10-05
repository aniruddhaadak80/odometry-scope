import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkill, validateSkill, type ParsedSkill } from './frontmatter.js'

export interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly upstream?: string
  readonly upstreamUrl?: string
  readonly body: string
  readonly path: string
}

export interface CatalogResult {
  readonly skills: readonly SkillEntry[]
  readonly issues: readonly string[]
}

/**
 * Discovers skills/<name>/SKILL.md. Invalid skills are REPORTED, never silently skipped —
 * a skill that fails to load is a product bug the user needs to see.
 */
export function loadCatalog(root = 'skills'): CatalogResult {
  const dir = join(root)
  if (!existsSync(dir)) return { skills: [], issues: [] }

  const issues: string[] = []
  const entries: SkillEntry[] = []
  const seen = new Map<string, string>()

  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const file = join(dir, dirent.name, 'SKILL.md')
    if (!existsSync(file)) {
      issues.push(`skills/${dirent.name}: has no SKILL.md`)
      continue
    }
    let parsed: ParsedSkill
    try {
      parsed = parseSkill(readFileSync(file, 'utf8'), `skills/${dirent.name}/SKILL.md`)
    } catch (cause) {
      issues.push(String(cause))
      continue
    }

    const found = validateSkill(parsed, `skills/${dirent.name}/SKILL.md`)
    if (found.length > 0) {
      issues.push(...found)
      continue
    }

    const name = parsed.frontmatter.name
    const previous = seen.get(name)
    if (previous !== undefined) {
      issues.push(`duplicate skill name "${name}" in ${dirent.name} and ${previous}`)
      continue
    }
    seen.set(name, dirent.name)

    entries.push({
      name,
      description: parsed.frontmatter.description,
      version: parsed.frontmatter.metadata?.version ?? '0.0.0',
      ...(parsed.frontmatter.metadata?.upstream === undefined
        ? {}
        : { upstream: parsed.frontmatter.metadata.upstream }),
      ...(parsed.frontmatter.metadata?.upstreamUrl === undefined
        ? {}
        : { upstreamUrl: parsed.frontmatter.metadata.upstreamUrl }),
      body: parsed.body,
      path: file,
    })
  }

  return { skills: entries.sort((a, b) => a.name.localeCompare(b.name)), issues }
}
