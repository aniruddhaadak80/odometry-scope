import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The product's identity and the surface manifest, in one typed place. Both the web UI and the
 * health endpoint read from here so a value is never stated twice.
 *
 * An omitted surface carries a `reason`. That field is not decoration: the whole point of
 * choosing a surface set is that the omissions were decisions, and an omission with no stated
 * reason is indistinguishable from unfinished work.
 */
export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped' | 'omitted'
  readonly reason?: string
}

export const PRODUCT = {
  name: 'Odometry Scope',
  slug: 'odometry-scope',
  version: '0.1.0',
  tagline:
    'Re-integrates a robot pose ODE with each sensor ablated in turn, so you can prove which sensor drifted instead of guessing.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'cli',
    title: 'CLI — odoscope',
    summary:
      'The flagship surface. `odoscope run <file>` reads a recorded run and prints the verdict, the envelope and the ablation table. Every other surface is an adapter over the same tools.',
    status: 'shipped',
  },
  {
    id: 'engine',
    title: 'Python deterministic engine',
    summary:
      'RK4 dead-reckoning with step-doubling error control, a random-walk drift envelope and sensor ablation. Pure functions with no clock, network or randomness — which is what makes the bound certifiable.',
    status: 'shipped',
  },
  {
    id: 'mcp-server',
    title: 'MCP server',
    summary:
      'Speaks MCP over stdio and exposes every tool, so another agent can ask "which sensor lied?" without shelling out.',
    status: 'shipped',
  },
  {
    id: 'mcp-client',
    title: 'MCP client',
    summary:
      'Connects to a server over stdio, lists tools and calls one. Used by the contract test that proves the protocol has not regressed.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary:
      'Four real skills loaded from disk: triage-drift, judge-envelope, ingest-recording and prove-a-finding. A body change is gated on a metadata.version bump.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary:
      'Manifests with real code and a genuine capability conflict, so the shadowed plugin is visible through list_plugins rather than hypothetical.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Memory',
    summary:
      'SQLite with WAL and numbered migrations. Runs persist columnar — one packed Float64Array per channel — because every consumer sweeps whole channels linearly.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'Web observatory',
    summary:
      'This app. Server-rendered, renders committed engine output, and imports no workspace package (ADR 0003) so a deploy cannot break with a monorepo build.',
    status: 'shipped',
  },
  {
    id: 'desktop',
    title: 'Desktop shell',
    summary: 'Electron shell that loads the web build. It does not reimplement the UI.',
    status: 'shipped',
  },
  {
    id: 'providers',
    title: 'LLM providers',
    summary: 'No provider adapters ship. Every answer this product gives is computed from the samples.',
    status: 'omitted',
    reason:
      'A model in the loop would make the error envelope unfalsifiable. The one property this product exists to protect is that its verdict is arithmetic, so there is nothing for a model to add that a number cannot.',
  },
  {
    id: 'chat',
    title: 'Chat interface',
    summary: 'No conversational surface.',
    status: 'omitted',
    reason:
      'The output is a verdict plus an envelope plot, not a conversation. A chat box would invite exactly the unsupported confidence the engine is built to refuse.',
  },
]

function packageVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function resolveVersion(): string {
  return packageVersion()
}
