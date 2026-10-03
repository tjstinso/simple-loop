import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  /** Give up acquiring a cache lock after this long (default 60s). */
  lockWaitMs?: number;
  /** Poll interval while waiting for a cache lock (default 50ms). */
  lockPollMs?: number;
  /** A lock directory older than this is stale (default 10 min). */
  lockStaleMs?: number;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DISABLED_PUSH_URL = 'no_push://disabled';

interface Ids {
  repo: string;
  chainId: number;
  jobId: number;
  delivery: number;
  issue: number;
}

function ids(chain: ChainView<SoftwareState>, job: Job): Ids {
  const { repo, issueNumber } = chain.state;
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error(`invalid repo: ${JSON.stringify(repo)}`);
  }
  if (!Number.isSafeInteger(chain.id) || chain.id < 0) throw new Error(`invalid chain id: ${chain.id}`);
  if (!Number.isSafeInteger(job.id) || job.id <= 0) throw new Error(`invalid job id: ${job.id}`);
  if (!Number.isSafeInteger(job.delivery) || job.delivery < 0) throw new Error(`invalid delivery: ${job.delivery}`);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error(`invalid issue number: ${issueNumber}`);
  return { repo, chainId: chain.id, jobId: job.id, delivery: job.delivery, issue: issueNumber };
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

  /** `delivery` restarts at 1 for every job, so the job id is part of a delivery's identity. */
  private deliveryPath(chainId: number, jobId: number, delivery: number): string {
    return join(this.opts.root, String(chainId), `j${jobId}-d${delivery}`);
  }

  private localBranch(issue: number, chainId: number, jobId: number, delivery: number): string {
    return `factory/issue-${issue}-c${chainId}-j${jobId}-d${delivery}`;
  }

  private async isStale(lock: string): Promise<boolean> {
    try {
      const st = await stat(lock);
      if (Date.now() - st.mtimeMs > (this.opts.lockStaleMs ?? 10 * 60_000)) return true;
    } catch {
      return false; // vanished; the next mkdir attempt will sort it out
    }
    let pid: number;
    try {
      pid = Number((await readFile(join(lock, 'pid'), 'utf8')).trim());
    } catch {
      return false; // holder may be between mkdir and writing its pid; age decides
    }
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async acquireLock(lock: string): Promise<void> {
    const deadline = Date.now() + (this.opts.lockWaitMs ?? 60_000);
    const poll = this.opts.lockPollMs ?? 50;
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(join(lock, 'pid'), String(process.pid));
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (await this.isStale(lock)) {
        const trash = `${lock}.stale-${process.pid}-${Date.now()}`;
        try {
          await rename(lock, trash);
          await rm(trash, { recursive: true, force: true });
        } catch {
          /* someone else broke it first */
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for cache lock ${lock}`);
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /** In-process queue plus a cross-process mkdir lock around anything that mutates the shared bare repo. */
  private withCache<T>(key: string, inner: () => Promise<T>): Promise<T> {
    const fn = async (): Promise<T> => {
      await mkdir(join(this.opts.root, '.cache'), { recursive: true });
      const lock = `${key}.lock`;
      await this.acquireLock(lock);
      try {
        return await inner();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    };
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
    if (!existsSync(join(cache, 'HEAD'))) await git(this.opts.root, ['init', '--bare', cache]);
    let hasOrigin = true;
    try {
      await git(cache, ['remote', 'get-url', 'origin']);
    } catch {
      hasOrigin = false;
    }
    if (!hasOrigin) await git(cache, ['remote', 'add', 'origin', url]);
    await this.setConfig(cache, 'remote.origin.url', url);
    await this.setConfig(cache, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await this.setConfig(cache, 'remote.origin.pushurl', DISABLED_PUSH_URL);
    await this.setConfig(cache, 'user.name', 'factory');
    await this.setConfig(cache, 'user.email', 'factory@localhost');
    return cache;
  }

  private async setConfig(cache: string, key: string, value: string): Promise<void> {
    let cur: string | null = null;
    try {
      cur = await git(cache, ['config', '--get', key]);
    } catch {
      cur = null;
    }
    if (cur !== value) await git(cache, ['config', key, value]);
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
    const { repo, chainId, jobId, delivery, issue } = ids(chain, job);
    const path = this.deliveryPath(chainId, jobId, delivery);
    const localBranch = this.localBranch(issue, chainId, jobId, delivery);
    const remoteBranch = `factory/issue-${issue}`;
    const remoteUrl = this.opts.cloneUrlFor(repo);
    const cache = this.cachePath(repo);

    return this.withCache(cache, async () => {
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
    const { repo, chainId, jobId, delivery, issue } = ids(chain, job);
    if (outcome === 'failed' && this.opts.keepOnFailure) return;
    const cache = this.cachePath(repo);
    await this.withCache(cache, () =>
      this.removeDelivery(cache, this.deliveryPath(chainId, jobId, delivery), this.localBranch(issue, chainId, jobId, delivery)),
    );
  }

  /** `liveDeliveries` holds `${chainId}:${jobId}:${delivery}` keys whose worktrees must survive. */
  async sweep(liveDeliveries: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    if (!existsSync(this.opts.root)) return removed;
    const caches = existsSync(join(this.opts.root, '.cache'))
      ? (await readdir(join(this.opts.root, '.cache'))).filter((n) => n.endsWith('.git')).map((n) => join(this.opts.root, '.cache', n))
      : [];

    for (const chainDir of await readdir(this.opts.root, { withFileTypes: true })) {
      if (!chainDir.isDirectory() || !/^\d+$/.test(chainDir.name)) continue;
      for (const dDir of await readdir(join(this.opts.root, chainDir.name), { withFileTypes: true })) {
        const m = /^j(\d+)-d(\d+)$/.exec(dDir.name);
        if (!dDir.isDirectory() || !m) continue;
        if (liveDeliveries.has(`${chainDir.name}:${m[1]}:${m[2]}`)) continue;
        const path = join(this.opts.root, chainDir.name, dDir.name);
        for (const cache of caches) {
          await this.withCache(cache, async () => {
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
    for (const cache of caches) await this.withCache(cache, () => attempt(git(cache, ['worktree', 'prune'])));
    return removed;
  }
}
