/**
 * ground-truth-adapter — normalises an external ground-truth export into the engine's shape.
 *
 * The engine wants a reference track as `{ t, x, y, theta }`: metres, seconds, heading in
 * radians, on its own ascending time base. Real trackers do not produce that. They write CSV
 * with `timestamp,easting,northing,heading`, or JSON keyed `time/pos_x/pos_y/yaw`, in degrees,
 * in milliseconds, or starting at an absolute epoch. Feeding one of those straight in gives a
 * drift number that is wrong by orders of magnitude and still looks plausible.
 *
 * This adapter does the conversion, then hands back the run-document shape:
 *
 *   - resolves column aliases to the canonical four;
 *   - converts headings to radians, and detects degrees by magnitude unless told otherwise;
 *   - rescales positions from millimetres or centimetres to metres;
 *   - shifts the time base to start at zero, matching a recorded run;
 *   - sorts by time, and drops incomplete rows while reporting how many;
 *   - accepts a CSV-ish string or an already-parsed object.
 *
 * `apply(run, external)` returns a run document with its truth replaced, ready for the engine.
 *
 * Entry point: check(input, options) -> report. Pure: no clock, no network, no filesystem.
 */

export const manifest = {
  name: 'ground-truth-adapter',
  version: '0.1.0',
}

export const capability = 'ingest:ground-truth'

const ALIASES = {
  t: ['t', 'time', 'timestamp', 'stamp', 'secs', 'seconds', 'elapsed', 't_s'],
  x: ['x', 'east', 'easting', 'px', 'pos_x', 'x_m', 'utm_e'],
  y: ['y', 'north', 'northing', 'py', 'pos_y', 'y_m', 'utm_n'],
  theta: ['theta', 'heading', 'yaw', 'bearing', 'orientation', 'yaw_deg', 'theta_rad'],
}

/** Keys that hold the track itself, in the order they are tried. */
const NESTED = ['truth', 'groundTruth', 'ground_truth', 'pose', 'track', 'poses', 'samples', 'data']

