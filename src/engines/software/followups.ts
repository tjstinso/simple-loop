import type Database from 'better-sqlite3';
import { GitHostError, type GitHost } from './github.js';
import type { Followup } from './schemas.js';

type Db = Database.Database;

export const FOLLOWUP_LABEL = 'factory:followup';
const DAY_MS = 86_400_000;

export const FOLLOWUPS_DDL = `
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  filed_issue_number INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (job_id, position)
);
CREATE INDEX IF NOT EXISTS followups_unfiled ON followups(job_id) WHERE filed_issue_number IS NULL;
`;

interface FollowupRow {
  id: number;
  job_id: number;
  chain_id: number;
  repo: string;
  issue_number: number;
  position: number;
  title: string;
  body: string;
  filed_issue_number: number | null;
  created_at: number;
}

/**
 * Stores the items of one job's result. Idempotent: `INSERT OR IGNORE` on (job_id, position)
 * means a replay never duplicates rows. Blank-title items are skipped but keep their position
 * (the index in the original list), so markers stay stable. Returns the ids of this job's rows
 * for the stored positions (inserted now or already present).
 */
export function storeFollowups(
  db: Db,
  args: { jobId: number; chainId: number; repo: string; issueNumber: number },
  items: Followup[],
  now: number,
): number[] {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO followups (job_id, chain_id, repo, issue_number, position, title, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const find = db.prepare('SELECT id FROM followups WHERE job_id = ? AND position = ?');
  return db.transaction((): number[] => {
    const ids: number[] = [];
    items.forEach((item, position) => {
      if (item.title.trim() === '') return;
      insert.run(args.jobId, args.chainId, args.repo, args.issueNumber, position, item.title, item.body, now);
      ids.push((find.get(args.jobId, position) as { id: number }).id);
    });
    return ids;
  })();
}

const markerOf = (r: FollowupRow) => `<!-- factory:chain=${r.chain_id} job=${r.job_id} followup=${r.position} -->`;

/**
 * Files one row. Looks for an existing labelled issue carrying the marker first (the crash
 * window between create and record), creates only if none exists, then records the number.
 * Only GitHostError is swallowed (row stays unfiled for the sweep); anything else propagates.
 * Returns true when the row ended up filed.
 */
async function fileRow(db: Db, host: GitHost, r: FollowupRow, beforeCreate?: () => void): Promise<boolean> {
  const record = db.prepare('UPDATE followups SET filed_issue_number = ? WHERE id = ? AND filed_issue_number IS NULL');
  try {
    const marker = markerOf(r);
    let n = await host.findIssueByMarker(r.repo, marker, FOLLOWUP_LABEL);
    if (n === null) {
      beforeCreate?.();
      const body = [r.body, '', `Discovered while working on #${r.issue_number}.`, marker].join('\n');
      n = await host.createIssue(r.repo, { title: r.title, body, labels: [FOLLOWUP_LABEL] });
    }
    record.run(n, r.id);
    return true;
  } catch (e) {
    if (e instanceof GitHostError) return false;
    throw e;
  }
}

/** Files every unfiled row of one job. `beforeCreate` runs before each issue creation (fence check). */
export async function fileFollowups(
  db: Db,
  host: GitHost,
  jobId: number,
  _now?: number,
  beforeCreate?: () => void,
): Promise<void> {
  const rows = db
    .prepare('SELECT * FROM followups WHERE job_id = ? AND filed_issue_number IS NULL ORDER BY position')
    .all(jobId) as FollowupRow[];
  for (const r of rows) await fileRow(db, host, r, beforeCreate);
}

/** Files every unfiled row of any job; returns how many were filed. */
export async function sweepUnfiledFollowups(db: Db, host: GitHost, _now: number): Promise<number> {
  const rows = db
    .prepare('SELECT * FROM followups WHERE filed_issue_number IS NULL ORDER BY id')
    .all() as FollowupRow[];
  let filed = 0;
  for (const r of rows) if (await fileRow(db, host, r)) filed++;
  return filed;
}

/** Deletes FILED rows older than the retention; unfiled rows are never deleted. */
export function pruneFiledFollowups(db: Db, now: number, retentionDays: number): number {
  return db
    .prepare('DELETE FROM followups WHERE filed_issue_number IS NOT NULL AND created_at < ?')
    .run(now - retentionDays * DAY_MS).changes;
}
