import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { RunAnalysis, Severity } from '@odometryscope/core'
import { buildToolRegistry, createContext } from './bootstrap.js'
import { doctor, renderReport } from './doctor.js'

const VERSION = '0.1.0'

/**
 * Render an error with both layers visible: the product-level taxonomy code, and the engine's
 * own code when the failure came from the Python side. Losing `BOUND_VIOLATION` behind a
 * generic `UPSTREAM_FAILED` would hide the one result this product exists to report.
 */
export function describeError(cause: unknown): string {
  const error = cause as { code?: string; message?: string; details?: Record<string, unknown> }
  const code = error.code ?? 'INTERNAL'
  const upstream = error.details?.code
  const message = error.message ?? String(cause)
  return typeof upstream === 'string' && upstream.length > 0
    ? `${upstream} (surfaced as ${code}): ${message}`
    : `${code}: ${message}`
}

/** Fixed-width so columns line up when the output is read in a terminal or a diff. */
function metres(value: number): string {
  return `${value.toFixed(4)} m`
}

/**
 * The terminal render. The envelope strip is the point of the whole tool: the bound is drawn
 * as a band of '=' marks, the observation as '.' when it is inside the band and 'x' when it
 * has escaped, and the first escape is marked with a caret.
 */
export function renderEnvelopeStrip(analysis: RunAnalysis, width = 64): string {
  const steps = analysis.steps
  if (steps.length === 0) return '  (no steps to plot)'
  const stride = Math.max(1, Math.ceil(steps.length / width))
  const sampled = steps.filter((_, index) => index % stride === 0).slice(0, width)

  const peak = Math.max(...sampled.map((step) => Math.max(step.observed, step.bound)), 1e-9)
  const scale = (value: number): number => Math.min(width - 1, Math.round((value / peak) * (width - 1)))

  const band: string[] = Array.from({ length: width }, () => ' ')
  const trace: string[] = Array.from({ length: width }, () => ' ')
  let caretColumn = -1

  sampled.forEach((step, column) => {
    const at = scale(Math.max(step.observed, step.bound))
    for (let c = 0; c <= at; c += 1) band[c] = '='
    trace[column] = step.exceeded ? 'x' : '.'
    if (step.exceeded && caretColumn < 0) caretColumn = column
  })

  const lines = [`  |${band.join('')}| bound`, `  |${trace.join('')}| observed  (. inside, x escaped)`]
  if (caretColumn >= 0) {
    const caret = Array.from({ length: width }, () => ' ').join('')
    lines.push(
      `  |${caret.slice(0, caretColumn)}^ first escape at t=${steps[caretColumn * stride]?.t.toFixed(2)}s`,
    )
  }
  lines.push(`  peak observed ${metres(analysis.maxObserved)} against a ${metres(analysis.maxBound)} bound`)
  return lines.join('\n')
}

function severityLabel(verdict: Severity): string {
  const mark = verdict.severity === 'ok' ? 'ok  ' : verdict.severity === 'watch' ? 'watch' : 'DRIFT'
  return `[${mark}] ${verdict.confidence}`
}

