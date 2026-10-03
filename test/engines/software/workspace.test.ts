import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChainView, Job } from '../../../src/kernel/types.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { GitWorkspaceProvider } from '../../../src/engines/software/workspace.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from '../../support/temp-repo.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function chain(id: number, over: Partial<SoftwareState> = {}): ChainView<SoftwareState> {
  return {
    id, engine: 'software', subjectKey: 'k', status: 'active',
    state: { repo: 'acme/widgets', issueNumber: 7, labels: [], profile: 'supervised', branch: 'factory/issue-7', attempt: 1, phase: 'executing', ...over },
  };
}
function job(chainId: number, delivery: number, type = 'execute'): Job {
  return { id: 1, chainId, type, attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null, claimedBy: 'w', leaseExpiresAt: null, delivery, error: null };
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
    expect(ws.path).toBe(join(root, '1', 'd1'));
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
    expect(a.localBranch).toBe('factory/issue-7-d1');
    expect(b.localBranch).toBe('factory/issue-7-d2');
    expect(git(a.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('factory/issue-7-d1');
    writeFileSync(join(a.path, 'only-a.txt'), 'x');
    expect(existsSync(join(b.path, 'only-a.txt'))).toBe(false);
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
    const removed = await provider.sweep(new Set(['1:2']));
    expect(removed.sort()).toEqual([a.path, c.path].sort());
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(c.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(join(root, '.cache'))).toBe(true);
    expect(existsSync(join(root, 'junk', 'notes'))).toBe(true);
    const cache = join(root, '.cache', 'acme__widgets.git');
    expect(git(cache, ['branch', '--list', 'factory/issue-7-d1'])).toBe('');
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
    await expect(provider.teardown(chain(1, { repo: '../x/y' }), job(1, 1), 'ok')).rejects.toThrow(/repo/);
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
});
