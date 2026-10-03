import type Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prunes kernel history older than `retentionDays` (spec section 4, Retention).
 * Exited `child_processes` are aged from `exited_at`, resolved `dead_letters`
 * from `resolved_at`. Rows that have not exited, unresolved dead letters, and
 * rows exactly at the cut-off are kept. Returns the rows deleted per table.
 */
export function pruneHistory(
  db: Database.Database,
  now: number,
  retentionDays: number,
): { childProcesses: number; deadLetters: number } {
  if (typeof retentionDays !== 'number' || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new RangeError(`retentionDays must be a positive finite number, got ${String(retentionDays)}`);
  }
  const cutoff = now - retentionDays * DAY_MS;
  return db.transaction(() => ({
    childProcesses: db
      .prepare('DELETE FROM child_processes WHERE exited_at IS NOT NULL AND exited_at < ?')
      .run(cutoff).changes,
    deadLetters: db
      .prepare('DELETE FROM dead_letters WHERE resolved_at IS NOT NULL AND resolved_at < ?')
      .run(cutoff).changes,
  }))();
}
