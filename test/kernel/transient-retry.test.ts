import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/kernel/db.js';
import { listDeadLetters } from '../../src/kernel/dlq.js';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { chainEvents } from '../../src/kernel/events.js';
import { chainJobViews, jobStateLabel } from '../../src/kernel/inspect.js';
import { processDelivery } from '../../src/kernel/process-delivery.js';
import { claimNext, createChain, getChain, getJob, recordResult, transientRetryDelayMs } from '../../src/kernel/queue.js';
import { reapExpired } from '../../src/kernel/reaper.js';
import { StaleDeliveryError } from '../../src/kernel/types.js';
import type { Job, KernelDeps } from '../../src/kernel/types.js';
import { registerWorker } from '../../src/kernel/workers.js';
import { PolicyStore } from '../../src/policy/store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import { makeEchoEngine } from '../support/echo-engine.js';

const T0 = 1_700_000_000_000;
const LEASE = 60_000;
const NETWORK = new Error("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com");

function setup(o: { maxTransientRetries?: number; maxDeliveries?: number } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  registerWorker(db, { id: 'w1', pid: 1, pgid: 1, startTime: 0, host: 'test' }, T0);
  const engine = makeEchoEngine('echo');
  const engines = new EngineRegistry();
  engines.register(engine);
  const fake = new FakeRunner();
  const runners = new RunnerRegistry();
  runners.register(fake);
  const policies = new PolicyStore([
    { id: 'echo-default', kind: 'echo', match: { labels: [] }, runner: 'fake', config: {}, default: true },
  ]);
  let now = T0;
  const deps: KernelDeps = {
    db,
    engines,
    runners,
    policies,
    clock: () => now,
    config: {
      leaseMs: LEASE,
      heartbeatMs: 1_000,
      maxDeliveries: o.maxDeliveries ?? 3,
      ...(o.maxTransientRetries === undefined ? {} : { maxTransientRetries: o.maxTransientRetries }),
    },
  };
  const chain = createChain(
    db,
    { engine: 'echo', subjectKey: 's1', engineState: { count: 0 }, firstJob: { type: 'echo', attempt: 1, policyId: 'echo-default' } },
    T0,
  ).chain;
  const claim = (): Job | null => claimNext(db, 'w1', now, LEASE);
  const run = (job: Job) => processDelivery(deps, job, 'w1', new AbortController().signal);
  return { db, deps, engine, fake, chain, claim, run, setNow: (n: number) => (now = n), now: () => now };
}

