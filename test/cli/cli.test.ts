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
    expect(out).toEqual(['no open chains']);
    out.length = 0;
    const { chain } = await h.submit(5);
    expect(await run(['status'], deps)).toBe(0);
    expect(out).toEqual([`${chain.id} software active ${h.engine.describe(h.chain(chain.id))}`]);
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

  it('does not close an injected runtime', async () => {
    const { deps, closed } = setup();
    await run(['status'], deps);
    expect(closed()).toBe(0);
  });
});
