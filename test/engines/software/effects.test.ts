import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectError, StaleDeliveryError, type ChainView, type Effect, type EffectFence, type Job } from '../../../src/kernel/types.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { GitWorkspaceProvider, type SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import { ExecGitPorts, type AddedChanges, type GitPorts } from '../../../src/engines/software/git-ports.js';
import { GitHostError } from '../../../src/engines/software/github.js';
import { runSoftwareEffect, type EffectContext } from '../../../src/engines/software/effects.js';
import { LABEL_IN_PROGRESS, LABEL_READY_FOR_MERGE } from '../../../src/engines/software/schemas.js';
import { FakeGitHost } from '../../support/fake-github.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from '../../support/temp-repo.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const REPO = 'acme/widgets';
const ISSUE = 7;
const BRANCH = 'factory/issue-7';

function chain(over: Partial<SoftwareState> = {}): ChainView<SoftwareState> {
  return {
    id: 3, engine: 'software', subjectKey: 'k', status: 'active',
    state: { repo: REPO, issueNumber: ISSUE, labels: [], profile: 'supervised', branch: BRANCH, attempt: 1, phase: 'executing', ...over },
  };
}
function job(over: Partial<Job> = {}): Job {
  return {
    id: 42, chainId: 3, type: 'execute', attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null,
    claimedBy: 'w', leaseExpiresAt: null, delivery: 1, error: null, ...over,
  };
}

function fence(): EffectFence & { checks: number } {
  const f = { jobId: 42, delivery: 1, checks: 0, assertCurrent: () => { f.checks++; } };
  return f;
}
function staleFence(): EffectFence {
  return { jobId: 42, delivery: 1, assertCurrent: () => { throw new StaleDeliveryError(); } };
}

class RecordingGit implements GitPorts {
  readonly calls: string[] = [];
  async commitAll(): Promise<boolean> { this.calls.push('commitAll'); return false; }
  async headSha(): Promise<string> { this.calls.push('headSha'); return 'x'; }
  async addedChanges(): Promise<AddedChanges> { this.calls.push('addedChanges'); return CLEAN; }
  async push(): Promise<void> { this.calls.push('push'); }
}

const CLEAN: AddedChanges = { paths: [], text: '', truncated: false };

const fakeWs: SoftwareWorkspace = {
  repo: 'acme/widgets', path: '/nonexistent', localBranch: 'l', remoteBranch: BRANCH, remoteUrl: '/nonexistent.git',
  remoteHeadSha: null, seedSha: 'seed', baseBranch: 'main',
};

