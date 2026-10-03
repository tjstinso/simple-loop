import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate, openDb } from '../../src/kernel/db.js';
import { listDeadLetters } from '../../src/kernel/dlq.js';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { processDelivery } from '../../src/kernel/process-delivery.js';
import {
  claimNext,
  createChain,
  getChain,
  getJob,
  listJobsForChain,
  recordResult,
  requeueJob,
} from '../../src/kernel/queue.js';
import { EffectError } from '../../src/kernel/types.js';
import type { Job, KernelDeps } from '../../src/kernel/types.js';
import { registerWorker } from '../../src/kernel/workers.js';
import { PolicyStore } from '../../src/policy/store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import type { Runner } from '../../src/runner/types.js';
import { makeEchoEngine, type EchoEngine, type EchoOptions } from '../support/echo-engine.js';

const NOW = 1_700_000_000_000;
const LEASE = 60_000;

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function setup(o: { echo?: EchoOptions; runner?: Runner; extraEngines?: EchoEngine[] } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  registerWorker(db, { id: 'w1', pid: 1, pgid: 1, startTime: 0, host: 'test' }, NOW);
  const engine = makeEchoEngine('echo', o.echo);
  const engines = new EngineRegistry();
  engines.register(engine);
  for (const e of o.extraEngines ?? []) engines.register(e);
  const fake = new FakeRunner();
  const runners = new RunnerRegistry();
  runners.register(o.runner ?? fake);
  const policies = new PolicyStore([
    { id: 'echo-default', kind: 'echo', match: { labels: [] }, runner: 'fake', config: {}, default: true },
  ]);
  const deps: KernelDeps = {
    db,
    engines,
    runners,
    policies,
    clock: () => NOW,
    config: { leaseMs: LEASE, heartbeatMs: 1_000, maxDeliveries: 3 },
  };
  const addChain = (engineId = 'echo', key = 's1') =>
    createChain(
      db,
      {
        engine: engineId,
        subjectKey: key,
        engineState: { count: 0 },
        firstJob: { type: 'echo', attempt: 1, policyId: 'echo-default' },
      },
      NOW,
    ).chain;
  const claim = (): Job => claimNext(db, 'w1', NOW, LEASE)!;
  return { db, deps, engine, fake, addChain, claim };
}

const signal = () => new AbortController().signal;

