import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildToolRegistry, createContext } from './bootstrap.js'
import { renderRun } from './program.js'

// `src/` -> `packages/cli` -> `packages` -> the repository root. Two hops up from `src`
// reaches `packages`, so the third is required.
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const RUNS_DIR = join(REPO_ROOT, 'apps', 'web', 'data', 'runs')

function runIds(): string[] {
  if (!existsSync(RUNS_DIR)) return []
  return readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.analysis.json'))
    .map((name) => name.replace('.analysis.json', ''))
    .sort()
}

function readRun(id: string): unknown {
  return JSON.parse(readFileSync(join(RUNS_DIR, `${id}.json`), 'utf8'))
}

async function analyze(id: string): Promise<Record<string, unknown>> {
  const registry = buildToolRegistry(REPO_ROOT)
  return (await registry.invoke('analyze_run', { run: readRun(id) }, createContext('test'), [
    'proc:spawn',
  ])) as Record<string, unknown>
}

describe('committed sample runs', () => {
  const ids = runIds()

  it('has at least one committed run', () => {
    expect(ids.length).toBeGreaterThan(0)
  })

  /**
   * The anti-rot test for the web tier.
   *
   * `apps/web` renders committed analysis files rather than calling the engine at request
   * time (ADR 0003). That makes the website's honesty depend on those files matching what the
   * engine currently computes — so this test recomputes every run through a live engine call
   * and fails on any drift. Without it, a change to the integrator would silently leave the
   * deployed site quoting stale numbers.
   */
  it.each(ids)('%s: committed analysis matches a live engine run', async (id) => {
    const committed = JSON.parse(readFileSync(join(RUNS_DIR, `${id}.analysis.json`), 'utf8')) as Record<
      string,
      unknown
    >
    const live = await analyze(id)

    expect(live.sampleCount).toBe(committed.sampleCount)
    expect(live.maxObserved).toBeCloseTo(committed.maxObserved as number, 9)
    expect(live.maxBound).toBeCloseTo(committed.maxBound as number, 9)
    expect(live.boundRatio).toBeCloseTo(committed.boundRatio as number, 6)
    expect(live.rmsObserved).toBeCloseTo(committed.rmsObserved as number, 9)
    // Discrete, so compared exactly: a different first-exceedance index means the envelope
    // genuinely changed, which is exactly the drift this test exists to catch.
    expect(live.firstExceedance).toBe(committed.firstExceedance)
    expect(live.exceeded).toBe(committed.exceeded)
    expect(live.dominantSensor).toBe(committed.dominantSensor)
    expect(live.verdict).toEqual(committed.verdict)

    // Compared field by field with a tolerance rather than with toEqual on the whole array,
    // and the reason is platform, not convenience.
    //
    // The committed files were generated on one platform's libm. `math.cos`, `math.sin` and
    // `math.hypot` are not specified to be bit-identical across implementations, so the same
    // engine run on Linux (CI) and Windows (the generating machine) differs in roughly the
    // last one or two bits. A whole-object equality check therefore fails on CI while passing
    // locally on the machine that produced the fixture — the worst possible failure mode for a
    // test whose job is to catch real drift.
    //
    // The tolerances below are ~1e-12 relative on values of order 1e-3, which is far tighter
    // than any drift a changed integrator or envelope could produce while comfortably
    // swallowing cross-platform libm noise. A real regression moves these by whole orders of
    // magnitude and still fails.
    const committedSensors = (committed.attribution as { sensor: string }[]).map((entry) => entry.sensor)
    const liveSensors = (live.attribution as { sensor: string }[]).map((entry) => entry.sensor)
    expect(liveSensors).toEqual(committedSensors)

    for (const [index, expected] of (committed.attribution as Record<string, unknown>[]).entries()) {
      const actual = (live.attribution as Record<string, unknown>[])[index] as Record<string, unknown>
      expect(actual.sensor).toBe(expected.sensor)
      expect(actual.verdict).toBe(expected.verdict)
      expect(actual.driftWithout).toBeCloseTo(expected.driftWithout as number, 12)
      expect(actual.delta).toBeCloseTo(expected.delta as number, 12)
      expect(actual.explainedFraction).toBeCloseTo(expected.explainedFraction as number, 9)
    }
  })
})

describe('analyze_run verdicts', () => {
  it('names the wheel for a run whose encoders over-report', async () => {
    const analysis = (await analyze('wheel-scale-drift')) as {
      verdict: { severity: string; confidence: string; dominantSensor: string | null }
      attribution: { sensor: string; verdict: string; explainedFraction: number }[]
      exceeded: boolean
    }
    expect(analysis.verdict.severity).toBe('drifting')
    expect(analysis.verdict.confidence).toBe('unbounded')
    expect(analysis.verdict.dominantSensor).toBe('wheel')
    expect(analysis.exceeded).toBe(true)

    const wheel = analysis.attribution.find((entry) => entry.sensor === 'wheel')
    expect(wheel?.verdict).toBe('primary')
    expect(wheel?.explainedFraction).toBeGreaterThan(0.9)
  })

  it('names the imu when only the imu is wrong', async () => {
    const analysis = (await analyze('imu-yaw-bias')) as {
      verdict: { dominantSensor: string | null }
    }
    expect(analysis.verdict.dominantSensor).toBe('imu')
  })

  /**
   * The most important negative test in the suite. A tool that reports drift on a healthy run
   * is worse than no tool, because it sends people chasing healthy hardware.
   */
  it('stays certified and inside the envelope on a clean run', async () => {
    const analysis = (await analyze('clean-run')) as {
      verdict: { severity: string; confidence: string; withinEnvelope: boolean }
      exceeded: boolean
      boundRatio: number
    }
    expect(analysis.verdict.severity).toBe('ok')
    expect(analysis.verdict.confidence).toBe('certified')
    expect(analysis.verdict.withinEnvelope).toBe(true)
    expect(analysis.exceeded).toBe(false)
    expect(analysis.boundRatio).toBeLessThan(1)
  })

  it('refuses to return a verdict in strict mode when the bound is escaped', async () => {
    const registry = buildToolRegistry(REPO_ROOT)
    await expect(
      registry.invoke(
        'analyze_run',
        { run: readRun('wheel-scale-drift'), strict: true },
        createContext('test'),
        ['proc:spawn'],
      ),
    ).rejects.toThrow(/BOUND_VIOLATION|escaped the certified envelope/)
  })
})

describe('run rendering', () => {
  it('includes the peak figures, the ablation and the verdict', async () => {
    const text = renderRun((await analyze('wheel-scale-drift')) as never)
    expect(text).toContain('DRIFT ENVELOPE')
    expect(text).toContain('SENSOR ABLATION')
    expect(text).toContain('VERDICT')
    expect(text).toContain('wheel')
    expect(text).toMatch(/peak observed .* against a .* bound/)
  })

  it('draws the bound band even when nothing escaped', async () => {
    const text = renderRun((await analyze('clean-run')) as never)
    expect(text).toContain('bound')
    expect(text).not.toContain('first escape')
  })
})

describe('engine reachability', () => {
  it('spawns the Python engine through the bridge', () => {
    const out = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js'), 'version'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    )
    const parsed = JSON.parse(out) as { tools: number; name: string }
    expect(parsed.name).toBe('odometry-scope')
    // Every registered tool plus the diagnostics tool.
    expect(parsed.tools).toBeGreaterThanOrEqual(10)
  })
})
