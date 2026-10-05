/**
 * rate-bias-linter — checks a run document's sensor block before the engine sees it.
 *
 * The engine treats the sensor block as a weighted mean and ablates one sensor at a time,
 * renormalising the rest. That only means something when the weights are sane, and the engine
 * is deliberately forgiving about them: a missing weight silently becomes 1.0, and any
 * positive set of weights is accepted. So a run document that is perfectly loadable can still
 * produce an attribution table that is meaningless.
 *
 * This linter catches the cases that survive loading:
 *
 *   - a sensor with no weight at all, which quietly becomes 1.0 and can outvote an explicit
 *     weight of 0.4;
 *   - all-zero or all-negative weights, which the engine rejects outright;
 *   - one sensor holding most of the weight, where ablating anything else cannot move the
 *     fused estimate and the attribution table collapses toward that one sensor;
 *   - a sensor holding almost none, where its ablation will report ~0 explained drift whether
 *     or not it is actually lying — the "innocent" verdict is an artefact of its weight;
 *   - rate series that do not line up with the fused track's length, which the engine rejects
 *     later with a less specific message.
 *
 * Entry point: check(run, params) -> report. Pure: no clock, no network, no filesystem.
 */

export const manifest = {
  name: 'rate-bias-linter',
  version: '0.1.0',
}

export const capability = 'diagnostics:rate-bias'

const DEFAULTS = {
  /** Above this share of the total weight, one sensor dominates the fusion. */
  dominantShare: 0.8,
  /** Below this share, a sensor cannot move the fusion enough to be ablated meaningfully. */
  negligibleShare: 0.02,
  /** The engine's own fallback for a weight the document does not state. */
  impliedWeight: 1.0,
}

function mapping(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value
}

function series(value, field, findings, sensor) {
  if (!Array.isArray(value)) {
    findings.push({
      level: 'error',
      code: 'series-missing',
      sensor,
      message: `'${field}' must be an array of numbers`,
    })
    return null
  }
  const bad = value.findIndex((sample) => typeof sample !== 'number' || !Number.isFinite(sample))
  if (bad !== -1) {
    findings.push({
      level: 'error',
      code: 'non-finite-sample',
      sensor,
      message: `'${field}[${bad}]' must be a finite number`,
    })
    return null
  }
  return value
}

function finding(level, code, sensor, message) {
  return { level, code, sensor, message }
}

export function check(run, params = {}) {
  const options = { ...DEFAULTS, ...params }
  const findings = []
  const document = mapping(run)
  if (document === null) {
    return {
      plugin: manifest.name,
      capability,
      ok: false,
      findings: [finding('error', 'run-not-an-object', null, "'run' must be an object")],
      totalWeight: 0,
      shares: {},
    }
  }

  const sensors = mapping(document.sensors)
  if (sensors === null || Object.keys(sensors).length === 0) {
    return {
      plugin: manifest.name,
      capability,
      ok: false,
      findings: [
        finding(
          'error',
          'sensors-missing',
          null,
          "'run.sensors' must be a non-empty object of per-sensor rates",
        ),
      ],
      totalWeight: 0,
      shares: {},
    }
  }

  const fused = mapping(document.fused)
  const fusedTimes = fused !== null && Array.isArray(fused.t) ? fused.t.length : null

  const weights = {}
  const names = Object.keys(sensors)
  for (const name of names) {
    const block = mapping(sensors[name])
    if (block === null) {
      findings.push(finding('error', 'sensor-not-an-object', name, `'run.sensors.${name}' must be an object`))
      weights[name] = options.impliedWeight
      continue
    }

    series(block.v, `run.sensors.${name}.v`, findings, name)
    series(block.omega, `run.sensors.${name}.omega`, findings, name)

    if (fusedTimes !== null) {
      for (const field of ['v', 'omega']) {
        const values = block[field]
        if (Array.isArray(values) && values.length !== fusedTimes) {
          findings.push(
            finding(
              'error',
              'length-mismatch',
              name,
              `'run.sensors.${name}.${field}' has ${values.length} samples but the fused track has ` +
                `${fusedTimes}`,
            ),
          )
        }
      }
    }

    if (!('weight' in block) || block.weight === undefined || block.weight === null) {
      findings.push(
        finding(
          'warning',
          'weight-missing',
          name,
          `'run.sensors.${name}' states no weight, so the engine will substitute ` +
            `${options.impliedWeight} and this sensor may outvote explicitly weighted sensors`,
        ),
      )
      weights[name] = options.impliedWeight
      continue
    }

    const weight = block.weight
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      findings.push(
        finding('error', 'weight-not-a-number', name, `'run.sensors.${name}.weight' must be a finite number`),
      )
      weights[name] = 0
      continue
    }
    if (weight < 0) {
      findings.push(
        finding(
          'error',
          'weight-negative',
          name,
          `'run.sensors.${name}.weight' is ${weight}; a negative weight inverts this sensor's ` +
            'contribution instead of weighting it',
        ),
      )
    }
    weights[name] = weight
  }

  const totalWeight = names.reduce((sum, name) => sum + weights[name], 0)
  if (!(totalWeight > 0)) {
    findings.push(
      finding(
        'error',
        'all-zero-weights',
        null,
        `the sensor weights sum to ${totalWeight}; the engine rejects any run whose weights do not ` +
          'sum to a positive number, so the ablation has nothing to ablate',
      ),
    )
  }

  const shares = {}
  if (totalWeight > 0) {
    for (const name of names) {
      const share = weights[name] / totalWeight
      shares[name] = share
      if (share > options.dominantShare) {
        findings.push(
          finding(
            'warning',
            'weight-dominant',
            name,
            `'${name}' holds ${(share * 100).toFixed(1)}% of the fusion weight; ablating any other ` +
              'sensor cannot move the fused estimate, so the attribution will name this sensor ' +
              'almost regardless of what the others did',
          ),
        )
      } else if (share < options.negligibleShare) {
        findings.push(
          finding(
            'warning',
            'weight-negligible',
            name,
            `'${name}' holds ${(share * 100).toFixed(1)}% of the fusion weight; ablating it barely ` +
              'changes the fused estimate, so a low explained fraction here means little about ' +
              'whether this sensor is actually accurate',
          ),
        )
      }
    }
  }

  return {
    plugin: manifest.name,
    capability,
    ok: !findings.some((f) => f.level === 'error'),
    findings,
    errorCount: findings.filter((f) => f.level === 'error').length,
    warningCount: findings.filter((f) => f.level === 'warning').length,
    totalWeight,
    shares,
  }
}

export default check
