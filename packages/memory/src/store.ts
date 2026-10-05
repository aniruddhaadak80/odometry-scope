import Database from 'better-sqlite3'
import { MIGRATIONS, LATEST_VERSION, pendingMigrations } from './migrations.js'

export interface RecordRow {
  id: string
  kind: string
  payload: string
  created_at: number
  updated_at: number
}

export interface MigrationRef {
  readonly version: number
  readonly name: string
}

/** What `doctor` reports: where the file is, and what is still owed to it. */
export interface StoreStatus {
  readonly version: number
  readonly latest: number
  readonly isPending: boolean
  readonly applied: readonly MigrationRef[]
  readonly pending: readonly MigrationRef[]
  readonly tables: readonly string[]
}

/**
 * Every write goes through `transaction()`. No ad-hoc db.exec outside it — that rule is
 * what makes concurrent writers safe and makes a failed write leave no partial state.
 */
export class Store {
  readonly #db: Database.Database

  constructor(path = ':memory:') {
    this.#db = new Database(path)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('foreign_keys = ON')
    this.migrate()
  }

  get version(): number {
    return (this.#db.pragma('user_version', { simple: true }) as number) ?? 0
  }

  get isPending(): boolean {
    return pendingMigrations(this.version).length > 0
  }

  /**
   * The live handle, for the same package only. A caller that writes through it must still
   * wrap the writes in `transaction()` — the handle is exposed so SQL and the transaction
   * stay in one place, not so that atomicity becomes optional.
   */
  get db(): Database.Database {
    return this.#db
  }

  /** `doctor`-friendly report: applied version, outstanding migrations, tables on disk. */
  status(): StoreStatus {
    const version = this.version
    const refs = (migrations: readonly { version: number; name: string }[]): MigrationRef[] =>
      migrations.map(({ version: v, name }) => ({ version: v, name }))
    const tables = this.#db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[]
    return {
      version,
      latest: LATEST_VERSION,
      isPending: this.isPending,
      applied: refs(MIGRATIONS.filter((m) => m.version <= version)),
      pending: refs(pendingMigrations(version)),
      tables: tables.map((row) => row.name),
    }
  }

  hasTable(name: string): boolean {
    const row = this.#db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { present: number } | undefined
    return row !== undefined
  }

  migrate(): number {
    const from = this.version
    for (const migration of pendingMigrations(from)) {
      this.transaction(() => {
        for (const statement of migration.up) this.#db.exec(statement)
        this.#db.pragma(`user_version = ${migration.version}`)
      })
    }
    return this.version
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)()
  }

  put(record: { id: string; kind: string; payload: unknown; now: number }): void {
    const text = JSON.stringify(record.payload)
    this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO records (id, kind, payload, created_at, updated_at)
           VALUES (@id, @kind, @payload, @now, @now)
           ON CONFLICT(id) DO UPDATE SET
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
        )
        .run({ id: record.id, kind: record.kind, payload: text, now: record.now })

      // FTS5 virtual tables do not support UPSERT (ON CONFLICT), so the index row is
      // replaced explicitly. This is a SQLite limitation, not a style preference.
      this.#db.prepare('DELETE FROM records_fts WHERE id = ?').run(record.id)
      this.#db.prepare('INSERT INTO records_fts (id, body) VALUES (?, ?)').run(record.id, text)
    })
  }

  get(id: string): RecordRow | undefined {
    return this.#db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined
  }

  list(kind: string, limit = 50): readonly RecordRow[] {
    return this.#db
      .prepare('SELECT * FROM records WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
      .all(kind, limit) as RecordRow[]
  }

  search(query: string, limit = 50): readonly RecordRow[] {
    return this.#db
      .prepare(
        `SELECT r.* FROM records_fts f
           JOIN records r ON r.id = f.id
           WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as RecordRow[]
  }

  delete(id: string): boolean {
    return this.transaction(() => {
      const result = this.#db.prepare('DELETE FROM records WHERE id = ?').run(id)
      this.#db.prepare('DELETE FROM records_fts WHERE id = ?').run(id)
      return result.changes > 0
    })
  }

  close(): void {
    this.#db.close()
  }
}

export { LATEST_VERSION, MIGRATIONS }
