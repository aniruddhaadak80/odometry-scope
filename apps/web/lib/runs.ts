import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The web tier reads committed engine output, not a live database.
 *
 * `scripts/generate-runs.py` builds each sample run, then runs the *real* deterministic
 * engine over it and writes the resulting `RunAnalysis` next to the run document. This app
 * renders exactly those numbers. Two reasons it is precomputed rather than computed at
 * request time:
 *
 *  1. The analysis runs in the Python engine, which is a pure stdin/stdout boundary. A
 *     serverless request handler has no portable Python runtime and would make every page
 *     view pay four process spawns.
 *  2. A deployed function filesystem is read-only, so the columnar store cannot be written
 *     to there. The CLI owns persistence; this app is the read-only observatory.
 *
 * The committed analysis is not a cached guess. `packages/cli/src/runs.test.ts` recomputes
 * every run through a live engine call and fails if a single field has drifted, so the files
 * on disk are always the engine's current answer.
 *
 * The types below restate the domain shapes from `packages/core/src/domain.ts`. That is a
 * deliberate duplication, not an oversight: ADR 0003 keeps `apps/web` free of workspace
 * dependencies so a Vercel build can never break because a monorepo package did. The
 * contract between the two is asserted field-by-field by the test named above.
 */

export type Severity = 'ok' | 'watch' | 'drifting'
export type Confidence = 'certified' | 'unbounded'
export type AttributionVerdict = 'primary' | 'contributing' | 'negligible' | 'masking' | 'sole-source'

export interface EnvelopeStep {
  readonly t: number
  readonly observed: number
  readonly bound: number
  readonly exceeded: boolean
}

export interface AttributionEntry {
  readonly sensor: string
  readonly driftWithout: number
  readonly delta: number
  readonly explainedFraction: number
  readonly verdict: AttributionVerdict
}

export interface Verdict {
  readonly severity: Severity
  readonly confidence: Confidence
  readonly boundRatio: number
  readonly firstExceedanceStep: number | null
  readonly dominantSensor: string | null
  readonly withinEnvelope: boolean
  readonly summary: string
}

export interface RunAnalysis {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly sampleCount: number
  readonly durationS: number
  readonly rateHz: number
  readonly pathLength: number
  readonly maxObserved: number
  readonly maxBound: number
  readonly boundRatio: number
  readonly rmsObserved: number
  readonly maxHeadingError: number
  readonly firstExceedance: number | null
  readonly exceeded: boolean
  readonly truncated: boolean
  readonly steps: readonly EnvelopeStep[]
  readonly attribution: readonly AttributionEntry[]
  readonly dominantSensor: string | null
  readonly baselineDrift: number
  readonly fusionInconsistency: number
  readonly notes: readonly string[]
  readonly verdict: Verdict
}

const DATA_DIR = join(process.cwd(), 'data', 'runs')

export interface RunSummary {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly severity: Severity
  readonly confidence: Confidence
  readonly dominantSensor: string | null
  readonly boundRatio: number
  readonly maxObserved: number
  readonly maxBound: number
  readonly sampleCount: number
  readonly durationS: number
  readonly rateHz: number
  readonly pathLength: number
  readonly exceeded: boolean
  readonly firstExceedance: number | null
}

export class RunDataError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message)
    this.name = 'RunDataError'
  }
}

const REQUIRED_FIELDS = ['id', 'name', 'sampleCount', 'maxObserved', 'maxBound', 'verdict'] as const

function assertAnalysis(value: unknown, file: string): RunAnalysis {
  if (typeof value !== 'object' || value === null) {
    throw new RunDataError(`${file} does not contain an analysis object`, file)
  }
  const candidate = value as Record<string, unknown>
  for (const field of REQUIRED_FIELDS) {
    if (candidate[field] === undefined) {
      throw new RunDataError(`${file} is missing the required field "${field}"`, file)
    }
  }
  if (!Array.isArray(candidate.steps)) {
    throw new RunDataError(`${file} is missing the "steps" array`, file)
  }
  return candidate as unknown as RunAnalysis
}

/** Every committed analysis, ordered worst-drift first so the problem is at the top. */
export function listRuns(): readonly RunAnalysis[] {
  let files: string[]
  try {
    files = readdirSync(DATA_DIR).filter((name) => name.endsWith('.analysis.json'))
  } catch {
    // No data directory is a legitimate empty state, not a crash: a fresh clone that has not
    // run the generator yet should still render a page that explains what to do.
    return []
  }

  const analyses = files
    .map((name) => {
      const raw = readFileSync(join(DATA_DIR, name), 'utf8')
      return assertAnalysis(JSON.parse(raw), name)
    })
    .sort((left, right) => right.boundRatio - left.boundRatio)

  return analyses
}

/** One run by id, or undefined so the route can render a real not-found state. */
export function getRun(id: string): RunAnalysis | undefined {
  // Reject anything that could escape the data directory before it reaches the filesystem.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return undefined
  try {
    const raw = readFileSync(join(DATA_DIR, `${id}.analysis.json`), 'utf8')
    return assertAnalysis(JSON.parse(raw), `${id}.analysis.json`)
  } catch (cause) {
    if (cause instanceof RunDataError) throw cause
    return undefined
  }
}

export function toSummary(analysis: RunAnalysis): RunSummary {
  return {
    id: analysis.id,
    name: analysis.name,
    summary: analysis.summary,
    severity: analysis.verdict.severity,
    confidence: analysis.verdict.confidence,
    dominantSensor: analysis.dominantSensor,
    boundRatio: analysis.boundRatio,
    maxObserved: analysis.maxObserved,
    maxBound: analysis.maxBound,
    sampleCount: analysis.sampleCount,
    durationS: analysis.durationS,
    rateHz: analysis.rateHz,
    pathLength: analysis.pathLength,
    exceeded: analysis.exceeded,
    firstExceedance: analysis.firstExceedance,
  }
}

/** How many samples each cell of the strip represents, so the x axis can be labelled. */
export function stripStride(steps: readonly EnvelopeStep[], width: number): number {
  if (steps.length === 0) return 1
  return Math.max(1, Math.ceil(steps.length / width))
}

export function severityTone(severity: Severity): 'ok' | 'warn' | 'danger' {
  if (severity === 'ok') return 'ok'
  if (severity === 'watch') return 'warn'
  return 'danger'
}
