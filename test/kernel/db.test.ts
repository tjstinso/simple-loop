import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/kernel/db.js';

function mk() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const addChain = (db: ReturnType<typeof mk>, key: string, status = 'active') =>
  db
    .prepare(
      `INSERT INTO chains (engine, subject_key, status, engine_state, created_at, updated_at) VALUES ('e', ?, ?, '{}', 0, 0)`,
    )
    .run(key, status);
const addJob = (db: ReturnType<typeof mk>, chainId: number | bigint, type: string, attempt: number) =>
  db
    .prepare(
      `INSERT INTO jobs (chain_id, type, attempt, status, policy_id, payload, created_at, updated_at) VALUES (?, ?, ?, 'queued', 'p', '{}', 0, 0)`,
    )
    .run(chainId, type, attempt);

describe('kernel schema', () => {
  it('sets pragmas', () => {
    const db = mk();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('rejects a second open chain for the same subject_key', () => {
    const db = mk();
    addChain(db, 'o/r#1');
    expect(() => addChain(db, 'o/r#1', 'waiting')).toThrow(/UNIQUE/);
  });

  it('allows a new chain once the previous is completed or cancelled', () => {
    const db = mk();
    addChain(db, 'k1', 'completed');
    addChain(db, 'k1');
    addChain(db, 'k2', 'cancelled');
    addChain(db, 'k2');
    expect(db.prepare('SELECT count(*) c FROM chains').get()).toEqual({ c: 4 });
  });

  it('rejects a duplicate (chain_id, type, attempt) job', () => {
    const db = mk();
    const id = addChain(db, 'k').lastInsertRowid;
    addJob(db, id, 'execute', 1);
    expect(() => addJob(db, id, 'execute', 1)).toThrow(/UNIQUE/);
    addJob(db, id, 'execute', 2);
    addJob(db, id, 'review', 1);
  });

  it('applies extra DDL passed by an engine', () => {
    const db = openDb(':memory:');
    migrate(db, ['CREATE TABLE IF NOT EXISTS followups (id INTEGER PRIMARY KEY, title TEXT)']);
    db.prepare("INSERT INTO followups (title) VALUES ('x')").run();
    expect(db.prepare('SELECT count(*) c FROM followups').get()).toEqual({ c: 1 });
  });

  it('is idempotent when migrated twice', () => {
    const db = mk();
    expect(() => migrate(db)).not.toThrow();
  });
});
