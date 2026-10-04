import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { migrate, openDb } from '../../src/kernel/db.js';
import { recordEvent } from '../../src/kernel/events.js';

export const NOW = 1_700_000_000_000;

export interface TempDb {
  db: Database.Database;
  path: string;
  cleanup(): void;
}

export function makeDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  const path = join(dir, 'factory.db');
  const db = openDb(path);
  migrate(db);
  return {
    db,
    path,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function addChain(
  db: Database.Database,
  o: { status: string; phase?: string; issue: number; subjectKey?: string; at?: number; branch?: string },
): number {
  const state = { repo: 'o/r', issueNumber: o.issue, branch: o.branch ?? `factory/issue-${o.issue}`, attempt: 1, phase: o.phase ?? 'executing' };
  const at = o.at ?? NOW - 3_600_000;
  const r = db
    .prepare(`INSERT INTO chains (engine, subject_key, status, engine_state, created_at, updated_at) VALUES ('software', ?, ?, ?, ?, ?)`)
    .run(o.subjectKey ?? `o/r#${o.issue}`, o.status, JSON.stringify(state), at, at);
  return Number(r.lastInsertRowid);
}

export function addJob(
  db: Database.Database,
  chainId: number,
  o: { type?: string; attempt?: number; status: string; worker?: string; lease?: number; delivery?: number; cost?: number; at?: number },
): number {
  const at = o.at ?? NOW - 3_000_000;
  const r = db
    .prepare(
      `INSERT INTO jobs (chain_id, type, attempt, status, policy_id, result, claimed_by, lease_expires_at, delivery, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'p', ?, ?, ?, ?, ?, ?)`,
    )
    .run(chainId, o.type ?? 'execute', o.attempt ?? 1, o.status, o.cost === undefined ? null : JSON.stringify({ costUsd: o.cost }), o.worker ?? null, o.lease ?? null, o.delivery ?? 0, at, at);
  return Number(r.lastInsertRowid);
}

export function addWorker(db: Database.Database, id: string, lastSeenAt: number, job?: { id: number; delivery: number }): void {
  db.prepare(
    `INSERT INTO workers (id, pid, pgid, host, started_at, last_seen_at, current_job_id, current_delivery) VALUES (?, 1, 1, 'h', ?, ?, ?, ?)`,
  ).run(id, NOW - 7_200_000, lastSeenAt, job?.id ?? null, job?.delivery ?? null);
}

export const event = (db: Database.Database, chainId: number, kind: string, at: number, detail: Record<string, unknown> = {}, jobId?: number, delivery?: number) =>
  recordEvent(db, { at, chainId, kind, engine: 'kernel', detail, jobId: jobId ?? null, delivery: delivery ?? null });
