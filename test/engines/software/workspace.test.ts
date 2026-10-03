import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChainView, Job } from '../../../src/kernel/types.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { ExecGitPorts } from '../../../src/engines/software/git-ports.js';
import { GitWorkspaceProvider } from '../../../src/engines/software/workspace.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from '../../support/temp-repo.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const HOUR = 3_600_000;

function chain(id: number, over: Partial<SoftwareState> = {}): ChainView<SoftwareState> {
  return {
    id, engine: 'software', subjectKey: 'k', status: 'active',
    state: { repo: 'acme/widgets', issueNumber: 7, labels: [], profile: 'supervised', branch: 'factory/issue-7', attempt: 1, phase: 'executing', ...over },
  };
}
function job(chainId: number, delivery: number, type = 'execute', id = 1): Job {
  return { id, chainId, type, attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null, claimedBy: 'w', leaseExpiresAt: null, delivery, error: null };
}

describe('GitWorkspaceProvider', () => {
  let remote: TempRemote;
  let root: string;
  let provider: GitWorkspaceProvider;
  const make = (keepOnFailure = true) =>
    new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure });

  beforeEach(() => {
    remote = makeRemote();
    root = mkdtempSync(join(tmpdir(), 'factory-ws-'));
    provider = make();
  });
  afterEach(() => {
    remote.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('seeds an execute delivery from the base branch when the remote branch is absent', async () => {
    const ws = await provider.prepare(chain(1), job(1, 1));
    const mainHead = git(remote.path, ['rev-parse', 'refs/heads/main']);
    expect(ws.remoteHeadSha).toBeNull();
    expect(ws.seedSha).toBe(mainHead);
    expect(ws.baseBranch).toBe('main');
    expect(ws.path).toBe(join(root, '1', 'j1-d1'));
    expect(ws.remoteBranch).toBe('factory/issue-7');
    expect(ws.remoteUrl).toBe(remote.url);
    expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect(git(ws.path, ['rev-parse', 'HEAD'])).toBe(mainHead);
  });

  it('seeds a revise delivery from the pushed remote branch head', async () => {
    const sha = remote.commit('factory/issue-7', 'src/a.txt', 'a\n');
    const ws = await provider.prepare(chain(1), job(1, 2));
    expect(ws.remoteHeadSha).toBe(sha);
    expect(ws.seedSha).toBe(sha);
    expect(readFileSync(join(ws.path, 'src/a.txt'), 'utf8')).toBe('a\n');
  });

  it('seeds a review delivery from the PR head', async () => {
    const sha = remote.commit('factory/issue-7', 'pr.txt', 'pr\n');
    const ws = await provider.prepare(chain(1), job(1, 3, 'review'));
    expect(ws.seedSha).toBe(sha);
    expect(ws.remoteHeadSha).toBe(sha);
    expect(existsSync(join(ws.path, 'pr.txt'))).toBe(true);
  });

  it('gives each delivery its own path and local branch factory/issue-<n>-d<delivery>', async () => {
    const a = await provider.prepare(chain(1), job(1, 1));
    const b = await provider.prepare(chain(1), job(1, 2));
    expect(a.path).not.toBe(b.path);
    expect(a.localBranch).toBe('factory/issue-7-c1-j1-d1');
    expect(b.localBranch).toBe('factory/issue-7-c1-j1-d2');
    expect(git(a.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('factory/issue-7-c1-j1-d1');
    writeFileSync(join(a.path, 'only-a.txt'), 'x');
    expect(existsSync(join(b.path, 'only-a.txt'))).toBe(false);
  });

  it('two jobs of one chain use distinct workspace paths and branches even at the same delivery number', async () => {
    const exec = await provider.prepare(chain(1), job(1, 1, 'execute', 1));
    writeFileSync(join(exec.path, 'in-flight.txt'), 'x');
    const review = await provider.prepare(chain(1), job(1, 1, 'review', 2));
    expect(exec.path).toBe(join(root, '1', 'j1-d1'));
    expect(review.path).toBe(join(root, '1', 'j2-d1'));
    expect(exec.localBranch).toBe('factory/issue-7-c1-j1-d1');
    expect(review.localBranch).toBe('factory/issue-7-c1-j2-d1');
    // The second prepare neither removed nor reused the first job's worktree.
    expect(existsSync(join(exec.path, 'in-flight.txt'))).toBe(true);
    expect(git(exec.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('factory/issue-7-c1-j1-d1');
    expect(existsSync(join(review.path, 'in-flight.txt'))).toBe(false);
    // Tearing one down leaves the other.
    await provider.teardown(chain(1), job(1, 1, 'review', 2), 'ok');
    expect(existsSync(review.path)).toBe(false);
    expect(existsSync(join(exec.path, 'in-flight.txt'))).toBe(true);
  });

  it('disables the push URL on the workspace remote', async () => {
    const ws = await provider.prepare(chain(1), job(1, 1));
    writeFileSync(join(ws.path, 'x.txt'), 'x');
    git(ws.path, ['add', '.']);
    git(ws.path, ['commit', '-m', 'x']);
    expect(() => git(ws.path, ['push', 'origin', `HEAD:refs/heads/${ws.remoteBranch}`])).toThrow();
    expect(git(remote.path, ['branch', '--list', 'factory/issue-7'])).toBe('');
    // the engine pushes explicitly to the real URL
    git(ws.path, ['push', ws.remoteUrl, `HEAD:refs/heads/${ws.remoteBranch}`]);
    expect(git(remote.path, ['branch', '--list', 'factory/issue-7'])).toContain('factory/issue-7');
  });

  it('teardown removes the worktree and local branch on success', async () => {
    const ws = await provider.prepare(chain(1), job(1, 1));
    await provider.teardown(chain(1), job(1, 1), 'ok');
    expect(existsSync(ws.path)).toBe(false);
    const cache = join(root, '.cache', 'acme__widgets.git');
    expect(git(cache, ['branch', '--list', ws.localBranch])).toBe('');
    expect(git(cache, ['worktree', 'list'])).not.toContain('d1');
    await expect(provider.teardown(chain(1), job(1, 1), 'ok')).resolves.toBeUndefined();
  });

  it('teardown keeps the worktree on failure when keepOnFailure is true', async () => {
    const ws = await provider.prepare(chain(1), job(1, 1));
    await provider.teardown(chain(1), job(1, 1), 'failed');
    expect(existsSync(ws.path)).toBe(true);
  });

  it('teardown removes the worktree on failure when keepOnFailure is false', async () => {
    const p = make(false);
    const ws = await p.prepare(chain(1), job(1, 1));
    await p.teardown(chain(1), job(1, 1), 'failed');
    expect(existsSync(ws.path)).toBe(false);
  });

  it('sweep removes worktrees that belong to no live delivery and keeps live ones', async () => {
    const a = await provider.prepare(chain(1), job(1, 1));
    const b = await provider.prepare(chain(1), job(1, 2));
    const c = await provider.prepare(chain(2, { issueNumber: 8 }), job(2, 1));
    mkdirSync(join(root, 'junk', 'notes'), { recursive: true });
    const removed = await provider.sweep(new Set(['1:1:2']), Date.now() + HOUR); // past the sweep grace
    expect(removed.sort()).toEqual([a.path, c.path].sort());
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(c.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(join(root, '.cache'))).toBe(true);
    expect(existsSync(join(root, 'junk', 'notes'))).toBe(true);
    const cache = join(root, '.cache', 'acme__widgets.git');
    expect(git(cache, ['branch', '--list', 'factory/issue-7-c1-j1-d1'])).toBe('');
  });

  it('prepare is idempotent for the same delivery', async () => {
    const first = await provider.prepare(chain(1), job(1, 1));
    writeFileSync(join(first.path, 'dirty.txt'), 'x');
    git(first.path, ['add', '.']);
    git(first.path, ['commit', '-m', 'wip']);
    const second = await provider.prepare(chain(1), job(1, 1));
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'dirty.txt'))).toBe(false);
    expect(git(second.path, ['rev-parse', 'HEAD'])).toBe(second.seedSha);
  });

  it('rejects a repo or issue number that would escape the workspace root', async () => {
    await expect(provider.prepare(chain(1, { repo: '../evil/x' }), job(1, 1))).rejects.toThrow(/repo/);
    await expect(provider.prepare(chain(1, { repo: 'a/b/../../c' }), job(1, 1))).rejects.toThrow(/repo/);
    await expect(provider.prepare(chain(1, { issueNumber: -1 }), job(1, 1))).rejects.toThrow(/issue/);
    await expect(provider.prepare(chain(1, { issueNumber: 1.5 }), job(1, 1))).rejects.toThrow(/issue/);
    await expect(provider.prepare(chain(1), job(1, -2))).rejects.toThrow(/delivery/);
    await expect(provider.prepare(chain(1.5), job(1, 1))).rejects.toThrow(/chain/);
    await expect(provider.prepare(chain(1), job(1, 1, 'execute', 0))).rejects.toThrow(/job id/);
    await expect(provider.prepare(chain(1), job(1, 1, 'execute', 2.5))).rejects.toThrow(/job id/);
    await expect(provider.teardown(chain(1, { repo: '../x/y' }), job(1, 1), 'ok')).rejects.toThrow(/repo/);
  });

  it('prepares delivery 1 of a resubmitted issue while a failed delivery of an earlier chain is kept', async () => {
    const a = await provider.prepare(chain(1), job(1, 1));
    await provider.teardown(chain(1), job(1, 1), 'failed');
    expect(existsSync(a.path)).toBe(true);
    const b = await provider.prepare(chain(2), job(2, 1));
    expect(b.path).not.toBe(a.path);
    expect(b.localBranch).not.toBe(a.localBranch);
    expect(b.localBranch).toBe('factory/issue-7-c2-j1-d1');
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });

  it('serialises concurrent prepares of the same repo across providers', async () => {
    const p2 = make();
    const p3 = make();
    const ps = [provider, p2, p3];
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((d) => ps[d % 3]!.prepare(chain(1), job(1, d))),
    );
    expect(new Set(results.map((r) => r.path)).size).toBe(6);
    for (const r of results) expect(existsSync(join(r.path, 'README.md'))).toBe(true);
    expect(existsSync(join(root, '.cache', 'acme__widgets.git.lock'))).toBe(false);
  });

  it('repairs a half-initialised cache that has no origin remote', async () => {
    const cache = join(root, '.cache', 'acme__widgets.git');
    mkdirSync(join(root, '.cache'), { recursive: true });
    git(root, ['init', '--bare', cache]);
    const ws = await provider.prepare(chain(1), job(1, 1));
    expect(existsSync(join(ws.path, 'README.md'))).toBe(true);
    expect(git(cache, ['remote', 'get-url', 'origin'])).toBe(remote.url);
  });

  it('breaks a stale lock held by a dead pid', async () => {
    const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const lock = join(root, '.cache', 'acme__widgets.git.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), dead.trim());
    const p = new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: true, lockWaitMs: 2000, lockPollMs: 10 });
    const ws = await p.prepare(chain(1), job(1, 1));
    expect(existsSync(ws.path)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('times out with a clear error when a live holder keeps the lock', async () => {
    const lock = join(root, '.cache', 'acme__widgets.git.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid));
    const p = new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: true, lockWaitMs: 200, lockPollMs: 10 });
    await expect(p.prepare(chain(1), job(1, 1))).rejects.toThrow(/acme__widgets\.git\.lock/);
    expect(existsSync(lock)).toBe(true);
  });

  it('an empty or unreadable lock pid file defers to the lock age instead of being stale at once', async () => {
    const lock = join(root, '.cache', 'acme__widgets.git.lock');
    const make = () =>
      new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: true, lockWaitMs: 100, lockPollMs: 10, lockStaleMs: 60_000 });
    for (const setup of [
      () => writeFileSync(join(lock, 'pid'), ''), // the holder is between mkdir and writing its pid
      () => writeFileSync(join(lock, 'pid'), 'garbage'),
      () => undefined, // no pid file yet
    ]) {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { recursive: true });
      setup();
      // Young lock: respected (the wait times out, the lock stays).
      await expect(make().prepare(chain(1), job(1, 1))).rejects.toThrow(/timed out waiting for cache lock/);
      expect(existsSync(lock)).toBe(true);
    }
    // Old lock: broken by age.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const ws = await make().prepare(chain(1), job(1, 1));
    expect(existsSync(ws.path)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('picks up a commit pushed to the remote between two prepares', async () => {
    const first = await provider.prepare(chain(1), job(1, 1));
    expect(first.remoteHeadSha).toBeNull();
    const sha = remote.commit('factory/issue-7', 'late.txt', 'late\n');
    const second = await provider.prepare(chain(1), job(1, 2));
    expect(second.remoteHeadSha).toBe(sha);
    expect(second.seedSha).toBe(sha);
    expect(existsSync(join(second.path, 'late.txt'))).toBe(true);
  });

  describe('sanitizeConfig (shared cache config the agent can write)', () => {
    const cacheOf = () => join(root, '.cache', 'acme__widgets.git');
    const localKeys = (cache: string) => git(cache, ['config', '--local', '--list', '--name-only']).split('\n').filter(Boolean);
    const poison = (cache: string, decoy: string) => {
      git(cache, ['config', `url.${decoy}.insteadOf`, remote.url]);
      git(cache, ['config', `url.${decoy}.pushInsteadOf`, remote.url]);
      git(cache, ['config', 'credential.helper', '!echo steal']);
      git(cache, ['config', 'core.sshCommand', 'ssh -i /tmp/stolen-key']);
      git(cache, ['config', 'core.fsmonitor', 'touch /tmp/factory-pwned']);
      git(cache, ['config', 'include.path', '/nonexistent/evil.inc']);
    };

    it('removes poisoned keys and keeps the allowed ones', async () => {
      const ws = await provider.prepare(chain(1), job(1, 1));
      const cache = cacheOf();
      const decoy = join(root, 'decoy.git');
      poison(cache, decoy);
      git(cache, ['config', 'extensions.worktreeConfig', 'true']);
      const admin = git(ws.path, ['rev-parse', '--git-dir']);
      writeFileSync(join(admin, 'config.worktree'), '[credential]\n\thelper = !echo steal\n');
      git(cache, ['config', 'gc.auto', '0']);

      await provider.sanitizeConfig('acme/widgets');

      const keys = localKeys(cache);
      for (const bad of [
        `url.${decoy}.insteadof`,
        `url.${decoy}.pushinsteadof`,
        'credential.helper',
        'core.sshcommand',
        'core.fsmonitor',
        'include.path',
        'extensions.worktreeconfig',
      ]) {
        expect(keys, bad).not.toContain(bad);
      }
      expect(keys).toEqual(
        expect.arrayContaining([
          'core.repositoryformatversion', 'core.bare', 'remote.origin.url', 'remote.origin.fetch',
          'remote.origin.pushurl', 'user.name', 'user.email', 'gc.auto',
        ]),
      );
      expect(git(cache, ['config', 'remote.origin.url'])).toBe(remote.url);
      expect(git(cache, ['config', 'remote.origin.pushurl'])).toBe('no_push://disabled');
      expect(existsSync(join(admin, 'config.worktree'))).toBe(false);
    });

    it('prepare sanitizes the cache config before it fetches', async () => {
      await provider.prepare(chain(1), job(1, 1));
      const cache = cacheOf();
      poison(cache, join(root, 'decoy.git'));
      await provider.prepare(chain(1), job(1, 2));
      const keys = localKeys(cache);
      expect(keys).not.toContain('credential.helper');
      expect(keys.some((k) => k.startsWith('url.'))).toBe(false);
    });

    it('a push after sanitizing uses the real URL', async () => {
      const decoy = join(root, 'decoy.git');
      git(root, ['init', '--bare', decoy]);
      const ws = await provider.prepare(chain(1), job(1, 1));
      writeFileSync(join(ws.path, 'x.txt'), 'x\n');
      const plain = new ExecGitPorts();
      await plain.commitAll(ws, 'work');
      git(cacheOf(), ['config', `url.${decoy}.pushInsteadOf`, remote.url]);

      // Without sanitizing, the poisoned config redirects the engine's push to the decoy.
      await plain.push(ws, { remoteBranch: 'factory/issue-7', expectSha: null });
      expect(git(decoy, ['branch', '--list', 'factory/issue-7'])).toContain('factory/issue-7');
      expect(git(remote.path, ['branch', '--list', 'factory/issue-7'])).toBe('');

      const safe = new ExecGitPorts({ prepareForPush: (w) => provider.sanitizeForPush(w) });
      await safe.prepareForPush(ws);
      await safe.push(ws, { remoteBranch: 'factory/issue-7', expectSha: null });
      expect(git(remote.path, ['rev-parse', 'refs/heads/factory/issue-7'])).toBe(git(ws.path, ['rev-parse', 'HEAD']));
    });

    it('sanitizeForPush refuses a worktree whose .git file was redirected', async () => {
      const ws = await provider.prepare(chain(1), job(1, 1));
      const elsewhere = join(root, 'elsewhere.git');
      git(root, ['init', '--bare', elsewhere]);
      writeFileSync(join(ws.path, '.git'), `gitdir: ${elsewhere}\n`);
      await expect(provider.sanitizeForPush(ws)).rejects.toThrow(/not a worktree of the factory cache/);
    });

    it('runs its own git commands with hooks disabled', async () => {
      await provider.prepare(chain(1), job(1, 1));
      const marker = join(root, 'hook-ran');
      const hook = join(cacheOf(), 'hooks', 'post-checkout');
      mkdirSync(join(cacheOf(), 'hooks'), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      await provider.prepare(chain(1), job(1, 2));
      expect(existsSync(marker)).toBe(false);
    });
  });

  it('a hung fetch is killed at networkTimeoutMs and prepare fails with a clear error', async () => {
    const proxy = join(root, 'proxy.sh');
    writeFileSync(proxy, '#!/bin/sh\nexec cat 3>&1 > /dev/null\n', { mode: 0o755 });
    const saved = process.env.GIT_PROXY_COMMAND;
    process.env.GIT_PROXY_COMMAND = proxy;
    try {
      const p = new GitWorkspaceProvider({
        cloneUrlFor: () => 'git://factory-test.invalid/r.git', root, keepOnFailure: false, networkTimeoutMs: 100,
      });
      const started = process.hrtime.bigint();
      await expect(p.prepare(chain(1), job(1, 1))).rejects.toThrow(/git fetch origin --prune timed out after 100 ms/);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
    } finally {
      if (saved === undefined) delete process.env.GIT_PROXY_COMMAND;
      else process.env.GIT_PROXY_COMMAND = saved;
    }
  });

  describe('sweep races', () => {
    it('re-checks liveness inside the cache lock: a delivery that became live after the snapshot is kept', async () => {
      const a = await provider.prepare(chain(1), job(1, 1));
      const b = await provider.prepare(chain(1), job(1, 2));
      const lock = join(root, '.cache', 'acme__widgets.git.lock');
      const calls: Array<{ key: string; locked: boolean }> = [];
      // 1:1:2 is not live in the first look, then a concurrent claim makes it live.
      const isLive = (key: string): boolean => {
        const seen = calls.filter((c) => c.key === key).length;
        calls.push({ key, locked: existsSync(lock) });
        return key === '1:1:2' && seen > 0;
      };
      const removed = await provider.sweep(isLive, Date.now() + HOUR);
      expect(removed).toEqual([a.path]);
      expect(existsSync(a.path)).toBe(false);
      expect(existsSync(b.path)).toBe(true);
      // The deciding look happens while the cache lock is held.
      expect(calls.filter((c) => c.key === '1:1:2')).toEqual([
        { key: '1:1:2', locked: false },
        { key: '1:1:2', locked: true },
      ]);
    });

    it('keeps delivery directories modified within sweepGraceMs (default 10 minutes) and removes older ones', async () => {
      const a = await provider.prepare(chain(1), job(1, 1));
      const mtime = statSync(a.path).mtimeMs;
      expect(await provider.sweep(new Set(), mtime + 9 * 60_000)).toEqual([]);
      expect(existsSync(a.path)).toBe(true);
      expect(await provider.sweep(new Set(), mtime + 11 * 60_000)).toEqual([a.path]);
      expect(existsSync(a.path)).toBe(false);

      const short = new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: true, sweepGraceMs: 1_000 });
      const b = await short.prepare(chain(1), job(1, 2));
      const bm = statSync(b.path).mtimeMs;
      expect(await short.sweep(new Set(), bm + 500)).toEqual([]);
      expect(await short.sweep(new Set(), bm + 2_000)).toEqual([b.path]);
    });
  });
});
