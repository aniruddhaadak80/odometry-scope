#!/usr/bin/env node
// Catches the junk that makes a public repository look abandoned: stray logs, editor
// directories, committed caches, oversized binaries, and leftover TODOs in source.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

const JUNK_FILES = [
  { match: /^\.DS_Store$/, why: 'macOS metadata' },
  { match: /^Thumbs\.db$/, why: 'Windows thumbnail cache' },
  { match: /\.log$/, why: 'log output' },
  { match: /\.tmp$/, why: 'temporary file' },
  { match: /~$/, why: 'editor backup' },
  { match: /^(run|error|debug)\.out$/, why: 'stray output file' },
]

const JUNK_DIRS = [
  { match: /^__pycache__$/, why: 'Python bytecode cache' },
  { match: /^\.pytest_cache$/, why: 'pytest cache' },
  { match: /^\.ruff_cache$/, why: 'ruff cache' },
  { match: /^\.mypy_cache$/, why: 'mypy cache' },
  { match: /^\.turbo$/, why: 'turbo cache' },
  { match: /^\.venv$/, why: 'virtualenv' },
  { match: /^playwright-report$/, why: 'Playwright report' },
  { match: /^test-results$/, why: 'Playwright results' },
]

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.turbo',
  'test-results',
  'playwright-report',
])

const MAX_FILE_BYTES = 1024 * 1024
const TODO_IN_SOURCE = /\b(TODO|FIXME|XXX|HACK):/

const findings = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    const rel = relative(ROOT, full).split(sep).join('/')

    if (stats.isDirectory()) {
      for (const rule of JUNK_DIRS) {
        if (rule.match.test(entry)) {
          findings.push({ rel, why: `${rule.why} — remove it and add it to .gitignore` })
        }
      }
      walk(full)
      continue
    }

    for (const rule of JUNK_FILES) {
      if (rule.match.test(entry)) findings.push({ rel, why: rule.why })
    }

    if (stats.size > MAX_FILE_BYTES && !/\.(png|jpe?g|gif|webp|ico|woff2?|mp4|zip|pdf)$/i.test(entry)) {
      findings.push({ rel, why: `${Math.round(stats.size / 1024)} KB, over the 1 MB non-asset limit` })
    }

    if (/\.(ts|tsx|js|mjs|py)$/.test(entry) && rel.startsWith('src') === false && rel.includes('src/')) {
      const lines = readFileSync(full, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (TODO_IN_SOURCE.test(lines[i])) {
          findings.push({ rel: `${rel}:${i + 1}`, why: `leftover ${lines[i].trim().slice(0, 60)}` })
        }
      }
    }
  }
}

walk(ROOT)

if (findings.length > 0) {
  console.error(`check:public-hygiene FAILED — ${findings.length} issue(s)`)
  for (const f of findings) console.error(`  ${f.rel} — ${f.why}`)
  console.error('\n  fix: remove the file, or gitignore the pattern.')
  process.exit(1)
}

console.log('check:public-hygiene — clean')
