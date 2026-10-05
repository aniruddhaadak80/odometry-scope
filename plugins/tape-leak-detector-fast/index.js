/**
 * tape-leak-detector-fast — the subsampled tape-leak check.
 *
 * This is the same measurement as `tape-leak-detector` with the per-run cause analysis
 * removed. It walks the fused track on a stride instead of every sample, which is roughly
 * `stride` times less work, and it does not split the run into thirds to separate
 * calibration error from progressive slip.
 *
 * It exists for long runs where the full check's cause analysis is not worth the pass. It is
 * also less truthful by construction: striding a curved path cuts corners, so the ground
 * distance it measures is a slight under-count and the ratio it reports is biased high. That
 * is the trade, and it is why this plugin ships at a lower priority than the full checker and
 * is therefore shadowed by it — raise the priority above 70 in its manifest if you want the
 * fast answer for a specific run.
 *
 * Entry point: check(run, params) -> report. Pure: no clock, no network, no filesystem.
 */

export const manifest = {
  name: 'tape-leak-detector-fast',
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
  /** Take every Nth sample. Larger is faster and less accurate. */
  stride: 8,
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

function verdictFor(ratio, options, truthDistanceM) {
  if (truthDistanceM < options.minTruthDistanceM) return 'insufficient-motion'
  if (ratio === null) return 'unknown'
  if (ratio < options.leakingBelow) return 'leaking'
  if (ratio < options.suspectBelow) return 'suspect'
  return 'ok'
}

export function check(run, params = {}) {
  const options = { ...DEFAULTS, ...params }
  const stride = Math.max(1, Math.floor(options.stride))

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
    fail('LENGTH_MISMATCH', `run.truth has ${truthX.length} samples with no truth.t; give it a time base`)
  }

  // Stride the fused track, then clip to the window the ground truth actually covers.
  const picks = []
  for (let i = 0; i < times.length; i += stride) picks.push(i)
  if (picks[picks.length - 1] !== times.length - 1) picks.push(times.length - 1)

  let kept = picks
  if (truthT !== null) {
    const first = truthT[0]
    const last = truthT[truthT.length - 1]
    kept = picks.filter((i) => times[i] >= first && times[i] <= last)
  }
  if (kept.length < 2) {
    fail('NO_OVERLAP', 'the fused track and the ground truth do not overlap for two or more samples')
  }

  const ground = []
  if (truthT !== null) {
    const cursor = { index: 0 }
    for (const i of kept) ground.push(atTime(truthT, truthX, truthY, times[i], cursor))
  } else {
    for (const i of kept) ground.push([truthX[i], truthY[i]])
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

    let encoderDistanceM = 0
    for (let i = 1; i < kept.length; i += 1) {
      const dt = times[kept[i]] - times[kept[i - 1]]
      encoderDistanceM += ((Math.abs(speeds[kept[i - 1]]) + Math.abs(speeds[kept[i]])) / 2) * dt
    }

    const ratio = truthDistanceM > 0 ? encoderDistanceM / truthDistanceM : null
    findings.push({
      sensor: name,
      verdict: verdictFor(ratio, options, truthDistanceM),
      distanceRatio: ratio,
      encoderDistanceM,
      truthDistanceM,
      shortfallM: truthDistanceM - encoderDistanceM,
      shortfallPct: truthDistanceM > 0 ? (100 * (truthDistanceM - encoderDistanceM)) / truthDistanceM : 0,
    })
  }

  findings.sort((a, b) => (a.distanceRatio ?? Infinity) - (b.distanceRatio ?? Infinity))

  return {
    plugin: manifest.name,
    capability,
    stride,
    sampleCount: kept.length,
    windowSeconds: times[kept[kept.length - 1]] - times[kept[0]],
    truthDistanceM,
    worstSensor: findings.length > 0 ? findings[0].sensor : null,
    findings,
    issues,
  }
}

export default check
