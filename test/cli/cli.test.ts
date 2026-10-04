import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type CliDeps } from '../../src/cli/index.js';
import type { Runtime } from '../../src/cli/runtime.js';
import { LABEL_DEAD_LETTER } from '../../src/engines/software/index.js';
import { ISSUE_BODY, makeHarness, ok, REPO, type Harness } from '../support/harness.js';

const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

let harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

function setup() {
  const h = makeHarness();
  harnesses.push(h);
  let closed = 0;
  const runtime: Runtime = {
    kernel: h.kernel,
    db: h.db,
    defaultEngine: 'software',
    close: () => {
      closed++;
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { runtime, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  return { h, out, err, deps, closed: () => closed };
}

describe('policies command', () => {
  it('prints each effective policy with redaction', async () => {
    const { deps, out } = setup();
    const token = 'gh' + 'p_' + 'a'.repeat(36);
    const runtime: Runtime = {
      ...deps.runtime!,
      effectivePolicies: [
        {
          name: 'p1',
          source: 'overridden',
          policy: { id: 'p1', kind: 'execute', match: { labels: ['x'] }, runner: 'claude-cli', config: { bare: false, note: token } },
        },
      ],
    };
    expect(await run(['policies'], { ...deps, runtime })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('p1 source=overridden kind=execute labels=x');
    expect(text).toContain('"bare": false');
    expect(text).not.toContain(token);
  });

  it('rejects arguments', async () => {
    const { deps } = setup();
    expect(await run(['policies', 'x'], deps)).toBe(2);
  });
});

async function deadLetter(h: Harness, n: number) {
  const { chain } = await h.submit(n);
  h.scriptExecute(() => {
    throw new Error('agent crashed: segfault in tool');
  });
  h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
  await h.runUntilIdle();
  return chain;
}

describe('factory cli', () => {
  it('submit prints the chain and job ids and exits 0', async () => {
    const { h, out, err, deps } = setup();
    h.host.addIssue({ number: 1, title: 'T', body: ISSUE_BODY, labels: [] });
    const code = await run(['submit', url(1)], deps);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const chain = h.chain();
    expect(out).toEqual([`chain ${chain.id} job ${h.jobs(chain.id)[0]!.id} engine software`]);
  });

  it('submit exits 1 with the validation message for an issue missing sections', async () => {
    const { h, out, err, deps } = setup();
    h.host.addIssue({ number: 2, title: 'T', body: '## Goal\nonly a goal\n', labels: [] });
    const code = await run(['submit', url(2)], deps);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/^error: /);
    expect(err.join('\n')).toContain('## Acceptance criteria');
  });

  it('submit exits 1 for ambiguous engine labels', async () => {
    const { err, deps } = setup();
    const code = await run(
      ['submit', url(3), '--label', 'factory:engine:a', '--label', 'factory:engine:b'],
      deps,
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('multiple engine labels');
  });

  it('submit exits 1 for an unknown engine', async () => {
    const { err, deps } = setup();
    const code = await run(['submit', url(3), '--engine', 'nope'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('unknown engine');
  });

  it('submit rejects a second submit for an open chain with exit 1', async () => {
    const { h, err, deps } = setup();
    h.host.addIssue({ number: 4, title: 'T', body: ISSUE_BODY, labels: [] });
    expect(await run(['submit', url(4)], deps)).toBe(0);
    expect(await run(['submit', url(4)], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/^error: /);
  });

  it('status prints one engine-described line per open chain and no open chains when empty', async () => {
    const { h, out, deps } = setup();
    expect(await run(['status'], deps)).toBe(0);
    expect(out).toEqual(['slots: 0 (no limit)', 'no open chains']);
    out.length = 0;
    const { chain } = await h.submit(5);
    expect(await run(['status'], deps)).toBe(0);
    expect(out[0]).toBe('slots: 0 (no limit)');
    out.shift();
    expect(out[0]).toBe(`${chain.id} software active ${h.engine.describe(h.chain(chain.id))}`);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^ {2}job \d+ execute attempt=1 queued delivery=0 last-event=\d+s ago$/);
  });

  it('status reports the slots in use against the configured limit', async () => {
    const { h, out, deps } = setup();
    h.kernel.deps.config.maxConcurrentJobs = 3;
    await h.submit(5);
    h.claim();
    expect(await run(['status'], deps)).toBe(0);
    expect(out[0]).toBe('slots: 1 of 3');
  });

  it('status shows the worker and lease of a running job, and --json prints the same data', async () => {
    const { h, out, deps } = setup();
    const { chain } = await h.submit(5);
    const job = h.claim()!;
    expect(await run(['status'], deps)).toBe(0);
    expect(out[2]).toContain(`job ${job.id} execute attempt=1 running delivery=1 worker=w1`);
    expect(out[2]).toContain(`lease-expires=${new Date(job.leaseExpiresAt!).toISOString()}`);
    out.length = 0;
    expect(await run(['status', '--json'], deps)).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed[0]).toMatchObject({ id: chain.id, status: 'active' });
    expect(parsed[0].jobs[0]).toMatchObject({
      id: job.id, type: 'execute', attempt: 1, status: 'running', delivery: 1, workerId: 'w1', leaseExpiresAt: job.leaseExpiresAt,
    });
  });

  it('show prints the chain timeline with the dead-letter reason and the cost', async () => {
    const { h, out, err, deps } = setup();
    const chain = await deadLetter(h, 8);
    expect(await run(['show', String(chain.id)], deps)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/chain\.created[\s\S]*job\.queued[\s\S]*job\.claimed[\s\S]*job\.dead_lettered .*"reason":"runner_error"/);
    expect(text).toContain('cost total $0.0000');
    out.length = 0;
    expect(await run(['show', String(chain.id), '--json'], deps)).toBe(0);
    const t = JSON.parse(out[0]!);
    expect(t.events.map((e: { kind: string }) => e.kind)).toContain('job.dead_lettered');
    expect(t.cost.totalUsd).toBe(0);
    expect(await run(['show', '999'], deps)).toBe(1);
    expect(err.join('\n')).toContain('chain 999 not found');
    expect(await run(['show'], deps)).toBe(2);
  });

  it('events filters by chain, duration and limit', async () => {
    const { h, out, deps } = setup();
    const a = await h.submit(5);
    const b = await h.submit(6);
    expect(await run(['events', '--chain', String(a.chain.id)], deps)).toBe(0);
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.includes(`chain=${a.chain.id}`))).toBe(true);
    out.length = 0;
    expect(await run(['events', '--limit', '1', '--json'], deps)).toBe(0);
    const last = JSON.parse(out[0]!);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ chainId: b.chain.id, kind: 'job.queued' });
    out.length = 0;
    h.advance(2 * 3_600_000);
    expect(await run(['events', '--since', '1h'], deps)).toBe(0);
    expect(out).toEqual(['no events']);
    expect(await run(['events', '--since', 'soon'], deps)).toBe(2);
    expect(await run(['events', '--limit', '0'], deps)).toBe(2);
  });

  it('workers lists registered workers with liveness, job and heartbeat age', async () => {
    const { h, out, deps } = setup();
    h.db
      .prepare(`INSERT INTO workers (id, pid, pgid, host, started_at, last_seen_at, current_job_id, current_delivery)
                VALUES ('w-here', ?, ?, ?, ?, ?, 4, 2), ('w-away', 1, 1, 'elsewhere', ?, ?, NULL, NULL)`)
      .run(process.pid, process.pid, hostname(), h.clock() - 5000, h.clock() - 5000, h.clock() - 90_000, h.clock() - 90_000);
    expect(await run(['workers'], deps)).toBe(0);
    expect(out).toEqual([
      `w-away pid=1 host=elsewhere unknown idle heartbeat=1m ago`,
      `w-here pid=${process.pid} host=${hostname()} alive job=4 delivery=2 heartbeat=5s ago`,
    ]);
    out.length = 0;
    expect(await run(['workers', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)[1]).toMatchObject({ id: 'w-here', alive: true, currentJobId: 4, heartbeatAgeMs: 5000 });
  });

  it('dlq list prints unresolved dead letters and no dead letters when empty', async () => {
    const { h, out, deps } = setup();
    expect(await run(['dlq', 'list'], deps)).toBe(0);
    expect(out).toEqual(['no dead letters']);
    out.length = 0;
    const chain = await deadLetter(h, 6);
    expect(await run(['dlq', 'list'], deps)).toBe(0);
    const jobId = h.jobs(chain.id)[0]!.id;
    expect(out).toEqual([`job ${jobId} chain ${chain.id} runner_error agent crashed: segfault in tool`]);
  });

  it('dlq retry requeues through kernel.retryDeadLetter and clears the dead-letter label', async () => {
    const { h, out, deps } = setup();
    const chain = await deadLetter(h, 7);
    const jobId = h.jobs(chain.id)[0]!.id;
    expect(h.issueLabels(7)).toContain(LABEL_DEAD_LETTER);
    h.scriptExecute((input) => {
      h.write(input, 'a.txt', 'a\n');
      return ok('fixed');
    });
    expect(await run(['dlq', 'retry', String(jobId)], deps)).toBe(0);
    expect(out).toEqual([`requeued job ${jobId}`]);
    expect(h.issueLabels(7)).not.toContain(LABEL_DEAD_LETTER);
    expect(h.chain(chain.id).status).toBe('active');
  });

  it('dlq discard cancels the chain', async () => {
    const { h, out, deps } = setup();
    const chain = await deadLetter(h, 8);
    const jobId = h.jobs(chain.id)[0]!.id;
    expect(await run(['dlq', 'discard', String(jobId)], deps)).toBe(0);
    expect(out).toEqual([`discarded job ${jobId}`]);
    expect(h.chain(chain.id).status).toBe('cancelled');
  });

  it('dlq discard clears the factory labels from the issue through the afterCancel hook', async () => {
    const { h, deps } = setup();
    const chain = await deadLetter(h, 9);
    expect(h.issueLabels(9)).toContain(LABEL_DEAD_LETTER);
    expect(await run(['dlq', 'discard', String(h.jobs(chain.id)[0]!.id)], deps)).toBe(0);
    expect(h.issueLabels(9)).toEqual([]);
  });

  it('cancel ends a waiting chain and prints cancelled chain <id>', async () => {
    const { h, out, err, deps } = setup();
    const { chain } = await h.submit(10);
    h.scriptExecute((input) => {
      h.write(input, 'a.txt', 'a\n');
      return ok('done');
    });
    h.scriptReview([{ verdict: 'approve', feedback: 'lgtm' }]);
    await h.runUntilIdle();
    expect(h.chain(chain.id).status).toBe('waiting');
    expect(await run(['cancel', String(chain.id)], deps)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([`cancelled chain ${chain.id}`]);
    expect(h.chain(chain.id).status).toBe('cancelled');
  });

  it('cancel exits 2 for a missing or invalid id and 1 when the cancel is refused', async () => {
    const { h, err, deps } = setup();
    expect(await run(['cancel'], deps)).toBe(2);
    expect(await run(['cancel', 'x'], deps)).toBe(2);
    expect(await run(['cancel', '0'], deps)).toBe(2);
    expect(err.join('\n')).toContain('Usage');
    err.length = 0;
    expect(await run(['cancel', '99'], deps)).toBe(1);
    expect(err).toEqual(['error: chain 99 not found']);
    const { chain } = await h.submit(11);
    h.claim(); // its execute job is running
    err.length = 0;
    expect(await run(['cancel', String(chain.id)], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/^error: .*running/);
    expect(h.chain(chain.id).status).toBe('active');
  });

  it('dlq retry fails with exit 1 when there is no dead letter', async () => {
    const { err, deps } = setup();
    expect(await run(['dlq', 'retry', '99'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/^error: /);
  });

  it('dlq retry and discard reject a non-numeric id with exit 2', async () => {
    const { err, deps } = setup();
    expect(await run(['dlq', 'retry', 'abc'], deps)).toBe(2);
    expect(await run(['dlq', 'discard', '1x'], deps)).toBe(2);
    expect(await run(['dlq', 'retry', '-3'], deps)).toBe(2);
    expect(err.join('\n')).toContain('Usage');
  });

  it('unknown command and missing arguments return 2 and print usage', async () => {
    const { err, deps } = setup();
    expect(await run(['bogus'], deps)).toBe(2);
    expect(await run([], deps)).toBe(2);
    expect(await run(['submit'], deps)).toBe(2);
    expect(await run(['dlq'], deps)).toBe(2);
    expect(await run(['status', 'extra'], deps)).toBe(2);
    expect(await run(['dlq', 'retry'], deps)).toBe(2);
    expect(err.join('\n')).toContain('Usage');
  });

  it('--help returns 0', async () => {
    const { out, deps } = setup();
    expect(await run(['--help'], deps)).toBe(0);
    expect(out.join('\n')).toContain('Usage');
    expect(await run(['-h'], deps)).toBe(0);
  });

  it('worker starts, stops on SIGTERM and exits 0', async () => {
    const { out, deps } = setup();
    const handlers = new Map<string, () => void>();
    const calls: string[] = [];
    const exit = run(['worker', '--poll-ms', '5', '--id', 'w-test'], {
      ...deps,
      onSignal: (sig, handler) => {
        calls.push(sig);
        handlers.set(sig, handler);
      },
    });
    for (let i = 0; i < 400 && !out.some((l) => l.includes('started')); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(out).toContain('worker w-test started');
    expect(calls.sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')!();
    expect(await exit).toBe(0);
    expect(out).toContain('worker w-test stopped');
  });

  it('worker refuses to start when the identity check fails, and starts nothing', async () => {
    const { out, err, deps } = setup();
    const runtime: Runtime = {
      ...deps.runtime!,
      verifyIdentity: async () => {
        throw new Error("the GitHub token resolves to the login 'a', but github.expectLogin is 'b'");
      },
    };
    expect(await run(['worker', '--id', 'w-id'], { ...deps, runtime })).toBe(1);
    expect(err.join('\n')).toContain("'a'");
    expect(err.join('\n')).toContain("'b'");
    expect(out.join('\n')).not.toContain('started');
  });

  it('does not close an injected runtime', async () => {
    const { deps, closed } = setup();
    await run(['status'], deps);
    expect(closed()).toBe(0);
  });

  it('rejects an invalid policy before running any command, naming the policy (exit 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-cli-policies-'));
    try {
      mkdirSync(join(dir, 'policies'));
      writeFileSync(
        join(dir, 'policies', 'software-review.yaml'),
        'id: broken-review\nkind: review\ndefault: true\nmatch:\n  labels: []\nrunner: claude-cli\nconfig:\n  prompt: x\n',
      );
      writeFileSync(join(dir, 'factory.config.json'), JSON.stringify({ dbPath: join(dir, 'f.db'), workspaceRoot: join(dir, 'ws') }));
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(['status'], { cwd: dir, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toMatch(/^error: .*policy 'broken-review'.*invalid config for runner 'claude-cli'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
