import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDrain } from '../../src/kernel/control.js';
import { migrate, openDb } from '../../src/kernel/db.js';
import { THROTTLE_EVENT_INTERVAL_MS, claimNext, createChain, recordThrottled } from '../../src/kernel/queue.js';
import { registerWorker } from '../../src/kernel/workers.js';

type Db = ReturnType<typeof openDb>;

const NOW = 1_700_000_000_000;
const first = { type: 'build', attempt: 1, policyId: 'p', payload: {} };

const opened: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mk(path = ':memory:') {
  const db = openDb(path);
  opened.push(db);
  migrate(db);
  return db;
}

/** Enqueues a chain; claims it when `run` is set (so it counts as running). */
function job(db: Db, key: string, run: boolean) {
  createChain(db, { engine: 'e', subjectKey: key, engineState: {}, firstJob: first }, NOW);
  if (run) claimNext(db, 'w1', NOW, 1_000_000_000);
}

const events = (db: Db) => (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'job.throttled'`).get() as { n: number }).n;

/** A database at its limit of 1 with one job waiting. */
function blocked(path?: string) {
  const db = mk(path);
  registerWorker(db, { id: 'w1', pid: 1, pgid: 1, startTime: 0, host: 'h' }, 0);
  job(db, 'a', true);
  job(db, 'b', false);
  return db;
}

describe('recordThrottled', () => {
  it('records one event when blocked and returns it only once per interval', () => {
    const db = blocked();
    expect(recordThrottled(db, NOW, 1)).toBe(true);
    expect(recordThrottled(db, NOW + 1_000, 1)).toBe(false);
    expect(events(db)).toBe(1);
    expect(recordThrottled(db, NOW + THROTTLE_EVENT_INTERVAL_MS + 1, 1)).toBe(true);
    expect(events(db)).toBe(2);
  });

  describe('returns false without starting a write transaction', () => {
    const cases: Array<[string, () => { db: Db; limit: number }]> = [
      ['when draining', () => { const db = blocked(); startDrain(db, NOW); return { db, limit: 1 }; }],
      ['below the limit', () => ({ db: blocked(), limit: 2 })],
      ['with nothing queued', () => {
        const db = mk();
        registerWorker(db, { id: 'w1', pid: 1, pgid: 1, startTime: 0, host: 'h' }, 0);
        job(db, 'a', true);
        return { db, limit: 1 };
      }],
      ['after a recent event', () => {
        const db = blocked();
        expect(recordThrottled(db, NOW - 1_000, 1)).toBe(true);
        return { db, limit: 1 };
      }],
    ];
    for (const [name, make] of cases) {
      it(name, () => {
        const { db, limit } = make();
        const before = events(db);
        const tx = vi.spyOn(db, 'transaction');
        expect(recordThrottled(db, NOW, limit)).toBe(false);
        expect(tx).not.toHaveBeenCalled();
        expect(events(db)).toBe(before);
      });
    }
  });

  it('does not wait for another connection holding a read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'throttle-'));
    dirs.push(dir);
    const db = blocked(join(dir, 'q.db'));
    recordThrottled(db, NOW, 1);
    const other = mk(join(dir, 'q.db'));
    other.exec('BEGIN');
    other.prepare('SELECT COUNT(*) FROM jobs').get();
    expect(recordThrottled(db, NOW + 1_000, 1)).toBe(false);
    other.exec('COMMIT');
    expect(events(db)).toBe(1);
  });

  it('still records exactly one event per interval when several connections race', () => {
    const dir = mkdtempSync(join(tmpdir(), 'throttle-'));
    dirs.push(dir);
    const path = join(dir, 'q.db');
    const db = blocked(path);
    const conns = [db, mk(path), mk(path)];
    const results = conns.flatMap((c) => [recordThrottled(c, NOW, 1), recordThrottled(c, NOW + 5, 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(events(db)).toBe(1);
  });

  it('repeats the checks inside the transaction', () => {
    const db = blocked();
    const real = db.transaction.bind(db);
    // Another worker records between the read-only check and the write transaction.
    vi.spyOn(db, 'transaction').mockImplementation(((fn: () => unknown) => {
      db.prepare(`INSERT INTO events (at, chain_id, job_id, kind, engine, detail) SELECT ?, chain_id, id, 'job.throttled', 'kernel', '{}' FROM jobs WHERE status = 'queued' LIMIT 1`).run(NOW);
      return real(fn as () => unknown);
    }) as typeof db.transaction);
    expect(recordThrottled(db, NOW, 1)).toBe(false);
    expect(events(db)).toBe(1);
  });
});
