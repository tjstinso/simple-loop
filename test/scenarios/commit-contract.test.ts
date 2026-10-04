import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chainEvents } from '../../src/kernel/events.js';
import type { RunInput } from '../../src/runner/types.js';
import { FAKE_API_KEY, makeHarness, ok, REPO, type Harness, type HarnessOptions } from '../support/harness.js';
import { GIT_TEST_ENV } from '../support/temp-repo.js';

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

/** What the agent's own `git` sees: no author variables, so only the workspace's local configuration names it. */
const AGENT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (input: RunInput, ...args: string[]): string =>
  execFileSync('git', args, { cwd: input.workspace.path, env: AGENT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Writes `file` and commits it with `message`. */
const commit = (h: Harness, input: RunInput, file: string, message: string): void => {
  h.write(input, file, `${message}\n`);
  git(input, 'add', file);
  git(input, 'commit', '-q', '-m', message);
};
const events = (h: Harness, kind: string) => chainEvents(h.db, h.chain().id).filter((e) => e.kind === kind);
const approve = (h: Harness) => h.scriptReview(Array.from({ length: 4 }, () => ({ verdict: 'approve' as const, feedback: 'ok' })));

describe('the agent commits, the engine validates and pushes', () => {
  it('pushes the agent\'s two commits after verification and lists them in the PR body', async () => {
    const needsB = ['node', '-e', 'if(!require("fs").existsSync("b.txt"))process.exit(2)'];
    const h = harness({ repos: { [REPO]: { verify: [needsB], verifyBaseline: false } } });
    await h.submit(N);
    h.scriptExecute((input) => {
      // The workspace's local configuration carries the factory identity.
      expect(git(input, 'config', 'user.email')).toBe('factory@localhost');
      commit(h, input, 'a.txt', 'Add a');
      commit(h, input, 'b.txt', 'Add b\n\nBecause b is needed.');
      return ok('done');
    });
    approve(h);
    await h.runUntilIdle();
    const subjects = execFileSync('git', ['log', '--format=%s', `refs/heads/${BRANCH}`], { cwd: h.remote.path, env: GIT_TEST_ENV, encoding: 'utf8' }).trim().split('\n');
    expect(subjects.slice(0, 2)).toEqual(['Add b', 'Add a']);
    expect(h.remoteLog(BRANCH)).toHaveLength(3);
    expect(events(h, 'commit.fallback')).toHaveLength(0);
    expect(events(h, 'commit.validated')[0]!.detail).toMatchObject({ commits: 2, head: h.remoteHead(BRANCH)!.slice(0, 12) });
    const body = [...h.host.prs.values()][0]!.body;
    expect(body).toContain('## Commits');
    expect(body).toMatch(/- `[0-9a-f]{7}` Add a\n- `[0-9a-f]{7}` Add b/);
    expect([...h.host.prs.values()][0]!.title).toBe('Issue 7');
  });

  it('treats a clean tree at the seed as no change', async () => {
    const h = harness();
    await h.submit(N);
    h.scriptExecute(() => ok('nothing to do'));
    expect(await h.deliver(h.claim()!)).toBe('dead_lettered');
    expect(h.deadLetters()[0]!.error).toContain('no changes produced');
    expect(h.remoteBranches()).not.toContain(BRANCH);
    expect(events(h, 'commit.validated')).toHaveLength(0);
  });

  it('commits a dirty tree itself and records one fallback event', async () => {
    const h = harness();
    await h.submit(N);
    h.scriptExecute((input) => {
      commit(h, input, 'a.txt', 'Add a');
      h.write(input, 'forgot.txt', 'x\n');
      h.write(input, 'also.txt', 'y\n');
      return ok('done');
    });
    approve(h);
    await h.runUntilIdle();
    expect(h.remoteLog(BRANCH)).toHaveLength(3);
    expect(h.remoteFiles(BRANCH)).toEqual(expect.arrayContaining(['a.txt', 'also.txt', 'forgot.txt']));
    const fallback = events(h, 'commit.fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.detail).toEqual({ files: 2 });
    const subject = execFileSync('git', ['log', '-1', '--format=%s', `refs/heads/${BRANCH}`], { cwd: h.remote.path, env: GIT_TEST_ENV, encoding: 'utf8' }).trim();
    expect(subject).toBe('factory: Issue 7 (attempt 1)');
  });

  const refused: Array<[string, string, (h: Harness, input: RunInput) => void]> = [
    ['history', 'rewritten history', (h, i) => {
      commit(h, i, 'a.txt', 'Add a');
      // A parentless commit replaces the branch: the seed is no longer an ancestor.
      const orphan = git(i, 'commit-tree', 'HEAD^{tree}', '-m', 'rewritten');
      git(i, 'reset', '-q', '--hard', orphan);
    }],
    ['branch', 'a detached HEAD', (h, i) => {
      git(i, 'checkout', '-q', '--detach');
      commit(h, i, 'a.txt', 'Add a');
    }],
    ['branch', 'a branch switch', (h, i) => {
      git(i, 'checkout', '-q', '-b', 'elsewhere');
      commit(h, i, 'a.txt', 'Add a');
    }],
    ['merge_commit', 'a merge commit', (h, i) => {
      const own = git(i, 'rev-parse', '--abbrev-ref', 'HEAD');
      git(i, 'checkout', '-q', '-b', 'side');
      commit(h, i, 'side.txt', 'Side');
      git(i, 'checkout', '-q', own);
      commit(h, i, 'a.txt', 'Add a');
      git(i, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    }],
    ['gitlink', 'a submodule entry', (_h, i) => {
      git(i, 'update-index', '--add', '--cacheinfo', `160000,${git(i, 'rev-parse', 'HEAD')},vendor/sub`);
      git(i, 'commit', '-q', '-m', 'Add submodule');
    }],
    ['identity', 'a commit by another author', (h, i) => {
      h.write(i, 'a.txt', 'a\n');
      git(i, 'add', 'a.txt');
      git(i, 'commit', '-q', '-m', 'Add a', '--author', 'Someone <someone@example.com>');
    }],
    ['commit_count', '51 commits', (_h, i) => {
      for (let n = 0; n < 51; n++) git(i, 'commit', '-q', '--allow-empty', '-m', `c${n}`);
    }],
  ];
  for (const [check, name, act] of refused) {
    it(`refuses ${name} and pushes nothing`, async () => {
      const h = harness();
      await h.submit(N);
      h.scriptExecute((input) => (act(h, input), ok('done')));
      expect(await h.deliver(h.claim()!)).toBe('dead_lettered');
      const dl = h.deadLetters()[0]!;
      expect(dl.reason).toBe('runner_error');
      expect(dl.error).toContain(`commit validation failed (${check})`);
      expect(h.remoteBranches()).not.toContain(BRANCH);
      expect(h.callsOf('execute')).toHaveLength(1);
      expect(events(h, 'commit.rejected')[0]!.detail).toMatchObject({ check });
      expect(events(h, 'commit.validated')).toHaveLength(0);
    });
  }

  it('starts a fix round with the failure, the agent commits on top and the second round pushes', async () => {
    const needsFixed = ['node', '-e', 'if(!require("fs").existsSync("fixed.txt")){console.log("FAIL: fixed.txt is missing");process.exit(2)}'];
    const h = harness({ repos: { [REPO]: { verify: [needsFixed], verifyBaseline: false } } });
    await h.submit(N);
    h.scriptExecute((input, call) => (commit(h, input, call === 0 ? 'a.txt' : 'fixed.txt', `Commit ${call}`), ok(`call ${call}`)));
    approve(h);
    await h.runUntilIdle();
    const calls = h.callsOf('execute');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.feedback).toContain('FAIL: fixed.txt is missing');
    expect(h.remoteLog(BRANCH)).toHaveLength(3);
    expect(h.remoteFile(BRANCH, 'fixed.txt')).toBe('Commit 1');
    expect(events(h, 'commit.validated')).toHaveLength(1);
  });

  it('reports verify_dirty with the file names and passes once they are committed', async () => {
    const regenerate = ['node', '-e', 'require("fs").writeFileSync("gen.txt","generated\\n")'];
    const h = harness({ repos: { [REPO]: { verify: [regenerate], verifyBaseline: false } } });
    await h.submit(N);
    h.scriptExecute((input, call) => {
      if (call === 0) commit(h, input, 'gen.txt', 'Add generated file');
      else {
        git(input, 'add', '-A');
        git(input, 'commit', '-q', '-m', 'Commit the regenerated file');
      }
      return ok('done');
    });
    approve(h);
    await h.runUntilIdle();
    const calls = h.callsOf('execute');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.feedback).toContain('left tracked files modified');
    expect(calls[1]!.feedback).toContain('- gen.txt');
    expect(h.remoteFile(BRANCH, 'gen.txt')).toBe('generated');
  });

  it('fails the delivery when HEAD moves after verification', async () => {
    const moveHead = ['git', 'commit', '-q', '--allow-empty', '-m', 'moved'];
    const h = harness({ repos: { [REPO]: { verify: [moveHead], verifyBaseline: false } } });
    await h.submit(N);
    h.scriptExecute((input) => (commit(h, input, 'a.txt', 'Add a'), ok('done')));
    expect(await h.deliver(h.claim()!)).toBe('dead_lettered');
    expect(h.deadLetters()[0]!.error).toContain('HEAD moved');
    expect(h.remoteBranches()).not.toContain(BRANCH);
  });

  it('still catches a secret in an agent commit message', async () => {
    const h = harness();
    await h.submit(N);
    h.scriptExecute((input) => (commit(h, input, 'a.txt', `Add a with ${FAKE_API_KEY}`), ok('done')));
    expect(await h.deliver(h.claim()!)).toBe('dead_lettered');
    expect(h.deadLetters()[0]!.error).toContain('refusing to push');
    expect(h.remoteBranches()).not.toContain(BRANCH);
  });
});

describe('conflict rounds', () => {
  async function conflicting(h: Harness) {
    const { chain } = await h.submit(N);
    h.scriptExecute((input, call) => {
      if (call === 0) h.write(input, 'README.md', 'branch version\n');
      return ok('first change');
    });
    approve(h);
    await h.runUntilIdle();
    const pr = h.pr(BRANCH)!.number;
    h.remote.commit('main', 'README.md', 'main version\n');
    h.host.setMergeable(pr, 'conflicting');
    return chain;
  }

  it('refuses an agent commit during a conflict round', async () => {
    const h = harness();
    const chain = await conflicting(h);
    const before = h.remoteHead(BRANCH);
    h.scriptExecute((input) => {
      h.write(input, 'README.md', 'both\n');
      git(input, 'add', 'README.md');
      // Mid-merge, git completes the merge itself: the agent committed.
      git(input, 'commit', '-q', '-m', 'Resolve');
      return ok('resolved');
    });
    await h.maintain();
    await h.runUntilIdle();
    expect(h.chain(chain.id).status).toBe('dead_lettered');
    expect(h.deadLetters()[0]!.error).toContain('commit validation failed (conflict_commit)');
    expect(h.remoteHead(BRANCH)).toBe(before);
  });

  it('tells the agent in the conflict feedback not to commit', async () => {
    const h = harness();
    await conflicting(h);
    h.scriptExecute((input) => (h.write(input, 'README.md', 'both\n'), ok('resolved')));
    await h.maintain();
    await h.runUntilIdle();
    expect(h.callsOf('execute').at(-1)!.feedback).toContain('do not commit');
  });
});

describe('the execute prompt', () => {
  const prompt = readFileSync(join(__dirname, '../../policies/software-execute.yaml'), 'utf8');

  it('asks the agent to commit its work, with the limits', () => {
    expect(prompt).toContain('commit it with `git add` and `git commit`');
    expect(prompt).toContain('72 characters');
    expect(prompt).toContain('do not amend, rebase, reset');
    expect(prompt).not.toContain('Do not commit; the factory commits for you');
  });

  it('makes conflict rounds the exception', () => {
    expect(prompt).toMatch(/Conflict rounds[\s\S]*must not commit/);
  });
});
