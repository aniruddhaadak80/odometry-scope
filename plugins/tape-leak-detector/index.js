/**
 * tape-leak-detector — flags wheel-encoder channels that under-report distance.
 *
 * A wheel encoder measures distance by counting wheel revolutions, so it can report less
 * ground than the robot actually covered. The usual causes are mechanical: a worn gearbox,
 * a tyre that slips under load, or an odometry scale constant set too high.
 *
 * This failure is invisible to the rest of the product on purpose. The fused estimate and
 * the ground truth stay together, because the fusion is *believing* the short reading — so
 * the error envelope never breaches and `attribute` never blames anyone. A tape leak has to
 * be measured directly rather than inferred from drift.
 *
 * The check integrates each sensor's speed channel into a distance, integrates the ground
 * truth into a distance over the same window, and reports the ratio. A ratio under 1.0 means
 * the sensor under-reports. The shape of the loss across the run separates the causes: a
 * ratio that is flat and low points at calibration or gearbox wear, while a ratio that
 * decays points at tyre slip or a bearing going.
 *
 * Entry point: check(run, params) -> report. Pure: no clock, no network, no filesystem.
 */

export const manifest = {
  name: 'tape-leak-detector',
  version: '0.1.0',
}

export const capability = 'diagnostics:tape-leak'

const DEFAULTS = {
  /** Below this distance ratio a channel is called suspect rather than trusted. */
  suspectBelow: 0.98,
  /** Below this distance ratio a channel is called leaking. */
  leakingBelow: 0.9,
  /** Under this much ground truth, a ratio is noise and no verdict is issued. */
  minTruthDistanceM: 0.05,
  /** Relative loss between the first and last third that counts as progressive. */
  progressiveDrop: 0.03,
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function mapping(value, field) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('BAD_SHAPE', `'${field}' must be an object`)
  }
  return value
}

function channel(value, field) {
  if (!Array.isArray(value)) {
    fail('BAD_SHAPE', `'${field}' must be an array of numbers`)
  }
  const out = new Array(value.length)
  for (let i = 0; i < value.length; i += 1) {
    const sample = value[i]
    if (typeof sample !== 'number' || !Number.isFinite(sample)) {
      fail('NON_FINITE', `'${field}[${i}]' must be a finite number`)
    }
    out[i] = sample
  }
  return out
}

/**
 * Linear interpolation of a ground-truth track at `time`, using a cursor so that a run of
 * ascending lookups stays O(n) overall instead of O(n log n).
 */
function atTime(truthT, truthX, truthY, time, cursor) {
  let i = cursor.index
  while (i + 1 < truthT.length && truthT[i + 1] <= time) i += 1
  while (i > 0 && truthT[i] > time) i -= 1
  cursor.index = i
  const t0 = truthT[i]
  const t1 = truthT[i + 1]
  if (t1 === undefined || time <= t0) {
    return [truthX[i], truthY[i]]
  }
  const fraction = (time - t0) / (t1 - t0)
  return [
    truthX[i] + (truthX[i + 1] - truthX[i]) * fraction,
    truthY[i] + (truthY[i + 1] - truthY[i]) * fraction,
  ]
}

function segmentRatio(segments) {
  let ground = 0
  let encoder = 0
  for (const segment of segments) {
    ground += segment.ground
    encoder += segment.encoder
  }
  return ground > 0 ? encoder / ground : null
}

function verdictFor(ratio, options, truthDistanceM) {
  if (truthDistanceM < options.minTruthDistanceM) return 'insufficient-motion'
  if (ratio === null) return 'unknown'
  if (ratio < options.leakingBelow) return 'leaking'
  if (ratio < options.suspectBelow) return 'suspect'
  return 'ok'
}

