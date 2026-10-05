import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineBridge } from './bridge.js'

const created: string[] = []

/**
 * The bridge spawns a real process, so a stub has to be a real file. Writing the stub to
 * disk is what makes these genuine integration tests of the spawn/parse/timeout path rather
 * than tests of a mock.
 */
function stubEngine(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-'))
  const file = join(dir, 'engine.py')
  writeFileSync(file, source, 'utf8')
  created.push(dir)
  return file
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ECHO = `
import json, sys
request = json.loads(sys.stdin.read())
op = request["op"]
if op == "echo":
    print(json.dumps({"ok": True, "value": request["input"], "durationMs": 1}))
elif op == "boom":
    print(json.dumps({"ok": False, "error": {"code": "BAD_OP", "message": "no such op"}, "durationMs": 0}))
else:
    print(json.dumps({"ok": False, "error": {"code": "UNKNOWN", "message": op}, "durationMs": 0}))
`

describe('EngineBridge', () => {
  it('round-trips a value through the engine', async () => {
    const response = await new EngineBridge({ enginePath: stubEngine(ECHO) }).invoke({
      op: 'echo',
      input: { a: 1 },
    })
    expect(response.ok).toBe(true)
    expect(response.value).toEqual({ a: 1 })
  })

  it('surfaces an engine error as an upstream failure', async () => {
    const response = await new EngineBridge({ enginePath: stubEngine(ECHO) }).invoke({
      op: 'boom',
      input: null,
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('BAD_OP')
  })

  it('throws UpstreamError from call() when the engine reports a failure', async () => {
    await expect(
      new EngineBridge({ enginePath: stubEngine(ECHO) }).call({ op: 'boom', input: null }),
    ).rejects.toThrowError(/no such op/)
  })

  it('reports a non-zero exit rather than throwing', async () => {
    const response = await new EngineBridge({
      enginePath: stubEngine('import sys; sys.exit(3)'),
    }).invoke({ op: 'echo', input: 1 })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('NONZERO_EXIT')
  })

  it('reports invalid engine output instead of crashing', async () => {
    const response = await new EngineBridge({
      enginePath: stubEngine('print("not json")'),
    }).invoke({ op: 'echo', input: 1 })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('BAD_OUTPUT')
  })

  it('times out a hung engine', async () => {
    const response = await new EngineBridge({
      enginePath: stubEngine('import time; time.sleep(30)'),
      timeoutMs: 400,
    }).invoke({ op: 'echo', input: 1 })
    expect(response.error?.code).toBe('TIMEOUT')
  }, 15_000)
})
