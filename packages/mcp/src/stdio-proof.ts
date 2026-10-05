/**
 * A real MCP client, driving the real server over real stdio.
 *
 * This is the proof that the MCP surface works as a protocol rather than as a list of names:
 * it spawns `odoscope mcp serve` as a child process, performs the MCP handshake, lists the
 * tools, and calls `analyze_run` — which reaches the Python engine. It also calls one tool with
 * invalid input to confirm the error envelope survives the round trip.
 *
 * Run it directly:
 *   node packages/mcp/dist/stdio-proof.js
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js')

/** The planted defect, so the assertion below is about the product's actual claim. */
const RUN_ID = 'wheel-scale-drift'

function line(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  process.stdout.write(`${label.padEnd(26)} ${text}\n`)
}

export async function main(): Promise<number> {
  if (!process.argv[1]?.includes('stdio-proof')) {
    // Imported rather than run directly.
    return 0
  }

  const runPath = join(REPO_ROOT, 'apps', 'web', 'data', 'runs', `${RUN_ID}.json`)
  const run = JSON.parse(readFileSync(runPath, 'utf8'))

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    stderr: 'inherit',
  })

  const client = new Client(
    { name: 'odometry-scope-stdio-proof', version: '0.1.0' },
    {
      capabilities: {},
    },
  )

  process.stdout.write('connecting to `odoscope mcp serve` over stdio\n')
  await client.connect(transport)
  line('handshake', 'initialize + initialized complete')

  const serverInfo = client.getServerVersion()
  line('server', `${serverInfo?.name ?? 'unknown'} v${serverInfo?.version ?? '?'}`)

  const { tools } = await client.listTools()
  line('tools/list', `${tools.length} tools: ${tools.map((tool) => tool.name).join(', ')}`)

  if (tools.length < 5) {
    process.stderr.write(`FAIL: the MCP contract requires at least 5 tools, got ${tools.length}\n`)
    await client.close()
    return 1
  }

  // A real tool call that reaches the Python engine and returns a verdict.
  const analysis = (await client.callTool({
    name: 'analyze_run',
    arguments: { run },
  })) as { isError?: boolean; content: { type: string; text: string }[] }

  if (analysis.isError === true) {
    process.stderr.write(`FAIL: analyze_run returned an error: ${analysis.content[0]?.text}\n`)
    await client.close()
    return 1
  }

  const parsed = JSON.parse(analysis.content[0]?.text ?? '{}') as {
    verdict: { severity: string; confidence: string; dominantSensor: string | null }
    maxObserved: number
    maxBound: number
    attribution: { sensor: string; verdict: string; explainedFraction: number }[]
  }

  line('tools/call analyze_run', `${parsed.verdict.severity} / ${parsed.verdict.confidence}`)
  line('  peak observed', `${parsed.maxObserved.toFixed(4)} m`)
  line('  certified bound', `${parsed.maxBound.toFixed(4)} m`)
  for (const entry of parsed.attribution) {
    line(`  ablation ${entry.sensor}`, `${entry.verdict} (${(entry.explainedFraction * 100).toFixed(1)}%)`)
  }

  if (parsed.verdict.dominantSensor !== 'wheel') {
    process.stderr.write(
      `FAIL: expected the wheel to be named for ${RUN_ID}, got ${parsed.verdict.dominantSensor}\n`,
    )
    await client.close()
    return 1
  }

  // The error envelope, over the wire.
  const bad = (await client.callTool({
    name: 'engine_divergence',
    arguments: { estimate: 'not-a-track' },
  })) as { isError?: boolean; content: { text: string }[] }

  line('tools/call invalid', `isError=${bad.isError === true} · ${bad.content[0]?.text?.slice(0, 80)}`)
  if (bad.isError !== true) {
    process.stderr.write('FAIL: invalid input was not reported as an error\n')
    await client.close()
    return 1
  }

  await client.close()
  process.stdout.write('\nMCP stdio proof passed.\n')
  return 0
}

process.exitCode = await main()