export function check(run, params = {}) {
  const options = { ...DEFAULTS, ...params }
  const document = mapping(run, 'run')
  const fused = mapping(document.fused, 'run.fused')
  const truth = mapping(document.truth, 'run.truth')
  const sensors = mapping(document.sensors, 'run.sensors')

  const names = Object.keys(sensors)
  if (names.length === 0) {
    fail('BAD_SHAPE', "'run.sensors' must name at least one sensor")
  }

  const times = channel(fused.t, 'run.fused.t')
  if (times.length < 2) {
    fail('BAD_SHAPE', "'run.fused.t' needs at least two samples to measure a distance")
  }
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] <= times[i - 1]) {
      fail('BAD_SHAPE', 'run.fused.t must be strictly increasing to define segment durations')
    }
  }

  const truthT = Array.isArray(truth.t) && truth.t.length > 0 ? channel(truth.t, 'run.truth.t') : null
  const truthX = channel(truth.x, 'run.truth.x')
  const truthY = channel(truth.y, 'run.truth.y')
  if (truthX.length !== truthY.length) {
    fail('LENGTH_MISMATCH', `run.truth.x has ${truthX.length} samples but run.truth.y has ${truthY.length}`)
  }
  if (truthT !== null && truthT.length !== truthX.length) {
    fail('LENGTH_MISMATCH', `run.truth.t has ${truthT.length} samples but run.truth.x has ${truthX.length}`)
  }
  if (truthT === null && truthX.length !== times.length) {
    fail(
      'LENGTH_MISMATCH',
      `run.truth has ${truthX.length} samples with no truth.t; give it a time base or match the ` +
        `fused track's ${times.length}`,
    )
  }

  // Only compare where both sides exist. A truth track that starts late must not silently
  // become a measurement of the fused track's first samples against a held truth position.
  let from = 0
  let to = times.length
  if (truthT !== null) {
    while (from < times.length && times[from] < truthT[0]) from += 1
    while (to > from && times[to - 1] > truthT[truthT.length - 1]) to -= 1
    if (to - from < 2) {
      fail('NO_OVERLAP', 'the fused track and the ground truth do not overlap for two or more samples')
    }
  }

  const window = times.slice(from, to)
  const ground = []
  if (truthT !== null) {
    const cursor = { index: 0 }
    for (const time of window) {
      ground.push(atTime(truthT, truthX, truthY, time, cursor))
    }
  } else {
    for (let i = from; i < to; i += 1) {
      ground.push([truthX[i], truthY[i]])
    }
  }

  let truthDistanceM = 0
  for (let i = 1; i < ground.length; i += 1) {
    truthDistanceM += Math.hypot(ground[i][0] - ground[i - 1][0], ground[i][1] - ground[i - 1][1])
  }

  const issues = []
  const findings = []
  for (const name of names) {
    const block = mapping(sensors[name], `run.sensors.${name}`)
    const speeds = channel(block.v, `run.sensors.${name}.v`)
    if (speeds.length !== times.length) {
      issues.push(
        `sensors.${name}.v has ${speeds.length} samples but the fused track has ${times.length}; skipped`,
      )
      continue
    }

    const segments = []
    let encoderDistanceM = 0
    for (let i = 1; i < window.length; i += 1) {
      const dt = window[i] - window[i - 1]
      const encoder = ((Math.abs(speeds[from + i - 1]) + Math.abs(speeds[from + i])) / 2) * dt
      encoderDistanceM += encoder
      segments.push({
        ground: Math.hypot(ground[i][0] - ground[i - 1][0], ground[i][1] - ground[i - 1][1]),
        encoder,
      })
    }

    const ratio = truthDistanceM > 0 ? encoderDistanceM / truthDistanceM : null
    const third = Math.max(1, Math.floor(segments.length / 3))
    const early = segmentRatio(segments.slice(0, third))
    const late = segmentRatio(segments.slice(-third))

    let causeHint = null
    if (early !== null && late !== null && early > 0) {
      const drop = (early - late) / early
      causeHint = drop > options.progressiveDrop ? 'progressive-slip' : 'constant-scale'
    }

    findings.push({
      sensor: name,
      verdict: verdictFor(ratio, options, truthDistanceM),
      distanceRatio: ratio,
      encoderDistanceM,
      truthDistanceM,
      shortfallM: truthDistanceM - encoderDistanceM,
      shortfallPct: truthDistanceM > 0 ? (100 * (truthDistanceM - encoderDistanceM)) / truthDistanceM : 0,
      earlyRatio: early,
      lateRatio: late,
      causeHint,
    })
  }

  // Worst first: the channel losing the most ground is the one to pull apart first.
  findings.sort((a, b) => (a.distanceRatio ?? Infinity) - (b.distanceRatio ?? Infinity))

  return {
    plugin: manifest.name,
    capability,
    sampleCount: window.length,
    windowSeconds: window[window.length - 1] - window[0],
    truthDistanceM,
    worstSensor: findings.length > 0 ? findings[0].sensor : null,
    findings,
    issues,
  }
}

export default check
