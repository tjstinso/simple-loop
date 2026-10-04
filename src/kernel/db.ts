import Database from 'better-sqlite3';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

const KERNEL_DDL = `
CREATE TABLE IF NOT EXISTS chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','waiting','dead_lettered','completed','cancelled')),
  engine_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS chains_open_subject
  ON chains(subject_key) WHERE status NOT IN ('completed','cancelled');

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  type TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  policy_id TEXT NOT NULL,
  payload TEXT,
  result TEXT,
  claimed_by TEXT,
  lease_expires_at INTEGER,
  delivery INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_chain_type_attempt ON jobs(chain_id, type, attempt);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,
  process_start_time TEXT,
  host TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- The job delivery the worker is processing right now (NULL when idle); the reaper kills a
  -- worker only while it is still on the expired delivery.
  current_job_id INTEGER,
  current_delivery INTEGER
);

CREATE TABLE IF NOT EXISTS child_processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  delivery INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,
  process_start_time TEXT,
  started_at INTEGER NOT NULL,
  exited_at INTEGER,
  exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS child_processes_job ON child_processes(job_id, delivery);

CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  reason TEXT NOT NULL CHECK (reason IN ('runner_error','timeout','max_deliveries','effect_error')),
  error TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  -- Set once the chain's engine surfaced the dead letter; NULL rows are retried by maintenance.
  surfaced_at INTEGER
);
CREATE INDEX IF NOT EXISTS dead_letters_job ON dead_letters(job_id);

-- Append-only log of lifecycle transitions; written only through recordEvent (events.ts).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  job_id INTEGER,
  delivery INTEGER,
  kind TEXT NOT NULL,
  engine TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_chain ON events(chain_id, id);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
`;

export function migrate(db: Database.Database, extra: string[] = []): void {
  db.transaction(() => {
    db.exec(KERNEL_DDL);
    for (const ddl of extra) db.exec(ddl);
  })();
}
