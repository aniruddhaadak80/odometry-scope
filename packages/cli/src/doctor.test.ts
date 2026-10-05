import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { doctor, renderReport } from './doctor.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const dirs: string[] = []

/**
 * A throwaway tree with a valid skill. The Python engine and the sample runs are *linked in*
 * from the real repository rather than faked, so the engine probe is testing the actual
 * boundary — a fake would only prove the mock is callable.
 */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'doctor-'))
  dirs.push(root)
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true })
  writeFileSync(
    join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: A valid skill for the doctor test suite.\nmetadata:\n  version: 1.0.0\n---\nBody.\n',
    'utf8',
  )
  // The engine is reached as `python -m odometry_scope` with its cwd inside the tree, so a
  // throwaway tree needs that layout to exist before the probe can succeed. Linking the real
  // source means the probe exercises the actual boundary rather than a stub.
  mkdirSync(join(root, 'services', 'engine'), { recursive: true })
  try {
    symlinkSync(
      join(REPO_ROOT, 'services', 'engine', 'src'),
      join(root, 'services', 'engine', 'src'),
      'junction',
    )
  } catch {
    // Symlinks may be unavailable on this host; the engine row then reports fail and is
    // asserted on directly by the probe tests, which run against REPO_ROOT.
  }
  return root
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('doctor', () => {
  it('passes on a well-formed tree', async () => {
    const report = await doctor(repo())
    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.name === 'skills')?.status).toBe('ok')
  })

  it('fails and names a fix when a skill is invalid', async () => {
    const root = repo()
    mkdirSync(join(root, 'skills', 'broken'), { recursive: true })
    writeFileSync(join(root, 'skills', 'broken', 'SKILL.md'), 'no frontmatter', 'utf8')
    const report = await doctor(root)
    expect(report.ok).toBe(false)
    const skills = report.checks.find((c) => c.name === 'skills')
    expect(skills?.status).toBe('fail')
    expect(skills?.fix).toBeTruthy()
  })

  it('warns rather than fails when config is absent', async () => {
    const report = await doctor(repo())
    expect(report.checks.find((c) => c.name === 'config')?.status).toBe('warn')
  })

  it('probes the engine rather than assuming it is there', async () => {
    const report = await doctor(REPO_ROOT)
    const engine = report.checks.find((c) => c.name === 'python engine')
    expect(engine).toBeDefined()
    // Against the real repository the engine is reachable; the row must say so rather than
    // being omitted, because a missing probe row is indistinguishable from a healthy one.
    expect(engine?.status).toBe('ok')
    expect(engine?.detail).toContain('reachable')
  })

  it('reports the committed sample runs', async () => {
    const report = await doctor(REPO_ROOT)
    const runs = report.checks.find((c) => c.name === 'sample runs')
    expect(runs?.status).toBe('ok')
    expect(runs?.detail).toContain('analysed runs')
  })

  it('renders every check with a status token', async () => {
    const rendered = renderReport(await doctor(repo()))
    expect(rendered).toMatch(/doctor/)
    expect(rendered).toMatch(/[PASS]/)
    expect(rendered).toMatch(/[WARN]/)
  })
})
