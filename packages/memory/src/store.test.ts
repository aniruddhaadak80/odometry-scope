import { describe, expect, it } from 'vitest'
import { Store } from './store.js'
import { LATEST_VERSION, pendingMigrations } from './migrations.js'

describe('Store', () => {
  it('migrates an empty database to the latest version', () => {
    const store = new Store()
    expect(store.version).toBe(LATEST_VERSION)
    expect(store.isPending).toBe(false)
    store.close()
  })

  it('is idempotent — migrating twice changes nothing', () => {
    const store = new Store()
    store.migrate()
    expect(store.migrate()).toBe(LATEST_VERSION)
    expect(pendingMigrations(LATEST_VERSION)).toHaveLength(0)
    store.close()
  })

  it('reports its schema for doctor without disturbing version or pending state', () => {
    const store = new Store()
    const status = store.status()
    expect(status.version).toBe(LATEST_VERSION)
    expect(status.latest).toBe(LATEST_VERSION)
    expect(status.isPending).toBe(false)
    expect(status.pending).toHaveLength(0)
    expect(status.applied.map((m) => m.version)).toEqual([1, 2, 3])
    expect(store.hasTable('runs')).toBe(true)
    expect(store.hasTable('pose_columns')).toBe(true)
    expect(store.hasTable('run_verdicts')).toBe(true)
    expect(store.hasTable('nope')).toBe(false)
    store.close()
  })

  it('round-trips a record', () => {
    const store = new Store()
    store.put({ id: 'a', kind: 'note', payload: { text: 'hello' }, now: 1 })
    expect(store.get('a')?.payload).toBe('{"text":"hello"}')
    store.close()
  })

  it('updates in place rather than duplicating', () => {
    const store = new Store()
    store.put({ id: 'a', kind: 'note', payload: { v: 1 }, now: 1 })
    store.put({ id: 'a', kind: 'note', payload: { v: 2 }, now: 2 })
    expect(store.list('note')).toHaveLength(1)
    expect(store.get('a')?.payload).toBe('{"v":2}')
    store.close()
  })

  it('finds records with full-text search', () => {
    const store = new Store()
    store.put({ id: 'a', kind: 'note', payload: { text: 'alpha beta' }, now: 1 })
    store.put({ id: 'b', kind: 'note', payload: { text: 'gamma delta' }, now: 2 })
    expect(store.search('alpha').map((r) => r.id)).toEqual(['a'])
    store.close()
  })

  it('rolls a failed transaction back completely', () => {
    const store = new Store()
    expect(() =>
      store.transaction(() => {
        store.put({ id: 'x', kind: 'note', payload: {}, now: 1 })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.get('x')).toBeUndefined()
    store.close()
  })
})
