/**
 * The columnar run store.
 *
 * A run's samples are parallel arrays, so they are persisted as parallel arrays: one
 * `pose_columns` row per (run, channel) whose six sample buffers are packed little-endian
 * Float64Array blobs. Reading a channel back is one row and one linear sweep, not a parse of
 * `n` objects. The bytes are written through `DataView` with an explicit little-endian flag,
 * so the round trip is exact on any host endianness rather than exact by accident.
 *
 * Every write goes through `store.transaction(...)`. Every value is validated on the way in —
 * a store that accepted a ragged or non-finite column would hand back a sweep that silently
 * reads past the end of a buffer.
 */
import type Database from 'better-sqlite3'
import { ValidationError } from '@odometryscope/core'
import type { ChannelSeries, RunDocument, Severity } from '@odometryscope/core'
import type { Store } from './store.js'

/** The sample buffers a row carries, in the order the schema declares them. */
export const COLUMN_NAMES = ['t', 'x', 'y', 'theta', 'v', 'omega'] as const
export type ColumnName = (typeof COLUMN_NAMES)[number]

/** The two channels a `RunDocument` states outright. */
export const ESTIMATE_CHANNEL = 'estimate'
export const TRUTH_CHANNEL = 'truth'

/** Per-sensor rate estimates are namespaced so they cannot collide with a channel. */
export const SENSOR_CHANNEL_PREFIX = 'sensor:'

export function sensorChannel(sensor: string): string {
  return `${SENSOR_CHANNEL_PREFIX}${sensor}`
}

/** The sensor a channel names, or `null` when the channel is not a sensor. */
export function sensorOfChannel(channel: string): string | null {
  return channel.startsWith(SENSOR_CHANNEL_PREFIX) ? channel.slice(SENSOR_CHANNEL_PREFIX.length) : null
}

/** The verdict as persisted. `withinEnvelope` and `summary` are derived, not stored. */
export interface StoredVerdict {
  readonly severity: Severity['severity']
  readonly confidence: Severity['confidence']
  readonly boundRatio: number
  readonly maxObserved: number
  readonly maxBound: number
  readonly dominantSensor: string | null
  readonly firstExceedanceStep: number | null
  readonly recordedAt: number
}

export interface StoredRun {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly rateHz: number
  readonly sampleCount: number
  readonly durationS: number | null
  readonly pathLength: number | null
  readonly source: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly verdict: StoredVerdict | null
}

export interface RunColumns {
  readonly t: Float64Array
  readonly x?: Float64Array
  readonly y?: Float64Array
  readonly theta?: Float64Array
  readonly v?: Float64Array
  readonly omega?: Float64Array
}

interface RunRow {
  id: string
  name: string
  summary: string
  rate_hz: number
  sample_count: number
  duration_s: number | null
  path_length: number | null
  source: string
  created_at: number
  updated_at: number
}

interface ColumnRow {
  run_id: string
  channel: string
  n: number
  t: Buffer | null
  x: Buffer | null
  y: Buffer | null
  theta: Buffer | null
  v: Buffer | null
  omega: Buffer | null
}

interface VerdictRow {
  run_id: string
  severity: string
  confidence: string
  bound_ratio: number
  max_observed: number
  max_bound: number
  dominant_sensor: string | null
  first_exceedance: number | null
  recorded_at: number
}

/** `listRuns` joins the verdict in so a listing costs one query, not one per row. */
interface ListedRunRow extends RunRow {
  v_severity: string | null
  v_confidence: string | null
  v_bound_ratio: number | null
  v_max_observed: number | null
  v_max_bound: number | null
  v_dominant_sensor: string | null
  v_first_exceedance: number | null
  v_recorded_at: number | null
}

interface PlannedColumn {
  readonly channel: string
  readonly n: number
  readonly t: Buffer
  readonly x: Buffer | null
  readonly y: Buffer | null
  readonly theta: Buffer | null
  readonly v: Buffer | null
  readonly omega: Buffer | null
}

const BYTES_PER_SAMPLE = 8
const LITTLE_ENDIAN = true

/** Pack samples into a little-endian float64 blob. Exact for every finite value. */
export function packSamples(values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * BYTES_PER_SAMPLE)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let offset = 0
  for (const value of values) {
    view.setFloat64(offset, value, LITTLE_ENDIAN)
    offset += BYTES_PER_SAMPLE
  }
  return buffer
}

/** Unpack a little-endian float64 blob back into `n` samples. */
export function unpackSamples(blob: Uint8Array, n: number): Float64Array {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) out[i] = view.getFloat64(i * BYTES_PER_SAMPLE, LITTLE_ENDIAN)
  return out
}

