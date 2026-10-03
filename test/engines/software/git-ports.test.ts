import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StaleDeliveryError, type ChainView, type Job } from '../../../src/kernel/types.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { GitWorkspaceProvider, type SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import { ExecGitPorts } from '../../../src/engines/software/git-ports.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from '../../support/temp-repo.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const chain: ChainView<SoftwareState> = {
  id: 1, engine: 'software', subjectKey: 'k', status: 'active',
  state: { repo: 'acme/widgets', issueNumber: 7, labels: [], profile: 'supervised', branch: 'factory/issue-7', attempt: 1, phase: 'executing' },
};
const job = (delivery: number): Job => ({
  id: 1, chainId: 1, type: 'execute', attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null,
  claimedBy: 'w', leaseExpiresAt: null, delivery, error: null,
});

describe('ExecGitPorts', () => {
  let remote: TempRemote;
  let root: string;
  let ws: SoftwareWorkspace;
  const ports = new ExecGitPorts();
  const remoteHead = (branch: string) => git(remote.path, ['rev-parse', `refs/heads/${branch}`]);

  beforeEach(async () => {
    remote = makeRemote();
    root = mkdtempSync(join(tmpdir(), 'factory-gp-'));
    ws = await new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: false }).prepare(chain, job(1));
  });
  afterEach(() => {
    remote.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('commitAll returns false on a clean tree and true when dirty', async () => {
    expect(await ports.commitAll(ws, 'nothing')).toBe(false);
    expect(await ports.headSha(ws)).toBe(ws.seedSha);
    writeFileSync(join(ws.path, 'new.txt'), 'x\n');
    expect(await ports.commitAll(ws, '-m --evil "title"\n\nbody')).toBe(true);
    const head = await ports.headSha(ws);
    expect(head).not.toBe(ws.seedSha);
    expect(git(ws.path, ['rev-parse', 'HEAD^'])).toBe(ws.seedSha);
    expect(git(ws.path, ['log', '-1', '--format=%s'])).toBe('-m --evil "title"');
    expect(git(ws.path, ['log', '-1', '--format=%an <%ae>'])).toBe('factory <factory@localhost>');
    expect(git(ws.path, ['status', '--porcelain'])).toBe('');
    expect(await ports.commitAll(ws, 'again')).toBe(false);
  });

  it('headSha returns the full sha of HEAD', async () => {
    expect(await ports.headSha(ws)).toMatch(/^[0-9a-f]{40}$/);
    expect(await ports.headSha(ws)).toBe(git(ws.path, ['rev-parse', 'HEAD']));
  });

  it('push with expectSha null creates an absent branch; a second null push of a new commit is stale', async () => {
    writeFileSync(join(ws.path, 'a.txt'), 'a\n');
    await ports.commitAll(ws, 'a');
    const first = await ports.headSha(ws);
    await ports.push(ws, { remoteBranch: 'factory/issue-7', expectSha: null });
    expect(remoteHead('factory/issue-7')).toBe(first);

    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    await ports.commitAll(ws, 'b');
    await expect(ports.push(ws, { remoteBranch: 'factory/issue-7', expectSha: null })).rejects.toBeInstanceOf(StaleDeliveryError);
    expect(remoteHead('factory/issue-7')).toBe(first);
  });

  it('push with the correct expected sha succeeds', async () => {
    writeFileSync(join(ws.path, 'a.txt'), 'a\n');
    await ports.commitAll(ws, 'a');
    const first = await ports.headSha(ws);
    await ports.push(ws, { remoteBranch: 'factory/issue-7', expectSha: null });
    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    await ports.commitAll(ws, 'b');
    const second = await ports.headSha(ws);
    await ports.push(ws, { remoteBranch: 'factory/issue-7', expectSha: first });
    expect(remoteHead('factory/issue-7')).toBe(second);
  });

  it('push fails as StaleDeliveryError when the remote branch moved', async () => {
    const seeded = remote.commit('factory/issue-7', 'seed.txt', 's\n');
    const ws2 = await new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: false }).prepare(chain, job(2));
    expect(ws2.remoteHeadSha).toBe(seeded);
    const moved = remote.commit('factory/issue-7', 'other.txt', 'o\n');
    writeFileSync(join(ws2.path, 'mine.txt'), 'm\n');
    await ports.commitAll(ws2, 'mine');
    await expect(ports.push(ws2, { remoteBranch: 'factory/issue-7', expectSha: ws2.remoteHeadSha })).rejects.toBeInstanceOf(
      StaleDeliveryError,
    );
    expect(remoteHead('factory/issue-7')).toBe(moved);
  });

  it('other push failures throw a plain Error with git stderr', async () => {
    const broken = { ...ws, remoteUrl: join(root, 'does-not-exist.git') };
    const err = await ports.push(broken, { remoteBranch: 'factory/issue-7', expectSha: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StaleDeliveryError);
    expect((err as Error).message).toMatch(/does-not-exist/);
  });

  it('rejects a remote branch name that could be read as an option or a bad ref', async () => {
    await expect(ports.push(ws, { remoteBranch: '--delete', expectSha: null })).rejects.toThrow(/invalid remote branch/);
    await expect(ports.push(ws, { remoteBranch: 'a b', expectSha: null })).rejects.toThrow(/invalid remote branch/);
  });
});
