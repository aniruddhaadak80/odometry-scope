import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const builderConfig = readFileSync(fileURLToPath(new URL('../electron-builder.yml', import.meta.url)), 'utf8')

describe('electron-builder configuration', () => {
  it('declares an appId and a product name', () => {
    expect(builderConfig).toMatch(/^appId:\s*\S+/m)
    expect(builderConfig).toMatch(/^productName:\s*\S+/m)
  })

  it('targets all three desktop platforms', () => {
    expect(builderConfig).toMatch(/^mac:/m)
    expect(builderConfig).toMatch(/^win:/m)
    expect(builderConfig).toMatch(/^linux:/m)
  })

  it('does not run npm rebuild, which breaks native modules', () => {
    expect(builderConfig).toMatch(/^npmRebuild:\s*false/m)
  })
})
