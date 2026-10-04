import { afterEach, describe, expect, it } from 'vitest';
import { buildOverview, waitingOn, type WaitingInput } from '../../src/dashboard/overview.js';
import { addChain, addJob, addWorker, event, makeDb, NOW, type TempDb } from './support.js';

const base: WaitingInput = { status: 'active', phase: 'executing', branch: 'b', jobs: [], workerAlive: {}, deadLetter: null, waitingSince: NOW - 60_000, now: NOW };
const job = (o: Partial<WaitingInput['jobs'][number]>): WaitingInput['jobs'][number] => ({
  id: 1, type: 'execute', attempt: 1, status: 'queued', workerId: null, leaseExpiresAt: null, startedAt: null, createdAt: NOW - 10_000, ...o,
});

describe('waitingOn', () => {
  it('a queued job with no live worker waits on a worker', () => {
    const w = waitingOn({ ...base, jobs: [job({})] });
    expect(w.kind).toBe('worker');
    expect(w.label).toBe('a worker');
    expect(w.detail).toContain('no live worker');
  });

  it('shows a job waiting for a transient retry as retrying instead of queued', () => {
    const w = waitingOn({ ...base, jobs: [job({ availableAt: NOW + 30_000, transientRetries: 2 })] });
    expect(w.detail).toContain('retrying (attempt 2, in 30s)');
    expect(w.detail).not.toContain('is queued');
  });

  it('names a retry', () => {
    expect(waitingOn({ ...base, jobs: [job({ attempt: 2 })] }).detail).toContain('retry');
  });

  it('a job claimed by a live worker is running, with its elapsed time and lease', () => {
    const w = waitingOn({ ...base, workerAlive: { w1: true }, jobs: [job({ status: 'running', workerId: 'w1', startedAt: NOW - 90_000, leaseExpiresAt: NOW + 60_000 })] });
    expect(w.kind).toBe('running');
    expect(w.label).toBe('running');
    expect(w.runningMs).toBe(90_000);
    expect(w.leaseExpiresAt).toBe(NOW + 60_000);
    expect(w.detail).toContain('1m');
  });

  it('a review job queued or running waits on a reviewer agent', () => {
    expect(waitingOn({ ...base, jobs: [job({ type: 'review' })] }).label).toBe('a reviewer agent');
    const running = waitingOn({ ...base, workerAlive: { w1: true }, jobs: [job({ type: 'review', status: 'running', workerId: 'w1', startedAt: NOW - 1000, leaseExpiresAt: NOW + 1000 })] });
    expect(running.label).toBe('a reviewer agent');
  });

  it('awaiting_merge waits on a person to review and merge, naming the pull request', () => {
    const w = waitingOn({ ...base, status: 'waiting', phase: 'awaiting_merge', branch: 'factory/issue-3' });
    expect(w.label).toBe('a person: review and merge');
    expect(w.detail).toContain('factory/issue-3');
    expect(w.since).toBe(NOW - 60_000);
  });

  it('needs_human waits on a person', () => {
    const w = waitingOn({ ...base, status: 'waiting', phase: 'needs_human' });
    expect(w.label).toBe('a person: needs attention');
    expect(w.since).toBe(NOW - 60_000);
  });

  it('a dead-lettered chain waits on a decision, with the reason', () => {
    const w = waitingOn({ ...base, status: 'dead_lettered', deadLetter: { reason: 'timeout', error: 'took too long\nmore' } });
    expect(w.label).toBe('a decision on the dead letter');
    expect(w.detail).toBe('timeout: took too long');
  });

  it('a running job whose worker is dead is stuck', () => {
    const w = waitingOn({ ...base, workerAlive: { w1: false }, jobs: [job({ status: 'running', workerId: 'w1', startedAt: NOW - 1000, leaseExpiresAt: NOW + 1000 })] });
    expect(w.kind).toBe('stuck');
    expect(w.label).toBe('a stuck job');
    expect(w.detail).toContain('dead');
  });

  it('a running job whose worker is unknown is stuck', () => {
    expect(waitingOn({ ...base, jobs: [job({ status: 'running', workerId: 'gone', leaseExpiresAt: NOW + 1000 })] }).kind).toBe('stuck');
  });

  it('a running job with an expired lease is stuck even if the worker is alive', () => {
    const w = waitingOn({ ...base, workerAlive: { w1: true }, jobs: [job({ status: 'running', workerId: 'w1', startedAt: NOW - 1000, leaseExpiresAt: NOW - 1 })] });
    expect(w.kind).toBe('stuck');
    expect(w.detail).toContain('lease');
  });
});

