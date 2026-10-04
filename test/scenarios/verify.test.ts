import { afterEach, describe, expect, it } from 'vitest';
import { chainEvents } from '../../src/kernel/events.js';
import { makeHarness, ok, REPO, type Harness, type HarnessOptions } from '../support/harness.js';

const N = 7;
const BRANCH = `factory/issue-${N}`;
const harnesses: Harness[] = [];
const harness = (opts?: HarnessOptions): Harness => {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** A fake verify command: passes once `fixed.txt` exists in the workspace. */
const needsFixed = ['node', '-e', 'const f=require("fs");if(!f.existsSync("fixed.txt")){console.log("FAIL: "+["fixed","txt"].join(".")+" is missing");process.exit(2)}'];
const kinds = (h: Harness) => chainEvents(h.db, h.chain().id).map((e) => e.kind);

describe('verification before the push', () => {
  it('pushes once when the verification passes', async () => {
    const h = harness({ repos: { [REPO]: { verify: [needsFixed] } } });
    await h.submit(N);
    h.scriptExecute((input) => (h.write(input, 'fixed.txt', 'x\n'), ok('done')));
    h.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await h.runUntilIdle();
    expect(h.callsOf('execute')).toHaveLength(1);
    expect(h.remoteLog(BRANCH)).toHaveLength(2);
    expect(kinds(h)).toEqual(expect.arrayContaining(['verify.started', 'verify.passed']));
    expect(kinds(h)).not.toContain('verify.failed');
  });

  it('starts a verify round with the failure and pushes only after it passes', async () => {
    const h = harness({ repos: { [REPO]: { verify: [needsFixed] } } });
    await h.submit(N);
    h.scriptExecute((input, call) => {
      if (call === 0) return { status: 'ok', summary: 'first', costUsd: 0.1, followups: [] };
      h.write(input, 'fixed.txt', 'x\n');
      return { status: 'ok', summary: 'fixed', costUsd: 0.2 };
    });
    h.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await h.runUntilIdle();
    const calls = h.callsOf('execute');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.feedback).toBeUndefined();
    expect(calls[1]!.feedback).toContain('FAIL: fixed.txt is missing');
    expect(calls[1]!.feedback).toContain('Exit code: 2');
    expect(calls[1]!.workspace.path).toBe(calls[0]!.workspace.path);
    expect(h.remoteFile(BRANCH, 'fixed.txt')).toBe('x');
    expect(h.remoteLog(BRANCH)).toHaveLength(2);
    expect(kinds(h).filter((k) => k.startsWith('verify.'))).toEqual(['verify.started', 'verify.failed', 'verify.started', 'verify.passed']);
    const failed = chainEvents(h.db, h.chain().id).find((e) => e.kind === 'verify.failed')!;
    expect(failed.detail).toMatchObject({ exitCode: 2, round: 0 });
    const job = h.jobs().find((j) => j.type === 'execute')!;
    expect(job.result).toMatchObject({ costUsd: expect.closeTo(0.3, 5), summary: 'fixed' });
    expect((job.result as { verifyDurationMs: number }).verifyDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails the attempt after maxVerifyRounds and pushes nothing', async () => {
    const h = harness({ repos: { [REPO]: { verify: [needsFixed], maxVerifyRounds: 3 } } });
    await h.submit(N);
    h.scriptExecute(() => ok('never fixes'));
    const first = h.claim()!;
    expect(await h.deliver(first)).toBe('dead_lettered');
    expect(h.callsOf('execute')).toHaveLength(4);
    expect(h.remoteBranches()).not.toContain(BRANCH);
    const dl = h.deadLetters()[0]!;
    expect(dl.reason).toBe('runner_error');
    expect(dl.error).toContain('node -e');
    expect(kinds(h).filter((k) => k === 'verify.failed')).toHaveLength(4);
    // The failure text never goes to GitHub beyond the dead-letter comment's command name.
    expect(h.comments(N).join('\n')).not.toContain('fixed.txt is missing');
  });

  it('is unchanged for a repository without an entry', async () => {
    const h = harness({ repos: { 'other/repo': { verify: [needsFixed] } } });
    await h.submit(N);
    h.scriptExecute((input) => (h.write(input, 'a.txt', 'a\n'), ok('done')));
    h.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await h.runUntilIdle();
    expect(h.callsOf('execute')).toHaveLength(1);
    expect(h.remoteFile(BRANCH, 'a.txt')).toBe('a');
    expect(kinds(h).some((k) => k.startsWith('verify.') || k === 'workspace.setup')).toBe(false);
  });
});

describe('setup in the workspace', () => {
  it('runs setup before the agent, in the workspace, for execute and review', async () => {
    const h = harness({ repos: { [REPO]: { setup: [['node', '-e', 'require("fs").writeFileSync("setup-ran.txt", process.env.CI + "," + (process.env.GH_TOKEN ?? "no"))']] } } });
    await h.submit(N);
    const seen: string[] = [];
    h.scriptExecute((input) => {
      seen.push(require('node:fs').readFileSync(`${input.workspace.path}/setup-ran.txt`, 'utf8'));
      return ok('done');
    });
    h.scriptReview((input) => {
      seen.push(require('node:fs').readFileSync(`${input.workspace.path}/setup-ran.txt`, 'utf8'));
      return { verdict: 'approve', feedback: 'ok' };
    });
    await h.runUntilIdle();
    expect(seen).toEqual(['true,no', 'true,no']);
    expect(kinds(h)).toContain('workspace.setup');
  });

  it('a setup failure is a runner_error naming the command, without its output', async () => {
    const h = harness({ repos: { [REPO]: { setup: [['node', '-e', 'console.log(["SECRET","OUTPUT"].join("-"));process.exit(5)']] } } });
    await h.submit(N);
    h.scriptExecute(() => ok('done'));
    const job = h.claim()!;
    expect(await h.deliver(job)).toBe('dead_lettered');
    expect(h.callsOf('execute')).toHaveLength(0);
    const dl = h.deadLetters()[0]!;
    expect(dl.reason).toBe('runner_error');
    expect(dl.error).toContain('setup command failed');
    expect(dl.error).toContain('node -e');
    expect(dl.error).toContain('exit code 5');
    expect(dl.error).not.toContain('SECRET-OUTPUT');
  });
});
