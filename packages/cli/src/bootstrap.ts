import { join } from 'node:path'
import {
  ToolRegistry,
  ValidationError,
  isRunDocument,
  type AttributionEntry,
  type EnvelopeStep,
  type RunAnalysis,
  type Severity,
  type Tool,
  type ToolContext,
} from '@odometryscope/core'
import { buildRegistry } from '@odometryscope/plugins'
import { loadCatalog } from '@odometryscope/skills'
import { doctor } from './doctor.js'

export const ENGINE_MODULE = 'odometry_scope'

/** One JSON Schema for a block of parallel numeric channels. */
const channelsSchema = (required: readonly string[]) => ({
  type: 'object',
  properties: {
    t: { type: 'array', items: { type: 'number' }, description: 'sample timestamps in seconds' },
    x: { type: 'array', items: { type: 'number' }, description: 'position x in metres' },
    y: { type: 'array', items: { type: 'number' }, description: 'position y in metres' },
    theta: { type: 'array', items: { type: 'number' }, description: 'heading in radians' },
    v: { type: 'array', items: { type: 'number' }, description: 'forward speed in m/s' },
    omega: { type: 'array', items: { type: 'number' }, description: 'yaw rate in rad/s' },
  },
  required: [...required],
  additionalProperties: false,
})

const envelopeParams = {
  rateSigma: {
    type: 'number',
    description: 'assumed 1-sigma relative uncertainty in the speed channel (default 0.01)',
  },
  rateSigmaOmega: {
    type: 'number',
    description: 'assumed 1-sigma relative uncertainty in the yaw-rate channel (default 0.005)',
  },
  strict: {
    type: 'boolean',
    description: 'raise BOUND_VIOLATION instead of reporting when drift escapes the envelope',
  },
  maxSteps: { type: 'number', description: 'cap on reported steps (default 4096)' },
} as const

