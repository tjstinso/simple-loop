import { describe, expect, it } from 'vitest';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { migrate, openDb } from '../../src/kernel/db.js';
import { deadLetter, listDeadLetters } from '../../src/kernel/dlq.js';
import { claimNext, getChain, getJob } from '../../src/kernel/queue.js';
import type { ChainView, Job } from '../../src/kernel/types.js';
import { makeEchoEngine } from '../support/echo-engine.js';
import { createKernel } from '../../src/kernel/kernel.js';
import { PolicyStore } from '../../src/policy/store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';

function fakeRunners(): RunnerRegistry {
  const r = new RunnerRegistry();
  r.register(new FakeRunner()); // the echo policies name runner 'fake' (validated by createKernel)
  return r;
}

const base = () => ({
  engines: new EngineRegistry(),
  runners: fakeRunners(),
  policies: new PolicyStore([]),
  clock: () => 1,
  config: { leaseMs: 1, heartbeatMs: 1, maxDeliveries: 1 },
});

describe('createKernel', () => {
  it('createKernel with an existing db uses that handle and close() does not close it', () => {
    const db = openDb(':memory:');
    migrate(db, []);
    const kernel = createKernel({ db, ...base() });
    expect(kernel.deps.db).toBe(db);
    kernel.close();
    expect(db.open).toBe(true);
    expect(db.prepare('SELECT 1 AS x').get()).toEqual({ x: 1 });
    db.close();
  });

  it('createKernel with a dbPath opens its own handle and close() closes it', () => {
    const kernel = createKernel({ dbPath: ':memory:', ...base() });
    kernel.close();
    expect(kernel.deps.db.open).toBe(false);
  });
});

describe('Kernel.retryDeadLetter', () => {
  function setup(afterRetry?: (chain: ChainView<any>, job: Job) => Promise<void>) {
    const db = openDb(':memory:');
    migrate(db, []);
    const engine = makeEchoEngine('echo');
    if (afterRetry) engine.afterRetry = afterRetry;
    const engines = new EngineRegistry();
    engines.register(engine);
    const policies = new PolicyStore([
      { id: 'echo-default', kind: 'echo', match: { labels: [] }, runner: 'fake', config: {}, default: true },
    ]);
    let now = 1_000;
    const kernel = createKernel({ ...base(), db, engines, policies, clock: () => now });
    const deadLettered = async () => {
      const { chain, job } = await kernel.enqueue('echo', { key: 'k' });
      claimNext(db, 'w1', now, 60_000);
      deadLetter(db, { jobId: job.id, reason: 'runner_error', error: 'boom' }, now);
      now = 2_000;
      return { chain, job };
    };
    return { db, kernel, deadLettered, close: () => db.close() };
  }

  it('Kernel.retryDeadLetter re-queues the job and calls the engine afterRetry hook', async () => {
    const seen: Array<{ chain: ChainView<any>; job: Job }> = [];
    const s = setup(async (chain, job) => {
      seen.push({ chain, job });
    });
    const { chain, job } = await s.deadLettered();
    const retried = await s.kernel.retryDeadLetter(job.id);
    expect(retried).toMatchObject({ id: job.id, status: 'queued', delivery: 1, error: null, result: null });
    expect(getChain(s.db, chain.id).status).toBe('active');
    expect(listDeadLetters(s.db)).toEqual([expect.objectContaining({ jobId: job.id, resolvedAt: 2_000 })]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.chain).toEqual({ id: chain.id, engine: 'echo', subjectKey: 'echo:k', status: 'active', state: { count: 0 } });
    expect(seen[0]!.job).toEqual(retried);
    s.close();
  });

  it('Kernel.retryDeadLetter keeps the retry when the hook throws', async () => {
    let calls = 0;
    const s = setup(async () => {
      calls++;
      throw new Error('hook failed');
    });
    const { chain, job } = await s.deadLettered();
    const retried = await s.kernel.retryDeadLetter(job.id);
    expect(calls).toBe(1);
    expect(retried).toMatchObject({ id: job.id, status: 'queued' });
    expect(getJob(s.db, job.id).status).toBe('queued');
    expect(getChain(s.db, chain.id).status).toBe('active');
    expect(listDeadLetters(s.db, { unresolved: true })).toEqual([]);
    s.close();
  });

  it('Kernel.retryDeadLetter reports a hook error to deps.onError and keeps the retry', async () => {
    const boom = new Error('hook failed');
    const s = setup(async () => {
      throw boom;
    });
    const reported: Array<{ err: unknown; context: string }> = [];
    s.kernel.deps.onError = (err, context) => reported.push({ err, context });
    const { job } = await s.deadLettered();
    await s.kernel.retryDeadLetter(job.id);
    expect(reported).toEqual([{ err: boom, context: `afterRetry for job ${job.id}` }]);
    expect(getJob(s.db, job.id).status).toBe('queued');
    s.close();
  });
});