/** The human report. Kept beside the command so the text is part of the tested surface. */
export function renderRun(analysis: RunAnalysis): string {
  const lines: string[] = []
  lines.push(`odoscope — ${analysis.name}`)
  lines.push('')
  lines.push(
    `  ${analysis.sampleCount} samples · ${analysis.durationS.toFixed(1)}s · ` +
      `${analysis.rateHz.toFixed(1)} Hz · ${analysis.pathLength.toFixed(2)} m path`,
  )
  lines.push('')
  lines.push('  DRIFT ENVELOPE')
  lines.push(renderEnvelopeStrip(analysis))
  lines.push('')
  lines.push('  SENSOR ABLATION')
  const width = Math.max(...analysis.attribution.map((a) => a.sensor.length), 6)
  for (const entry of analysis.attribution) {
    lines.push(
      `    ${entry.sensor.padEnd(width)}  ` +
        `drift without it ${metres(entry.driftWithout).padEnd(12)}  ` +
        `explained ${(entry.explainedFraction * 100).toFixed(1).padStart(6)}%  ${entry.verdict}`,
    )
  }
  lines.push('')
  lines.push('  VERDICT')
  lines.push(`    ${severityLabel(analysis.verdict)}`)
  lines.push(`    ${analysis.verdict.summary}`)
  if (analysis.notes.length > 0) {
    lines.push('')
    lines.push('  RUN NOTES')
    for (const note of analysis.notes) lines.push(`    - ${note}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error. */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('odoscope')
    .description(
      "Odometry Scope — Re-integrates a robot's pose ODE with each sensor's contribution ablated, so you can prove which sensor drifted instead of guessing.",
    )
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride((error) => {
      process.exitCode = error.exitCode === 0 ? 0 : 2
      throw error
    })

  program
    .command('doctor')
    .description('diagnose every subsystem and print an actionable report')
    .option('--json', 'machine-readable output')
    .action(async () => {
      const report = await doctor()
      process.stdout.write(
        process.argv.includes('--json')
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${renderReport(report)}\n`,
      )
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('tools')
    .description('list the registered tools — the authoritative capability list')
    .option('--json', 'machine-readable output')
    .action(() => {
      const registry = buildToolRegistry()
      const tools = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        surface: registry.surfaceOf(tool.name),
        source: registry.sourceOf(tool.name),
        permissions: tool.permissions,
        inputSchema: tool.inputSchema,
      }))
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
        return
      }
      const width = Math.max(...tools.map((t) => t.name.length), 4)
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(width)}  [${tool.surface}]  ${tool.description}\n`)
      }
    })

  const mcp = program.command('mcp').description('Model Context Protocol commands')

  mcp
    .command('serve')
    .description('run the MCP server over stdio')
    .action(async () => {
      const { serveStdio } = await import('@odometryscope/mcp')
      const registry = buildToolRegistry()
      // stdout belongs to the protocol from here on; diagnostics must go to stderr.
      await serveStdio(registry, createContext('mcp'))
    })

  mcp
    .command('call')
    .description('invoke one tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .argument('<input>', 'JSON input document')
    .action(async (tool: string, raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        process.stderr.write(`error: input is not valid JSON — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      const registry = buildToolRegistry()
      try {
        const value = await registry.invoke(tool, parsed, createContext('cli'), [
          'fs:read',
          'net:fetch',
          'proc:spawn',
        ])
        process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`)
      } catch (cause) {
        process.stderr.write(`${describeError(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('run')
    .description('analyse a recorded run file and report which sensor is lying')
    .argument('<file>', 'path to a run document (.json)')
    .option('--json', 'machine-readable output')
    .option('--strict', 'exit non-zero when drift escapes the certified envelope')
    .option('--max-steps <n>', 'cap on reported envelope steps', '4096')
    .action(async (file: string) => {
      let document: unknown
      try {
        document = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'))
      } catch (cause) {
        process.stderr.write(`error: cannot read run file ${file} — ${String(cause)}\n`)
        process.exitCode = 2
        return
      }

      const maxSteps = Number(process.argv[process.argv.indexOf('--max-steps') + 1] ?? '4096')
      const registry = buildToolRegistry()
      try {
        const analysis = (await registry.invoke(
          'analyze_run',
          {
            run: document,
            strict: process.argv.includes('--strict'),
          },
          createContext('cli'),
          ['proc:spawn'],
        )) as RunAnalysis

        if (process.argv.includes('--json')) {
          process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`)
        } else {
          process.stdout.write(renderRun(analysis))
        }
        if (Number.isFinite(maxSteps)) {
          // The engine already caps reported steps; this line exists so the flag is honest
          // about what it did rather than silently ignored.
          if (analysis.truncated) {
            process.stderr.write(
              `note: envelope truncated; raise --max-steps above ${maxSteps} for every step\n`,
            )
          }
        }
        if (process.argv.includes('--strict') && analysis.exceeded) {
          process.exitCode = 1
        }
      } catch (cause) {
        process.stderr.write(`${describeError(cause)}\n`)
        process.exitCode = 1
      }
    })

  program
    .command('version')
    .description('print version and runtime information as JSON')
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            name: 'odometry-scope',
            version: VERSION,
            node: process.versions.node,
            platform: process.platform,
            tools: buildToolRegistry().size,
          },
          null,
          2,
        )}\n`,
      )
    })

  return program
}
