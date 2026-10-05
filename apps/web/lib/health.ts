import { PRODUCT, resolveVersion } from './product'
import { listRuns } from './runs'

export type Status = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

export interface HealthReport {
  readonly ok: boolean
  readonly name: string
  readonly version: string
  readonly commit: string
  readonly runtime: string
  readonly region: string
  readonly checks: readonly Check[]
}

const MINIMUM_NODE_MAJOR = 22

/**
 * Probes only what can genuinely be observed at runtime.
 *
 * The data probe reads the same committed analyses the pages render, so if it passes the site
 * is genuinely serving product data — not an empty shell with a green light. A health check
 * that claims a probe it did not run is worse than no health check at all.
 */
export function probeHealth(): HealthReport {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0')
  checks.push(
    nodeMajor >= MINIMUM_NODE_MAJOR
      ? { name: 'runtime', status: 'ok', detail: `node ${process.versions.node}` }
      : {
          name: 'runtime',
          status: 'fail',
          detail: `node ${process.versions.node} is below the required v${MINIMUM_NODE_MAJOR}.12.0`,
          fix: 'target Node 22 in the deployment runtime',
        },
  )

  checks.push({
    name: 'package',
    status: 'ok',
    detail: `${PRODUCT.slug}@${resolveVersion()}`,
  })

  const runs = listRuns()
  checks.push(
    runs.length > 0
      ? {
          name: 'data',
          status: 'ok',
          detail: `${runs.length} analysed run${runs.length === 1 ? '' : 's'} readable`,
        }
      : {
          name: 'data',
          status: 'fail',
          detail: 'no committed analyses found under data/runs',
          fix: 'run `python scripts/generate-runs.py` from the repository root',
        },
  )

  const drifting = runs.filter((run) => run.verdict.severity === 'drifting').length
  if (runs.length > 0) {
    checks.push({
      name: 'verdicts',
      status: 'ok',
      detail: `${drifting} of ${runs.length} run${runs.length === 1 ? '' : 's'} drifting`,
    })
  }

  checks.push({
    name: 'region',
    status: 'ok',
    detail: process.env.VERCEL_REGION ?? 'local',
  })

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    name: PRODUCT.slug,
    version: resolveVersion(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
    runtime: process.versions.node,
    region: process.env.VERCEL_REGION ?? 'local',
    checks,
  }
}
