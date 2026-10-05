#!/usr/bin/env node
// Every command in the README must be a real npm script or a real binary. This is the
// anti-rot gate: it is what stops documentation from describing a product that no longer
// exists the way the docs claim.
//
// The check is deliberately inverted — it looks for lines that LOOK like commands and
// verifies those, rather than flagging every unknown first word. Flagging unknown words
// turns every prose line inside a fence into a false positive.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const README = join(ROOT, 'README.md')

if (!existsSync(README)) {
  console.log('check:readme-commands — no README.md, skipping')
  process.exit(0)
}

function manifestPaths() {
  const roots = [join(ROOT, 'package.json')]
  for (const dir of ['packages', 'apps']) {
    const base = join(ROOT, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = join(base, entry.name, 'package.json')
      if (existsSync(nested)) roots.push(nested)
    }
  }
  return roots
}

/** Every npm script name defined anywhere in the workspace. */
function allScripts() {
  const names = new Set()
  for (const manifest of manifestPaths()) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      for (const name of Object.keys(pkg.scripts ?? {})) names.add(name)
    } catch {
      /* a malformed manifest is a typecheck failure, not a readme failure */
    }
  }
  return names
}

/** Every binary any workspace package declares in "bin" — the project CLIs. */
function allBins() {
  const bins = new Set()
  for (const manifest of manifestPaths()) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const bin = pkg.bin
      if (typeof bin === 'string') bins.add(bin)
      else if (bin && typeof bin === 'object') for (const name of Object.keys(bin)) bins.add(name)
    } catch {
      /* handled above */
    }
  }
  return bins
}

/**
 * Pair fences by scanning lines, so a closing fence can never be mistaken for an opening
 * one. Only explicitly shell-tagged blocks are treated as command blocks.
 */
function shellBlocks(markdown) {
  const SHELL = new Set(['bash', 'sh', 'shell', 'console', 'zsh'])
  const blocks = []
  let buffer = null
  let lang = ''

  for (const line of markdown.split('\n')) {
    const fence = /^\s*```([A-Za-z0-9]*)\s*$/.exec(line)
    if (fence === null) {
      if (buffer !== null) buffer.push(line)
      continue
    }
    if (buffer === null) {
      buffer = []
      lang = fence[1].toLowerCase()
    } else {
      if (SHELL.has(lang)) blocks.push(buffer.join('\n'))
      buffer = null
      lang = ''
    }
  }
  return blocks
}

const scripts = allScripts()
const bins = allBins()
const markdown = readFileSync(README, 'utf8')
const problems = []
let commandsChecked = 0

for (const block of shellBlocks(markdown)) {
  for (const raw of block.split('\n')) {
    const line = raw.trim().replace(/^\$\s+/, '')
    if (line === '' || line.startsWith('#')) continue

    // Strict rule: an npm script that does not exist anywhere in the workspace.
    // This is the rot this gate exists to catch — a command that was renamed or removed
    // while the README kept telling people to run it.
    const npmRun = /^npm\s+run\s+([A-Za-z0-9:._-]+)/.exec(line)
    if (npmRun) {
      commandsChecked += 1
      if (!scripts.has(npmRun[1])) {
        problems.push({
          line,
          why: `"${npmRun[1]}" is not an npm script in any workspace package`,
        })
      }
      continue
    }

    // A declared project CLI must actually be referenced. This catches a renamed binary,
    // which no other rule here would notice.
    const first = /^([A-Za-z0-9_.-]+)\s+\S/.exec(line)
    if (first !== null && bins.has(first[1])) commandsChecked += 1

    // Everything else — known binaries, prose, piped output, JSON — is intentionally not
    // policed. Flagging unknown first words turns prose into false positives, and a gate
    // that cries wolf gets ignored.
  }
}

// Every declared bin must appear in the README at least once.
for (const bin of bins) {
  if (!markdown.includes(bin)) {
    problems.push({
      line: `(no reference to "${bin}")`,
      why: `"${bin}" is declared as a bin but never appears in README.md`,
    })
  }
}

if (problems.length > 0) {
  console.error(`check:readme-commands FAILED — ${problems.length} problem(s) in README.md`)
  for (const problem of problems) {
    console.error(`  ${problem.line}`)
    console.error(`    ${problem.why}`)
    console.error('    fix: run it and paste the real output, or remove the line')
  }
  process.exit(1)
}

console.log(
  `check:readme-commands — clean (${commandsChecked} command(s) verified, ` +
    `${scripts.size} scripts and ${bins.size} bins known)`,
)
