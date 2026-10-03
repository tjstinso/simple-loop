import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deadLetter, discardDeadLetter, listDeadLetters, retryDeadLetter } from '../../src/kernel/dlq.js';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { processDelivery } from '../../src/kernel/process-delivery.js';
import { createKernel, type Kernel } from '../../src/kernel/kernel.js';
import { DuplicateChainError, claimNext, getChain, getJob, listJobsForChain } from '../../src/kernel/queue.js';
import type { Engine, Job } from '../../src/kernel/types.js';
import { liveChildrenFor } from '../../src/kernel/workers.js';
import { runMaintenance, type WorkerOptions } from '../../src/kernel/worker-loop.js';
import { PolicyStore } from '../../src/policy/store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import type { RunHooks, Runner, RunInput } from '../../src/runner/types.js';
import { makeEchoEngine, type EchoEngine } from '../support/echo-engine.js';

const NOW = 1_700_000_000_000;
const LEASE = 60_000;
const HEARTBEAT = 1_000;

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** A runner named 'fake' whose behaviour each test supplies. */
function customRunner(run: (input: RunInput, signal: AbortSignal, hooks?: RunHooks) => Promise<unknown>): Runner {
  return { name: 'fake', configSchema: z.unknown(), run };
}

/** Rejects with AbortError when the signal fires; never resolves otherwise. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function setup(o: { runner?: Runner; engines?: Engine<any>[]; historyRetentionDays?: number } = {}) {
  const echo = makeEchoEngine('echo');
  const engines = new EngineRegistry();
  engines.register(echo);
  for (const e of o.engines ?? []) engines.register(e);
  const fake = new FakeRunner();
  const runners = new RunnerRegistry();
  runners.register(o.runner ?? fake);
  const policies = new PolicyStore([
    { id: 'echo-default', kind: 'echo', match: { labels: [] }, runner: 'fake', config: {}, default: true },
  ]);
  const kernel = createKernel({
    dbPath: ':memory:',
    engines,
    runners,
    policies,
    clock: () => Date.now(),
    config: {
      leaseMs: LEASE,
      heartbeatMs: HEARTBEAT,
      maxDeliveries: 3,
      ...(o.historyRetentionDays !== undefined ? { historyRetentionDays: o.historyRetentionDays } : {}),
    },
  });
  const db = kernel.deps.db;
  const killGroup = vi.fn<(pgid: number) => void>();
  const errors: { err: unknown; job?: Job }[] = [];
  const start = (opts: WorkerOptions = {}) =>
    kernel.startWorker({
      pollMs: 100,
      maintenanceMs: 600_000,
      killGroup,
      onError: (err, job) => errors.push({ err, job }),
      ...opts,
    });
  const leaseOf = (jobId: number) => getJob(db, jobId).leaseExpiresAt;
  return { kernel, db, echo, fake, killGroup, errors, start, leaseOf };
}

/** Let the worker loop run: flush microtasks and any due timers. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('worker loop', () => {
  let kernels: Kernel[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    kernels = [];
  });
  afterEach(() => {
    for (const k of kernels) k.close();
    vi.useRealTimers();
  });
  const track = <T extends { kernel: Kernel }>(s: T): T => {
    kernels.push(s.kernel);
    return s;
  };

  it('claims queued jobs and processes them until stopped', async () => {
    const s = track(setup());
    s.fake.script('echo', [{ value: 'one' }, { value: 'two' }]);
    const { chain } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start();

    await tick(500);

    expect(getChain(s.db, chain.id)).toMatchObject({ status: 'completed', engineState: { count: 2 } });
    const jobs = listJobsForChain(s.db, chain.id);
    expect(jobs.map((j) => [j.status, j.claimedBy])).toEqual([
      ['succeeded', w.id],
      ['succeeded', w.id],
    ]);
    expect(s.echo.notes).toEqual(['one', 'two']);
    await w.stop();
    await w.done;
    expect(s.errors).toEqual([]);
  });

  it('renews the lease every heartbeatMs while a job runs', async () => {
    let release!: (v: unknown) => void;
    const s = track(
      setup({
        runner: customRunner((_input, signal) =>
          Promise.race([new Promise((r) => (release = r)), untilAborted(signal)]),
        ),
      }),
    );
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start();
    await tick();
    expect(getJob(s.db, job.id).status).toBe('running');

    const seen = [s.leaseOf(job.id)!];
    for (let i = 0; i < 3; i++) {
      await tick(HEARTBEAT);
      seen.push(s.leaseOf(job.id)!);
    }
    expect(seen[0]).toBe(NOW + LEASE);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1] + HEARTBEAT);
    const workerRow = s.db.prepare('SELECT last_seen_at FROM workers WHERE id = ?').get(w.id) as {
      last_seen_at: number;
    };
    expect(workerRow.last_seen_at).toBe(NOW + 3 * HEARTBEAT);

    release({ value: 'done' });
    await tick();
    expect(getJob(s.db, job.id).status).toBe('succeeded');
    await w.stop();
  });

  it('aborts the run and kills children when a lease renewal fails', async () => {
    let runSignal: AbortSignal | undefined;
    const s = track(
      setup({
        runner: customRunner((_input, signal, hooks) => {
          runSignal = signal;
          hooks?.onSpawn?.({ pid: 4242, pgid: 4242, startTime: 0 });
          // A misbehaving runner: rejects on abort but never reports the child's exit.
          return untilAborted(signal);
        }),
      }),
    );
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start();
    await tick();
    const claimed = getJob(s.db, job.id);
    expect(claimed.delivery).toBe(1);
    expect(liveChildrenFor(s.db, job.id, 1)).toHaveLength(1);

    // Someone else now owns the job: the fence is stale.
    s.db.prepare("UPDATE jobs SET delivery = delivery + 1, claimed_by = 'other' WHERE id = ?").run(job.id);
    await tick(HEARTBEAT);

    expect(runSignal?.aborted).toBe(true);
    expect(s.killGroup).toHaveBeenCalledWith(4242);
    expect(liveChildrenFor(s.db, job.id, 1)).toEqual([]);
    const after = getJob(s.db, job.id);
    expect(after).toMatchObject({ status: 'running', result: null, delivery: 2, claimedBy: 'other' });
    expect(s.echo.calls.transition).toHaveLength(0);

    await w.stop();
    // Stop must not requeue a delivery whose lease was lost.
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'running', claimedBy: 'other' });
  });

  it('treats an already expired local deadline as lease loss without renewing', async () => {
    let runSignal: AbortSignal | undefined;
    const s = track(
      setup({
        runner: customRunner((_input, signal) => {
          runSignal = signal;
          return untilAborted(signal);
        }),
      }),
    );
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start();
    await tick();
    const lease = s.leaseOf(job.id)!;

    // The machine was suspended: wall clock jumps past the lease without timers firing.
    vi.setSystemTime(NOW + LEASE + 5_000);
    await tick(HEARTBEAT);

    expect(runSignal?.aborted).toBe(true);
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'running', leaseExpiresAt: lease, delivery: 1 });
    await w.stop();
    expect(getJob(s.db, job.id).status).toBe('running'); // left for the reaper
  });

  it('stop() aborts the current run, kills its children and requeues the job immediately', async () => {
    let runSignal: AbortSignal | undefined;
    const s = track(
      setup({
        runner: customRunner((_input, signal, hooks) => {
          runSignal = signal;
          hooks?.onSpawn?.({ pid: 777, pgid: 777, startTime: 0 });
          return untilAborted(signal);
        }),
      }),
    );
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start();
    await tick();
    expect(getJob(s.db, job.id).status).toBe('running');

    await w.stop();
    await w.done;

    expect(runSignal?.aborted).toBe(true);
    expect(s.killGroup).toHaveBeenCalledWith(777);
    expect(liveChildrenFor(s.db, job.id, 1)).toEqual([]);
    expect(getJob(s.db, job.id)).toMatchObject({
      status: 'queued',
      leaseExpiresAt: null,
      claimedBy: null,
      delivery: 1,
      result: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() requeues anyway when the delivery does not settle within stopTimeoutMs', async () => {
    const s = track(
      setup({
        runner: customRunner((_input, _signal, hooks) => {
          hooks?.onSpawn?.({ pid: 888, pgid: 888, startTime: 0 });
          return new Promise(() => {}); // ignores the abort entirely
        }),
      }),
    );
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start({ stopTimeoutMs: 2_000 });
    await tick();

    let stopped = false;
    void w.stop().then(() => (stopped = true));
    await tick(1_999);
    expect(stopped).toBe(false);
    await tick(1);
    expect(stopped).toBe(true);
    expect(s.killGroup).toHaveBeenCalledWith(888);
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'queued', leaseExpiresAt: null, delivery: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs the reaper on an interval', async () => {
    const s = track(setup());
    s.fake.script('echo', [{ value: 'one' }, { value: 'two' }]);
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    // A crashed worker holds the job with a short lease.
    claimNext(s.db, 'ghost', NOW, 1_000);
    const w = s.start({ maintenanceMs: 5_000 });

    await tick(4_900);
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'running', claimedBy: 'ghost', delivery: 1 });

    await tick(100); // maintenance requeues it
    await tick(200); // the worker claims and processes it
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'succeeded', claimedBy: w.id, delivery: 2 });
    await w.stop();
  });

  it('runs engine sweeps on the maintenance interval and survives a throwing sweep', async () => {
    const sweptA: number[] = [];
    const boom = new Error('sweep failed');
    const a: EchoEngine = Object.assign(makeEchoEngine('a'), {
      sweep: async (now: number) => {
        sweptA.push(now);
      },
    });
    const b: EchoEngine = Object.assign(makeEchoEngine('b'), {
      sweep: async () => {
        throw boom;
      },
    });
    const c: EchoEngine = Object.assign(makeEchoEngine('c'), {
      sweep: async (now: number) => {
        sweptA.push(-now);
      },
    });
    const s = track(setup({ engines: [a, b, c] }));
    const w = s.start({ maintenanceMs: 5_000 });

    await tick(5_000);
    await tick(5_000);

    expect(sweptA).toEqual([NOW + 5_000, -(NOW + 5_000), NOW + 10_000, -(NOW + 10_000)]);
    expect(s.errors).toEqual([
      { err: boom, job: undefined },
      { err: boom, job: undefined },
    ]);
    await w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runMaintenance reaps expired jobs and runs sweeps', async () => {
    const swept: number[] = [];
    const a = Object.assign(makeEchoEngine('a'), { sweep: async (now: number) => void swept.push(now) });
    const s = track(setup({ engines: [a] }));
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    claimNext(s.db, 'ghost', NOW, 1_000);
    vi.setSystemTime(NOW + 2_000);

    await runMaintenance(s.kernel.deps);

    expect(getJob(s.db, job.id)).toMatchObject({ status: 'queued', delivery: 1 });
    expect(swept).toEqual([NOW + 2_000]);
  });

  it('maintenance prunes history after reaping and before engine sweeps', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let s!: ReturnType<typeof setup>;
    const seen: Array<{ children: number; deadLetters: number }> = [];
    const a = Object.assign(makeEchoEngine('a'), {
      sweep: async () => {
        seen.push({
          children: (s.db.prepare('SELECT COUNT(*) AS n FROM child_processes').get() as { n: number }).n,
          deadLetters: (s.db.prepare('SELECT COUNT(*) AS n FROM dead_letters').get() as { n: number }).n,
        });
      },
    });
    s = track(setup({ engines: [a] }));
    const old = await s.kernel.enqueue('echo', { key: 'old' });
    const reaped = await s.kernel.enqueue('echo', { key: 'reaped' });
    claimNext(s.db, 'ghost', NOW, 1_000);
    claimNext(s.db, 'ghost', NOW, 1_000);
    s.db.prepare('UPDATE jobs SET delivery = 3 WHERE id = ?').run(reaped.job.id); // the reaper dead-letters it
    s.db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?').run(NOW + 100 * DAY, old.job.id);
    s.db
      .prepare("INSERT INTO workers (id, pid, pgid, process_start_time, host, started_at, last_seen_at) VALUES ('w', 1, 1, '0', 'h', 0, 0)")
      .run();
    s.db
      .prepare('INSERT INTO child_processes (worker_id, job_id, delivery, pid, pgid, started_at, exited_at) VALUES (?, ?, 1, 1, 1, 0, 1)')
      .run('w', old.job.id);
    s.db
      .prepare("INSERT INTO dead_letters (job_id, chain_id, reason, error, created_at, resolved_at) VALUES (?, ?, 'timeout', 'x', 0, 1)")
      .run(old.job.id, old.chain.id);
    vi.setSystemTime(NOW + 60 * DAY);

    await runMaintenance(s.kernel.deps);

    // The reaper's own dead letter exists (reaping ran first) and survives; the old rows are gone before the sweep.
    expect(getJob(s.db, reaped.job.id).status).toBe('failed');
    expect(seen).toEqual([{ children: 0, deadLetters: 1 }]);
  });

  it('a pruning error is reported to onError and does not stop the engine sweeps', async () => {
    const swept: number[] = [];
    const a = Object.assign(makeEchoEngine('a'), { sweep: async (now: number) => void swept.push(now) });
    const s = track(setup({ engines: [a], historyRetentionDays: Number.NaN }));
    const errors: Array<{ err: unknown; job?: Job }> = [];

    await runMaintenance(s.kernel.deps, { onError: (err, job) => errors.push({ err, job }) });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.err).toBeInstanceOf(RangeError);
    expect(swept).toHaveLength(1);
  });

  it('maintenance surfaces a reaper dead letter through the engine and survives a surfacing error', async () => {
    const s = track(setup());
    const surfaced: Array<{ chainId: number; state: unknown; jobId: number; reason: string }> = [];
    const boom = new Error('surface failed');
    const first = await s.kernel.enqueue('echo', { key: 'a' });
    const second = await s.kernel.enqueue('echo', { key: 'b' });
    s.echo.surfaceDeadLetter = async (chain, dl) => {
      if (chain.id === first.chain.id) throw boom;
      surfaced.push({ chainId: chain.id, state: chain.state, jobId: dl.jobId, reason: dl.reason });
    };
    claimNext(s.db, 'ghost', NOW, 1_000);
    claimNext(s.db, 'ghost', NOW, 1_000);
    s.db.prepare('UPDATE jobs SET delivery = 3').run(); // the third delivery of each job
    vi.setSystemTime(NOW + 2_000);
    const errors: Array<{ err: unknown; job?: Job }> = [];

    await runMaintenance(s.kernel.deps, { onError: (err, job) => errors.push({ err, job }) });

    expect(getJob(s.db, first.job.id).status).toBe('failed');
    expect(getJob(s.db, second.job.id).status).toBe('failed');
    // The first job's surfacing error is reported and does not stop the second.
    expect(errors).toHaveLength(1);
    expect((errors[0]!.err as Error).message).toContain('surface failed');
    expect(errors[0]!.job).toMatchObject({ id: first.job.id });
    expect(surfaced).toEqual([{ chainId: second.chain.id, state: { count: 0 }, jobId: second.job.id, reason: 'max_deliveries' }]);
  });

  it('a failed surfacing is retried by the next maintenance and then marked', async () => {
    const s = track(setup());
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    claimNext(s.db, 'w1', NOW, LEASE);
    let fail = true;
    let attempts = 0;
    s.echo.surfaceDeadLetter = async (_chain, dl) => {
      attempts++;
      if (fail) throw new Error('502 bad gateway');
      s.echo.calls.surfaced.push(dl);
    };
    // A delivery dead-letters the job; its own surfacing fails.
    s.fake.script('echo', [new Error('boom')]);
    const reported: string[] = [];
    s.kernel.deps.onError = (_err, context) => reported.push(context);
    await processDelivery(s.kernel.deps, getJob(s.db, job.id), 'w1', new AbortController().signal);
    expect(listDeadLetters(s.db)[0]).toMatchObject({ jobId: job.id, surfacedAt: null });
    expect(reported).toHaveLength(1);

    // Maintenance retries; the host is still failing: the error is reported, the row stays unsurfaced.
    const errors: Array<{ err: unknown; job?: Job }> = [];
    await runMaintenance(s.kernel.deps, { onError: (err, j) => errors.push({ err, job: j }) });
    expect(errors.map((e) => (e.err as Error).message)).toEqual(['502 bad gateway']);
    expect(errors[0]!.job).toMatchObject({ id: job.id });
    expect(listDeadLetters(s.db)[0]!.surfacedAt).toBeNull();

    // The host recovers: the next maintenance surfaces and marks it; later passes leave it alone.
    fail = false;
    vi.setSystemTime(NOW + 5_000);
    await runMaintenance(s.kernel.deps, { onError: (err, j) => errors.push({ err, job: j }) });
    expect(errors).toHaveLength(1);
    expect(s.echo.calls.surfaced.map((d) => d.jobId)).toEqual([job.id]);
    expect(listDeadLetters(s.db)[0]!.surfacedAt).toBe(NOW + 5_000);
    await runMaintenance(s.kernel.deps, { onError: (err, j) => errors.push({ err, job: j }) });
    expect(attempts).toBe(3);
  });

  it("maintenance does not surface a resolved or cancelled chain's dead letter", async () => {
    const s = track(setup());
    const retried = await s.kernel.enqueue('echo', { key: 'r' });
    const discarded = await s.kernel.enqueue('echo', { key: 'd' });
    for (const j of [retried.job, discarded.job]) {
      claimNext(s.db, 'w1', NOW, LEASE);
      deadLetter(s.db, { jobId: j.id, reason: 'runner_error', error: 'x' }, NOW);
    }
    retryDeadLetter(s.db, retried.job.id, NOW);
    discardDeadLetter(s.db, discarded.job.id, NOW);
    const errors: unknown[] = [];
    await runMaintenance(s.kernel.deps, { onError: (err) => errors.push(err) });
    expect(errors).toEqual([]);
    expect(s.echo.calls.surfaced).toEqual([]);
  });

  it('registers itself and records children through RunHooks', async () => {
    let childRows: unknown[] = [];
    const s = track(
      setup({
        runner: customRunner(async (input, _signal, hooks) => {
          hooks?.onSpawn?.({ pid: 31337, pgid: 31337, startTime: 0 });
          if (input.job.id === job.id) childRows = s.db.prepare('SELECT * FROM child_processes').all();
          hooks?.onExit?.(31337, 0);
          return { value: 'x' };
        }),
      }),
    );
    const { job } = await s.kernel.enqueue('echo', { key: 'a' });
    const w = s.start({ id: 'worker-x' });
    expect(w.id).toBe('worker-x');
    await tick();

    const row = s.db.prepare('SELECT * FROM workers WHERE id = ?').get('worker-x') as Record<string, unknown>;
    expect(row).toMatchObject({ id: 'worker-x', pid: process.pid, started_at: NOW });
    expect(childRows).toEqual([
      expect.objectContaining({ worker_id: 'worker-x', job_id: job.id, delivery: 1, pid: 31337, pgid: 31337 }),
    ]);
    const exited = s.db.prepare('SELECT exited_at, exit_code FROM child_processes WHERE job_id = ?').get(job.id);
    expect(exited).toEqual({ exited_at: NOW, exit_code: 0 });
    await w.stop();
  });

  it('stops heartbeating and keeps running when processDelivery throws', async () => {
    const s = track(setup());
    s.fake.script('echo', () => ({ value: 'v' }));
    const first = await s.kernel.enqueue('echo', { key: 'bad' });
    const second = await s.kernel.enqueue('echo', { key: 'good' });
    // Committing the first chain's transition fails with a non-stale database error.
    s.db.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE ON chains WHEN NEW.id = ${first.chain.id}
               BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
    const w = s.start();

    await tick();
    expect(s.errors).toHaveLength(1);
    expect(String(s.errors[0].err)).toMatch(/disk on fire/);
    expect(s.errors[0].job?.id).toBe(first.job.id);

    // The first job is left running and no longer heartbeated.
    const lease = s.leaseOf(first.job.id);
    expect(getJob(s.db, first.job.id)).toMatchObject({ status: 'running', delivery: 1 });
    await tick(HEARTBEAT * 3);
    expect(s.leaseOf(first.job.id)).toBe(lease);

    // The worker kept going: the second chain completed.
    expect(getChain(s.db, second.chain.id).status).toBe('completed');

    // The lease expires; the reaper (bounded by maxDeliveries) takes it from there.
    await tick(LEASE);
    expect(s.leaseOf(first.job.id)).toBe(lease);
    expect(Date.now()).toBeGreaterThan(lease!);
    await w.stop();
  });

  it('stop() is idempotent and does not wait a full poll interval', async () => {
    const s = track(setup());
    const w = s.start({ pollMs: 60_000 });
    await tick(10);

    const p1 = w.stop();
    const p2 = w.stop();
    // No timers are advanced: stop must not depend on the poll timer firing.
    await Promise.all([p1, p2, w.done]);
    await w.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('kernel.enqueue', () => {
  it('enqueue creates a chain and its first job through the engine, and rejects a duplicate open subject', async () => {
    const s = setup();
    try {
      const { chain, job } = await s.kernel.enqueue('echo', { key: 'k1' });
      expect(chain).toMatchObject({ engine: 'echo', subjectKey: 'echo:k1', status: 'active', engineState: { count: 0 } });
      expect(job).toMatchObject({
        chainId: chain.id,
        type: 'echo',
        attempt: 1,
        status: 'queued',
        policyId: 'echo-default',
        delivery: 0,
      });
      await expect(s.kernel.enqueue('echo', { key: 'k1' })).rejects.toBeInstanceOf(DuplicateChainError);
      await expect(s.kernel.enqueue('nope', { key: 'k1' })).rejects.toThrow(/unknown engine/);
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM chains').get()).toEqual({ n: 1 });
    } finally {
      s.kernel.close();
    }
  });
});
