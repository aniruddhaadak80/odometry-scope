import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from '@odometryscope/skills'
import { buildRegistry as buildPluginRegistry } from '@odometryscope/plugins'

export type Status = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly Check[]
}

const pkg = { name: 'odometry-scope', version: '0.1.0' }

/**
 * The flagship command. An agent that mutates its own configuration must be able to
 * diagnose itself, and every failing row carries a fix hint rather than only a status.
 */
export async function doctor(cwd = process.cwd()): Promise<DoctorReport> {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(
    nodeMajor >= 22
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is below the required v22.12.0`,
          fix: 'install Node 22.12 or newer (see .nvmrc)',
        },
  )

  checks.push({
    name: 'package',
    status: 'ok',
    detail: `${pkg.name}@${pkg.version}`,
  })

  const skills = loadCatalog(join(cwd, 'skills'))
  checks.push(
    skills.issues.length === 0
      ? { name: 'skills', status: 'ok', detail: `${skills.skills.length} skills, 0 invalid` }
      : {
          name: 'skills',
          status: 'fail',
          detail: `${skills.skills.length} valid, ${skills.issues.length} invalid`,
          fix: skills.issues[0] ?? 'see npm run check:skill-version',
        },
  )

  const plugins = buildPluginRegistry(join(cwd, 'plugins'))
  checks.push(
    plugins.rejected.length === 0
      ? {
          name: 'plugins',
          status: 'ok',
          detail: `${plugins.active.length} active, ${plugins.disabled.length} disabled`,
        }
      : {
          name: 'plugins',
          status: 'warn',
          detail: `${plugins.rejected.length} rejected`,
          fix: plugins.rejected[0]?.issues[0] ?? 'inspect plugins/*/plugin.json',
        },
  )

  const configPath = join(cwd, 'product.config.json')
  checks.push(
    existsSync(configPath)
      ? { name: 'config', status: 'ok', detail: 'product.config.json found' }
      : {
          name: 'config',
          status: 'warn',
          detail: 'no product.config.json — using defaults',
          fix: 'run with defaults, or create product.config.json',
        },
  )

  // The engine is the product. A tree where Python is missing or the module cannot be
  // imported passes every other check and still cannot answer a single question, so this is
  // probed by actually calling it rather than by checking that a file exists.
  checks.push(await probeEngine(cwd))

  const runsDir = join(cwd, 'apps', 'web', 'data', 'runs')
  const analyses = existsSync(runsDir)
    ? readdirSync(runsDir).filter((name) => name.endsWith('.analysis.json'))
    : []
  checks.push(
    analyses.length > 0
      ? { name: 'sample runs', status: 'ok', detail: `${analyses.length} analysed runs committed` }
      : {
          name: 'sample runs',
          status: 'warn',
          detail: 'no committed analyses under apps/web/data/runs',
          fix: 'run `python scripts/generate-runs.py` from the repository root',
        },
  )

  return { ok: checks.every((c) => c.status !== 'fail'), checks }
}

/** One real round trip through the stdio boundary, reported as a doctor row. */
async function probeEngine(cwd: string): Promise<Check> {
  try {
    const { EngineBridge } = await import('@odometryscope/engine-client')
    const bridge = new EngineBridge({ module: 'odometry_scope', cwd: join(cwd, 'services', 'engine', 'src') })
    const result = (await bridge.call({
      op: 'summarize',
      input: { channels: { t: [0, 1], x: [0, 1], y: [0, 0], theta: [0, 0] } },
    })) as { count?: number }
    return { name: 'python engine', status: 'ok', detail: `reachable, ${result.count ?? 0}-sample probe ok` }
  } catch (cause) {
    return {
      name: 'python engine',
      status: 'fail',
      detail: cause instanceof Error ? cause.message : String(cause),
      fix: 'check that python is on PATH and services/engine is installed',
    }
  }
}

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length), 5)
  const icon = (status: Status): string => (status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL')
  const lines = report.checks.map((c) => {
    const head = `  [${icon(c.status)}] ${c.name.padEnd(width)}  ${c.detail}`
    return c.fix === undefined ? head : `${head}\n         fix: ${c.fix}`
  })
  return [
    `${pkg.name} doctor`,
    ...lines,
    '',
    report.ok ? 'all required checks passed' : 'one or more checks failed',
  ].join('\n')
}