describe('runSoftwareEffect', () => {
  let host: FakeGitHost;
  let delays: number[];
  let rgit: RecordingGit;
  const ctx = (over: Partial<EffectContext> = {}): EffectContext => ({
    chain: chain(), job: job(), workspace: fakeWs, host, git: rgit,
    sleep: async (ms) => { delays.push(ms); }, ...over,
  });

  beforeEach(() => {
    host = new FakeGitHost();
    host.addIssue({ number: ISSUE, title: 'Add widgets', body: 'please', labels: [LABEL_IN_PROGRESS] });
    delays = [];
    rgit = new RecordingGit();
  });

  describe('git effects (real git)', () => {
    let remote: TempRemote;
    let root: string;
    let provider: GitWorkspaceProvider;
    const ports = new ExecGitPorts();
    const remoteHead = () => git(remote.path, ['rev-parse', `refs/heads/${BRANCH}`]);

    beforeEach(() => {
      remote = makeRemote();
      root = mkdtempSync(join(tmpdir(), 'factory-eff-'));
      provider = new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: false });
    });
    afterEach(() => {
      remote.cleanup();
      rmSync(root, { recursive: true, force: true });
    });

    it('commit_push commits leftover changes and pushes with force-with-lease against the seed sha', async () => {
      const previous = remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain({ attempt: 2 }), job({ delivery: 2, attempt: 2 }));
      expect(ws.remoteHeadSha).toBe(previous);
      writeFileSync(join(ws.path, 'leftover.txt'), 'left\n');
      const f = fence();
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ chain: chain({ attempt: 2 }), job: job({ attempt: 2 }), workspace: ws, git: ports }), f);
      const head = remoteHead();
      expect(head).not.toBe(previous);
      expect(git(remote.path, ['rev-parse', `${head}^`])).toBe(previous);
      expect(git(remote.path, ['log', '-1', '--format=%s', head])).toBe('factory: Add widgets (attempt 2)');
      expect(git(remote.path, ['show', `${head}:leftover.txt`])).toBe('left');
      expect(f.checks).toBeGreaterThanOrEqual(2);
    });

    it('commit_push with no changes at all throws no changes produced and opens no PR', async () => {
      const ws = await provider.prepare(chain(), job());
      const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as EffectError).message).toMatch(/no changes produced/);
      expect(host.prs.size).toBe(0);
      expect(git(remote.path, ['branch', '--list', BRANCH])).toBe('');
    });

    it('commit_push uses the agent own commit when the tree is clean', async () => {
      const ws = await provider.prepare(chain(), job());
      writeFileSync(join(ws.path, 'agent.txt'), 'a\n');
      git(ws.path, ['add', '.']);
      git(ws.path, ['commit', '-m', 'agent commit']);
      const agentSha = git(ws.path, ['rev-parse', 'HEAD']);
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(agentSha);
    });

    it('commit_push pushing the same commit twice is a no-op', async () => {
      const ws = await provider.prepare(chain(), job());
      writeFileSync(join(ws.path, 'a.txt'), 'a\n');
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      const head = remoteHead();
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(head);
      expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(head);
    });

    class SpyGit implements GitPorts {
      pushes = 0;
      commitAll(ws: SoftwareWorkspace, m: string) { return ports.commitAll(ws, m); }
      headSha(ws: SoftwareWorkspace) { return ports.headSha(ws); }
      addedChanges(ws: SoftwareWorkspace, sha: string) { return ports.addedChanges(ws, sha); }
      push(ws: SoftwareWorkspace, a: { sha: string; remoteBranch: string; expectSha: string | null }) { this.pushes++; return ports.push(ws, a); }
    }

    it('commit_push on an already-published branch with no new changes succeeds without pushing', async () => {
      const published = remote.commit(BRANCH, 'done.txt', 'd\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      expect(ws.remoteHeadSha).toBe(published);
      const spy = new SpyGit();
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: spy }), fence());
      expect(spy.pushes).toBe(0);
      expect(remoteHead()).toBe(published);
    });

    it('commit_push with no changes and no published branch still throws no changes produced', async () => {
      const ws = await provider.prepare(chain(), job());
      const spy = new SpyGit();
      const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: spy }), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe('no changes produced');
      expect(spy.pushes).toBe(0);
    });

    it('after a post-push crash the rerun lets open_pr open the missing PR', async () => {
      const published = remote.commit(BRANCH, 'done.txt', 'd\n');
      const ws = await provider.prepare(chain(), job({ delivery: 3 }));
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      await runSoftwareEffect({ kind: 'open_pr' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(published);
      const open = [...host.prs.values()].filter((p) => p.head === BRANCH && p.state === 'open');
      expect(open).toHaveLength(1);
    });

    it('commit_push replay with a non-null expected sha and the remote already at HEAD is a no-op', async () => {
      const previous = remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      expect(ws.remoteHeadSha).toBe(previous);
      writeFileSync(join(ws.path, 'more.txt'), 'm\n');
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      const head = remoteHead();
      expect(head).not.toBe(previous);
      await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence());
      expect(remoteHead()).toBe(head);
      expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(head);
    });

    it('commit_push throws StaleDeliveryError when the remote branch moved and this delivery is stale', async () => {
      remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      const moved = remote.commit(BRANCH, 'zombie.txt', 'z\n');
      writeFileSync(join(ws.path, 'mine.txt'), 'm\n');
      // A newer delivery owns the job by the time the lease rejection is examined (a zombie).
      let checks = 0;
      const turnsStale: EffectFence = { jobId: 42, delivery: 1, assertCurrent: () => { if (++checks > 2) throw new StaleDeliveryError(); } };
      await expect(runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), turnsStale)).rejects.toBeInstanceOf(
        StaleDeliveryError,
      );
      expect(checks).toBe(3);
      expect(remoteHead()).toBe(moved);
    });

    it('commit_push: a lease rejection while this delivery is still current is a runner_error (someone else moved the branch)', async () => {
      remote.commit(BRANCH, 'first.txt', '1\n');
      const ws = await provider.prepare(chain(), job({ delivery: 2 }));
      const human = remote.commit(BRANCH, 'human.txt', 'h\n'); // e.g. a person pushed to factory/issue-7
      writeFileSync(join(ws.path, 'mine.txt'), 'm\n');
      const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe('remote branch moved by someone else');
      expect(remoteHead()).toBe(human);
    });

    describe('secret guard', () => {
      // Assembled at run time: no literal token-shaped string in the source.
      const API_KEY = 'sk-ant-' + 'api03-' + 'workerKeyForTests_0123456789';
      const GH_TOKEN = 'gh' + 'p_' + 'A1b2C3d4'.repeat(5);
      const secrets = () => [API_KEY];
      const refuse = async (ws: SoftwareWorkspace) => {
        const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports, secretValues: secrets }), fence()).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(EffectError);
        expect((err as EffectError).reason).toBe('runner_error');
        expect(git(remote.path, ['branch', '--list', BRANCH])).toBe('');
        return err as EffectError;
      };

      it("commit_push refuses to push a file containing the worker's API key and the remote is unchanged", async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'config.txt'), `key = ${API_KEY}\n`);
        const err = await refuse(ws);
        expect(err.message).toBe(
          'refusing to push: the change contains a secret (anthropic-key, known-secret-value); the matched text is not shown',
        );
        expect(host.prs.size).toBe(0);
      });

      it('commit_push refuses a file with a github token pattern', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'src.ts'), `export const t = '${GH_TOKEN}';\n`);
        expect((await refuse(ws)).message).toMatch(/\(github-token\)/);
      });

      it('commit_push refuses an added .env file', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, '.env'), 'DEBUG=1\n');
        expect((await refuse(ws)).message).toMatch(/\(secret-file\)/);
      });

      it('commit_push allows .env.example', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, '.env.example'), 'API_KEY=\n');
        await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports, secretValues: secrets }), fence());
        expect(git(remote.path, ['show', `${remoteHead()}:.env.example`])).toBe('API_KEY=');
      });

      it('the refusal message and dead letter text do not contain the secret', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'a.txt'), `${API_KEY}\n${GH_TOKEN}\n`);
        const err = await refuse(ws);
        const text = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
        expect(text).not.toContain(API_KEY);
        expect(text).not.toContain(GH_TOKEN);
        expect(text).not.toContain('workerKeyForTests');
        expect(JSON.stringify(host.calls)).not.toContain(API_KEY);
      });

      it('commit_push refuses a binary file holding the key after a NUL byte', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'data.bin'), Buffer.concat([Buffer.from([0, 0xff, 0]), Buffer.from(API_KEY), Buffer.from([0])]));
        expect((await refuse(ws)).message).toMatch(/known-secret-value/);
      });

      it('commit_push refuses a UTF-16LE file holding the key', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'notes.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`key=${API_KEY}\n`, 'utf16le')]));
        const err = await refuse(ws);
        expect(err.message).toMatch(/anthropic-key/);
        expect(err.message).toMatch(/known-secret-value/);
      });

      it('commit_push refuses a hand-built commit carrying the key in a custom header on an unchanged tree', async () => {
        const ws = await provider.prepare(chain(), job());
        const tree = git(ws.path, ['rev-parse', 'HEAD^{tree}']);
        const obj =
          `tree ${tree}\nparent ${ws.seedSha}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\n` +
          `x-note ${API_KEY}\n\nharmless message\n`;
        const c = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: ws.path, env: GIT_TEST_ENV, input: obj, encoding: 'utf8' }).trim();
        git(ws.path, ['reset', '-q', '--soft', c]);
        const err = await refuse(ws);
        expect(err.message).toMatch(/known-secret-value/);
        expect(err.message).not.toContain(API_KEY);
      });

      it('commit_push refuses a secret commit hidden behind a replace ref', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'leak.txt'), `${API_KEY}\n`);
        git(ws.path, ['add', '.']);
        git(ws.path, ['commit', '-q', '-m', 'bad']);
        const bad = git(ws.path, ['rev-parse', 'HEAD']);
        const seedTree = git(ws.path, ['rev-parse', `${ws.seedSha}^{tree}`]);
        const clean = git(ws.path, ['commit-tree', seedTree, '-p', ws.seedSha, '-m', 'clean']);
        git(ws.path, ['replace', bad, clean]);
        // The worktree and index match the clean replacement, so commitAll adds nothing: HEAD stays BAD.
        git(ws.path, ['rm', '-q', '-f', 'leak.txt']);
        const err = await refuse(ws);
        expect(err.message).toMatch(/known-secret-value/);
        expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(bad);
      });

      it('a clean change with an unrelated replace ref still pushes the pinned sha', async () => {
        const ws = await provider.prepare(chain(), job());
        const emptyTree = git(ws.path, ['hash-object', '-t', 'tree', '/dev/null']);
        const x = git(ws.path, ['commit-tree', emptyTree, '-m', 'x']);
        const y = git(ws.path, ['commit-tree', emptyTree, '-m', 'y']);
        git(ws.path, ['replace', x, y]);
        writeFileSync(join(ws.path, 'clean.txt'), 'clean\n');
        await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports, secretValues: secrets }), fence());
        expect(remoteHead()).toBe(git(ws.path, ['rev-parse', 'HEAD']));
      });

      it('a clean change still pushes', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'clean.ts'), 'export const answer = 42;\n');
        await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports, secretValues: secrets }), fence());
        expect(git(remote.path, ['show', `${remoteHead()}:clean.ts`])).toBe('export const answer = 42;');
      });

      it('an agent-made commit containing a secret is refused too', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'leak.txt'), `${API_KEY}\n`);
        git(ws.path, ['add', '.']);
        git(ws.path, ['commit', '-q', '-m', 'agent commit']);
        git(ws.path, ['rm', '-q', '-f', 'leak.txt']);
        git(ws.path, ['commit', '-q', '-m', 'agent removes it again']);
        expect((await refuse(ws)).message).toMatch(/known-secret-value/);
      });

      it('commit_push pushes the sha it scanned even when HEAD moves after the scan', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'clean.txt'), 'clean\n');
        let scanned = '';
        const racing: GitPorts = {
          commitAll: (w, m) => ports.commitAll(w, m),
          headSha: (w) => ports.headSha(w),
          addedChanges: async (w, sha) => {
            scanned = sha;
            const c = await ports.addedChanges(w, sha);
            // A leftover background process commits a secret right after the scan.
            writeFileSync(join(w.path, 'late.txt'), `${API_KEY}\n`);
            git(w.path, ['add', '.']);
            git(w.path, ['commit', '-q', '-m', 'late']);
            return c;
          },
          push: (w, a) => ports.push(w, a),
        };
        await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: racing, secretValues: secrets }), fence());
        expect(scanned).toMatch(/^[0-9a-f]{40}$/);
        expect(remoteHead()).toBe(scanned);
        expect(git(ws.path, ['rev-parse', 'HEAD'])).not.toBe(scanned);
        expect(git(remote.path, ['ls-tree', '-r', '--name-only', remoteHead()])).not.toContain('late.txt');
      });

      it('a scan that hit its cap refuses the push as scan-truncated', async () => {
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'big.txt'), 'z'.repeat(500) + '\n');
        const capped = new ExecGitPorts({ scanCapBytes: 100 });
        const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: capped }), fence()).catch((e: unknown) => e);
        expect((err as EffectError).reason).toBe('runner_error');
        expect((err as Error).message).toMatch(/\(scan-truncated\)/);
        expect(git(remote.path, ['branch', '--list', BRANCH])).toBe('');
      });

      it('the commit message built from the issue title is redacted', async () => {
        host.issues.get(ISSUE)!.title = `Rotate ${API_KEY} now`;
        const ws = await provider.prepare(chain(), job());
        writeFileSync(join(ws.path, 'ok.txt'), 'ok\n');
        await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports, secretValues: secrets }), fence());
        expect(git(remote.path, ['log', '-1', '--format=%s', remoteHead()])).toBe('factory: Rotate [redacted] now (attempt 1)');
      });
    });

    it('a stale fence stops commit_push before it pushes', async () => {
      const ws = await provider.prepare(chain(), job());
      writeFileSync(join(ws.path, 'a.txt'), 'a\n');
      await expect(runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: ws, git: ports }), staleFence())).rejects.toBeInstanceOf(
        StaleDeliveryError,
      );
      expect(git(remote.path, ['branch', '--list', BRANCH])).toBe('');
      expect(host.calls).toEqual([]);
    });
  });

  it('commit_push sanitizes the shared repository config before it commits and pushes', async () => {
    const order: string[] = [];
    const g: GitPorts = {
      prepareForPush: async () => void order.push('prepareForPush'),
      commitAll: async () => (order.push('commitAll'), true),
      headSha: async () => (order.push('headSha'), 'new'),
      addedChanges: async () => (order.push('addedChanges'), CLEAN),
      push: async () => void order.push('push'),
    };
    await runSoftwareEffect({ kind: 'commit_push' }, ctx({ git: g }), fence());
    expect(order).toEqual(['prepareForPush', 'commitAll', 'headSha', 'addedChanges', 'push']);
  });

  it("an execute job's commit_push git or host failure is a runner_error (a retry reruns the agent)", async () => {
    const pushFails: GitPorts = {
      commitAll: async () => true,
      headSha: async () => 'new',
      addedChanges: async () => CLEAN,
      push: async () => {
        throw new Error('git push failed: Could not resolve host: github.com');
      },
    };
    const cases: Array<[string, () => unknown]> = [
      ['git push failed: Could not resolve host: github.com', () => ctx({ git: pushFails })],
      ['Not Found', () => { host.failNext('getIssue', new GitHostError('Not Found', 404)); return ctx(); }],
    ];
    for (const [message, mk] of cases) {
      const err = await runSoftwareEffect({ kind: 'commit_push' }, mk() as EffectContext, fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe(message);
    }
    // A transient host failure is still retried first.
    delays = [];
    host.getIssue = async () => {
      throw new GitHostError('bad gateway', 502);
    };
    const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx(), fence()).catch((e: unknown) => e);
    expect((err as EffectError).reason).toBe('runner_error');
    expect(delays).toEqual([100, 200]);
  });

  it('a failing secret scan is a runner_error and nothing is pushed', async () => {
    const pushed: string[] = [];
    const scanFails: GitPorts = {
      commitAll: async () => true,
      headSha: async () => 'new',
      addedChanges: async () => {
        throw new Error('git log timed out after 60000 ms');
      },
      push: async () => void pushed.push('push'),
    };
    // Also for a job type outside the execute-only runner_error mapping: the scan itself classifies.
    for (const j of [job(), job({ type: 'review' })]) {
      const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ git: scanFails, job: j }), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe('refusing to push: the secret scan failed: git log timed out after 60000 ms');
    }
    expect(pushed).toEqual([]);
  });

  it("an execute job's open_pr host failure is a runner_error", async () => {
    host.failNext('openPr', new GitHostError('Validation Failed', 422));
    const err = await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('Validation Failed');
  });

  it("a review job's effect failures stay effect_error (its retry keeps the verdict)", async () => {
    const review = job({ type: 'review' });
    const err = await runSoftwareEffect({ kind: 'set_labels', target: 'pr', add: ['x'], remove: [] }, ctx({ job: review }), fence()).catch(
      (e: unknown) => e,
    );
    expect((err as EffectError).reason).toBe('effect_error');
    host.failNext('setLabels', new GitHostError('Validation Failed', 422));
    const err2 = await runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx({ job: review }), fence()).catch(
      (e: unknown) => e,
    );
    expect((err2 as EffectError).reason).toBe('effect_error');
  });

  it('commit_push with a missing workspace throws EffectError runner_error', async () => {
    const err = await runSoftwareEffect({ kind: 'commit_push' }, ctx({ workspace: null }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('workspace for this delivery is gone; retry will rerun the agent');
    expect(rgit.calls).toEqual([]);
  });

  it('open_pr with a missing workspace throws EffectError runner_error', async () => {
    const err = await runSoftwareEffect({ kind: 'open_pr' }, ctx({ workspace: null }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect(host.prs.size).toBe(0);
  });

  it('open_pr on a closed issue is an effect_error and opens no PR', async () => {
    host.issues.get(ISSUE)!.state = 'closed';
    const err = await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe(`issue #${ISSUE} is closed`);
    expect(host.prs.size).toBe(0);
  });

  it('merge_pr on a closed issue is an effect_error and merges nothing', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.issues.get(ISSUE)!.state = 'closed';
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: job({ type: 'review' }) }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe(`issue #${ISSUE} is closed`);
    expect(host.prs.get(pr.number)?.state).toBe('open');
    expect(host.calls.map((c) => c.method)).not.toContain('mergePr');
  });

  it('the closed-issue check re-reads the issue through the transient retry', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.setPrHead(pr.number, 'seed'); // the head the review workspace was seeded from
    host.failNext('getIssue', new GitHostError('bad gateway', 502));
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: job({ type: 'review' }) }), fence());
    expect(host.prs.get(pr.number)?.state).toBe('merged');
    expect(delays).toEqual([100]);
  });

  it('open_pr reuses an existing open PR for the branch', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.calls.length = 0;
    await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence());
    expect(host.prs.size).toBe(1);
    expect(host.prs.get(pr.number)?.state).toBe('open');
    expect(host.calls.map((c) => c.method)).not.toContain('openPr');
  });

  it('open_pr opens a new PR when the earlier one for the branch is closed', async () => {
    const old = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.prs.get(old.number)!.state = 'closed';
    await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence());
    expect(host.prs.size).toBe(2);
  });

  it('open_pr opens a PR with Closes #n and the marker body', async () => {
    const f = fence();
    await runSoftwareEffect(
      { kind: 'open_pr' },
      ctx({ job: job({ result: { status: 'ok', summary: 'Added the widget factory.' } }) }),
      f,
    );
    expect(host.prs.size).toBe(1);
    const pr = [...host.prs.values()][0]!;
    expect(pr.head).toBe(BRANCH);
    expect(pr.baseBranch).toBe('main');
    expect(pr.title).toBe('Add widgets');
    expect(pr.body).toBe('Closes #7\n\nAdded the widget factory.\n\n<!-- factory:chain=3 job=42 event=open-pr -->');
    expect(f.checks).toBeGreaterThanOrEqual(2);
  });

  it('open_pr neutralizes a hostile agent summary: no mentions, no closing keywords, capped at 2000 characters', async () => {
    const ZW = '\u200b';
    const hostile = 'Done. cc @octocat and @org/team. Fixes #12, closes #3, Resolved  #44, fix #5 and FIXES #6.';
    await runSoftwareEffect({ kind: 'open_pr' }, ctx({ job: job({ result: { status: 'ok', summary: hostile } }) }), fence());
    const body = [...host.prs.values()][0]!.body;
    const summary = body.split('\n\n')[1]!;
    expect(summary).toBe(
      `Done. cc @${ZW}octocat and @${ZW}org/team. Fixes #${ZW}12, closes #${ZW}3, Resolved  #${ZW}44, fix #${ZW}5 and FIXES #${ZW}6.`,
    );
    expect(body.startsWith('Closes #7\n\n')).toBe(true); // the factory's own closing reference is intact
    expect(summary).not.toMatch(/@\w/);
    expect(summary).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d/i);
  });

  it('PR body redacts a secret in the summary', async () => {
    const key = 'sk-ant-' + 'api03-' + 'summaryKey_0123456789abcdef';
    const known = 'operator-password-value';
    host.issues.get(ISSUE)!.title = `Add widgets ${known}`;
    const summary = `Done. I used ${key} and the password ${known}; cc @octocat.`;
    await runSoftwareEffect(
      { kind: 'open_pr' },
      ctx({ job: job({ result: { status: 'ok', summary } }), secretValues: () => [known] }),
      fence(),
    );
    const pr = [...host.prs.values()][0]!;
    expect(pr.body.split('\n\n')[1]).toBe('Done. I used [redacted] and the password [redacted]; cc @​octocat.');
    expect(pr.title).toBe('Add widgets [redacted]');
    expect(JSON.stringify(host.calls)).not.toContain(key);
    expect(JSON.stringify(host.calls)).not.toContain(known);
  });

  it('open_pr caps the agent summary at 2000 characters', async () => {
    const long = 'x'.repeat(5000);
    await runSoftwareEffect({ kind: 'open_pr' }, ctx({ job: job({ result: { status: 'ok', summary: long } }) }), fence());
    const summary = [...host.prs.values()][0]!.body.split('\n\n')[1]!;
    expect(summary.length).toBe(2000);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('open_pr body omits the summary when the job has no result', async () => {
    await runSoftwareEffect({ kind: 'open_pr' }, ctx(), fence());
    const pr = [...host.prs.values()][0]!;
    expect(pr.body).toBe('Closes #7\n\n<!-- factory:chain=3 job=42 event=open-pr -->');
  });

  it('set_labels sets specific labels and is repeatable', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    const onIssue: Effect = { kind: 'set_labels', target: 'issue', add: [LABEL_READY_FOR_MERGE], remove: [LABEL_IN_PROGRESS] };
    const onPr: Effect = { kind: 'set_labels', target: 'pr', add: [LABEL_READY_FOR_MERGE], remove: [] };
    for (let i = 0; i < 2; i++) {
      await runSoftwareEffect(onIssue, ctx(), fence());
      await runSoftwareEffect(onPr, ctx({ workspace: null }), fence());
    }
    expect(host.getLabels(ISSUE)).toEqual([LABEL_READY_FOR_MERGE]);
    expect(host.getLabels(pr.number)).toEqual([LABEL_READY_FOR_MERGE]);
  });

  it('set_labels on the pr target with no PR is an effect_error', async () => {
    const err = await runSoftwareEffect({ kind: 'set_labels', target: 'pr', add: ['x'], remove: [] }, ctx(), fence()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe('no PR found for label target');
  });

  it("merge_pr pins the review workspace's seed sha (the head the reviewer saw)", async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.setPrHead(pr.number, 'pushed-after-review');
    const review = job({ type: 'review' });
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: review }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('merge refused for the reviewed head: head commit changed');
    expect(host.calls.filter((c) => c.method === 'mergePr').map((c) => c.args)).toEqual([[REPO, pr.number, { expectHeadSha: 'seed' }]]);
    expect(host.prs.get(pr.number)?.state).toBe('open');

    host.setPrHead(pr.number, 'seed');
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: review }), fence());
    expect(host.prs.get(pr.number)?.state).toBe('merged');
  });

  it('merge_pr without a workspace throws runner_error and never calls mergePr', async () => {
    // After a crash resume or an effect_error retry the workspace is gone: no reviewed head to pin.
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.calls.length = 0;
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: job({ type: 'review' }), workspace: null }), fence()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('cannot verify the reviewed head; the review will be redone');
    expect(host.calls.map((c) => c.method)).not.toContain('mergePr');
    expect(host.prs.get(pr.number)?.state).toBe('open');
    expect(delays).toEqual([]);
  });

  it('merge_pr checks PR state first and is a no-op when already merged', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.setPrHead(pr.number, 'seed');
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence());
    expect(host.prs.get(pr.number)?.state).toBe('merged');
    host.calls.length = 0;
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence());
    expect(host.calls.map((c) => c.method)).toEqual(['findPrByHead']);
    // Also without a workspace: an already merged PR needs no pin.
    host.calls.length = 0;
    await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ workspace: null }), fence());
    expect(host.calls.map((c) => c.method)).toEqual(['findPrByHead']);
  });

  it('merge_pr on a closed unmerged PR is an effect_error', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.prs.get(pr.number)!.state = 'closed';
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe('PR is closed and cannot be merged');
  });

  it('a pinned merge refused by the host becomes runner_error', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    for (const status of [405, 409]) {
      host.failNext('mergePr', new GitHostError('Pull Request is not mergeable', status));
      const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx(), fence()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('runner_error');
      expect((err as Error).message).toBe('merge refused for the reviewed head: Pull Request is not mergeable');
      expect(host.prs.get(pr.number)?.state).toBe('open');
    }
    expect(delays).toEqual([]); // a 4xx is not retried

    // Real gh reports a refused --match-head-commit merge without an HTTP status: it is retried as
    // transient first, then classified runner_error.
    let attempts = 0;
    host.mergePr = async (_repo, _n, opts) => {
      attempts++;
      expect(opts).toEqual({ expectHeadSha: 'seed' });
      throw new GitHostError('GraphQL: Head branch was modified');
    };
    const err = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: job({ type: 'review' }) }), fence()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('runner_error');
    expect((err as Error).message).toBe('merge refused for the reviewed head: GraphQL: Head branch was modified');
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(host.prs.get(pr.number)?.state).toBe('open');
  });

  it('an unpinned merge failure stays effect_error', async () => {
    // No merge is attempted unpinned any more (no workspace is runner_error before mergePr), so the
    // effect_error cases left are the missing PR, the closed issue and the closed PR: unchanged.
    const review = job({ type: 'review' });
    const noPr = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: review, workspace: null }), fence()).catch((e: unknown) => e);
    expect(noPr).toBeInstanceOf(EffectError);
    expect((noPr as EffectError).reason).toBe('effect_error');
    expect((noPr as Error).message).toBe('no PR found to merge');

    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.issues.get(ISSUE)!.state = 'closed';
    const closedIssue = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: review, workspace: null }), fence()).catch(
      (e: unknown) => e,
    );
    expect(closedIssue).toBeInstanceOf(EffectError);
    expect((closedIssue as EffectError).reason).toBe('effect_error');
    expect((closedIssue as Error).message).toBe(`issue #${ISSUE} is closed`);

    host.prs.get(pr.number)!.state = 'closed';
    for (const workspace of [null, fakeWs]) {
      const closedPr = await runSoftwareEffect({ kind: 'merge_pr' }, ctx({ job: review, workspace }), fence()).catch((e: unknown) => e);
      expect(closedPr).toBeInstanceOf(EffectError);
      expect((closedPr as EffectError).reason).toBe('effect_error');
      expect((closedPr as Error).message).toBe('PR is closed and cannot be merged');
    }
    expect(host.calls.map((c) => c.method)).not.toContain('mergePr');
  });

  it('a GitHostError 404 on the issue becomes effect_error', async () => {
    host.issues.delete(ISSUE);
    const err = await runSoftwareEffect(
      { kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- m -->' },
      ctx(),
      fence(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect((err as Error).message).toBe('Not Found');
  });

  it('transient GitHostError is retried with backoff three times, then effect_error', async () => {
    for (const make of [() => new GitHostError('bad gateway', 502), () => new GitHostError('rate limited', 429), () => new GitHostError('network down')]) {
      delays = [];
      let attempts = 0;
      host.setLabels = async () => {
        attempts++;
        throw make();
      };
      const err = await runSoftwareEffect(
        { kind: 'set_labels', target: 'issue', add: ['x'], remove: [] },
        ctx(),
        fence(),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EffectError);
      expect((err as EffectError).reason).toBe('effect_error');
      expect((err as Error).message).toBe(make().message);
      expect(attempts).toBe(3);
      expect(delays).toEqual([100, 200]);
    }
  });

  it('a transient failure that recovers succeeds', async () => {
    host.failNext('setLabels', new GitHostError('bad gateway', 503));
    await runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx(), fence());
    expect(host.getLabels(ISSUE)).toContain('x');
    expect(delays).toEqual([100]);
  });

  it('a 404 is not retried', async () => {
    let attempts = 0;
    host.setLabels = async () => {
      attempts++;
      throw new GitHostError('Not Found', 404);
    };
    const err = await runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx(), fence()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EffectError);
    expect((err as EffectError).reason).toBe('effect_error');
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('non-GitHostError exceptions from the host propagate unchanged', async () => {
    const boom = new TypeError('boom');
    host.failNext('setLabels', boom);
    await expect(runSoftwareEffect({ kind: 'set_labels', target: 'issue', add: ['x'], remove: [] }, ctx(), fence())).rejects.toBe(boom);
    expect(delays).toEqual([]);
  });

  it('a stale fence stops the effect before it acts', async () => {
    await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    host.calls.length = 0;
    const effects: Effect[] = [
      { kind: 'commit_push' },
      { kind: 'open_pr' },
      { kind: 'set_labels', target: 'issue', add: ['x'], remove: [] },
      { kind: 'merge_pr' },
      { kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- m -->' },
    ];
    for (const e of effects) {
      await expect(runSoftwareEffect(e, ctx(), staleFence())).rejects.toBeInstanceOf(StaleDeliveryError);
    }
    expect(host.calls).toEqual([]);
    expect(rgit.calls).toEqual([]);
  });

  it('a fence that goes stale between the look and the act stops the mutation', async () => {
    let n = 0;
    const f: EffectFence = { jobId: 42, delivery: 1, assertCurrent: () => { if (++n > 1) throw new StaleDeliveryError(); } };
    await expect(
      runSoftwareEffect({ kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- m -->' }, ctx(), f),
    ).rejects.toBeInstanceOf(StaleDeliveryError);
    expect(host.getComments(ISSUE)).toEqual([]);
    expect(host.calls.map((c) => c.method)).toEqual(['findComment']);
  });

  it('comment skips when the marker already exists', async () => {
    await host.comment(REPO, ISSUE, 'earlier\n\n<!-- factory:chain=3 job=42 event=x -->');
    await runSoftwareEffect(
      { kind: 'comment', target: 'issue', body: 'hi', marker: '<!-- factory:chain=3 job=42 event=x -->' },
      ctx(),
      fence(),
    );
    expect(host.getComments(ISSUE)).toHaveLength(1);
  });

  it('comment posts body plus marker the first time', async () => {
    const pr = await host.openPr(REPO, { head: BRANCH, base: 'main', title: 't', body: 'b' });
    await runSoftwareEffect({ kind: 'comment', target: 'issue', body: 'hello', marker: '<!-- m1 -->' }, ctx(), fence());
    await runSoftwareEffect({ kind: 'comment', target: 'pr', body: 'on pr', marker: '<!-- m2 -->' }, ctx(), fence());
    expect(host.getComments(ISSUE)).toEqual(['hello\n\n<!-- m1 -->']);
    expect(host.getComments(pr.number)).toEqual(['on pr\n\n<!-- m2 -->']);
  });

  it('rejects an unknown effect kind as unsupported', async () => {
    await expect(runSoftwareEffect({ kind: 'bogus' }, ctx(), fence())).rejects.toThrow('unsupported effect: bogus');
    await expect(runSoftwareEffect({ kind: 'set_labels', target: 'nope' }, ctx(), fence())).rejects.toThrow(/invalid set_labels effect/);
    expect(host.calls).toEqual([]);
  });
});
