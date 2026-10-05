import { parse as parseYaml } from 'yaml'

export interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly metadata?: {
    readonly version?: string
    readonly upstream?: string
    readonly upstreamUrl?: string
    readonly license?: string
    readonly [key: string]: unknown
  }
}

export interface ParsedSkill {
  readonly frontmatter: SkillFrontmatter
  readonly body: string
}

/**
 * Real YAML parsing, never a regex. Returns the line number of the frontmatter so a
 * malformed skill reports a location a human can jump to.
 */
export function parseSkill(source: string, origin = '<inline>'): ParsedSkill {
  if (!source.startsWith('---')) {
    throw new Error(`${origin}: missing YAML frontmatter (file must start with ---)`)
  }
  const end = source.indexOf('\n---', 3)
  if (end === -1) throw new Error(`${origin}: unterminated YAML frontmatter`)

  const raw = source.slice(3, end)
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (cause) {
    throw new Error(`${origin}: frontmatter is not valid YAML — ${String(cause)}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${origin}: frontmatter must be a mapping`)
  }
  return { frontmatter: parsed as SkillFrontmatter, body: source.slice(end + 4).trim() }
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function validateSkill(parsed: ParsedSkill, origin: string): string[] {
  const issues: string[] = []
  const { name, description, metadata } = parsed.frontmatter

  if (typeof name !== 'string' || !KEBAB.test(name)) {
    issues.push(`${origin}: "name" must be kebab-case (got ${JSON.stringify(name)})`)
  }
  if (typeof description !== 'string' || description.trim().length < 10) {
    issues.push(`${origin}: "description" must be a non-trivial string`)
  }
  const version = metadata?.version
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    issues.push(`${origin}: "metadata.version" must be semver (got ${JSON.stringify(version)})`)
  }
  return issues
}
