import { describe, expect, it } from 'vitest'
import { ValidationError } from '@odometryscope/core'
import type { RunDocument, Severity } from '@odometryscope/core'
import { Store } from './store.js'
import { LATEST_VERSION, pendingMigrations } from './migrations.js'
import { ESTIMATE_CHANNEL, RunStore, TRUTH_CHANNEL, sensorChannel } from './runs.js'

/**
 * Values chosen to break any lossy encoding: irrational, subnormal, extreme, and -0.
 * The derived series divide rather than multiply so no sample can overflow to Infinity —
 * a non-finite value must arrive deliberately, as the validation tests inject one.
 */
const TRICKY = [
  0,
  -0,
  0.1,
  1 / 3,
  Math.PI,
  Math.E,
  -Math.PI * 1e-9,
  5e-324,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  1.7976931348623157e308,
  -1.2345678901234567e-17,
]

function series(
  length: number,
  offset = 0,
): {
  t: number[]
  x: number[]
  y: number[]
  theta: number[]
  v: number[]
  omega: number[]
} {
  const pick = (i: number): number => TRICKY[(i + offset) % TRICKY.length] as number
  return {
    t: Array.from({ length }, (_, i) => pick(i)),
    x: Array.from({ length }, (_, i) => pick(i + 1) / 3),
    y: Array.from({ length }, (_, i) => pick(i + 2) / 7),
    theta: Array.from({ length }, (_, i) => pick(i + 3) / 11),
    v: Array.from({ length }, (_, i) => pick(i + 4)),
    omega: Array.from({ length }, (_, i) => pick(i + 5) / 13),
  }
}

function document(overrides: Partial<RunDocument> = {}): RunDocument {
  const estimate = series(TRICKY.length)
  const truth = series(TRICKY.length, 3)
  return {
    id: 'run-1',
    name: 'Warehouse loop',
    summary: 'Yaw drifts after the third turn.',
    rateHz: 50,
    durationS: 12.5,
    pathLength: 84.25,
    estimate,
    truth,
    sensors: {
      wheel: { v: estimate.v, omega: estimate.omega },
      imu: { v: truth.v, omega: truth.omega, weight: 0.4 },
    },
    ...overrides,
  }
}

function verdict(overrides: Partial<Severity> = {}): Severity {
  return {
    severity: 'drifting',
    confidence: 'unbounded',
    boundRatio: 1.42,
    firstExceedanceStep: 7,
    dominantSensor: 'imu',
    withinEnvelope: false,
    summary: 'Escaped at step 7.',
    ...overrides,
  }
}

function withRunStore(): { store: Store; runs: RunStore } {
  const store = new Store()
  return { store, runs: new RunStore(store) }
}

describe('RunStore migrations', () => {
  it('applies the run migrations and reports no pending work', () => {
    const { store } = withRunStore()
    expect(store.version).toBe(LATEST_VERSION)
    expect(store.isPending).toBe(false)
    expect(store.hasTable('runs')).toBe(true)
    expect(store.hasTable('pose_columns')).toBe(true)
    expect(store.hasTable('run_verdicts')).toBe(true)
    store.close()
  })

  it('is idempotent — migrating twice changes nothing and keeps user_version at the latest', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document(), verdict(), 1_000)
    expect(store.migrate()).toBe(LATEST_VERSION)
    expect(store.migrate()).toBe(LATEST_VERSION)
    expect(store.version).toBe(LATEST_VERSION)
    expect(pendingMigrations(LATEST_VERSION)).toHaveLength(0)
    // Re-running must not duplicate rows.
    expect(runs.countColumns('run-1')).toBe(4)
    store.close()
  })

  it('reports the schema for doctor without disturbing version or pending state', () => {
    const { store } = withRunStore()
    const status = store.status()
    expect(status.version).toBe(LATEST_VERSION)
    expect(status.latest).toBe(LATEST_VERSION)
    expect(status.isPending).toBe(false)
    expect(status.pending).toHaveLength(0)
    expect(status.applied.at(-1)?.name).toBe('columnar_runs')
    expect(status.tables).toContain('pose_columns')
    expect(status.tables).toContain('run_verdicts')
    store.close()
  })
})

