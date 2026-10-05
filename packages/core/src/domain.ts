/**
 * The product's domain vocabulary.
 *
 * A **run** is one recorded drive: a fused pose estimate, the reference track it is judged
 * against, and the per-sensor rate estimates the fusion is built from. Everything the product
 * reports is a statement about a run.
 *
 * Samples are stored **columnar** — parallel arrays rather than one object per sample — so a
 * whole channel can be swept linearly. A 400-sample track is six contiguous buffers instead of
 * 400 objects to allocate, parse, and walk. That choice is the reason the divergence sweep
 * stays cheap at bag-file sizes.
 *
 * This module is types only. It has no runtime behaviour and no dependencies, so both the CLI
 * and the web app can depend on it without pulling anything in.
 */

/** One channel block. Only `t` is mandatory; the engine derives the rest or refuses. */
export interface ChannelSeries {
  readonly t: readonly number[]
  readonly x?: readonly number[]
  readonly y?: readonly number[]
  readonly theta?: readonly number[]
  readonly v?: readonly number[]
  readonly omega?: readonly number[]
}

/** One sensor's rate estimate, plus the weight the fusion gives it. */
export interface SensorEstimate {
  readonly v: readonly number[]
  readonly omega: readonly number[]
  readonly weight?: number
}

/** The stated assumptions the certified envelope is allowed to rely on. */
export interface EnvelopeAssumptions {
  /** Assumed 1-sigma relative uncertainty in the speed channel. */
  readonly rateSigma?: number
  /** Assumed 1-sigma relative uncertainty in the yaw-rate channel. */
  readonly rateSigmaOmega?: number
  /** Treat an escaped bound as an error instead of a reported result. */
  readonly strict?: boolean
  /** Cap on the number of reported steps. */
  readonly maxSteps?: number
}

export interface RunDocument {
  readonly id: string
  readonly name: string
  /** One paragraph: what this run demonstrates. */
  readonly summary: string
  readonly robot?: string
  readonly rateHz: number
  readonly sampleCount?: number
  readonly durationS?: number
  readonly pathLength?: number
  /** How the defect was planted, so a reader can check the finding against the input. */
  readonly notes?: readonly string[]
  readonly params?: EnvelopeAssumptions
  readonly estimate: ChannelSeries
  readonly truth: ChannelSeries
  readonly sensors: Readonly<Record<string, SensorEstimate>>
}

/** One step of the envelope: what was observed, what was allowed, and whether it escaped. */
export interface EnvelopeStep {
  readonly t: number
  readonly observed: number
  readonly bound: number
  readonly exceeded: boolean
}

/** How much drift one sensor accounted for. */
export interface AttributionEntry {
  readonly sensor: string
  readonly driftWithout: number
  readonly delta: number
  readonly explainedFraction: number
  readonly verdict: 'primary' | 'contributing' | 'negligible' | 'masking' | 'sole-source'
}

export interface Severity {
  readonly severity: 'ok' | 'watch' | 'drifting'
  /** `certified` while drift stays inside the envelope; `unbounded` once it escapes. */
  readonly confidence: 'certified' | 'unbounded'
  readonly boundRatio: number
  readonly firstExceedanceStep: number | null
  readonly dominantSensor: string | null
  readonly withinEnvelope: boolean
  readonly summary: string
}

/** Everything the product can say about one run. */
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
  readonly firstExceedance: number | null
  readonly exceeded: boolean
  readonly truncated: boolean
  readonly maxHeadingError: number
  readonly steps: readonly EnvelopeStep[]
  readonly attribution: readonly AttributionEntry[]
  readonly dominantSensor: string | null
  readonly baselineDrift: number
  /**
   * How far the declared fused rate series sits from what the sensors actually imply.
   * A large value means the fusion described in the run document is not the fusion that
   * produced the estimate, which undermines every ablation.
   */
  readonly fusionInconsistency: number
  readonly verdict: Severity
  readonly notes: readonly string[]
}

export function isRunDocument(value: unknown): value is RunDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RunDocument>
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return false
  const estimate = candidate.estimate as ChannelSeries | undefined
  const truth = candidate.truth as ChannelSeries | undefined
  if (!estimate || !Array.isArray(estimate.t)) return false
  if (!truth || !Array.isArray(truth.t)) return false
  return typeof candidate.sensors === 'object' && candidate.sensors !== null
}