describe('transient failures', () => {
  it('requeues with delays 15, 30, 60, 120, 240 and then caps at 300 seconds', async () => {
    const s = setup({ maxTransientRetries: 8 });
    s.engine.workspace.prepare = async () => {
      throw NETWORK;
    };
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const job = s.claim();
      expect(job, `claim ${i}`).not.toBeNull();
      expect(await s.run(job!)).toBe('retry_scheduled');
      const after = getJob(s.db, job!.id);
      expect(after).toMatchObject({ status: 'queued', claimedBy: null, leaseExpiresAt: null, transientRetries: i + 1 });
      delays.push(after.availableAt! - s.now());
      s.setNow(after.availableAt!);
    }
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(getChain(s.db, s.chain.id).status).toBe('active');
    expect(listDeadLetters(s.db)).toEqual([]);
  });

  it('records job.retry_scheduled with reason, delay and count', async () => {
    const s = setup();
    s.engine.workspace.prepare = async () => {
      throw NETWORK;
    };
    await s.run(s.claim()!);
    const ev = chainEvents(s.db, s.chain.id).find((e) => e.kind === 'job.retry_scheduled')!;
    expect(ev.detail).toMatchObject({ delayMs: 15_000, count: 1 });
    expect(String(ev.detail.reason)).toContain('workspace prepare failed');
    expect(String(ev.detail.reason)).toContain('Could not resolve host');
  });

  it('does not claim the job before available_at and claims it afterwards', async () => {
    const s = setup();
    s.engine.workspace.prepare = async () => {
      throw NETWORK;
    };
    const job = s.claim()!;
    await s.run(job);
    const at = getJob(s.db, job.id).availableAt!;
    expect(claimNextAt(s, at - 1)).toBeNull();
    const again = claimNextAt(s, at);
    expect(again).toMatchObject({ id: job.id, delivery: 2, availableAt: null });
  });

  it('leaves maxDeliveries untouched: success after two transient failures, and the reaper budget', async () => {
    const s = setup({ maxDeliveries: 2 });
    let failures = 2;
    const prepare = s.engine.workspace.prepare.bind(s.engine.workspace);
    s.engine.workspace.prepare = async (c, j) => {
      if (failures-- > 0) throw NETWORK;
      return prepare(c, j);
    };
    s.fake.script('echo', [{ value: 'a' }, { value: 'b' }]);
    for (let i = 0; i < 2; i++) {
      const job = s.claim()!;
      expect(await s.run(job)).toBe('retry_scheduled');
      s.setNow(getJob(s.db, job.id).availableAt!);
    }
    const job = s.claim()!;
    expect(job).toMatchObject({ delivery: 3, transientRetries: 2 });
    // Delivery 3 with maxDeliveries 2: the two retried deliveries are free, so a lease expiry requeues.
    const r = reapExpired(s.db, { now: s.now() + LEASE + 1, maxDeliveries: 2, isAlive: () => false, groupProbe: () => false });
    expect(r.requeued).toEqual([job.id]);
    const fourth = claimNextAt(s, s.now() + LEASE + 2)!;
    expect(fourth.delivery).toBe(4);
    const r2 = reapExpired(s.db, { now: s.now() + 3 * LEASE, maxDeliveries: 2, isAlive: () => false, groupProbe: () => false });
    expect(r2.deadLettered).toEqual([job.id]);
  });

  it('completes the chain step after retries and keeps the delivery budget', async () => {
    const s = setup();
    let failures = 2;
    const prepare = s.engine.workspace.prepare.bind(s.engine.workspace);
    s.engine.workspace.prepare = async (c, j) => {
      if (failures-- > 0) throw NETWORK;
      return prepare(c, j);
    };
    s.fake.script('echo', [{ value: 'a' }]);
    for (let i = 0; i < 2; i++) {
      const job = s.claim()!;
      await s.run(job);
      s.setNow(getJob(s.db, job.id).availableAt!);
    }
    const job = s.claim()!;
    expect(await s.run(job)).toBe('succeeded');
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'succeeded', transientRetries: 2, delivery: 3 });
  });

  it('dead-letters after maxTransientRetries with the transient error as the reason', async () => {
    const s = setup({ maxTransientRetries: 2 });
    s.engine.workspace.prepare = async () => {
      throw NETWORK;
    };
    for (let i = 0; i < 2; i++) {
      const job = s.claim()!;
      expect(await s.run(job)).toBe('retry_scheduled');
      s.setNow(getJob(s.db, job.id).availableAt!);
    }
    const job = s.claim()!;
    expect(await s.run(job)).toBe('dead_lettered');
    const [dl] = listDeadLetters(s.db);
    expect(dl).toMatchObject({ reason: 'runner_error', jobId: job.id });
    expect(dl!.error).toContain('transient_retries_exhausted');
    expect(dl!.error).toContain('Could not resolve host');
    expect(getChain(s.db, s.chain.id).status).toBe('dead_lettered');
    expect(s.engine.calls.surfaced).toHaveLength(1);
  });

  it('retries a transient onJobStart failure and ignores a permanent one', async () => {
    const s = setup();
    s.engine.onJobStart = async () => {
      throw new Error('error connecting to api.github.com');
    };
    const job = s.claim()!;
    expect(await s.run(job)).toBe('retry_scheduled');
    expect(s.fake.calls).toHaveLength(0);

    const p = setup();
    p.engine.onJobStart = async () => {
      throw new Error('label does not exist');
    };
    p.fake.script('echo', [{ value: 'a' }]);
    expect(await p.run(p.claim()!)).toBe('succeeded');
  });

  it('cleans up the failed delivery and rejects its late writes', async () => {
    const s = setup();
    s.engine.workspace.prepare = async () => {
      throw NETWORK;
    };
    const job = s.claim()!;
    await s.run(job);
    expect(s.engine.calls.cleanup).toHaveLength(1);
    const next = claimNextAt(s, getJob(s.db, job.id).availableAt!)!;
    expect(() => recordResult(s.db, { jobId: job.id, delivery: job.delivery }, { value: 'late' })).toThrow(StaleDeliveryError);
    expect(next.delivery).toBe(job.delivery + 1);
  });

  it('still dead-letters a permanent failure immediately', async () => {
    const s = setup();
    s.engine.workspace.prepare = async () => {
      throw new Error("fatal: couldn't find remote ref refs/heads/nope");
    };
    expect(await s.run(s.claim()!)).toBe('dead_lettered');
    expect(listDeadLetters(s.db)[0]).toMatchObject({ reason: 'runner_error' });
    expect(chainEvents(s.db, s.chain.id).some((e) => e.kind === 'job.retry_scheduled')).toBe(false);
  });

  it('still dead-letters an invalid result immediately', async () => {
    const s = setup();
    s.fake.script('echo', [{ wrong: 1 }]);
    expect(await s.run(s.claim()!)).toBe('dead_lettered');
    expect(getJob(s.db, 1).transientRetries).toBe(0);
  });

  it('shows a waiting job as retrying instead of queued', async () => {
    const s = setup();
    s.engine.workspace.prepare = async () => {
      throw NETWORK;
    };
    const job = s.claim()!;
    await s.run(job);
    const [view] = chainJobViews(s.db, s.chain.id, s.now());
    expect(jobStateLabel(view!, s.now())).toBe('retrying (attempt 1, in 15s)');
    expect(jobStateLabel(view!, view!.availableAt!)).toBe('queued');
  });
});

function claimNextAt(s: ReturnType<typeof setup>, at: number): Job | null {
  return claimNext(s.db, 'w1', at, LEASE);
}

describe('retry backoff and migration', () => {
  it('transientRetryDelayMs doubles from 15s and caps at 300s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(transientRetryDelayMs)).toEqual([15, 30, 60, 120, 240, 300, 300, 300].map((n) => n * 1000));
  });

  it('adds available_at and transient_retries to a database created before them, idempotently', () => {
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chain_id INTEGER NOT NULL, type TEXT NOT NULL, attempt INTEGER NOT NULL,
      status TEXT NOT NULL, policy_id TEXT NOT NULL, payload TEXT, result TEXT, claimed_by TEXT,
      lease_expires_at INTEGER, delivery INTEGER NOT NULL DEFAULT 0, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.prepare(
      `INSERT INTO jobs (chain_id, type, attempt, status, policy_id, created_at, updated_at) VALUES (1, 'x', 1, 'queued', 'p', 1, 2)`,
    ).run();
    migrate(db);
    migrate(db);
    const cols = (db.pragma('table_info(jobs)') as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'available_at' || c === 'transient_retries')).toEqual(['available_at', 'transient_retries']);
    expect(db.prepare('SELECT available_at, transient_retries FROM jobs').get()).toEqual({ available_at: null, transient_retries: 0 });
  });
});