function optionalSamples(blob: Buffer | null, n: number): Float64Array | undefined {
  return blob === null ? undefined : unpackSamples(blob, n)
}

function assertFinite(column: string, series: string, values: readonly number[]): void {
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError(
        `run column "${column}" series "${series}" has a non-finite sample at index ${i}: ${String(value)}`,
        { channel: column, series, index: i, value: String(value) },
      )
    }
  }
}

/** Check a channel: every present series must be as long as the channel's timeline. */
function planChannel(channel: string, series: ChannelSeries): PlannedColumn {
  const timeline = series.t
  for (const key of COLUMN_NAMES) {
    const values = key === 't' ? timeline : series[key]
    if (values === undefined) continue
    if (values.length !== timeline.length) {
      throw new ValidationError(
        `run channel "${channel}" series "${key}" has ${values.length} samples but its timeline has ${timeline.length}; every series of a channel must be the same length`,
        {
          channel,
          series: key,
          actual: values.length,
          expected: timeline.length,
        },
      )
    }
    assertFinite(channel, key, values)
  }

  const pack = (key: ColumnName): Buffer | null => {
    const values = key === 't' ? timeline : series[key]
    return values === undefined ? null : packSamples(values)
  }
  // `t` is mandatory on a channel, so it always packs; only the optional series can be absent.
  const packedTimeline = packSamples(timeline)

  return {
    channel,
    n: timeline.length,
    t: packedTimeline,
    x: pack('x'),
    y: pack('y'),
    theta: pack('theta'),
    v: pack('v'),
    omega: pack('omega'),
  }
}

function planColumns(run: RunDocument): PlannedColumn[] {
  if (run.estimate.t.length === 0) {
    throw new ValidationError(`run "${run.id}" has an empty estimate timeline; nothing to store`, {
      runId: run.id,
    })
  }
  const timeline = run.estimate.t

  const planned: PlannedColumn[] = [
    planChannel(ESTIMATE_CHANNEL, run.estimate),
    planChannel(TRUTH_CHANNEL, run.truth),
  ]

  // A sensor contributes rates, not a timeline: its row rides the estimate's sample grid.
  for (const [name, estimate] of Object.entries(run.sensors)) {
    planned.push(planChannel(sensorChannel(name), { t: timeline, v: estimate.v, omega: estimate.omega }))
  }
  return planned
}

/**
 * The envelope extremes, derived from the run itself: `Severity` states the ratio but not
 * the two figures behind it, and `run_verdicts` stores all three. The observed figure is the
 * largest gap between the estimate and the reference; the bound is the largest reference
 * magnitude the gap is measured against. Heading is preferred, then position.
 */
function deriveEnvelope(run: RunDocument): { maxObserved: number; maxBound: number } {
  const { estimate, truth } = run
  if (estimate.theta !== undefined && truth.theta !== undefined) {
    let maxObserved = 0
    let maxBound = 0
    for (const [i, truthTheta] of truth.theta.entries()) {
      const estimateTheta = estimate.theta[i]
      if (estimateTheta === undefined) break
      maxObserved = Math.max(maxObserved, Math.abs(estimateTheta - truthTheta))
      maxBound = Math.max(maxBound, Math.abs(truthTheta))
    }
    return { maxObserved, maxBound }
  }
  if (estimate.x !== undefined && truth.x !== undefined) {
    let maxObserved = 0
    let maxBound = 0
    for (const [i, truthX] of truth.x.entries()) {
      const estimateX = estimate.x[i]
      if (estimateX === undefined) break
      const estimateY = estimate.y?.[i] ?? 0
      const truthY = truth.y?.[i] ?? 0
      maxObserved = Math.max(
        maxObserved,
        Math.hypot(estimateX - truthX, (estimate.y === undefined ? 0 : estimateY) - truthY),
      )
      maxBound = Math.max(maxBound, Math.hypot(truthX, truthY))
    }
    return { maxObserved, maxBound }
  }
  return { maxObserved: 0, maxBound: 0 }
}

function planVerdict(run: RunDocument, verdict: Severity, now: number): VerdictRow {
  const envelope = deriveEnvelope(run)
  const numbers: Record<string, number> = {
    boundRatio: verdict.boundRatio,
    maxObserved: envelope.maxObserved,
    maxBound: envelope.maxBound,
  }
  for (const [field, value] of Object.entries(numbers)) {
    if (!Number.isFinite(value)) {
      throw new ValidationError(
        `run "${run.id}" verdict ${field} must be a finite number, got ${String(value)}`,
        { runId: run.id, field, value: String(value) },
      )
    }
  }
  return {
    run_id: run.id,
    severity: verdict.severity,
    confidence: verdict.confidence,
    bound_ratio: verdict.boundRatio,
    max_observed: envelope.maxObserved,
    max_bound: envelope.maxBound,
    dominant_sensor: verdict.dominantSensor,
    first_exceedance: verdict.firstExceedanceStep,
    recorded_at: now,
  }
}