describe('RunStore round trip', () => {
  it('reads every float64 sample back exactly, on every channel', () => {
    const { store, runs } = withRunStore()
    const run = document()
    runs.putRun(run, verdict(), 1_000)

    const estimate = runs.columns('run-1', ESTIMATE_CHANNEL)
    expect(estimate).toBeDefined()
    const truth = runs.columns('run-1', TRUTH_CHANNEL)
    expect(truth).toBeDefined()
    expect(runs.columns('run-1', sensorChannel('wheel'))).toBeDefined()
    expect(runs.columns('run-1', sensorChannel('imu'))).toBeDefined()

    const keys = ['t', 'x', 'y', 'theta', 'v', 'omega'] as const
    for (const key of keys) {
      expect(Array.from(estimate?.[key] as Float64Array)).toStrictEqual(run.estimate[key])
      expect(Array.from(truth?.[key] as Float64Array)).toStrictEqual(run.truth[key])
    }

    // A sensor owns only its rates; its timeline is the estimate's sample grid, and the
    // series it never stated come back absent rather than zero-filled.
    for (const [name, rates] of Object.entries(run.sensors)) {
      const read = runs.columns('run-1', sensorChannel(name))
      expect(Array.from(read?.t as Float64Array)).toStrictEqual(run.estimate.t)
      expect(Array.from(read?.v as Float64Array)).toStrictEqual(rates.v)
      expect(Array.from(read?.omega as Float64Array)).toStrictEqual(rates.omega)
      expect(read?.x).toBeUndefined()
      expect(read?.y).toBeUndefined()
      expect(read?.theta).toBeUndefined()
    }

    // -0 must survive as -0, not flatten to 0.
    expect(Object.is(estimate?.t[0], 0)).toBe(true)
    expect(Object.is(estimate?.x[0], -0)).toBe(true)
    expect(store.version).toBe(LATEST_VERSION)
    store.close()
  })

  it('stores each channel as one row and preserves absent series as absent', () => {
    const { store, runs } = withRunStore()
    runs.putRun(
      document({
        truth: { t: series(TRICKY.length, 3).t, x: series(TRICKY.length, 3).x },
      }),
      verdict(),
      1_000,
    )
    expect(runs.listChannels('run-1')).toEqual([
      ESTIMATE_CHANNEL,
      TRUTH_CHANNEL,
      sensorChannel('wheel'),
      sensorChannel('imu'),
    ])
    const truth = runs.columns('run-1', TRUTH_CHANNEL)
    expect(truth?.t).toHaveLength(TRICKY.length)
    expect(truth?.x).toHaveLength(TRICKY.length)
    expect(truth?.y).toBeUndefined()
    expect(truth?.omega).toBeUndefined()
    store.close()
  })

  it('reads every channel of a run in one sweep', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document(), verdict(), 1_000)
    const all = runs.readColumns('run-1')
    expect(Object.keys(all)).toHaveLength(4)
    expect(Array.from(all[ESTIMATE_CHANNEL]?.t as Float64Array)).toStrictEqual(document().estimate.t)
    store.close()
  })
})

describe('RunStore CRUD', () => {
  it('puts a run with its verdict and reads it back', () => {
    const { store, runs } = withRunStore()
    const run = document()
    runs.putRun(run, verdict(), 1_000)
    const stored = runs.getRun('run-1')
    expect(stored).toBeDefined()
    expect(stored?.id).toBe('run-1')
    expect(stored?.name).toBe('Warehouse loop')
    expect(stored?.summary).toBe('Yaw drifts after the third turn.')
    expect(stored?.rateHz).toBe(50)
    expect(stored?.sampleCount).toBe(TRICKY.length)
    expect(stored?.durationS).toBe(12.5)
    expect(stored?.pathLength).toBe(84.25)
    expect(stored?.source).toBe('odoscope')
    expect(stored?.createdAt).toBe(1_000)
    expect(stored?.updatedAt).toBe(1_000)

    const widest = Math.max(
      ...run.estimate.theta.map((value, i) => Math.abs((value as number) - (run.truth.theta[i] as number))),
    )
    expect(stored?.verdict).toEqual({
      severity: 'drifting',
      confidence: 'unbounded',
      boundRatio: 1.42,
      // The two extremes are derived from the run: the widest gap between the estimate and
      // the reference, and the largest reference magnitude that gap was measured against.
      maxObserved: widest,
      maxBound: Math.max(...run.truth.theta.map((value) => Math.abs(value as number))),
      dominantSensor: 'imu',
      firstExceedanceStep: 7,
      recordedAt: 1_000,
    })
    store.close()
  })

  it('keeps a null first exceedance distinct from step zero', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document({ id: 'certified' }), verdict({ firstExceedanceStep: null }), 1)
    runs.putRun(document({ id: 'zero' }), verdict({ firstExceedanceStep: 0 }), 1)
    expect(runs.getRun('certified')?.verdict?.firstExceedanceStep).toBeNull()
    expect(runs.getRun('zero')?.verdict?.firstExceedanceStep).toBe(0)
    store.close()
  })

  it('lists runs newest first', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document({ id: 'a' }), verdict(), 300)
    runs.putRun(document({ id: 'b' }), verdict(), 100)
    runs.putRun(document({ id: 'c' }), verdict(), 200)
    expect(runs.listRuns().map((r) => r.id)).toEqual(['a', 'c', 'b'])
    expect(runs.listRuns(2).map((r) => r.id)).toEqual(['a', 'c'])
    store.close()
  })

  it('updates a run in place rather than duplicating its channels', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document(), verdict(), 1_000)
    runs.putRun(document({ name: 'Renamed' }), verdict({ severity: 'watch' }), 2_000)
    expect(runs.listRuns()).toHaveLength(1)
    expect(runs.countColumns('run-1')).toBe(4)
    const stored = runs.getRun('run-1')
    expect(stored?.name).toBe('Renamed')
    expect(stored?.verdict?.severity).toBe('watch')
    expect(stored?.createdAt).toBe(1_000)
    expect(stored?.updatedAt).toBe(2_000)
    store.close()
  })

  it('drops the columns of a sensor that left the document', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document(), verdict(), 1_000)
    const estimate = series(TRICKY.length)
    runs.putRun(
      document({
        estimate,
        truth: series(TRICKY.length, 3),
        sensors: { wheel: { v: estimate.v, omega: estimate.omega } },
      }),
      verdict(),
      2_000,
    )
    expect(runs.listChannels('run-1')).toEqual([ESTIMATE_CHANNEL, TRUTH_CHANNEL, sensorChannel('wheel')])
    expect(runs.columns('run-1', sensorChannel('imu'))).toBeUndefined()
    store.close()
  })

  it('deletes a run with its columns and verdict', () => {
    const { store, runs } = withRunStore()
    runs.putRun(document(), verdict(), 1_000)
    expect(runs.deleteRun('run-1')).toBe(true)
    expect(runs.getRun('run-1')).toBeUndefined()
    expect(runs.countColumns('run-1')).toBe(0)
    expect(runs.columns('run-1', ESTIMATE_CHANNEL)).toBeUndefined()
    expect(runs.deleteRun('run-1')).toBe(false)
    store.close()
  })

  it('returns undefined for an unknown run or channel', () => {
    const { store, runs } = withRunStore()
    expect(runs.getRun('missing')).toBeUndefined()
    expect(runs.columns('missing', ESTIMATE_CHANNEL)).toBeUndefined()
    expect(runs.listRuns()).toEqual([])
    store.close()
  })
})

