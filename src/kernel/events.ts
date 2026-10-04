import type Database from 'better-sqlite3';

type Db = Database.Database;

/** Longest string kept in an event's `detail`: events are a log of transitions, not of agent output. */
export const EVENT_TEXT_MAX = 200;

export interface NewEvent {
  /** Epoch milliseconds. */
  at: number;
  chainId: number;
  jobId?: number | null;
  delivery?: number | null;
  kind: string;
  /** Who recorded it: `kernel`, or an engine id. */
  engine: string;
  /** Small, structured and already redacted by the caller; strings are capped at 200 characters here. */
  detail?: Record<string, unknown>;
}

export interface EventRow {
  id: number;
  at: number;
  chainId: number;
  jobId: number | null;
  delivery: number | null;
  kind: string;
  engine: string;
  detail: Record<string, unknown>;
}

/** `text` capped at 200 characters, the last one an ellipsis when it was cut. */
export const capEventText = (text: string): string =>
  text.length > EVENT_TEXT_MAX ? `${text.slice(0, EVENT_TEXT_MAX - 1)}…` : text;

function bounded(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return capEventText(v);
  if (Array.isArray(v)) return depth > 2 ? null : v.slice(0, 20).map((x) => bounded(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    if (depth > 2) return null;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bounded(x, depth + 1)]));
  }
  return v;
}

/** The only writer of the append-only `events` table. Call it inside the transaction it describes. */
export function recordEvent(db: Db, e: NewEvent): void {
  db.prepare(
    `INSERT INTO events (at, chain_id, job_id, delivery, kind, engine, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.at, e.chainId, e.jobId ?? null, e.delivery ?? null, e.kind, e.engine, JSON.stringify(bounded(e.detail ?? {})));
}

interface EventDbRow {
  id: number;
  at: number;
  chain_id: number;
  job_id: number | null;
  delivery: number | null;
  kind: string;
  engine: string;
  detail: string;
}

const toEvent = (r: EventDbRow): EventRow => ({
  id: r.id,
  at: r.at,
  chainId: r.chain_id,
  jobId: r.job_id,
  delivery: r.delivery,
  kind: r.kind,
  engine: r.engine,
  detail: JSON.parse(r.detail) as Record<string, unknown>,
});

/** Every event of a chain, oldest first. */
export function chainEvents(db: Db, chainId: number): EventRow[] {
  return (db.prepare('SELECT * FROM events WHERE chain_id = ? ORDER BY id').all(chainId) as EventDbRow[]).map(toEvent);
}

/** The newest `limit` events (optionally of one chain, optionally at or after `since`), oldest first. */
export function recentEvents(db: Db, opts: { since?: number; chainId?: number; limit?: number } = {}): EventRow[] {
  const where: string[] = [];
  const args: number[] = [];
  if (opts.since !== undefined) {
    where.push('at >= ?');
    args.push(opts.since);
  }
  if (opts.chainId !== undefined) {
    where.push('chain_id = ?');
    args.push(opts.chainId);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, opts.limit ?? 50) as EventDbRow[];
  return rows.map(toEvent).reverse();
}