/**
 * Builds the one registry every surface shares.
 *
 * The tools below are the product's actual capability: canonicalise a recorded log,
 * dead-reckon a pose, measure drift against a certified envelope, and attribute that drift to
 * the sensor responsible. The registry is the only way in — the CLI, the web app and the MCP
 * server all reach these same handlers, so a fix here fixes every surface at once.
 *
 * Every name matches ^[a-z][a-z0-9_]*$ so it is directly exposable over MCP.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register(
    {
      name: 'list_skills',
      description:
        'List the skill catalog with each skill name, version and description. Use this to discover what the agent can do before guessing a command.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBodies: { type: 'boolean', description: 'Include each skill body.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          skills: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'issues', 'skills'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { includeBodies?: boolean }) => {
        const { skills, issues } = loadCatalog(join(cwd, 'skills'))
        return {
          count: skills.length,
          issues: [...issues],
          skills: skills.map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            ...(input.includeBodies === true ? { body: skill.body } : {}),
          })),
        }
      },
    } satisfies Tool<{ includeBodies?: boolean }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_plugins',
      description:
        'List the resolved plugin registry, including plugins that were shadowed, disabled or rejected and why. Use this to explain why an expected capability is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async () => {
        const result = buildRegistry(join(cwd, 'plugins'))
        return {
          active: result.active.map((p) => ({
            name: p.manifest.name,
            version: p.manifest.version,
            capabilities: p.manifest.capabilities,
            shadowed: p.shadowed,
          })),
          disabled: result.disabled.map((p) => p.manifest.name),
          rejected: result.rejected.map((p) => ({ path: p.path, issues: p.issues })),
        }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  const runEngine = async (op: string, input: unknown): Promise<unknown> => {
    const { EngineBridge } = await import('@odometryscope/engine-client')
    const bridge = new EngineBridge({
      module: ENGINE_MODULE,
      cwd: join(cwd, 'services', 'engine', 'src'),
    })
    return await bridge.call({ op, input })
  }

  const requireObject = (input: unknown, field: string): Record<string, unknown> => {
    const value = (input as Record<string, unknown> | undefined)?.[field]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ValidationError(`"${field}" must be an object`, { field })
    }
    return value as Record<string, unknown>
  }

  registry.register(
    {
      name: 'engine_normalize',
      description:
        'Canonicalise a recorded sample log into typed channels (t, x, y, theta, v, omega). Accepts common field aliases such as yaw for theta and time for t, sorts by time, and reports the sample rate and duration. Call this first on any raw log so later operations never depend on field naming or ordering.',
      inputSchema: {
        type: 'object',
        properties: {
          samples: {
            type: 'array',
            items: { type: 'object' },
            description: 'raw recorded samples, each with a timestamp and pose or rate fields',
          },
        },
        required: ['samples'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          channels: { type: 'object' },
          count: { type: 'number' },
          durationS: { type: 'number' },
          rateHz: { type: 'number' },
          presentFields: { type: 'array', items: { type: 'string' } },
          reordered: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['channels', 'count', 'durationS', 'rateHz', 'presentFields', 'reordered', 'issues'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: { samples?: unknown }) => {
        if (!Array.isArray((input as { samples?: unknown }).samples)) {
          throw new ValidationError('"samples" must be an array', { field: 'samples' })
        }
        return await runEngine('normalize', input)
      },
    } satisfies Tool<{ samples: unknown[] }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_integrate',
      description:
        'Dead-reckon a pose series from a recorded rate series using RK4 with step-doubling error control. Use this to predict where the robot should have been from its wheel and gyro rates, or to re-integrate a track at a different substep count. Returns the integrated pose plus the integrator’s own truncation error.',
      inputSchema: {
        type: 'object',
        properties: {
          channels: channelsSchema(['t']),
          params: {
            type: 'object',
            properties: {
              substeps: { type: 'number', description: 'RK4 sub-steps per interval (default 4)' },
              x0: { type: 'number' },
              y0: { type: 'number' },
              theta0: { type: 'number' },
              estimateError: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        required: ['channels'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          x: { type: 'array', items: { type: 'number' } },
          y: { type: 'array', items: { type: 'number' } },
          theta: { type: 'array', items: { type: 'number' } },
          pathLength: { type: 'number' },
          maxLocalError: { type: 'number' },
          substeps: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['x', 'y', 'theta', 'pathLength', 'maxLocalError', 'substeps', 'issues'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: { channels?: unknown }) => {
        requireObject(input, 'channels')
        return await runEngine('integrate', input)
      },
    } satisfies Tool<{ channels: unknown }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_divergence',
      description:
        'Measure how far a fused pose estimate drifts from a reference track, and compare that drift against a propagated error envelope built from the sensor uncertainty you state. Returns per-step observed-versus-bound values, the first step where the bound was exceeded, and the worst-case ratio. Set params.strict to make an escaped bound an error instead of a result — that is how you prove drift is real rather than reporting a confidence you did not earn.',
      inputSchema: {
        type: 'object',
        properties: {
          estimate: channelsSchema(['t']),
          truth: channelsSchema(['t']),
          params: {
            type: 'object',
            properties: envelopeParams,
            additionalProperties: false,
          },
        },
        required: ['estimate', 'truth'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'object' } },
          stepCount: { type: 'number' },
          truncated: { type: 'boolean' },
          maxObserved: { type: 'number' },
          maxBound: { type: 'number' },
          boundRatio: { type: 'number' },
          rmsObserved: { type: 'number' },
          terminalObserved: { type: 'number' },
          terminalBound: { type: 'number' },
          maxHeadingError: { type: 'number' },
          firstExceedance: { type: ['number', 'null'] },
          exceeded: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'steps',
          'stepCount',
          'truncated',
          'maxObserved',
          'maxBound',
          'boundRatio',
          'rmsObserved',
          'terminalObserved',
          'terminalBound',
          'maxHeadingError',
          'firstExceedance',
          'exceeded',
          'issues',
        ],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: { estimate?: unknown; truth?: unknown }) => {
        requireObject(input, 'estimate')
        requireObject(input, 'truth')
        return await runEngine('divergence', input)
      },
    } satisfies Tool<{ estimate: unknown; truth: unknown }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_attribute',
      description:
        'Find which sensor is lying. Ablate one sensor at a time, renormalise the remaining fusion weights, re-integrate, and report how much of the run’s drift each sensor explained. A sensor can come back "primary" (removing it fixes the drift), "masking" (its presence was hiding drift that the rest of the stack would otherwise show), or "negligible". Give it the fused track, a per-sensor map of v/omega with fusion weights, and the reference track.',
      inputSchema: {
        type: 'object',
        properties: {
          fused: channelsSchema(['t']),
          sensors: {
            type: 'object',
            description:
              'per-sensor rate estimates keyed by name; each value has v, omega and an optional fusion weight (default 1)',
            additionalProperties: {
              type: 'object',
              properties: {
                v: { type: 'array', items: { type: 'number' } },
                omega: { type: 'array', items: { type: 'number' } },
                weight: { type: 'number' },
              },
              required: ['v', 'omega'],
            },
          },
          truth: channelsSchema(['t']),
        },
        required: ['fused', 'sensors', 'truth'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          baselineDrift: { type: 'number' },
          fusionInconsistency: { type: 'number' },
          dominant: { type: ['string', 'null'] },
          sensors: { type: 'array', items: { type: 'object' } },
        },
        required: ['baselineDrift', 'fusionInconsistency', 'dominant', 'sensors'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: Record<string, unknown>) => {
        requireObject(input, 'fused')
        requireObject(input, 'sensors')
        requireObject(input, 'truth')
        return await runEngine('attribute', input)
      },
    } satisfies Tool<Record<string, unknown>, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_classify',
      description:
        'Turn a divergence envelope and an attribution into a bounded verdict: severity ok, watch or drifting, plus whether the verdict is still "certified" (drift stayed inside the envelope) or "unbounded" (it escaped and there is no longer a bound to quote). Use this last, so a report always states whether it is standing on proven ground.',
      inputSchema: {
        type: 'object',
        properties: {
          envelope: { type: 'object', description: 'the object returned by engine_divergence' },
          attribution: {
            type: 'object',
            description: 'the object returned by engine_attribute (optional but recommended)',
          },
        },
        required: ['envelope'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['ok', 'watch', 'drifting'] },
          confidence: { type: 'string', enum: ['certified', 'unbounded'] },
          boundRatio: { type: 'number' },
          firstExceedanceStep: { type: ['number', 'null'] },
          dominantSensor: { type: ['string', 'null'] },
          withinEnvelope: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: [
          'severity',
          'confidence',
          'boundRatio',
          'firstExceedanceStep',
          'dominantSensor',
          'withinEnvelope',
          'summary',
        ],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: { envelope?: unknown }) => {
        requireObject(input, 'envelope')
        return await runEngine('classify', input)
      },
    } satisfies Tool<{ envelope: unknown }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'engine_summarize',
      description:
        'Aggregate a recorded run into the few numbers an operator reads first: sample count, duration, sample rate, path length, mean and peak speed, peak yaw rate and terminal pose. Use this to describe a run before deciding whether it is worth analysing.',
      inputSchema: {
        type: 'object',
        properties: {
          channels: channelsSchema(['t']),
          params: {
            type: 'object',
            properties: { substeps: { type: 'number' } },
            additionalProperties: false,
          },
        },
        required: ['channels'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          durationS: { type: 'number' },
          rateHz: { type: 'number' },
          pathLength: { type: 'number' },
          meanSpeed: { type: 'number' },
          maxSpeed: { type: 'number' },
          maxYawRate: { type: 'number' },
          terminalPose: { type: 'object' },
          maxLocalError: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'count',
          'durationS',
          'rateHz',
          'pathLength',
          'meanSpeed',
          'maxSpeed',
          'maxYawRate',
          'terminalPose',
          'maxLocalError',
          'issues',
        ],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: { channels?: unknown }) => {
        requireObject(input, 'channels')
        return await runEngine('summarize', input)
      },
    } satisfies Tool<{ channels: unknown }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'analyze_run',
      description:
        'The flagship operation: take one recorded run (a fused pose estimate, the reference track, and the per-sensor rate estimates the fusion is built from) and return everything the product can say about it — a summary, the full per-step drift envelope against a certified bound, the sensor-by-sensor ablation naming who is lying, and a bounded verdict. Use this instead of chaining the individual engine_* tools by hand, so the verdict always includes the attribution.',
      inputSchema: {
        type: 'object',
        properties: {
          run: {
            type: 'object',
            description: 'a run document',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              summary: { type: 'string' },
              rateHz: { type: 'number' },
              params: { type: 'object' },
              estimate: channelsSchema(['t']),
              truth: channelsSchema(['t']),
              sensors: { type: 'object' },
            },
            required: ['id', 'name', 'estimate', 'truth', 'sensors'],
            additionalProperties: true,
          },
          strict: {
            type: 'boolean',
            description: 'treat an escaped bound as an error instead of a reported verdict (default false)',
          },
        },
        required: ['run'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          sampleCount: { type: 'number' },
          maxObserved: { type: 'number' },
          maxBound: { type: 'number' },
          boundRatio: { type: 'number' },
          exceeded: { type: 'boolean' },
          steps: { type: 'array', items: { type: 'object' } },
          attribution: { type: 'array', items: { type: 'object' } },
          verdict: { type: 'object' },
        },
        required: [
          'id',
          'name',
          'sampleCount',
          'maxObserved',
          'maxBound',
          'boundRatio',
          'exceeded',
          'steps',
          'attribution',
          'verdict',
        ],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input: { run?: unknown; strict?: boolean }) => {
        const run = input.run
        if (!isRunDocument(run)) {
          throw new ValidationError(
            '"run" must be a run document with id, name, estimate, truth and sensors',
            { field: 'run' },
          )
        }
        const params = { ...run.params, strict: input.strict === true }
        const summary = (await runEngine('summarize', { channels: run.estimate })) as Record<string, unknown>
        const envelope = (await runEngine('divergence', {
          estimate: run.estimate,
          truth: run.truth,
          params,
        })) as Record<string, unknown>
        const attribution = (await runEngine('attribute', {
          fused: run.estimate,
          sensors: run.sensors,
          truth: run.truth,
        })) as Record<string, unknown>
        const verdict = (await runEngine('classify', { envelope, attribution })) as Severity
        return {
          id: run.id,
          name: run.name,
          summary: run.summary,
          sampleCount: Number(summary.count ?? 0),
          durationS: Number(summary.durationS ?? 0),
          rateHz: Number(summary.rateHz ?? run.rateHz ?? 0),
          pathLength: Number(summary.pathLength ?? 0),
          maxObserved: Number(envelope.maxObserved ?? 0),
          maxBound: Number(envelope.maxBound ?? 0),
          boundRatio: Number(envelope.boundRatio ?? 0),
          rmsObserved: Number(envelope.rmsObserved ?? 0),
          maxHeadingError: Number(envelope.maxHeadingError ?? 0),
          firstExceedance: (envelope.firstExceedance as number | null) ?? null,
          exceeded: envelope.exceeded === true,
          truncated: envelope.truncated === true,
          steps: (envelope.steps as EnvelopeStep[] | undefined) ?? [],
          attribution: (attribution.sensors as AttributionEntry[] | undefined) ?? [],
          dominantSensor: (attribution.dominant as string | null) ?? null,
          baselineDrift: Number(attribution.baselineDrift ?? 0),
          fusionInconsistency: Number(attribution.fusionInconsistency ?? 0),
          notes: run.notes ?? [],
          verdict,
        } satisfies RunAnalysis
      },
    } satisfies Tool<{ run: unknown; strict?: boolean }, RunAnalysis>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'health_check',
      description:
        'Report whether this installation can actually do the work: Node version, whether the Python engine is reachable, the registry size, the skill catalog, and the plugin registry. Use this first when a tool call fails, to tell a broken environment apart from a broken input. Returns a per-check status with a fix hint for anything failing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          checks: { type: 'array', items: { type: 'object' } },
        },
        required: ['ok', 'checks'],
      },
      permissions: ['fs:read', 'proc:spawn'],
      surface: 'core',
      handler: async () => {
        const report = await doctor()
        return { ok: report.ok, checks: report.checks }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  return registry
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env.PRODUCT_DATA_DIR ?? '.data',
  }
}