describe('RunStore validation', () => {
  it('rejects a channel whose series disagree in length', () => {
    const { store, runs } = withRunStore()
    const estimate = series(TRICKY.length)
    expect(() =>
      runs.putRun(document({ estimate: { ...estimate, x: [...estimate.x, 1] } }), verdict(), 1_000),
    ).toThrow(ValidationError)
    expect(() =>
      runs.putRun(document({ estimate: { ...estimate, x: [...estimate.x, 1] } }), verdict(), 1_000),
    ).toThrow(/series "x" has 13 samples but its timeline has 12/)
    expect(runs.getRun('run-1')).toBeUndefined()
    expect(runs.countColumns('run-1')).toBe(0)
    store.close()
  })

  it('rejects a sensor whose rate estimate does not fit the timeline', () => {
    const { store, runs } = withRunStore()
    const estimate = series(TRICKY.length)
    expect(() =>
      runs.putRun(document({ sensors: { wheel: { v: estimate.v, omega: [1, 2] } } }), verdict(), 1_000),
    ).toThrow(/channel "sensor:wheel" series "omega" has 2 samples but its timeline has 12/)
    expect(runs.countColumns('run-1')).toBe(0)
    store.close()
  })

  it('rejects a non-finite sample', () => {
    const { store, runs } = withRunStore()
    const estimate = series(TRICKY.length)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const tainted = { ...estimate, y: [...estimate.y] }
      tainted.y[4] = bad
      expect(() => runs.putRun(document({ estimate: tainted }), verdict(), 1_000)).toThrow(ValidationError)
      expect(() => runs.putRun(document({ estimate: tainted }), verdict(), 1_000)).toThrow(
        /series "y" has a non-finite sample at index 4/,
      )
    }
    expect(runs.countColumns('run-1')).toBe(0)
    store.close()
  })

  it('rejects a non-finite verdict figure', () => {
    const { store, runs } = withRunStore()
    expect(() => runs.putRun(document(), verdict({ boundRatio: Number.NaN }), 1_000)).toThrow(
      /verdict boundRatio must be a finite number/,
    )
    store.close()
  })

  it('rejects a declared sample count that disagrees with the timeline', () => {
    const { store, runs } = withRunStore()
    expect(() => runs.putRun(document({ sampleCount: 999 }), verdict(), 1_000)).toThrow(
      /declares sampleCount 999 but its timeline has 12/,
    )
    store.close()
  })

  it('rejects an empty timeline', () => {
    const { store, runs } = withRunStore()
    expect(() =>
      runs.putRun(document({ estimate: { t: [] }, truth: { t: [] }, sensors: {} }), verdict(), 1_000),
    ).toThrow(/empty estimate timeline/)
    store.close()
  })

  it('leaves no partial run behind when the write rolls back', () => {
    const { store, runs } = withRunStore()
    expect(() =>
      store.transaction(() => {
        runs.putRun(document(), verdict(), 1_000)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(runs.getRun('run-1')).toBeUndefined()
    expect(runs.countColumns('run-1')).toBe(0)
    expect(store.version).toBe(LATEST_VERSION)
    store.close()
  })
})
