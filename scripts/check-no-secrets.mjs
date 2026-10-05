#!/usr/bin/env node
// Fails on committed credentials. Deliberately conservative: it reports file, line, and the
// pattern that matched, and never prints the matched value.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'test-results',
  'playwright-report',
])

const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'Stripe live key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  {
    name: 'assigned secret',
    re: /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^"'\s${\n]{8,}["']/i,
  },
  { name: 'bearer header', re: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i },
]

const SKIP_FILE = /(?:\.example|\.template|\.sample|\.dist)$/i

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else if (stats.size < 2 * 1024 * 1024) out.push(full)
  }
  return out
}

const findings = []

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join('/')

  // A tracked .env with any assignment at all is a failure.
  if (/(^|\/)\.env(\..+)?$/.test(rel) && !SKIP_FILE.test(rel)) {
    const source = readFileSync(file, 'utf8')
    const assigned = source
      .split('\n')
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line) && !/=$/.test(line))
    if (assigned.length > 0) {
      findings.push({ rel, line: 0, name: `.env with values (${assigned.length} assignment(s))` })
    }
    continue
  }

  if (SKIP_FILE.test(rel)) continue
  if (
    ![
      '.ts',
      '.tsx',
      '.js',
      '.mjs',
      '.cjs',
      '.py',
      '.json',
      '.yaml',
      '.yml',
      '.sh',
      '.md',
      '.css',
      '.env',
    ].some((e) => rel.endsWith(e))
  )
    continue

  // Skip this gate itself — it contains the patterns it searches for.
  if (rel.endsWith(join('scripts', 'check-no-secrets.mjs'))) continue

  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (re.test(lines[i])) {
        findings.push({ rel, line: i + 1, name })
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`check:no-secrets FAILED — ${findings.length} potential secret(s)`)
  for (const f of findings) {
    console.error(`  ${f.rel}${f.line > 0 ? `:${f.line}` : ''} — ${f.name}`)
  }
  console.error('\n  fix: remove the value, and rotate it if it was ever real.')
  process.exit(1)
}

console.log('check:no-secrets — clean')