function toStoredVerdict(row: VerdictRow): StoredVerdict {
  return {
    severity: row.severity as Severity['severity'],
    confidence: row.confidence as Severity['confidence'],
    boundRatio: row.bound_ratio,
    maxObserved: row.max_observed,
    maxBound: row.max_bound,
    dominantSensor: row.dominant_sensor,
    firstExceedanceStep: row.first_exceedance,
    recordedAt: row.recorded_at,
  }
}

function toStoredRun(row: RunRow, verdict: VerdictRow | undefined): StoredRun {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    rateHz: row.rate_hz,
    sampleCount: row.sample_count,
    durationS: row.duration_s,
    pathLength: row.path_length,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verdict: verdict === undefined ? null : toStoredVerdict(verdict),
  }
}

export interface RunStoreOptions {
  /** Recorded on every row so a reader can tell where the run came from. */
  readonly source?: string
}

const DEFAULT_SOURCE = 'odoscope'

export class RunStore {
  readonly #store: Store
  readonly #source: string

  constructor(store: Store, options: RunStoreOptions = {}) {
    this.#store = store
    this.#source = options.source ?? DEFAULT_SOURCE
  }

  get source(): string {
    return this.#source
  }

  /**
   * Write the run, every one of its channels, and its verdict in a single transaction.
   * Rejects a ragged channel, a non-finite sample, or a declared sample count that
   * disagrees with the timeline — before anything is written.
   */
  putRun(run: RunDocument, verdict: Severity, now: number): void {
    if (typeof run.id !== 'string' || run.id.length === 0) {
      throw new ValidationError('run.id must be a non-empty string', { runId: String(run.id) })
    }
    if (!Number.isFinite(run.rateHz)) {
      throw new ValidationError(`run "${run.id}" rateHz must be a finite number`, {
        runId: run.id,
        rateHz: String(run.rateHz),
      })
    }
    const timeline = run.estimate.t
    if (run.sampleCount !== undefined && run.sampleCount !== timeline.length) {
      throw new ValidationError(
        `run "${run.id}" declares sampleCount ${run.sampleCount} but its timeline has ${timeline.length}`,
        { runId: run.id, sampleCount: run.sampleCount, timeline: timeline.length },
      )
    }

    const columns = planColumns(run)
    const verdictRow = planVerdict(run, verdict, now)
    const db = this.#store.db

    this.#store.transaction(() => {
      db.prepare(
        `INSERT INTO runs (
           id, name, summary, rate_hz, sample_count, duration_s, path_length,
           source, created_at, updated_at
         ) VALUES (
           @id, @name, @summary, @rate_hz, @sample_count, @duration_s, @path_length,
           @source, @now, @now
         )
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           summary = excluded.summary,
           rate_hz = excluded.rate_hz,
           sample_count = excluded.sample_count,
           duration_s = excluded.duration_s,
           path_length = excluded.path_length,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      ).run({
        id: run.id,
        name: run.name,
        summary: run.summary,
        rate_hz: run.rateHz,
        sample_count: run.sampleCount ?? timeline.length,
        duration_s: run.durationS ?? null,
        path_length: run.pathLength ?? null,
        source: this.#source,
        now,
      })

      // Replace rather than merge: a channel that dropped out of the document must not
      // survive as a stale row that still claims to belong to this run.
      db.prepare('DELETE FROM pose_columns WHERE run_id = ?').run(run.id)
      const insertColumn = db.prepare(
        `INSERT INTO pose_columns (run_id, channel, n, t, x, y, theta, v, omega)
         VALUES (@run_id, @channel, @n, @t, @x, @y, @theta, @v, @omega)`,
      )
      for (const column of columns) insertColumn.run({ run_id: run.id, ...column })

      db.prepare(
        `INSERT INTO run_verdicts (
           run_id, severity, confidence, bound_ratio, max_observed, max_bound,
           dominant_sensor, first_exceedance, recorded_at
         ) VALUES (
           @run_id, @severity, @confidence, @bound_ratio, @max_observed, @max_bound,
           @dominant_sensor, @first_exceedance, @recorded_at
         )
         ON CONFLICT(run_id) DO UPDATE SET
           severity = excluded.severity,
           confidence = excluded.confidence,
           bound_ratio = excluded.bound_ratio,
           max_observed = excluded.max_observed,
           max_bound = excluded.max_bound,
           dominant_sensor = excluded.dominant_sensor,
           first_exceedance = excluded.first_exceedance,
           recorded_at = excluded.recorded_at`,
      ).run(verdictRow)
    })
  }

  getRun(id: string): StoredRun | undefined {
    const db = this.#store.db
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    if (row === undefined) return undefined
    const verdict = db.prepare('SELECT * FROM run_verdicts WHERE run_id = ?').get(id) as
      VerdictRow | undefined
    return toStoredRun(row, verdict)
  }

  /** Newest first. `created_at` ties break on id so the order is stable, not arbitrary. */
  listRuns(limit = 50): readonly StoredRun[] {
    const db = this.#store.db
    const rows = db
      .prepare(
        `SELECT r.*, v.severity AS v_severity, v.confidence AS v_confidence,
                v.bound_ratio AS v_bound_ratio, v.max_observed AS v_max_observed,
                v.max_bound AS v_max_bound, v.dominant_sensor AS v_dominant_sensor,
                v.first_exceedance AS v_first_exceedance, v.recorded_at AS v_recorded_at
           FROM runs r
           LEFT JOIN run_verdicts v ON v.run_id = r.id
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ?`,
      )
      .all(limit) as ListedRunRow[]

    return rows.map((row) =>
      toStoredRun(
        row,
        row.v_severity === null
          ? undefined
          : {
              run_id: row.id,
              severity: row.v_severity,
              confidence: row.v_confidence as string,
              bound_ratio: row.v_bound_ratio as number,
              max_observed: row.v_max_observed as number,
              max_bound: row.v_max_bound as number,
              dominant_sensor: row.v_dominant_sensor,
              first_exceedance: row.v_first_exceedance,
              recorded_at: row.v_recorded_at as number,
            },
      ),
    )
  }

  deleteRun(id: string): boolean {
    const db = this.#store.db
    return this.#store.transaction(() => {
      db.prepare('DELETE FROM pose_columns WHERE run_id = ?').run(id)
      db.prepare('DELETE FROM run_verdicts WHERE run_id = ?').run(id)
      return db.prepare('DELETE FROM runs WHERE id = ?').run(id).changes > 0
    })
  }

  /** One channel's buffers, unpacked. Absent series come back absent rather than zeroed. */
  columns(id: string, channel: string): RunColumns | undefined {
    const row = this.#store.db
      .prepare('SELECT * FROM pose_columns WHERE run_id = ? AND channel = ?')
      .get(id, channel) as ColumnRow | undefined
    return row === undefined ? undefined : unpackRow(row)
  }

  /** The channel names stored for a run, in write order. */
  listChannels(id: string): readonly string[] {
    const rows = this.#store.db
      .prepare('SELECT channel FROM pose_columns WHERE run_id = ? ORDER BY rowid')
      .all(id) as { channel: string }[]
    return rows.map((row) => row.channel)
  }

  /** Every channel of a run at once — the whole sample set as parallel arrays. */
  readColumns(id: string): Readonly<Record<string, RunColumns>> {
    const rows = this.#store.db
      .prepare('SELECT * FROM pose_columns WHERE run_id = ? ORDER BY rowid')
      .all(id) as ColumnRow[]
    const out: Record<string, RunColumns> = {}
    for (const row of rows) out[row.channel] = unpackRow(row)
    return out
  }

  /** The row count for a run, so a caller can assert a delete actually removed the samples. */
  countColumns(id: string): number {
    const row = this.#store.db.prepare('SELECT COUNT(*) AS n FROM pose_columns WHERE run_id = ?').get(id) as
      { n: number } | undefined
    return row?.n ?? 0
  }

  /** Escape hatch for a bulk read that must not build an intermediate object graph. */
  transaction<T>(fn: (db: Database.Database) => T): T {
    return this.#store.transaction(() => fn(this.#store.db))
  }
}

function unpackRow(row: ColumnRow): RunColumns {
  if (row.t === null) {
    throw new ValidationError(`run "${row.run_id}" channel "${row.channel}" has no timeline buffer`, {
      runId: row.run_id,
      channel: row.channel,
    })
  }
  const t = unpackSamples(row.t, row.n)
  const x = optionalSamples(row.x, row.n)
  const y = optionalSamples(row.y, row.n)
  const theta = optionalSamples(row.theta, row.n)
  const v = optionalSamples(row.v, row.n)
  const omega = optionalSamples(row.omega, row.n)
  return {
    t,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(theta !== undefined ? { theta } : {}),
    ...(v !== undefined ? { v } : {}),
    ...(omega !== undefined ? { omega } : {}),
  }
}
