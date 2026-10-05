#!/usr/bin/env node
// Bumps the version across every manifest and regenerates the CHANGELOG heading.
// The release workflow owns this — no PR edits a version by hand.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const bump = process.argv[2] ?? 'patch'

if (!['major', 'minor', 'patch'].includes(bump)) {
  console.error(`usage: node scripts/release.mjs <major|minor|patch>`)
  process.exit(2)
}

function bumpVersion(current, kind) {
  const [major = 0, minor = 0, patch = 0] = current.split('.').map((n) => Number.parseInt(n, 10) || 0)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const manifests = [join(ROOT, 'package.json')]
for (const dir of ['packages', 'apps']) {
  const base = join(ROOT, dir)
  if (!existsSync(base)) continue
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(base, entry.name, 'package.json')
    if (existsSync(manifest)) manifests.push(manifest)
  }
}

const rootPkg = JSON.parse(readFileSync(manifests[0], 'utf8'))
const next = bumpVersion(rootPkg.version ?? '0.0.0', bump)

for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  pkg.version = next
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`  ${manifest.slice(ROOT.length + 1)} -> ${next}`)
}

const changelog = join(ROOT, 'CHANGELOG.md')
if (existsSync(changelog)) {
  const source = readFileSync(changelog, 'utf8')
  const today = new Date().toISOString().slice(0, 10)
  const heading = `## [${next}] - ${today}`
  if (!source.includes(heading)) {
    writeFileSync(
      changelog,
      source.replace('## [Unreleased]', `## [Unreleased]\n\n## [${next}] - ${today}`),
      'utf8',
    )
    console.log(`  CHANGELOG.md -> ${heading}`)
  }
}

try {
  execFileSync('git', ['tag', `v${next}`], { cwd: ROOT, stdio: 'inherit' })
  console.log(`\ntagged v${next}`)
} catch {
  console.log(`\nnext: git commit -am "chore(release): v${next}" && git push --follow-tags`)
}
