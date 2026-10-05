/**
 * Migrations are numbered, ordered, and idempotent. Never edit an applied migration —
 * append a new one. `user_version` is the source of truth for the applied prefix.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: [
      `CREATE TABLE IF NOT EXISTS records (
         id         TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS records_kind_idx ON records (kind, updated_at DESC)`,
    ],
  },
  {
    version: 2,
    name: 'full_text',
    up: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
         id UNINDEXED, body, tokenize = 'porter unicode61'
       )`,
    ],
  },
  {
    version: 3,
    name: 'columnar_runs',
    up: [
      // One row per run: the metadata a listing needs, without touching a sample buffer.
      `CREATE TABLE IF NOT EXISTS runs (
         id           TEXT PRIMARY KEY,
         name         TEXT NOT NULL,
         summary      TEXT NOT NULL,
         rate_hz      REAL NOT NULL,
         sample_count INTEGER NOT NULL,
         duration_s   REAL,
         path_length  REAL,
         source       TEXT NOT NULL,
         created_at   INTEGER NOT NULL,
         updated_at   INTEGER NOT NULL
       )`,
      // The columnar store. One row per (run, channel); every sample buffer is a packed
      // little-endian Float64Array of exactly `n` values, so a channel is a linear sweep
      // and not `n` objects to walk. Missing optional series are NULL, never zero-filled.
      `CREATE TABLE IF NOT EXISTS pose_columns (
         run_id  TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
         channel TEXT NOT NULL,
         n       INTEGER NOT NULL,
         t       BLOB,
         x       BLOB,
         y       BLOB,
         theta   BLOB,
         v       BLOB,
         omega   BLOB,
         PRIMARY KEY (run_id, channel)
       )`,
      `CREATE INDEX IF NOT EXISTS pose_columns_run_idx ON pose_columns (run_id)`,
      // The verdict the product is allowed to state about the run. `first_exceedance` is
      // genuinely nullable: a certified run has no exceedance step, and 0 is a real index.
      `CREATE TABLE IF NOT EXISTS run_verdicts (
         run_id          TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
         severity        TEXT NOT NULL,
         confidence      TEXT NOT NULL,
         bound_ratio     REAL NOT NULL,
         max_observed    REAL NOT NULL,
         max_bound       REAL NOT NULL,
         dominant_sensor TEXT,
         first_exceedance INTEGER,
         recorded_at     INTEGER NOT NULL
       )`,
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export function pendingMigrations(current: number): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
