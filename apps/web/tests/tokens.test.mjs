import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { test } from 'node:test'

const WEB = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1')
const TOKENS_REL = join('styles', 'tokens.css')
const TOKENS = join(WEB, TOKENS_REL)
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      out.push(...walk(full))
    } else {
      out.push(full)
    }
  }
  return out
}

test('tokens.css defines both themes', () => {
  const css = readFileSync(TOKENS, 'utf8')
  assert.match(css, /:root\s*{/)
  // Quote-agnostic: prettier normalises attribute-selector quotes, so pinning either style
  // makes this test fail on formatting alone.
  assert.match(css, /\[data-theme=['"]dark['"]\]/)
})

test('tokens.css is the only file containing raw colour literals', () => {
  const offenders = []
  for (const file of walk(WEB)) {
    if (!['.css', '.tsx', '.ts'].includes(extname(file))) continue
    if (relative(WEB, file) === TOKENS_REL) continue
    if (RAW_COLOUR.test(readFileSync(file, 'utf8'))) offenders.push(relative(WEB, file).split(sep).join('/'))
  }
  assert.deepEqual(offenders, [], `raw colour literals outside tokens.css: ${offenders.join(', ')}`)
})