/** Any radian heading beyond this magnitude is not a radian heading. */
const RADIAN_CEILING = 2 * Math.PI

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberAt(raw) {
  if (isFiniteNumber(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return Number.NaN
    const parsed = Number(trimmed)
    return isFiniteNumber(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

function pick(source, names) {
  for (const name of names) {
    if (Array.isArray(source[name])) return source[name]
  }
  for (const name of names) {
    const found = Object.keys(source).find((key) => key.toLowerCase() === name)
    if (found !== undefined && Array.isArray(source[found])) return source[found]
  }
  return null
}

function parseDelimited(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length === 0) {
    fail('EMPTY_INPUT', 'the ground-truth export has no data rows')
  }

  const cells = (line) => line.split(/[,;\t]+/).map((cell) => cell.trim())
  const first = cells(lines[0])
  // A header row is one whose cells are not all numbers.
  const headerish = first.some((cell) => cell !== '' && !Number.isFinite(Number(cell)))

  let index = { t: null, x: null, y: null, theta: null }
  let rows = []
  if (headerish) {
    for (const [position, cell] of first.entries()) {
      const key = cell
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
      for (const [field, names] of Object.entries(ALIASES)) {
        if (index[field] === null && names.includes(key)) index[field] = position
      }
    }
    rows = lines.slice(1).map(cells)
  } else {
    // No header: assume the conventional column order the engine itself uses.
    index = { t: 0, x: 1, y: 2, theta: 3 }
    rows = lines.map(cells)
  }

  for (const field of ['t', 'x', 'y']) {
    if (index[field] === null) {
      fail('MISSING_FIELD', `the export has no '${field}' column; looked for ${ALIASES[field].join(', ')}`)
    }
  }

  const out = { t: [], x: [], y: [], theta: [] }
  const hasTheta = index.theta !== null
  for (const row of rows) {
    const at = (position) => (position !== null && position < row.length ? row[position] : undefined)
    out.t.push(numberAt(at(index.t)))
    out.x.push(numberAt(at(index.x)))
    out.y.push(numberAt(at(index.y)))
    if (hasTheta) out.theta.push(numberAt(at(index.theta)))
  }
  return out
}

function unwrap(input) {
  if (typeof input === 'string') {
    return { columns: parseDelimited(input), source: 'text' }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('BAD_SHAPE', 'ground truth must be a delimited string or an object of channels')
  }
  for (const key of NESTED) {
    const nested = input[key]
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const found = pick(nested, ALIASES.t)
      if (found !== null) return { columns: nested, source: key, depth: 1 }
    }
  }
  return { columns: input, source: 'object', depth: 0 }
}

export function check(input, options = {}) {
  const settings = {
    /** 'rad' | 'deg' | 'auto'. Auto treats any heading beyond +/-2*pi as degrees. */
    headingUnit: 'auto',
    /** Multiplier applied to x and y. Use 0.001 for millimetres, 0.01 for centimetres. */
    unitScale: 1,
    /** Keep the source time base instead of shifting it to start at zero. */
    absoluteTime: false,
    /** Drop rows with a missing or non-finite required sample. */
    dropIncomplete: true,
    ...options,
  }

  const unwrapped = unwrap(input)
  const source = unwrapped.columns
  const issues = []

  const rawT = pick(source, ALIASES.t)
  const rawX = pick(source, ALIASES.x)
  const rawY = pick(source, ALIASES.y)
  const rawTheta = pick(source, ALIASES.theta)
  if (rawT === null || rawX === null || rawY === null) {
    fail('MISSING_FIELD', "ground truth must supply a time, an x and a y channel ('theta' is optional)")
  }

  const rows = rawT.length
  if (rows === 0) {
    fail('EMPTY_INPUT', 'the ground-truth export has no samples')
  }
  if (rawX.length !== rows || rawY.length !== rows) {
    fail(
      'LENGTH_MISMATCH',
      `the ground-truth channels disagree in length: t=${rows}, x=${rawX.length}, y=${rawY.length}`,
    )
  }
  if (rawTheta !== null && rawTheta.length !== rows) {
    issues.push(`theta has ${rawTheta.length} samples but t has ${rows}; the heading channel was dropped`)
  }

  const scale = isFiniteNumber(settings.unitScale) ? settings.unitScale : 1
  let kept = []
  let dropped = 0
  for (let i = 0; i < rows; i += 1) {
    const t = numberAt(rawT[i])
    const x = numberAt(rawX[i])
    const y = numberAt(rawY[i])
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) {
      dropped += 1
      continue
    }
    kept.push({
      t,
      x: x * scale,
      y: y * scale,
      theta: rawTheta === null ? Number.NaN : numberAt(rawTheta[i]),
    })
  }
  if (kept.length < 2) {
    fail(
      'TOO_FEW_SAMPLES',
      `only ${kept.length} usable sample(s) in ${rows}; a reference track needs at least two`,
    )
  }
  if (!settings.dropIncomplete && dropped > 0) {
    issues.push(`${dropped} row(s) hold a non-finite required sample and were left as NaN`)
  }

  let reordered = false
  for (let i = 1; i < kept.length; i += 1) {
    if (kept[i].t < kept[i - 1].t) {
      reordered = true
      break
    }
  }
  if (reordered) {
    kept.sort((a, b) => a.t - b.t)
    issues.push('the export was not in ascending time order and has been sorted')
  }

  const duplicateT = kept.some((row, i) => i > 0 && row.t === kept[i - 1].t)
  if (duplicateT) {
    issues.push(
      'the export repeats a timestamp; the engine interpolates by time and duplicates are ambiguous',
    )
  }

  const hasHeading = kept.some((row) => Number.isFinite(row.theta))
  let headingUnit = settings.headingUnit
  if (headingUnit === 'auto') {
    headingUnit = kept.some((row) => Math.abs(row.theta) > RADIAN_CEILING) ? 'deg' : 'rad'
  }
  const toRadians = headingUnit === 'deg' ? Math.PI / 180 : 1
  if (hasHeading && headingUnit === 'deg') {
    issues.push('headings were read as degrees and converted to radians')
  }

  const origin = settings.absoluteTime ? 0 : kept[0].t
  const truth = {
    t: kept.map((row) => row.t - origin),
    x: kept.map((row) => row.x),
    y: kept.map((row) => row.y),
  }
  if (hasHeading) {
    truth.theta = kept.map((row) => (Number.isFinite(row.theta) ? row.theta * toRadians : 0))
  }

  return {
    plugin: manifest.name,
    capability,
    source: unwrapped.source,
    sampleCount: truth.t.length,
    droppedRows: dropped,
    headingUnit,
    timeBase: settings.absoluteTime ? 'absolute' : 'relative',
    truth,
    issues,
  }
}

/** Replace a run document's truth channel with a normalised external track. */
export function apply(run, input, options = {}) {
  if (typeof run !== 'object' || run === null || Array.isArray(run)) {
    fail('BAD_SHAPE', "'run' must be an object")
  }
  const report = check(input, options)
  return { run: { ...run, truth: report.truth }, report }
}

export default check
