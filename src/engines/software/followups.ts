import type Database from 'better-sqlite3';
import { GitHostError, type GitHost } from './github.js';
import type { Followup } from './schemas.js';

type Db = Database.Database;
/** Applied to agent-written text before it is published (the engine passes the secret redaction). */
export type Redact = (text: string) => string;
const asIs: Redact = (t) => t;

export const FOLLOWUP_LABEL = 'factory:followup';
/** How long a filer owns a row before another may take it over. */
export const FOLLOWUP_CLAIM_TTL_MS = 5 * 60_000;
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
  claimed_until INTEGER,
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
  claimed_until: number | null;
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
 * Files one row. First takes a time-limited claim (an atomic conditional UPDATE) so concurrent
 * filers (the effect, or sweeps on other workers) never act on the same row; a row that is
 * already filed or freshly claimed by someone else is skipped silently. The owner then looks for
 * an existing labelled issue carrying the marker (the crash window between create and record),
 * creates only if none exists, and records the number. Any failure releases the claim; only
 * GitHostError is swallowed (row stays unfiled for the sweep), anything else propagates.
 * Returns true when this call filed the row.
 */
async function fileRow(db: Db, host: GitHost, r: FollowupRow, now: number, beforeCreate?: () => void, redact: Redact = asIs): Promise<boolean> {
  const claimed = db
    .prepare(
      `UPDATE followups SET claimed_until = ?
       WHERE id = ? AND filed_issue_number IS NULL AND (claimed_until IS NULL OR claimed_until < ?)`,
    )
    .run(now + FOLLOWUP_CLAIM_TTL_MS, r.id, now).changes;
  if (claimed !== 1) return false;
  try {
    const marker = markerOf(r);
    let n = await host.findIssueByMarker(r.repo, marker, FOLLOWUP_LABEL);
    if (n === null) {
      beforeCreate?.();
      const body = [redact(r.body), '', `Discovered while working on #${r.issue_number}.`, marker].join('\n');
      n = await host.createIssue(r.repo, { title: redact(r.title), body, labels: [FOLLOWUP_LABEL] });
    }
    db.prepare('UPDATE followups SET filed_issue_number = ?, claimed_until = NULL WHERE id = ?').run(n, r.id);
    return true;
  } catch (e) {
    db.prepare('UPDATE followups SET claimed_until = NULL WHERE id = ? AND filed_issue_number IS NULL').run(r.id);
    if (e instanceof GitHostError) return false;
    throw e;
  }
}

/**
 * Files every unfiled row of one job. `beforeCreate` runs before each issue creation (fence check);
 * `redact` is applied to each title and body before it is published.
 */
export async function fileFollowups(
  db: Db,
  host: GitHost,
  jobId: number,
  now: number,
  beforeCreate?: () => void,
  redact: Redact = asIs,
): Promise<void> {
  const rows = db
    .prepare('SELECT * FROM followups WHERE job_id = ? AND filed_issue_number IS NULL ORDER BY position')
    .all(jobId) as FollowupRow[];
  for (const r of rows) await fileRow(db, host, r, now, beforeCreate, redact);
}

/** Files every unfiled row of any job; returns how many this call filed. */
export async function sweepUnfiledFollowups(db: Db, host: GitHost, now: number, redact: Redact = asIs): Promise<number> {
  const rows = db
    .prepare('SELECT * FROM followups WHERE filed_issue_number IS NULL ORDER BY id')
    .all() as FollowupRow[];
  let filed = 0;
  for (const r of rows) if (await fileRow(db, host, r, now, undefined, redact)) filed++;
  return filed;
}

/** Deletes FILED rows older than the retention; unfiled rows are never deleted. */
export function pruneFiledFollowups(db: Db, now: number, retentionDays: number): number {
  return db
    .prepare('DELETE FROM followups WHERE filed_issue_number IS NOT NULL AND created_at < ?')
    .run(now - retentionDays * DAY_MS).changes;
}
