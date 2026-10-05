import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/index.js';
import type { IntakeConfig } from '../../src/cli/config.js';
import type { Runtime } from '../../src/cli/runtime.js';
import { GitHostError } from '../../src/engines/software/github.js';
import { Intake } from '../../src/intake/loop.js';
import { ISSUE_BODY, makeHarness, REPO, type Harness } from '../support/harness.js';

const config = (over: Partial<IntakeConfig> = {}): IntakeConfig => ({
  repos: [REPO], readyLabel: 'factory:ready', pollIntervalMs: 60_000, maxOpenChains: 2,
  allowedAuthorAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'], ...over,
});

let h: Harness;
afterEach(() => h.cleanup());

function setup(over: Partial<IntakeConfig> = {}) {
  h = makeHarness();
  const out: string[] = [];
  const err: string[] = [];
  const cfg = config(over);
  const openSubjects = () =>
    (h.db.prepare(`SELECT subject_key FROM chains WHERE status IN ('active', 'waiting', 'dead_lettered')`).all() as Array<{ subject_key: string }>).map((r) => r.subject_key);
  const intake = new Intake({
    host: h.host, kernel: h.kernel, config: cfg, engine: 'software', openSubjects, isDraining: () => false,
    redact: (t) => t, stdout: (l) => out.push(l), stderr: (l) => err.push(l),
  });
  const ready = (n: number, o: { body?: string; assoc?: string } = {}) =>
    h.host.addIssue({ number: n, title: `Issue ${n}`, body: o.body ?? ISSUE_BODY, labels: ['factory:ready'], authorAssociation: o.assoc ?? 'OWNER' });
  const chains = () => (h.db.prepare('SELECT COUNT(*) AS n FROM chains').get() as { n: number }).n;
  return { intake, out, err, ready, chains, cfg };
}

describe('intake loop', () => {
  it('enqueues a ready issue once and swaps the labels', async () => {
    const { intake, out, ready, chains } = setup();
    ready(1);
    expect(await intake.pass()).toBe(false);
    expect(chains()).toBe(1);
    expect(out).toEqual([`${REPO}#1 enqueued chain 1 job 1`]);
    expect(h.issueLabels(1)).toEqual(['factory:queued']);
    await intake.pass();
    expect(chains()).toBe(1);
  });

  it('retries a failed label swap without a second chain', async () => {
    const { intake, err, ready, chains } = setup();
    ready(1);
    h.host.failNext('setLabels', new GitHostError('boom', 502));
    expect(await intake.pass()).toBe(true);
    expect(err).toEqual(['error: boom']);
    expect(chains()).toBe(1);
    expect(h.issueLabels(1)).toEqual(['factory:ready']);
    expect(await intake.pass()).toBe(false);
    expect(chains()).toBe(1);
    expect(h.issueLabels(1)).toEqual(['factory:queued']);
  });

  it('rejects an issue without a required section exactly once', async () => {
    const { intake, out, ready, chains } = setup();
    ready(1, { body: '## Goal\nonly a goal\n' });
    await intake.pass();
    await intake.pass();
    await intake.pass();
    expect(chains()).toBe(0);
    expect(h.comments(1)).toHaveLength(1);
    expect(h.comments(1)[0]).toMatch(/^<!-- factory:intake-rejected hash=[0-9a-f]{8} -->/);
    expect(h.comments(1)[0]).toContain('missing required section(s): ## Acceptance criteria');
    expect(h.issueLabels(1)).toEqual(['factory:rejected']);
    expect(out).toEqual([`${REPO}#1 rejected issue ${REPO}#1 is missing required section(s): ## Acceptance criteria`]);
    // Re-adding the label without a fix does not comment again.
    await h.host.setLabels(REPO, 1, ['factory:ready'], []);
    await intake.pass();
    expect(h.comments(1)).toHaveLength(1);
    expect(h.issueLabels(1)).toEqual(['factory:rejected']);
  });

  it('holds a second issue back at maxOpenChains and enqueues it after the first chain closes', async () => {
    const { intake, out, ready, chains } = setup({ maxOpenChains: 1 });
    ready(1);
    ready(2);
    await intake.pass();
    await intake.pass();
    expect(chains()).toBe(1);
    expect(h.issueLabels(2)).toEqual(['factory:ready']);
    expect(out.filter((l) => l.includes('at capacity'))).toEqual([`${REPO}#2 skip at capacity`]);
    await h.kernel.cancelChain(1);
    await intake.pass();
    expect(chains()).toBe(2);
    expect(h.issueLabels(2)).toEqual(['factory:queued']);
  });

  it('ignores a non-allowed author', async () => {
    const { intake, ready, chains } = setup();
    ready(1, { assoc: 'NONE', body: 'no sections' });
    await intake.pass();
    expect(chains()).toBe(0);
    expect(h.comments(1)).toEqual([]);
    expect(h.issueLabels(1)).toEqual(['factory:ready']);
  });

  it('a gh failure on one issue does not stop the others', async () => {
    const { intake, err, ready, chains } = setup();
    ready(1);
    ready(2);
    h.host.failNext('getIssue', new GitHostError('rate limited', 429));
    expect(await intake.pass()).toBe(true);
    expect(err).toEqual(['error: rate limited']);
    expect(chains()).toBe(1);
    expect(h.comments(1)).toEqual([]);
    expect(await intake.pass()).toBe(false);
    expect(chains()).toBe(2);
  });

  it('does not enqueue while draining', async () => {
    const { cfg, out, ready, chains } = setup();
    const drained = new Intake({
      host: h.host, kernel: h.kernel, config: cfg, engine: 'software', openSubjects: () => [], isDraining: () => true,
      redact: (t) => t, stdout: (l) => out.push(l), stderr: () => {},
    });
    ready(1);
    await drained.pass();
    expect(chains()).toBe(0);
  });

  it('ends cleanly on SIGTERM and SIGINT, polling in between', async () => {
    for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      const { ready } = setup({ pollIntervalMs: 5_000 });
      ready(1);
      const out: string[] = [];
      const handlers = new Map<string, () => void>();
      const runtime: Runtime = {
        kernel: h.kernel, db: h.db, defaultEngine: 'software', host: h.host, intake: config({ pollIntervalMs: 5_000 }), close: () => {},
      };
      const exit = run(['intake'], { runtime, stdout: (l) => out.push(l), stderr: () => {}, onSignal: (s, fn) => void handlers.set(s, fn) });
      for (let i = 0; i < 400 && out.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(out).toEqual([`${REPO}#1 enqueued chain 1 job 1`]);
      handlers.get(sig)!();
      expect(await exit).toBe(code);
      h.cleanup();
    }
  });

  it('--once runs a single pass and exits 0, or 1 when a repository errored', async () => {
    const { ready } = setup();
    ready(1);
    const runtime: Runtime = { kernel: h.kernel, db: h.db, defaultEngine: 'software', host: h.host, intake: config(), close: () => {} };
    const deps = { runtime, stdout: () => {}, stderr: () => {}, onSignal: () => {} };
    expect(await run(['intake', '--once'], deps)).toBe(0);
    h.host.failNext('listIssuesByLabel', new GitHostError('down', 503));
    expect(await run(['intake', '--once'], deps)).toBe(1);
  });
});