describe('processDelivery', () => {
  it('passes the chain view, the job and the fence to runEffect', async () => {
    const seen: any[] = [];
    const s = setup({ echo: { onEffect: (_e, _f, ctx) => { seen.push(ctx); } } });
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'hi' }]);
    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('succeeded');
    expect(seen).toHaveLength(1);
    expect(seen[0].chain).toMatchObject({ id: chain.id, engine: 'echo', state: { count: 0 } });
    expect(seen[0].job).toMatchObject({ id: job.id, delivery: job.delivery });
    expect(seen[0].fence).toMatchObject({ jobId: job.id, delivery: job.delivery });
    expect(typeof seen[0].fence.assertCurrent).toBe('function');
  });

  it('runs a delivery end to end and enqueues the follow-on job only after effects ran', async () => {
    const jobsAtEffect: number[] = [];
    const s = setup({
      echo: {
        onEffect: (_e, fence) => {
          fence.assertCurrent();
          jobsAtEffect.push(listJobsForChain(s.db, chain.id).length);
        },
      },
    });
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'hello' }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('succeeded');

    expect(s.engine.notes).toEqual(['hello']);
    expect(jobsAtEffect).toEqual([1]); // the follow-on did not exist while the effect ran
    expect(s.fake.calls).toHaveLength(1);
    expect(s.fake.calls[0]).toMatchObject({ config: {}, workspace: { path: s.engine.dir } });
    const jobs = listJobsForChain(s.db, chain.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ status: 'succeeded', result: { value: 'hello' } });
    expect(jobs[1]).toMatchObject({ type: 'echo', attempt: 2, status: 'queued', policyId: 'echo-default' });
    expect(getChain(s.db, chain.id)).toMatchObject({ status: 'active', engineState: { count: 1 } });
  });

  it('dead-letters with runner_error when the result fails its schema', async () => {
    const s = setup();
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 42 }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');

    const [dl] = listDeadLetters(s.db);
    expect(dl).toMatchObject({ jobId: job.id, reason: 'runner_error' });
    expect(dl.error).toMatch(/value/);
    expect(s.engine.calls.surfaced).toEqual([dl]);
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'failed', result: null });
    expect(getChain(s.db, chain.id).status).toBe('dead_lettered');
    expect(s.engine.calls.transition).toHaveLength(0);
  });

  it('dead-letters with effect_error when an effect throws and creates no follow-on jobs', async () => {
    const s = setup({
      echo: {
        onEffect: () => {
          throw new Error('push failed');
        },
      },
    });
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');

    const [dl] = listDeadLetters(s.db);
    expect(dl).toMatchObject({ jobId: job.id, reason: 'effect_error' });
    expect(dl.error).toMatch(/push failed/);
    expect(listJobsForChain(s.db, chain.id)).toHaveLength(1);
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'failed', result: { value: 'x' } });
    expect(getChain(s.db, chain.id)).toMatchObject({ status: 'dead_lettered', engineState: { count: 0 } });
    expect(s.engine.calls.surfaced).toHaveLength(1);
  });

  it('skips the runner and resumes post-processing when job.result is already recorded', async () => {
    const s = setup();
    const chain = s.addChain();
    const claimed = s.claim();
    recordResult(s.db, { jobId: claimed.id, delivery: claimed.delivery }, { value: 'prior' });
    const job = getJob(s.db, claimed.id);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('succeeded');

    expect(s.fake.calls).toHaveLength(0);
    expect(s.engine.calls.prepare).toHaveLength(0);
    expect(s.engine.notes).toEqual(['prior']);
    expect(listJobsForChain(s.db, chain.id)).toHaveLength(2);
    expect(s.engine.calls.cleanup).toHaveLength(1);
  });

  it('discards the outcome of a stale delivery and returns stale', async () => {
    const s = setup();
    const chain = s.addChain();
    const old = s.claim();
    expect(requeueJob(s.db, old.id)).toBe(true);
    const fresh = s.claim();
    expect(fresh.delivery).toBe(old.delivery + 1);
    s.fake.script('echo', [{ value: 'late' }]);

    expect(await processDelivery(s.deps, old, 'w1', signal())).toBe('stale');

    expect(getJob(s.db, old.id)).toMatchObject({ status: 'running', delivery: fresh.delivery, result: null });
    expect(listJobsForChain(s.db, chain.id)).toHaveLength(1);
    expect(listDeadLetters(s.db)).toHaveLength(0);
    expect(s.engine.notes).toEqual([]);
    expect(s.engine.calls.cleanup).toHaveLength(1);
  });

  it('does not dead-letter on behalf of a stale delivery', async () => {
    const s = setup();
    s.addChain();
    const old = s.claim();
    requeueJob(s.db, old.id);
    const fresh = s.claim();
    s.fake.script('echo', [{ value: 42 }]);

    expect(await processDelivery(s.deps, old, 'w1', signal())).toBe('stale');

    expect(listDeadLetters(s.db)).toHaveLength(0);
    expect(getJob(s.db, old.id)).toMatchObject({ status: 'running', delivery: fresh.delivery });
    expect(s.engine.calls.surfaced).toHaveLength(0);
  });

  it('returns stale when an effect fence check fails', async () => {
    const s = setup({
      echo: {
        onEffect: (_e, fence) => {
          requeueJob(s.db, fence.jobId);
          claimNext(s.db, 'w2', NOW, LEASE);
          fence.assertCurrent();
        },
      },
    });
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('stale');

    expect(s.engine.notes).toEqual([]);
    expect(listJobsForChain(s.db, chain.id)).toHaveLength(1);
    expect(listDeadLetters(s.db)).toHaveLength(0);
  });

  it('dead-letters with timeout when the runner rejects with reason timeout', async () => {
    const s = setup();
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [Object.assign(new Error('too slow'), { reason: 'timeout' })]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');

    const [dl] = listDeadLetters(s.db);
    expect(dl).toMatchObject({ jobId: job.id, reason: 'timeout' });
    expect(dl.error).toMatch(/too slow/);
  });

  it('dead-letters with runner_error when the runner rejects', async () => {
    const s = setup();
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [new Error('claude crashed')]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');

    expect(listDeadLetters(s.db)[0]).toMatchObject({ reason: 'runner_error', error: expect.stringMatching(/claude crashed/) });
  });

  it('calls cleanup on success and on failure', async () => {
    const ok = setup();
    const c1 = ok.addChain();
    const j1 = ok.claim();
    ok.fake.script('echo', [{ value: 'a' }]);
    expect(await processDelivery(ok.deps, j1, 'w1', signal())).toBe('succeeded');
    expect(ok.engine.calls.cleanup).toEqual([{ chainId: c1.id, jobId: j1.id }]);

    const bad = setup();
    const c2 = bad.addChain();
    const j2 = bad.claim();
    bad.fake.script('echo', [new Error('boom')]);
    expect(await processDelivery(bad.deps, j2, 'w1', signal())).toBe('dead_lettered');
    expect(bad.engine.calls.cleanup).toEqual([{ chainId: c2.id, jobId: j2.id }]);
  });

  it('does not let a throwing cleanup or surfaceDeadLetter change the outcome', async () => {
    const s = setup();
    s.engine.cleanup = async () => {
      throw new Error('cleanup broke');
    };
    s.engine.surfaceDeadLetter = async () => {
      throw new Error('surface broke');
    };
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 1 }]);
    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');
  });

  it("two engines register and each job is dispatched to its chain's engine", async () => {
    const other = makeEchoEngine('other');
    const s = setup({ extraEngines: [other] });
    const ca = s.addChain('echo', 'a');
    const cb = s.addChain('other', 'b');
    const ja = s.claim();
    const jb = s.claim();
    s.fake.script('echo', (input) => ({ value: `job-${input.job.id}` }));

    expect(await processDelivery(s.deps, ja, 'w1', signal())).toBe('succeeded');
    expect(await processDelivery(s.deps, jb, 'w1', signal())).toBe('succeeded');

    expect(s.engine.calls.transition).toEqual([{ chainId: ca.id, jobId: ja.id }]);
    expect(other.calls.transition).toEqual([{ chainId: cb.id, jobId: jb.id }]);
    expect(s.engine.notes).toEqual([`job-${ja.id}`]);
    expect(other.notes).toEqual([`job-${jb.id}`]);
    expect(s.deps.engines.ids().sort()).toEqual(['echo', 'other']);
    expect(() => s.deps.engines.register(makeEchoEngine('other'))).toThrow(/already registered/);
    expect(() => s.deps.engines.get('nope')).toThrow(/unknown engine/);
  });

  it('dead-letters with the reason of an EffectError thrown by transition', async () => {
    const s = setup({
      echo: {
        onTransition: () => {
          throw new EffectError('cannot interpret result', 'runner_error');
        },
      },
    });
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');

    expect(listDeadLetters(s.db)[0]).toMatchObject({ reason: 'runner_error', error: expect.stringMatching(/cannot interpret/) });
    expect(s.engine.calls.effects).toHaveLength(0);
  });

  it('dead-letters with effect_error when transition throws a plain error', async () => {
    const s = setup({
      echo: {
        onTransition: () => {
          throw new Error('bug in transition');
        },
      },
    });
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');
    expect(listDeadLetters(s.db)[0]).toMatchObject({ reason: 'effect_error' });
  });

  it('returns aborted and writes nothing when the signal aborts the run', async () => {
    const s = setup();
    const chain = s.addChain();
    const job = s.claim();
    const ac = new AbortController();
    s.fake.script('echo', () => {
      ac.abort();
      return abortError();
    });

    expect(await processDelivery(s.deps, job, 'w1', ac.signal)).toBe('aborted');

    expect(getJob(s.db, job.id)).toMatchObject({ status: 'running', result: null, delivery: job.delivery });
    expect(getChain(s.db, chain.id).status).toBe('active');
    expect(listDeadLetters(s.db)).toHaveLength(0);
    expect(s.engine.calls.cleanup).toHaveLength(1);
  });

  function expectAbortedUntouched(s: ReturnType<typeof setup>, job: Job) {
    expect(getJob(s.db, job.id)).toMatchObject({ status: 'running', delivery: job.delivery, result: null });
    expect(listDeadLetters(s.db)).toHaveLength(0);
    expect(s.engine.calls.surfaced).toHaveLength(0);
    expect(s.engine.calls.cleanup).toHaveLength(1);
  }

  it('returns aborted and dead-letters nothing when the signal aborts during workspace.prepare', async () => {
    const s = setup();
    const ac = new AbortController();
    s.engine.workspace.prepare = async () => {
      ac.abort();
      throw new Error('prepare interrupted');
    };
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', ac.signal)).toBe('aborted');

    expectAbortedUntouched(s, job);
    expect(s.fake.calls).toHaveLength(0);
  });

  it('returns aborted and dead-letters nothing when buildRunInput throws after the signal aborted', async () => {
    const s = setup();
    const ac = new AbortController();
    s.engine.buildRunInput = async () => {
      ac.abort();
      throw new Error('fetch cancelled');
    };
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', ac.signal)).toBe('aborted');

    expectAbortedUntouched(s, job);
    expect(s.fake.calls).toHaveLength(0);
  });

  it('returns aborted when the runner rejects with a non-AbortError after the signal aborted', async () => {
    const s = setup();
    const ac = new AbortController();
    s.addChain();
    const job = s.claim();
    s.fake.script('echo', () => {
      ac.abort();
      return new Error('claude exited with code 143');
    });

    expect(await processDelivery(s.deps, job, 'w1', ac.signal)).toBe('aborted');

    expectAbortedUntouched(s, job);
  });

  it('does not run the runner when the signal is already aborted before the run', async () => {
    let ran = 0;
    const s = setup({
      runner: {
        name: 'fake',
        configSchema: z.unknown(),
        async run() {
          ran++;
          return { value: 'should not run' };
        },
      },
    });
    const ac = new AbortController();
    ac.abort();
    s.addChain();
    const job = s.claim();

    expect(await processDelivery(s.deps, job, 'w1', ac.signal)).toBe('aborted');

    expect(ran).toBe(0);
    expectAbortedUntouched(s, job);
  });

  it('still processes a result the runner resolved even if the signal aborted meanwhile', async () => {
    const s = setup();
    const ac = new AbortController();
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', () => {
      ac.abort();
      return { value: 'done anyway' };
    });

    expect(await processDelivery(s.deps, job, 'w1', ac.signal)).toBe('succeeded');

    expect(s.engine.notes).toEqual(['done anyway']);
    expect(getJob(s.db, job.id).status).toBe('succeeded');
    expect(listJobsForChain(s.db, chain.id)).toHaveLength(2);
  });

  it('records and exits child processes through the run hooks', async () => {
    let liveDuringRun: unknown[] = [];
    const s = setup({
      runner: {
        name: 'fake',
        configSchema: z.unknown(),
        async run(input, _signal, hooks) {
          hooks?.onSpawn?.({ pid: 4242, pgid: 4242, startTime: 77 });
          liveDuringRun = s.db
            .prepare('SELECT * FROM child_processes WHERE exited_at IS NULL')
            .all();
          hooks?.onExit?.(4242, 0);
          return { value: `ran ${input.job.id}` };
        },
      },
    });
    s.addChain();
    const job = s.claim();

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('succeeded');

    expect(liveDuringRun).toHaveLength(1);
    const rows = s.db.prepare('SELECT * FROM child_processes').all();
    expect(rows).toEqual([
      expect.objectContaining({
        worker_id: 'w1',
        job_id: job.id,
        delivery: job.delivery,
        pid: 4242,
        pgid: 4242,
        process_start_time: '77',
        started_at: NOW,
        exited_at: NOW,
        exit_code: 0,
      }),
    ]);
  });

  it('treats a DeadLetterStateError as stale', async () => {
    const s = setup();
    const chain = s.addChain();
    const job = s.claim();
    s.db.prepare(`UPDATE chains SET status = 'cancelled' WHERE id = ?`).run(chain.id);
    s.fake.script('echo', [{ value: 42 }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('stale');

    expect(listDeadLetters(s.db)).toHaveLength(0);
    expect(s.engine.calls.surfaced).toHaveLength(0);
    expect(s.engine.calls.cleanup).toHaveLength(1);
  });

  it('dead-letters with effect_error when a new job cannot be resolved to a policy', async () => {
    const s = setup({});
    s.engine.transition = (_c, job) => ({
      engineState: { count: 1 },
      chainStatus: 'active',
      newJobs: [{ type: 'echo', attempt: job.attempt + 1, policyKind: 'missing-kind', labels: [] }],
      effects: [],
    });
    const chain = s.addChain();
    const job = s.claim();
    s.fake.script('echo', [{ value: 'x' }]);

    expect(await processDelivery(s.deps, job, 'w1', signal())).toBe('dead_lettered');

    expect(listDeadLetters(s.db)[0]).toMatchObject({
      reason: 'effect_error',
      error: expect.stringMatching(/missing-kind/),
    });
    expect(listJobsForChain(s.db, chain.id)).toHaveLength(1);
  });
});