describe('Kernel.cancelChain and discardDeadLetter', () => {
  function setup() {
    const db = openDb(':memory:');
    migrate(db, []);
    const engine = makeEchoEngine('echo');
    const seen: Array<{ chain: ChainView<any>; job?: Job }> = [];
    engine.afterCancel = async (chain, job) => {
      seen.push({ chain, job });
    };
    const engines = new EngineRegistry();
    engines.register(engine);
    const policies = new PolicyStore([
      { id: 'echo-default', kind: 'echo', match: { labels: [] }, runner: 'fake', config: {}, default: true },
    ]);
    const reported: Array<{ err: unknown; context: string }> = [];
    const kernel = createKernel({
      ...base(), db, engines, policies, clock: () => 5_000,
      onError: (err, context) => reported.push({ err, context }),
    });
    return { db, kernel, engine, seen, reported, close: () => db.close() };
  }

  it('Kernel.cancelChain cancels the chain and calls afterCancel with the cancelled chain view', async () => {
    const s = setup();
    const { chain, job } = await s.kernel.enqueue('echo', { key: 'k' });
    await s.kernel.cancelChain(chain.id);
    expect(getChain(s.db, chain.id).status).toBe('cancelled');
    expect(getJob(s.db, job.id).status).toBe('cancelled');
    expect(s.seen).toEqual([
      { chain: { id: chain.id, engine: 'echo', subjectKey: 'echo:k', status: 'cancelled', state: { count: 0 } }, job: undefined },
    ]);
    s.close();
  });

  it('Kernel.cancelChain keeps the cancellation and reports a hook error to onError', async () => {
    const s = setup();
    const boom = new Error('labels failed');
    s.engine.afterCancel = async () => {
      throw boom;
    };
    const { chain } = await s.kernel.enqueue('echo', { key: 'k' });
    await s.kernel.cancelChain(chain.id);
    expect(getChain(s.db, chain.id).status).toBe('cancelled');
    expect(s.reported).toEqual([{ err: boom, context: `afterCancel for chain ${chain.id}` }]);
    s.close();
  });

  it('Kernel.cancelChain rejects (nothing changed, no hook) when a job is running', async () => {
    const s = setup();
    const { chain } = await s.kernel.enqueue('echo', { key: 'k' });
    claimNext(s.db, 'w1', 1, 60_000);
    await expect(s.kernel.cancelChain(chain.id)).rejects.toThrow(/running/);
    expect(getChain(s.db, chain.id).status).toBe('active');
    expect(s.seen).toEqual([]);
    s.close();
  });

  it('Kernel.discardDeadLetter cancels the chain and calls afterCancel with the dead-lettered job', async () => {
    const s = setup();
    const { chain, job } = await s.kernel.enqueue('echo', { key: 'k' });
    claimNext(s.db, 'w1', 1, 60_000);
    deadLetter(s.db, { jobId: job.id, reason: 'runner_error', error: 'boom' }, 2);
    await s.kernel.discardDeadLetter(job.id);
    expect(getChain(s.db, chain.id).status).toBe('cancelled');
    expect(listDeadLetters(s.db, { unresolved: true })).toEqual([]);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.chain.status).toBe('cancelled');
    expect(s.seen[0]!.job).toMatchObject({ id: job.id, status: 'failed' });
    s.close();
  });
});
