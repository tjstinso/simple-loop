import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StaleDeliveryError, type ChainView, type Job } from '../../../src/kernel/types.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { GitWorkspaceProvider, type SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import { ExecGitPorts, GIT_LOCAL_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_MS } from '../../../src/engines/software/git-ports.js';
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_WAIT_MS } from '../../../src/engines/software/workspace.js';
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
    await ports.push(ws, { sha: await ports.headSha(ws), remoteBranch: 'factory/issue-7', expectSha: null });
    expect(remoteHead('factory/issue-7')).toBe(first);

    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    await ports.commitAll(ws, 'b');
    await expect(ports.push(ws, { sha: await ports.headSha(ws), remoteBranch: 'factory/issue-7', expectSha: null })).rejects.toBeInstanceOf(StaleDeliveryError);
    expect(remoteHead('factory/issue-7')).toBe(first);
  });

  it('push with the correct expected sha succeeds', async () => {
    writeFileSync(join(ws.path, 'a.txt'), 'a\n');
    await ports.commitAll(ws, 'a');
    const first = await ports.headSha(ws);
    await ports.push(ws, { sha: await ports.headSha(ws), remoteBranch: 'factory/issue-7', expectSha: null });
    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    await ports.commitAll(ws, 'b');
    const second = await ports.headSha(ws);
    await ports.push(ws, { sha: await ports.headSha(ws), remoteBranch: 'factory/issue-7', expectSha: first });
    expect(remoteHead('factory/issue-7')).toBe(second);
  });

  it('push fails as StaleDeliveryError when the remote branch moved', async () => {
    const seeded = remote.commit('factory/issue-7', 'seed.txt', 's\n');
    const ws2 = await new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: false }).prepare(chain, job(2));
    expect(ws2.remoteHeadSha).toBe(seeded);
    const moved = remote.commit('factory/issue-7', 'other.txt', 'o\n');
    writeFileSync(join(ws2.path, 'mine.txt'), 'm\n');
    await ports.commitAll(ws2, 'mine');
    await expect(ports.push(ws2, { sha: await ports.headSha(ws2), remoteBranch: 'factory/issue-7', expectSha: ws2.remoteHeadSha })).rejects.toBeInstanceOf(
      StaleDeliveryError,
    );
    expect(remoteHead('factory/issue-7')).toBe(moved);
  });

  it('other push failures throw a plain Error with git stderr', async () => {
    const broken = { ...ws, remoteUrl: join(root, 'does-not-exist.git') };
    const err = await ports.push(broken, { sha: ws.seedSha, remoteBranch: 'factory/issue-7', expectSha: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StaleDeliveryError);
    expect((err as Error).message).toMatch(/does-not-exist/);
  });

  it('rejects a remote branch name that could be read as an option or a bad ref', async () => {
    await expect(ports.push(ws, { sha: await ports.headSha(ws), remoteBranch: '--delete', expectSha: null })).rejects.toThrow(/invalid remote branch/);
    await expect(ports.push(ws, { sha: await ports.headSha(ws), remoteBranch: 'a b', expectSha: null })).rejects.toThrow(/invalid remote branch/);
  });

  it('a git network command that hangs is killed at networkTimeoutMs, with ssh in batch mode', async () => {
    // GIT_PROXY_COMMAND makes git:// go through this script, which records the environment and then
    // never answers (fd 3 keeps its stdout pipe to git open; it exits when git dies and closes its stdin).
    const envFile = join(root, 'proxy-env');
    const proxy = join(root, 'proxy.sh');
    writeFileSync(proxy, `#!/bin/sh\necho "$GIT_SSH_COMMAND" > ${envFile}\nexec cat 3>&1 > /dev/null\n`, { mode: 0o755 });
    const saved = process.env.GIT_PROXY_COMMAND;
    process.env.GIT_PROXY_COMMAND = proxy;
    try {
      writeFileSync(join(ws.path, 'n.txt'), 'n\n');
      const p = new ExecGitPorts({ networkTimeoutMs: 100 });
      await p.commitAll(ws, 'n');
      const started = process.hrtime.bigint();
      await expect(p.push({ ...ws, remoteUrl: 'git://factory-test.invalid/r.git' }, { sha: await p.headSha(ws), remoteBranch: 'factory/issue-7', expectSha: null })).rejects.toThrow(
        /git push timed out after 100 ms/,
      );
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
      expect(readFileSync(envFile, 'utf8').trim()).toBe('ssh -o BatchMode=yes');
    } finally {
      if (saved === undefined) delete process.env.GIT_PROXY_COMMAND;
      else process.env.GIT_PROXY_COMMAND = saved;
    }
  });

  describe('addedChanges', () => {
    it('returns the added paths and added lines of an uncommitted change after commitAll, not deleted or unchanged files', async () => {
      git(ws.path, ['rm', '-q', 'README.md']);
      writeFileSync(join(ws.path, 'new.txt'), 'first line\nsecond line\n');
      mkdirSync(join(ws.path, 'dir'));
      writeFileSync(join(ws.path, 'dir', 'b.txt'), 'bee\n');
      writeFileSync(join(ws.path, 'odd\nname.txt'), 'odd\n');
      await ports.commitAll(ws, 'work');
      const c = await ports.addedChanges(ws, await ports.headSha(ws));
      expect([...c.paths].sort()).toEqual(['dir/b.txt', 'new.txt', 'odd\nname.txt']);
      const lines = c.text.split('\n');
      expect(lines).toEqual(expect.arrayContaining(['first line', 'second line', 'bee', 'odd']));
      expect(lines).not.toContain('hello'); // README.md's deleted line
      expect(c.text).not.toMatch(/^\+\+\+|^---|^@@|^diff --git/m);
      expect(c.truncated).toBe(false);
    });

    it('keeps only the added lines of a modified file', async () => {
      writeFileSync(join(ws.path, 'README.md'), 'hello\nadded below\n');
      await ports.commitAll(ws, 'edit');
      const c = await ports.addedChanges(ws, await ports.headSha(ws));
      expect(c.paths).toEqual(['README.md']);
      expect(c.text.split('\n')).toContain('added below');
      expect(c.text.split('\n')).not.toContain('hello');
    });

    it('covers commits the agent made itself, including a file added in one commit and deleted in the next', async () => {
      writeFileSync(join(ws.path, '.env'), 'PLANTED=agent-commit-value\n');
      git(ws.path, ['add', '.']);
      git(ws.path, ['commit', '-q', '-m', 'agent message line']);
      git(ws.path, ['rm', '-q', '.env']);
      git(ws.path, ['commit', '-q', '-m', 'remove it again']);
      writeFileSync(join(ws.path, 'later.txt'), '++starts with two pluses\n');
      await ports.commitAll(ws, 'leftover');
      const c = await ports.addedChanges(ws, await ports.headSha(ws));
      expect([...c.paths].sort()).toEqual(['.env', 'later.txt']);
      const lines = c.text.split('\n');
      expect(lines).toContain('PLANTED=agent-commit-value');
      expect(lines).toContain('++starts with two pluses');
      // Commit metadata is pushed too.
      expect(lines).toContain('agent message line');
    });

    it('reads every header of a hand-built commit object, not only author, committer and message', async () => {
      const tree = git(ws.path, ['rev-parse', 'HEAD^{tree}']);
      const obj =
        `tree ${tree}\nparent ${ws.seedSha}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\n` +
        'x-note custom-header-value\nencoding encoding-header-value\n\nplain message\n';
      const c = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: ws.path, env: GIT_TEST_ENV, input: obj, encoding: 'utf8' }).trim();
      git(ws.path, ['reset', '-q', '--soft', c]);
      const changes = await ports.addedChanges(ws, c);
      expect(changes.text).toContain('custom-header-value');
      expect(changes.text).toContain('encoding-header-value');
      expect(changes.text).toContain('plain message');
    });

    it('a .gitattributes in the change cannot hide a text file from the scan', async () => {
      writeFileSync(join(ws.path, '.gitattributes'), 'hidden.txt -diff\n');
      writeFileSync(join(ws.path, 'hidden.txt'), 'hidden content\n');
      await ports.commitAll(ws, 'attrs');
      const c = await ports.addedChanges(ws, await ports.headSha(ws));
      expect(c.text.split('\n')).toContain('hidden content');
    });

    it("scans a binary file's content as text", async () => {
      writeFileSync(join(ws.path, 'blob.bin'), Buffer.from([0, 1, 2, 0, 0x41, 0x42, 0x43, 0x0a]));
      await ports.commitAll(ws, 'bin');
      const c = await ports.addedChanges(ws, await ports.headSha(ws));
      expect(c.paths).toEqual(['blob.bin']);
      expect(c.text).toContain('ABC');
    });

    it('a file marked binary in the shared info/attributes is still scanned', async () => {
      const common = git(ws.path, ['rev-parse', '--git-common-dir']);
      const infoDir = join(isAbsolute(common) ? common : join(ws.path, common), 'info');
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(join(infoDir, 'attributes'), '* -diff binary\n');
      writeFileSync(join(ws.path, 'plain.txt'), 'marked binary by info/attributes\n');
      await ports.commitAll(ws, 'info');
      const c = await ports.addedChanges(ws, await ports.headSha(ws));
      expect(c.text.split('\n')).toContain('marked binary by info/attributes');
    });

    it('stops at the cap and reports the change as truncated', async () => {
      writeFileSync(join(ws.path, 'big.txt'), 'y'.repeat(200) + '\n');
      const small = new ExecGitPorts({ scanCapBytes: 64 });
      await small.commitAll(ws, 'big');
      const c = await small.addedChanges(ws, await ports.headSha(ws));
      expect(c.truncated).toBe(true);
      expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(64);
      expect((await new ExecGitPorts({ scanCapBytes: 4096 }).addedChanges(ws, await ports.headSha(ws))).truncated).toBe(false);
    });

    it('scans up to the given sha only, and push sends that sha, not a later HEAD', async () => {
      writeFileSync(join(ws.path, 'first.txt'), 'first\n');
      await ports.commitAll(ws, 'first');
      const pinned = await ports.headSha(ws);
      writeFileSync(join(ws.path, 'second.txt'), 'second\n');
      await ports.commitAll(ws, 'second');
      const c = await ports.addedChanges(ws, pinned);
      expect(c.paths).toEqual(['first.txt']);
      expect(c.text.split('\n')).not.toContain('second');
      await ports.push(ws, { sha: pinned, remoteBranch: 'factory/issue-7', expectSha: null });
      expect(remoteHead('factory/issue-7')).toBe(pinned);
    });

    it('rejects a sha that is not a full object id', async () => {
      await expect(ports.addedChanges(ws, 'HEAD')).rejects.toThrow(/invalid/);
      await expect(ports.push(ws, { sha: '--all', remoteBranch: 'factory/issue-7', expectSha: null })).rejects.toThrow(/invalid/);
    });

    it('is empty when HEAD is the seed', async () => {
      expect(await ports.addedChanges(ws, await ports.headSha(ws))).toEqual({ paths: [], text: '', truncated: false });
    });
  });

  it('timeout defaults stay below the documented limits', () => {
    expect(GIT_LOCAL_TIMEOUT_MS).toBe(60_000);
    expect(GIT_NETWORK_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_LOCK_STALE_MS).toBe(600_000);
    expect(DEFAULT_LOCK_WAIT_MS).toBe(600_000);
    // A fetch under the cache lock ends (or is killed) before the lock could be judged stale.
    expect(GIT_NETWORK_TIMEOUT_MS).toBeLessThan(DEFAULT_LOCK_STALE_MS);
  });
});
