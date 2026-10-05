import type Database from 'better-sqlite3';
import { recordEvent } from './events.js';

type Db = Database.Database;

const DRAIN_KEY = 'drain';

/** Whether the drain flag is set: while it is, `claimNext` claims nothing. */
export function isDraining(db: Db): boolean {
  return db.prepare('SELECT 1 FROM control WHERE key = ?').get(DRAIN_KEY) !== undefined;
}

/** Sets the drain flag. Idempotent: a second call keeps `updated_at`. Returns whether it was newly set. */
export function startDrain(db: Db, now: number): boolean {
  return db.transaction((): boolean => {
    const r = db.prepare(`INSERT INTO control (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO NOTHING`).run(DRAIN_KEY, now);
    if (r.changes === 0) return false;
    recordEvent(db, { at: now, chainId: 0, kind: 'drain.started', engine: 'kernel' });
    return true;
  }).immediate();
}

/** Clears the drain flag. Returns whether it was set. */
export function stopDrain(db: Db, now: number): boolean {
  return db.transaction((): boolean => {
    const r = db.prepare('DELETE FROM control WHERE key = ?').run(DRAIN_KEY);
    if (r.changes === 0) return false;
    recordEvent(db, { at: now, chainId: 0, kind: 'drain.resumed', engine: 'kernel' });
    return true;
  }).immediate();
}