let t: TempDb | undefined;
afterEach(() => t?.cleanup());

describe('buildOverview', () => {
  function populate(db: TempDb['db']) {
    addWorker(db, 'alive', NOW - 10_000);
    addWorker(db, 'dead', NOW - 61_000);
    const queued = addChain(db, { status: 'active', issue: 1 });
    addJob(db, queued, { status: 'queued' });

    const running = addChain(db, { status: 'active', issue: 2 });
    const rj = addJob(db, running, { status: 'running', worker: 'alive', lease: NOW + 100_000, delivery: 1, cost: 0.25 });
    db.prepare('UPDATE workers SET current_job_id = ?, current_delivery = 1 WHERE id = ?').run(rj, 'alive');
    event(db, running, 'job.claimed', NOW - 120_000, {}, rj, 1);

    const stuck = addChain(db, { status: 'active', issue: 3 });
    addJob(db, stuck, { status: 'running', worker: 'dead', lease: NOW + 100_000, delivery: 1 });

    const expired = addChain(db, { status: 'active', issue: 4 });
    addJob(db, expired, { status: 'running', worker: 'alive', lease: NOW - 5_000, delivery: 1 });

    const person = addChain(db, { status: 'waiting', phase: 'awaiting_merge', issue: 5 });
    const pj = addJob(db, person, { status: 'succeeded', cost: 0.5 });
    addJob(db, person, { type: 'review', status: 'succeeded', cost: 0.125 });
    event(db, person, 'pr.opened', NOW - 400_000, { branch: 'factory/issue-5' }, pj);
    event(db, person, 'chain.waiting', NOW - 300_000);

    const human = addChain(db, { status: 'waiting', phase: 'needs_human', issue: 6 });
    event(db, human, 'chain.waiting', NOW - 200_000);

    const dead = addChain(db, { status: 'dead_lettered', issue: 7 });
    const dj = addJob(db, dead, { status: 'failed' });
    db.prepare(`INSERT INTO dead_letters (job_id, chain_id, reason, error, created_at) VALUES (?, ?, 'max_deliveries', 'gave up', ?)`).run(dj, dead, NOW - 50_000);

    const review = addChain(db, { status: 'active', phase: 'reviewing', issue: 8 });
    addJob(db, review, { type: 'review', status: 'queued' });

    for (let i = 0; i < 25; i++) addChain(db, { status: i % 2 ? 'completed' : 'cancelled', issue: 100 + i, at: NOW - 1_000_000 + i * 1000 });
    for (let i = 0; i < 12; i++) event(db, queued, 'job.queued', NOW - 100_000 + i * 1000, { i });
    return { queued, running, stuck, expired, person, human, dead, review };
  }

  it('reports the concurrency limit, null when there is none', () => {
    t = makeDb();
    expect(buildOverview(t.db, NOW).limits).toEqual({ maxConcurrentJobs: null });
    expect(buildOverview(t.db, NOW, { maxConcurrentJobs: 4 }).limits).toEqual({ maxConcurrentJobs: 4 });
  });

  it('reports when each chain was last checked and flags a waiting chain unchecked for over three intervals', () => {
    t = makeDb();
    const fresh = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 1 });
    const edge = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 2 });
    const old = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 3 });
    const never = addChain(t.db, { status: 'waiting', phase: 'needs_human', issue: 4 });
    const newWaiting = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 5, at: NOW - 30_000 });
    const active = addChain(t.db, { status: 'active', issue: 6 });
    const set = t.db.prepare('UPDATE chains SET last_checked_at = ?, last_check_result = ? WHERE id = ?');
    set.run(NOW - 20_000, 'none', fresh);
    set.run(NOW - 180_000, 'unknown', edge);
    set.run(NOW - 180_001, 'error: boom', old);
    const byId = new Map(buildOverview(t.db, NOW).openChains.map((c) => [c.id, c]));
    const f = (id: number) => {
      const c = byId.get(id)!;
      return [c.lastCheckedAt, c.lastCheckResult, c.checkStale];
    };
    expect(f(fresh)).toEqual([NOW - 20_000, 'none', false]);
    expect(f(edge)).toEqual([NOW - 180_000, 'unknown', false]);
    expect(f(old)).toEqual([NOW - 180_001, 'error: boom', true]);
    expect(f(never)).toEqual([null, null, true]); // waiting for an hour and never looked at
    expect(f(newWaiting)).toEqual([null, null, false]);
    expect(f(active)).toEqual([null, null, false]);
    // The threshold follows the maintenance interval.
    expect(buildOverview(t.db, NOW, { maintenanceMs: 10_000 }).openChains.find((c) => c.id === fresh)!.checkStale).toBe(false);
    expect(buildOverview(t.db, NOW, { maintenanceMs: 5_000 }).openChains.find((c) => c.id === fresh)!.checkStale).toBe(true);
  });

  it('lists open chains, finished chains and workers with derived waitingOn', () => {
    t = makeDb();
    const ids = populate(t.db);
    const o = buildOverview(t.db, NOW);
    const byId = new Map(o.openChains.map((c) => [c.id, c]));

    expect(o.generatedAt).toBe(NOW);
    expect(o.openChains).toHaveLength(8);
    expect(byId.get(ids.queued)!.waitingOn!.label).toBe('a worker');
    expect(byId.get(ids.running)!.waitingOn!.label).toBe('running');
    expect(byId.get(ids.running)!.waitingOn!.runningMs).toBe(120_000);
    expect(byId.get(ids.stuck)!.waitingOn!.label).toBe('a stuck job');
    expect(byId.get(ids.expired)!.waitingOn!.label).toBe('a stuck job');
    expect(byId.get(ids.person)!.waitingOn!.label).toBe('a person: review and merge');
    expect(byId.get(ids.person)!.waitingOn!.since).toBe(NOW - 300_000);
    expect(byId.get(ids.human)!.waitingOn!.label).toBe('a person: needs attention');
    expect(byId.get(ids.dead)!.waitingOn!.label).toBe('a decision on the dead letter');
    expect(byId.get(ids.dead)!.waitingOn!.detail).toBe('max_deliveries: gave up');
    expect(byId.get(ids.review)!.waitingOn!.label).toBe('a reviewer agent');

    expect(o.finishedChains).toHaveLength(20);
    expect(o.finishedChains.every((c) => c.waitingOn === null)).toBe(true);
    expect(o.finishedChains[0]!.updatedAt).toBeGreaterThanOrEqual(o.finishedChains[19]!.updatedAt);
  });

  it('describes a chain: subject, phase, attempt, links, jobs, cost and its 10 latest events', () => {
    t = makeDb();
    const ids = populate(t.db);
    const o = buildOverview(t.db, NOW);
    const person = o.openChains.find((c) => c.id === ids.person)!;
    expect(person.subject).toEqual({ repo: 'o/r', issueNumber: 5 });
    expect(person.engine).toBe('software');
    expect(person.status).toBe('waiting');
    expect(person.phase).toBe('awaiting_merge');
    expect(person.attempt).toBe(1);
    expect(person.links.issue).toBe('https://github.com/o/r/issues/5');
    expect(person.links.pullRequest).toContain('https://github.com/o/r/pulls?q=');
    expect(person.jobs.map((j) => [j.type, j.status, j.costUsd])).toEqual([['execute', 'succeeded', 0.5], ['review', 'succeeded', 0.125]]);
    expect(person.totalCostUsd).toBe(0.625);
    expect(o.openChains.find((c) => c.id === ids.queued)!.links.pullRequest).toBeNull();

    const queued = o.openChains.find((c) => c.id === ids.queued)!;
    expect(queued.events).toHaveLength(10);
    expect(queued.events.at(-1)!.detail).toEqual({ i: 11 });
    expect(o.totalCostUsd).toBe(0.875);
  });

  it('reports worker liveness from the heartbeat and the job each runs', () => {
    t = makeDb();
    const ids = populate(t.db);
    const o = buildOverview(t.db, NOW);
    const alive = o.workers.find((w) => w.id === 'alive')!;
    const dead = o.workers.find((w) => w.id === 'dead')!;
    expect(alive.alive).toBe(true);
    expect(alive.currentChainId).toBe(ids.running);
    expect(alive.currentJobId).not.toBeNull();
    expect(dead.alive).toBe(false);
    expect(o.summary).toMatchObject({ workers: 1, aliveWorkers: 1, stoppedWorkers: 1, runningJobs: 3, waitingOnPerson: 3 });
  });

  it('lists alive workers first, then only the 5 most recently seen dead ones', () => {
    t = makeDb();
    for (let i = 0; i < 13; i++) addWorker(t.db, `dead-${String(i).padStart(2, '0')}`, NOW - 120_000 - i * 1000);
    addWorker(t.db, 'alive-1', NOW - 1000);
    addWorker(t.db, 'alive-2', NOW - 2000);
    const o = buildOverview(t.db, NOW);
    expect(o.workers.map((w) => w.id)).toEqual(['alive-1', 'alive-2', 'dead-00', 'dead-01', 'dead-02', 'dead-03', 'dead-04']);
    expect(o.summary).toMatchObject({ workers: 2, aliveWorkers: 2, stoppedWorkers: 13 });
  });

  it('counts an idle worker with an old heartbeat as alive when its process exists', () => {
    t = makeDb();
    t.db
      .prepare(`INSERT INTO workers (id, pid, pgid, host, started_at, last_seen_at) VALUES ('idle', ?, 1, 'here', 0, ?)`)
      .run(process.pid, NOW - 3_600_000);
    const o = buildOverview(t.db, NOW, { host: 'here' });
    expect(o.workers[0]).toMatchObject({ id: 'idle', alive: true });
    expect(o.summary.workers).toBe(1);
  });

  it('links to the pull request by number when recorded, else to a search', () => {
    t = makeDb();
    const withNumber = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 7 });
    const old = addChain(t.db, { status: 'waiting', phase: 'awaiting_merge', issue: 8 });
    const state = JSON.parse((t.db.prepare('SELECT engine_state FROM chains WHERE id = ?').get(withNumber) as { engine_state: string }).engine_state);
    t.db.prepare('UPDATE chains SET engine_state = ? WHERE id = ?').run(JSON.stringify({ ...state, prNumber: 42 }), withNumber);
    const o = buildOverview(t.db, NOW);
    expect(o.openChains.find((c) => c.id === withNumber)!.links.pullRequest).toBe('https://github.com/o/r/pull/42');
    expect(o.openChains.find((c) => c.id === old)!.links.pullRequest).toContain('https://github.com/o/r/pulls?q=');
  });

  it('is empty on an empty database', () => {
    t = makeDb();
    const o = buildOverview(t.db, NOW);
    expect(o.openChains).toEqual([]);
    expect(o.finishedChains).toEqual([]);
    expect(o.workers).toEqual([]);
  });
});
