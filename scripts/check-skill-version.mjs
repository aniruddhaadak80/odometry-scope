#!/usr/bin/env node
// A SKILL.md body change without a metadata.version bump means the update is never
// offered to users — these files ship into agent directories. Fail the build instead.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SKILLS = join(ROOT, 'skills')

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function listSkills(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, 'SKILL.md'))
    .filter((f) => existsSync(f))
}

function versionOf(source) {
  const match = /^\s*version:\s*["']?([^"'\s#]+)["']?/m.exec(source)
  return match ? match[1] : null
}

const files = listSkills(SKILLS)
if (files.length === 0) {
  console.log('check:skill-version — no skills found, nothing to gate')
  process.exit(0)
}

const head = git(['rev-parse', '--verify', 'HEAD'])
if (head === null) {
  console.log('check:skill-version — no git HEAD yet (fresh repo), skipping the diff')
  process.exit(0)
}

const failures = []

for (const file of files) {
  const current = readFileSync(file, 'utf8')
  const relative = file
    .slice(ROOT.length + 1)
    .split('\\')
    .join('/')

  const previous = git(['show', `HEAD:${relative}`])
  if (previous === null) continue

  if (previous === current) continue

  const before = versionOf(previous)
  const after = versionOf(current)
  if (before === after) {
    failures.push(
      `  ${relative}` +
        `\n    body changed but metadata.version stayed at ${before ?? '(absent)'}` +
        `\n    fix: bump metadata.version`,
    )
  }
}

if (failures.length > 0) {
  console.error(`check:skill-version FAILED — ${failures.length} skill(s) changed without a version bump`)
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

console.log(`check:skill-version — ${files.length} skills, all version bumps present`)
