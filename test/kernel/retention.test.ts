import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/kernel/db.js';
import { deadLetter, discardDeadLetter } from '../../src/kernel/dlq.js';
import { claimNext, createChain } from '../../src/kernel/queue.js';
import { pruneHistory } from '../../src/kernel/retention.js';
import { markChildExited, recordChild, registerWorker } from '../../src/kernel/workers.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const first = { type: 'build', attempt: 1, policyId: 'p', payload: {} };

function mk() {
  const db = openDb(':memory:');
  migrate(db);
  registerWorker(db, { id: 'w1', pid: 1, pgid: 1, startTime: 0, host: 'h' }, 0);
  let n = 0;
  /** A claimed job (so a child process or dead letter can reference it). */
  const job = () => {
    const key = `k${n++}`;
    createChain(db, { engine: 'e', subjectKey: key, engineState: {}, firstJob: first }, 1);
    return claimNext(db, 'w1', 2, 1_000_000_000)!;
  };
  /** A child of a fresh job, exited at `exitedAt` (or still live when null). */
  const child = (exitedAt: number | null) => {
    const j = job();
    const id = recordChild(db, { workerId: 'w1', jobId: j.id, delivery: j.delivery, pid: 10, pgid: 10, startTime: 0 }, 3);
    if (exitedAt !== null) markChildExited(db, id, 0, exitedAt);
    return id;
  };
  /** A dead letter created at `createdAt`, resolved at `resolvedAt` (or unresolved when null). */
  const dl = (createdAt: number, resolvedAt: number | null) => {
    const j = job();
    deadLetter(db, { jobId: j.id, reason: 'runner_error', error: 'x' }, createdAt);
    if (resolvedAt !== null) discardDeadLetter(db, j.id, resolvedAt);
    return j.id;
  };
  const childIds = () => (db.prepare('SELECT id FROM child_processes ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  const dlJobIds = () => (db.prepare('SELECT job_id FROM dead_letters ORDER BY id').all() as { job_id: number }[]).map((r) => r.job_id);
  return { db, child, dl, childIds, dlJobIds };
}

describe('pruneHistory', () => {
  it('prunes exited child_processes older than retention', () => {
    const t = mk();
    t.child(NOW - 31 * DAY);
    const recent = t.child(NOW - 29 * DAY);
    expect(pruneHistory(t.db, NOW, 30).childProcesses).toBe(1);
    expect(t.childIds()).toEqual([recent]);
  });

  it('never prunes child_processes that have not exited', () => {
    const t = mk();
    const live = t.child(null);
    t.db.prepare('UPDATE child_processes SET started_at = 0').run(); // ancient, but still live
    expect(pruneHistory(t.db, NOW, 30).childProcesses).toBe(0);
    expect(t.childIds()).toEqual([live]);
  });

  it('keeps child_processes exactly at the cut-off', () => {
    const t = mk();
    const edge = t.child(NOW - 30 * DAY);
    t.child(NOW - 30 * DAY - 1);
    pruneHistory(t.db, NOW, 30);
    expect(t.childIds()).toEqual([edge]);
  });

  it('prunes resolved dead letters older than retention, measured from resolution', () => {
    const t = mk();
    t.dl(1, NOW - 31 * DAY); // old resolution: pruned
    const freshlyResolved = t.dl(1, NOW - 1 * DAY); // ancient creation, recent resolution: kept
    const edge = t.dl(1, NOW - 30 * DAY); // exactly at the cut-off: kept
    pruneHistory(t.db, NOW, 30);
    expect(t.dlJobIds()).toEqual([freshlyResolved, edge]);
  });

  it('never prunes unresolved dead letters however old', () => {
    const t = mk();
    const open = t.dl(0, null);
    expect(pruneHistory(t.db, NOW, 30).deadLetters).toBe(0);
    expect(t.dlJobIds()).toEqual([open]);
  });

  it('returns the number of rows deleted per table', () => {
    const t = mk();
    t.child(NOW - 40 * DAY);
    t.child(NOW - 50 * DAY);
    t.child(NOW - 1 * DAY);
    t.dl(1, NOW - 60 * DAY);
    t.dl(1, null);
    expect(pruneHistory(t.db, NOW, 30)).toEqual({ childProcesses: 2, deadLetters: 1 });
    expect(pruneHistory(t.db, NOW, 30)).toEqual({ childProcesses: 0, deadLetters: 0 });
  });

  it('rejects a zero, negative or non-finite retention', () => {
    const t = mk();
    t.child(NOW - 40 * DAY);
    t.dl(1, NOW - 60 * DAY);
    for (const bad of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => pruneHistory(t.db, NOW, bad)).toThrow(RangeError);
    }
    expect(t.childIds()).toHaveLength(1);
    expect(t.dlJobIds()).toHaveLength(1);
  });
});
