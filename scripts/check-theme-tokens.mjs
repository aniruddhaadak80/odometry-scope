#!/usr/bin/env node
// The highest-value visual gate. apps/web/styles/tokens.css is the only file permitted to
// contain raw colour literals; anywhere else is a violation. This is what stops a codebase
// drifting into forty slightly different greys.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const WEB = join(ROOT, 'apps', 'web')
const TOKENS_REL = join('styles', 'tokens.css')

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', 'coverage', '.turbo', 'test-results'])
const EXTS = new Set(['.css', '.tsx', '.ts', '.jsx', '.js', '.mjs'])

// Matches #abc, #aabbcc, #aabbccdd, rgb(), rgba(), hsl(), hsla()
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

function walk(dir, out = []) {
  if (!readdirSyncSafe(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function readdirSyncSafe(dir) {
  try {
    readdirSync(dir)
    return true
  } catch {
    return false
  }
}

if (!readdirSyncSafe(WEB)) {
  console.log('check:theme-tokens — apps/web not present, skipping')
  process.exit(0)
}

const tokensPath = join(WEB, TOKENS_REL)
if (!readdirSyncSafe(tokensPath) && !existsFile(tokensPath)) {
  console.error('check:theme-tokens FAILED — apps/web/styles/tokens.css is missing')
  console.error('  fix: tokens.css is the single source of colour truth and must exist.')
  process.exit(1)
}

function existsFile(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

const violations = []

for (const file of walk(WEB)) {
  if (!EXTS.has(extname(file))) continue
  const rel = relative(WEB, file).split(sep).join('/')
  if (rel === TOKENS_REL.split(sep).join('/')) continue

  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!RAW_COLOUR.test(line)) continue
    // Allow colour inside a comment explaining the rule, and inside gradients of tokens only.
    violations.push({ rel, line: i + 1, text: line.trim().slice(0, 100) })
  }
}

if (violations.length > 0) {
  console.error(`check:theme-tokens FAILED — ${violations.length} raw colour literal(s) outside tokens.css`)
  for (const v of violations) {
    console.error(`  apps/web/${v.rel}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    fix: reference a CSS custom property from apps/web/styles/tokens.css`)
  }
  process.exit(1)
}

console.log('check:theme-tokens — clean (tokens.css is the only source of colour)')
