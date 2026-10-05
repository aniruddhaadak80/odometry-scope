#!/usr/bin/env node
// No package may import another package's deep path. Only declared entry points are legal.
// Without this, a monorepo quietly becomes a single coupled codebase.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PACKAGES_DIR = join(ROOT, 'packages')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.next'])

/** Collect every declared entry point for every workspace package. */
function declaredExports() {
  const allowed = new Map() // package name -> Set(subpaths)

  const manifests = []
  if (existsSync(PACKAGES_DIR)) {
    for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(PACKAGES_DIR, entry.name, 'package.json')
      if (existsSync(manifest)) manifests.push(manifest)
    }
  }
  for (const dir of ['apps']) {
    const base = join(ROOT, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = join(base, entry.name, 'package.json')
      if (existsSync(manifest)) manifests.push(manifest)
    }
  }

  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof pkg.name !== 'string') continue
    const subpaths = new Set(['.'])
    if (pkg.exports && typeof pkg.exports === 'object') {
      for (const key of Object.keys(pkg.exports)) subpaths.add(key)
    }
    allowed.set(pkg.name, subpaths)
  }
  return allowed
}

/** Deep imports look like @scope/pkg/internal/thing — more than one slash after the scope. */
function importsOf(source) {
  const found = []
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1])
  }
  return found
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const allowed = declaredExports()
const violations = []

for (const [name, subpaths] of allowed) {
  const pkgDir = join(PACKAGES_DIR, name.split('/').pop() ?? '', 'src')
  const searchRoots = existsSync(pkgDir) ? [pkgDir] : []
  if (searchRoots.length === 0) continue

  for (const root of searchRoots) {
    for (const file of walk(root)) {
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) continue
      const source = readFileSync(file, 'utf8')

      for (const specifier of importsOf(source)) {
        if (specifier === name) continue
        if (!specifier.startsWith(`${name}/`)) continue

        const subpath = specifier.slice(name.length)
        if (subpaths.has(subpath)) continue

        violations.push({
          file: file
            .slice(ROOT.length + 1)
            .split('\\')
            .join('/'),
          specifier,
          allowed: [...subpaths].join(', '),
        })
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`check:boundaries FAILED — ${violations.length} deep import(s)`)
  for (const v of violations) {
    console.error(`  ${v.file}`)
    console.error(`    imports "${v.specifier}"`)
    console.error(`    allowed entry points for that package: ${v.allowed}`)
    console.error(`    fix: import the package entry point, or add the subpath to its "exports"`)
  }
  process.exit(1)
}

console.log(`check:boundaries — clean (${allowed.size} workspace packages, no deep imports)`)
