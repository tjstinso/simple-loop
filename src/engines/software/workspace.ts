import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChainView, Job, WorkspaceProvider } from '../../kernel/types.js';
import type { Workspace } from '../../runner/types.js';
import type { SoftwareState } from './state.js';

export interface SoftwareWorkspace extends Workspace {
  path: string;
  localBranch: string;
  remoteBranch: string;
  remoteUrl: string;
  /** Sha of the remote factory/issue-<n> branch at prepare time; null when it does not exist. */
  remoteHeadSha: string | null;
  /** The commit the worktree was created at. */
  seedSha: string;
  baseBranch: string;
}

export interface GitWorkspaceOptions {
  cloneUrlFor(repo: string): string;
  root: string;
  keepOnFailure: boolean;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DISABLED_PUSH_URL = 'no_push://disabled';

interface Ids {
  repo: string;
  chainId: number;
  delivery: number;
  issue: number;
}

function ids(chain: ChainView<SoftwareState>, job: Job): Ids {
  const { repo, issueNumber } = chain.state;
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error(`invalid repo: ${JSON.stringify(repo)}`);
  }
  if (!Number.isSafeInteger(chain.id) || chain.id < 0) throw new Error(`invalid chain id: ${chain.id}`);
  if (!Number.isSafeInteger(job.delivery) || job.delivery < 0) throw new Error(`invalid delivery: ${job.delivery}`);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error(`invalid issue number: ${issueNumber}`);
  return { repo, chainId: chain.id, delivery: job.delivery, issue: issueNumber };
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

const attempt = async (p: Promise<unknown>): Promise<void> => {
  try {
    await p;
  } catch {
    /* already gone */
  }
};

export class GitWorkspaceProvider implements WorkspaceProvider {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: GitWorkspaceOptions) {}

  private cachePath(repo: string): string {
    return join(this.opts.root, '.cache', `${repo.replace('/', '__')}.git`);
  }

  private deliveryPath(chainId: number, delivery: number): string {
    return join(this.opts.root, String(chainId), `d${delivery}`);
  }

  /** Serialises git mutations on one cache within this process (git's own locks cover other processes). */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  private async ensureCache(repo: string): Promise<string> {
    const cache = this.cachePath(repo);
    const url = this.opts.cloneUrlFor(repo);
    await mkdir(join(this.opts.root, '.cache'), { recursive: true });
    if (!existsSync(join(cache, 'HEAD'))) {
      await git(this.opts.root, ['init', '--bare', cache]);
      await git(cache, ['remote', 'add', 'origin', url]);
      await git(cache, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      await git(cache, ['config', 'user.name', 'factory']);
      await git(cache, ['config', 'user.email', 'factory@localhost']);
    }
    await git(cache, ['remote', 'set-url', 'origin', url]);
    await git(cache, ['config', 'remote.origin.pushurl', DISABLED_PUSH_URL]);
    return cache;
  }

  private async detectBase(cache: string): Promise<string> {
    try {
      const out = await git(cache, ['ls-remote', '--symref', 'origin', 'HEAD']);
      const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
      if (m) return m[1]!;
    } catch {
      /* fall through */
    }
    return 'main';
  }

  private async removeDelivery(cache: string | null, path: string, branch: string | null): Promise<void> {
    if (cache && existsSync(cache)) {
      await attempt(git(cache, ['worktree', 'remove', '--force', path]));
    }
    await rm(path, { recursive: true, force: true });
    if (cache && existsSync(cache)) {
      await attempt(git(cache, ['worktree', 'prune']));
      if (branch) await attempt(git(cache, ['branch', '-D', branch]));
    }
  }

  async prepare(chain: ChainView<SoftwareState>, job: Job): Promise<SoftwareWorkspace> {
    const { repo, chainId, delivery, issue } = ids(chain, job);
    const path = this.deliveryPath(chainId, delivery);
    const localBranch = `factory/issue-${issue}-d${delivery}`;
    const remoteBranch = `factory/issue-${issue}`;
    const remoteUrl = this.opts.cloneUrlFor(repo);
    const cache = this.cachePath(repo);

    return this.serial(cache, async () => {
      await this.ensureCache(repo);
      await git(cache, ['fetch', 'origin', '--prune']);
      const baseBranch = await this.detectBase(cache);

      let remoteHeadSha: string | null = null;
      try {
        remoteHeadSha = await git(cache, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${remoteBranch}^{commit}`]);
      } catch {
        remoteHeadSha = null;
      }
      const seedRef = remoteHeadSha ? `refs/remotes/origin/${remoteBranch}` : `refs/remotes/origin/${baseBranch}`;
      const seedSha = remoteHeadSha ?? (await git(cache, ['rev-parse', '--verify', `${seedRef}^{commit}`]));

      // Idempotent: a retry of the same delivery starts from a clean slate.
      await this.removeDelivery(cache, path, localBranch);
      await mkdir(join(this.opts.root, String(chainId)), { recursive: true });
      await git(cache, ['worktree', 'add', '-b', localBranch, path, seedSha]);

      return { path, localBranch, remoteBranch, remoteUrl, remoteHeadSha, seedSha, baseBranch };
    });
  }

  async teardown(chain: ChainView<SoftwareState>, job: Job, outcome: 'ok' | 'failed'): Promise<void> {
    const { repo, chainId, delivery, issue } = ids(chain, job);
    if (outcome === 'failed' && this.opts.keepOnFailure) return;
    const cache = this.cachePath(repo);
    await this.serial(cache, () =>
      this.removeDelivery(cache, this.deliveryPath(chainId, delivery), `factory/issue-${issue}-d${delivery}`),
    );
  }

  async sweep(liveDeliveries: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    if (!existsSync(this.opts.root)) return removed;
    const caches = existsSync(join(this.opts.root, '.cache'))
      ? (await readdir(join(this.opts.root, '.cache'))).filter((n) => n.endsWith('.git')).map((n) => join(this.opts.root, '.cache', n))
      : [];

    for (const chainDir of await readdir(this.opts.root, { withFileTypes: true })) {
      if (!chainDir.isDirectory() || !/^\d+$/.test(chainDir.name)) continue;
      for (const dDir of await readdir(join(this.opts.root, chainDir.name), { withFileTypes: true })) {
        const m = /^d(\d+)$/.exec(dDir.name);
        if (!dDir.isDirectory() || !m) continue;
        if (liveDeliveries.has(`${chainDir.name}:${m[1]}`)) continue;
        const path = join(this.opts.root, chainDir.name, dDir.name);
        for (const cache of caches) {
          await this.serial(cache, async () => {
            // Find the branch this worktree holds so it can be deleted too.
            let branch: string | null = null;
            try {
              const list = await git(cache, ['worktree', 'list', '--porcelain']);
              for (const block of list.split('\n\n')) {
                if (block.split('\n').includes(`worktree ${path}`)) {
                  branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
                }
              }
            } catch {
              /* ignore */
            }
            if (branch !== null) await this.removeDelivery(cache, path, branch);
          });
        }
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      }
    }
    for (const cache of caches) await this.serial(cache, () => attempt(git(cache, ['worktree', 'prune'])));
    return removed;
  }
}
