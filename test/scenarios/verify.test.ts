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
    const h = harness({ repos: { [REPO]: { verify: [needsFixed], verifyBaseline: false } } });
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
    const h = harness({ repos: { [REPO]: { verify: [needsFixed], verifyBaseline: false } } });
    await h.submit(N);
    h.scriptExecute((input, call) => {
      if (call === 0) return (h.write(input, 'first.txt', 'x\n'), { status: 'ok', summary: 'first', costUsd: 0.1, followups: [] });
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
    expect(h.remoteLog(BRANCH)).toHaveLength(3);
    expect(kinds(h).filter((k) => k.startsWith('verify.'))).toEqual(['verify.started', 'verify.failed', 'verify.started', 'verify.passed']);
    const failed = chainEvents(h.db, h.chain().id).find((e) => e.kind === 'verify.failed')!;
    expect(failed.detail).toMatchObject({ exitCode: 2, round: 0 });
    const job = h.jobs().find((j) => j.type === 'execute')!;
    expect(job.result).toMatchObject({ costUsd: expect.closeTo(0.3, 5), summary: 'fixed' });
    expect((job.result as { verifyDurationMs: number }).verifyDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the round feedback when it appends the verify failure', async () => {
    const noBad = ['node', '-e', 'if(require("fs").existsSync("bad.txt")){console.log("FAIL: bad file present");process.exit(3)}'];
    const h = harness({ repos: { [REPO]: { verify: [noBad], verifyBaseline: false } } });
    const { chain } = await h.submit(N);
    h.scriptExecute((input, call) => {
      if (call === 1) h.write(input, 'bad.txt', 'x\n');
      if (call === 2) require('node:fs').rmSync(`${input.workspace.path}/bad.txt`);
      h.write(input, `rev-${call}.txt`, `${call}\n`);
      return ok(`call ${call}`);
    });
    h.scriptReview(Array.from({ length: 4 }, () => ({ verdict: 'approve' as const, feedback: 'lgtm' })));
    await h.runUntilIdle();
    const head = h.remoteHead(BRANCH)!;
    h.host.setChecks(head, [{ name: 'check (node 22)', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/1', runId: 900 }]);
    h.host.setFailedLog(900, 'expected 1 to be 2');
    await h.maintain();
    await h.runUntilIdle();
    const calls = h.callsOf('execute');
    expect(calls).toHaveLength(3);
    expect(calls[1]!.feedback).toContain('check (node 22)');
    expect(calls[2]!.feedback).toContain('check (node 22)');
    expect(calls[2]!.feedback).toContain('expected 1 to be 2');
    expect(calls[2]!.feedback).toContain('FAIL: bad file present');
    expect(h.chain(chain.id).state.phase).toBe('awaiting_merge');
  });

  it('fails the attempt after maxVerifyRounds and pushes nothing', async () => {
    const h = harness({ repos: { [REPO]: { verify: [needsFixed], verifyBaseline: false, maxVerifyRounds: 3 } } });
    await h.submit(N);
    h.scriptExecute((input, call) => (h.write(input, `try-${call}.txt`, 'x\n'), ok('never fixes')));
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
    const h = harness({ repos: { 'other/repo': { verify: [needsFixed], verifyBaseline: false } } });
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

const written = (name: string) => ['node', '-e', `const f=require("fs");f.writeFileSync(${JSON.stringify(name)}, "x")`];
const failingCmd = ['node', '-e', 'console.log(["RED","output"].join(": "));process.exit(4)'];
/** Fake `npm ci`: writes node_modules and counts its runs in a file outside the workspace. */
const fakeInstall = (counter: string) => [
  'node', '-e',
  `const f=require("fs");f.mkdirSync("node_modules/pkg",{recursive:true});f.writeFileSync("node_modules/.package-lock.json","{}");f.writeFileSync("node_modules/pkg/i.js","orig");f.appendFileSync(${JSON.stringify(counter)},"x")`,
];

describe('baseline verification', () => {
  it('stores a passing baseline, tells the agent about dependencies and reports the regression', async () => {
    const seed = ['node', '-e', 'process.exit(0)'];
    const h2 = harness({ repos: { [REPO]: { verify: [seed, ['node', '-e', 'if(require("fs").existsSync("broken.txt")){console.log("BROKEN");process.exit(1)}']] } } });
    await h2.submit(N);
    h2.scriptExecute((input, call) => {
      if (call === 0) h2.write(input, 'broken.txt', 'x');
      else require('node:fs').rmSync(`${input.workspace.path}/broken.txt`);
      return ok('done');
    });
    h2.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await h2.runUntilIdle();
    const calls = h2.callsOf('execute');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.baseline).toHaveLength(2);
    expect(calls[0]!.baseline!.every((b) => b.status === 'pass')).toBe(true);
    expect(calls[1]!.feedback).toContain('passed on the unmodified tree before your change');
    const primed = chainEvents(h2.db, h2.chain().id).find((e) => e.kind === 'workspace.primed')!;
    expect(primed.detail).toMatchObject({ cache: 'none', baseline: 'pass' });
  });

  it('puts the verify prompt text in the run input only for a repository with verify', async () => {
    const withVerify = harness({ repos: { [REPO]: { verify: [written('v.txt')] } } });
    await withVerify.submit(N);
    withVerify.scriptExecute(() => ok('done'));
    withVerify.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await withVerify.runUntilIdle();
    const text = withVerify.callsOf('execute')[0]!.promptAddendum!;
    expect(text).toContain("The project's dependencies are installed.");
    expect(text).toContain('run only targeted tests');
    expect(text).toContain('Do not run the full type-check, build or test suite before finishing');
    expect(text).toContain('the factory runs them after you finish and returns any failures');
    expect(text).toContain('Finish as soon as the change is complete.');

    const without = harness();
    await without.submit(N);
    without.scriptExecute(() => ok('done'));
    without.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await without.runUntilIdle();
    expect(without.callsOf('execute')[0]!.promptAddendum).toBeUndefined();
    expect(without.callsOf('execute')[0]!.baseline).toBeUndefined();
  });

  it('a failing baseline never starts the agent, comments once and retries as transient', async () => {
    const h = harness({ repos: { [REPO]: { verify: [failingCmd] } } });
    await h.submit(N);
    h.scriptExecute(() => ok('done'));
    expect(await h.deliver(h.claim()!)).toBe('retry_scheduled');
    expect(h.callsOf('execute')).toHaveLength(0);
    expect(h.deadLetters()).toHaveLength(0);
    const primed = chainEvents(h.db, h.chain().id).find((e) => e.kind === 'workspace.primed')!;
    expect(primed.detail).toMatchObject({ baseline: 'fail' });
    const retry = chainEvents(h.db, h.chain().id).find((e) => e.kind === 'job.retry_scheduled')!;
    expect(JSON.stringify(retry.detail)).toContain('baseline_failing');
    let mine = h.comments(N).filter((c) => c.includes('event=baseline-failing'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('node -e');
    expect(mine[0]).not.toContain('RED: output');
    // A second failing delivery posts no second comment.
    h.advance(24 * 3_600_000);
    expect(await h.deliver(h.claim()!)).toBe('retry_scheduled');
    mine = h.comments(N).filter((c) => c.includes('event=baseline-failing'));
    expect(mine).toHaveLength(1);
  });

  it('verifyBaseline: false skips the baseline', async () => {
    const h = harness({ repos: { [REPO]: { verify: [needsFixed], verifyBaseline: false } } });
    await h.submit(N);
    h.scriptExecute((input) => (h.write(input, 'fixed.txt', 'x\n'), ok('done')));
    h.scriptReview([{ verdict: 'approve', feedback: 'ok' }]);
    await h.runUntilIdle();
    expect(h.callsOf('execute')).toHaveLength(1);
    expect(h.callsOf('execute')[0]!.baseline).toBeUndefined();
    expect(chainEvents(h.db, h.chain().id).some((e) => e.kind === 'workspace.primed')).toBe(false);
  });
});

describe('dependency cache in the engine', () => {
  it('runs the install once on a miss, copies on a hit and records workspace.primed', async () => {
    const counterDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'factory-counter-'));
    const counter = `${counterDir}/count`;
    try {
      const install = fakeInstall(counter);
      // The standard install is `npm ci`; stand in for it with a fake `npm` first on PATH.
      const bin = `${counterDir}/bin`;
      require('node:fs').mkdirSync(bin);
      const script = `#!/usr/bin/env node\n${install[2]}\n`;
      require('node:fs').writeFileSync(`${bin}/npm`, script, { mode: 0o755 });
      const h = harness({ repos: { [REPO]: { setup: [['npm', 'ci']] } }, env: () => ({ PATH: `${bin}:${process.env.PATH}` }) });
      h.remote.commit('main', 'package-lock.json', '{"lockfileVersion":3}');
      await h.submit(N);
      h.scriptExecute((input) => {
        require('node:fs').writeFileSync(`${input.workspace.path}/node_modules/pkg/i.js`, 'tampered');
        return ok('done');
      });
      h.scriptReview([{ verdict: 'approve', feedback: 'ok' }, { verdict: 'approve', feedback: 'ok' }]);
      await h.runUntilIdle();
      // Execute and review each prepared a workspace: one install, one copy.
      expect(require('node:fs').readFileSync(counter, 'utf8')).toBe('x');
      const primed = chainEvents(h.db, h.chain().id).filter((e) => e.kind === 'workspace.primed').map((e) => e.detail as Record<string, unknown>);
      expect(primed.map((p) => p.cache)).toEqual(['miss', 'hit']);
      expect(primed[0]!.keyPrefix).toMatch(/^[0-9a-f]{12}$/);
      const [entry] = require('node:fs').readdirSync(`${h.workspaceRoot}/.cache/deps`);
      expect(require('node:fs').readFileSync(`${h.workspaceRoot}/.cache/deps/${entry}/node_modules/pkg/i.js`, 'utf8')).toBe('orig');
    } finally {
      require('node:fs').rmSync(counterDir, { recursive: true, force: true });
    }
  });
});
