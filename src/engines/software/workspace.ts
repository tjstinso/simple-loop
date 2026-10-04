import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ChainView, Job, WorkspaceProvider } from '../../kernel/types.js';
import type { Workspace } from '../../runner/types.js';
import { conflictingPaths, looksBinary, MAX_CONFLICT_PATHS, parseUnmerged, structuralConflicts, type ConflictInfo } from './conflict.js';
import { FACTORY_GIT_EMAIL, FACTORY_GIT_NAME, GIT_LOCAL_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_MS, GIT_SSH_BATCH } from './git-ports.js';
import { gitAuthEnv, NO_CREDENTIAL_HELPER_ARGS, type CommitIdentity, type GithubAuth } from './identity.js';
import type { SoftwareState } from './state.js';

export interface SoftwareWorkspace extends Workspace {
  /** `owner/name`; identifies the shared cache repository this worktree belongs to. */
  repo: string;
  path: string;
  localBranch: string;
  remoteBranch: string;
  remoteUrl: string;
  /** Sha of the remote factory/issue-<n> branch at prepare time; null when it does not exist. */
  remoteHeadSha: string | null;
  /** The commit the worktree was created at. */
  seedSha: string;
  baseBranch: string;
  /** The shared cache repository (bare) holding `refs/remotes/origin/<baseBranch>`. */
  cacheDir: string;
  /** Set on a conflict round: the result of merging `origin/<baseBranch>` into the branch (see `mergeBase`). */
  conflict?: ConflictInfo;
}

export interface GitWorkspaceOptions {
  cloneUrlFor(repo: string): string;
  root: string;
  keepOnFailure: boolean;
  /** Give up acquiring a cache lock after this long (default DEFAULT_LOCK_WAIT_MS, 10 min). */
  lockWaitMs?: number;
  /** Poll interval while waiting for a cache lock (default 50ms). */
  lockPollMs?: number;
  /** A lock directory older than this is stale (default DEFAULT_LOCK_STALE_MS, 10 min). */
  lockStaleMs?: number;
  /** Limit for local git commands (default GIT_LOCAL_TIMEOUT_MS). */
  localTimeoutMs?: number;
  /** Limit for fetch and ls-remote (default GIT_NETWORK_TIMEOUT_MS, below lockStaleMs). */
  networkTimeoutMs?: number;
  /**
   * The sweep leaves a delivery directory alone while it was modified less than this long ago
   * (default DEFAULT_SWEEP_GRACE_MS, 10 min); 0 disables the check.
   */
  sweepGraceMs?: number;
  /** The factory's GitHub identity: fetch, ls-remote and clone authenticate with its token (HTTPS, GIT_ASKPASS). */
  auth?: GithubAuth;
  /** Identity written to the cache repository's `user.name`/`user.email` (default `factory <factory@localhost>`). */
  identity?: CommitIdentity;
}

export const DEFAULT_SWEEP_GRACE_MS = 600_000;

/** A first fetch of a large repository can take minutes; waiting for the lock must outlast it. */
export const DEFAULT_LOCK_WAIT_MS = 600_000;
export const DEFAULT_LOCK_STALE_MS = 600_000;

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DISABLED_PUSH_URL = 'no_push://disabled';

/**
 * Local config keys of the shared cache repository that survive `sanitizeConfig`: what git itself and
 * this provider write. Everything else (url.*.insteadOf, credential.*, core.sshCommand, core.fsmonitor,
 * include.path, filters, aliases, ...) could redirect or hijack the engine's own git commands and is
 * removed. `extensions.worktreeConfig` is removed too: it would enable per-worktree config files the
 * agent can write.
 */
const ALLOWED_KEYS = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.hookspath',
  'commit.gpgsign',
  'remote.origin.url',
  'remote.origin.fetch',
  'remote.origin.pushurl',
  'user.name',
  'user.email',
]);
const ALLOWED_PREFIXES = ['extensions.', 'worktree.', 'gc.'];
const DENIED_KEYS = new Set(['extensions.worktreeconfig']);

function isAllowedKey(key: string): boolean {
  const k = key.toLowerCase();
  if (DENIED_KEYS.has(k)) return false;
  return ALLOWED_KEYS.has(k) || ALLOWED_PREFIXES.some((p) => k.startsWith(p));
}

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
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: GIT_SSH_BATCH };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
}

/** Subcommands that talk to the remote and get the network timeout. */
const NETWORK_COMMANDS = new Set(['fetch', 'ls-remote', 'clone', 'push']);

/** Per-provider git timeouts. */
interface Timeouts {
  local: number;
  network: number;
}

function git(
  cwd: string,
  args: string[],
  t: Timeouts = { local: GIT_LOCAL_TIMEOUT_MS, network: GIT_NETWORK_TIMEOUT_MS },
  auth?: GithubAuth,
): Promise<string> {
  const network = NETWORK_COMMANDS.has(args[0] ?? '');
  const timeout = network ? t.network : t.local;
  const withAuth = network && auth !== undefined;
  return new Promise((resolve, reject) => {
    // Hooks off: the agent can write the shared cache (hooks/, core.hooksPath) and must not get
    // code run by the worker's own git commands (worktree add runs post-checkout).
    const argv = ['-c', 'core.hooksPath=/dev/null', ...(withAuth ? NO_CREDENTIAL_HELPER_ARGS : []), ...args];
    execFile(
      'git',
      argv,
      { cwd, env: withAuth ? { ...gitEnv(), ...gitAuthEnv(auth) } : gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
        if (e?.killed === true && e.signal === 'SIGKILL') reject(new Error(`git ${args.join(' ')} timed out after ${timeout} ms`));
        else if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || err.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

/** The execute job of a conflict round carries `payload.conflictRound`. */
export function isConflictRound(job: Job): boolean {
  return typeof (job.payload as { conflictRound?: unknown } | null | undefined)?.conflictRound === 'number';
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

  private readonly timeouts: Timeouts;

  constructor(private readonly opts: GitWorkspaceOptions) {
    this.timeouts = {
      local: opts.localTimeoutMs ?? GIT_LOCAL_TIMEOUT_MS,
      network: opts.networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS,
    };
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return git(cwd, args, this.timeouts, this.opts.auth);
  }

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
      if (Date.now() - st.mtimeMs > (this.opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS)) return true;
    } catch {
      return false; // vanished; the next mkdir attempt will sort it out
    }
    let pid: number;
    try {
      pid = Number((await readFile(join(lock, 'pid'), 'utf8')).trim());
    } catch {
      return false; // holder may be between mkdir and writing its pid; age decides
    }
    // Empty or half-written (the holder is between mkdir and writing its pid): the age above decides.
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async acquireLock(lock: string): Promise<void> {
    const deadline = Date.now() + (this.opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
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

  /**
   * Removes every local config key of the cache that is not allow-listed and every per-worktree
   * config file. Caller holds the cache lock. A missing cache is a no-op.
   */
  private async sanitizeLocked(cache: string): Promise<void> {
    if (!existsSync(join(cache, 'HEAD'))) return;
    const out = await this.git(cache, ['config', '--local', '--list', '--name-only']);
    const keys = [...new Set(out.split('\n').map((k) => k.trim()).filter(Boolean))];
    for (const key of keys) {
      if (!isAllowedKey(key)) await this.git(cache, ['config', '--local', '--unset-all', key]);
    }
    const admin = join(cache, 'worktrees');
    if (existsSync(admin)) {
      for (const d of await readdir(admin)) await rm(join(admin, d, 'config.worktree'), { force: true });
    }
  }

  /**
   * Removes config the agent could have written into the shared cache repository (redirecting URLs,
   * credential helpers, ssh commands, fsmonitor, includes...), keeping only allow-listed keys. Runs
   * at the start of every `prepare` and, through `sanitizeForPush`, right before the engine commits
   * and pushes.
   */
  async sanitizeConfig(repo: string): Promise<void> {
    if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
      throw new Error(`invalid repo: ${JSON.stringify(repo)}`);
    }
    const cache = this.cachePath(repo);
    if (!existsSync(cache)) return;
    await this.withCache(cache, () => this.sanitizeLocked(cache));
  }

  /**
   * Before the engine runs git in a delivery's worktree under the worker's own environment: checks
   * that the worktree's `.git` file (which the agent can rewrite) still points at this delivery's
   * administrative directory inside the cache and that the latter still points back at the cache,
   * then sanitizes the cache config. Throws when the worktree was redirected.
   */
  async sanitizeForPush(ws: SoftwareWorkspace): Promise<void> {
    const cache = this.cachePath(ws.repo);
    const refuse = (why: string): never => {
      throw new Error(`refusing to publish from ${ws.path}: not a worktree of the factory cache (${why})`);
    };
    const gitFile = join(ws.path, '.git');
    const st = await lstat(gitFile).catch(() => null);
    if (!st || !st.isFile()) refuse('.git is not a regular file');
    const m = /^gitdir: (.+)$/m.exec(await readFile(gitFile, 'utf8'));
    if (!m) refuse('.git has no gitdir line');
    const realCache = await realpath(cache);
    const adminDir = await realpath(resolve(ws.path, m![1]!.trim())).catch(() => refuse('gitdir does not exist'));
    if (!adminDir.startsWith(join(realCache, 'worktrees') + sep)) refuse('gitdir is outside the cache');
    const common = await readFile(join(adminDir, 'commondir'), 'utf8').catch(() => refuse('no commondir'));
    const realCommon = await realpath(resolve(adminDir, common.trim())).catch(() => refuse('commondir does not exist'));
    if (realCommon !== realCache) refuse('commondir is not the cache');
    await this.sanitizeConfig(ws.repo);
  }

  private async ensureCache(repo: string): Promise<string> {
    const cache = this.cachePath(repo);
    const url = this.opts.cloneUrlFor(repo);
    if (!existsSync(join(cache, 'HEAD'))) await this.git(this.opts.root, ['init', '--bare', cache]);
    let hasOrigin = true;
    try {
      await this.git(cache, ['remote', 'get-url', 'origin']);
    } catch {
      hasOrigin = false;
    }
    if (!hasOrigin) await this.git(cache, ['remote', 'add', 'origin', url]);
    await this.setConfig(cache, 'remote.origin.url', url);
    await this.setConfig(cache, 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await this.setConfig(cache, 'remote.origin.pushurl', DISABLED_PUSH_URL);
    await this.setConfig(cache, 'user.name', this.opts.identity?.name ?? FACTORY_GIT_NAME);
    await this.setConfig(cache, 'user.email', this.opts.identity?.email ?? FACTORY_GIT_EMAIL);
    return cache;
  }

  private async setConfig(cache: string, key: string, value: string): Promise<void> {
    let cur: string | null = null;
    try {
      cur = await this.git(cache, ['config', '--get', key]);
    } catch {
      cur = null;
    }
    if (cur !== value) await this.git(cache, ['config', key, value]);
  }

  private async detectBase(cache: string): Promise<string> {
    try {
      const out = await this.git(cache, ['ls-remote', '--symref', 'origin', 'HEAD']);
      const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
      if (m) return m[1]!;
    } catch {
      /* fall through */
    }
    return 'main';
  }

  private async removeDelivery(cache: string | null, path: string, branch: string | null): Promise<void> {
    if (cache && existsSync(cache)) {
      await attempt(this.git(cache, ['worktree', 'remove', '--force', path]));
    }
    await rm(path, { recursive: true, force: true });
    if (cache && existsSync(cache)) {
      await attempt(this.git(cache, ['worktree', 'prune']));
      if (branch) await attempt(this.git(cache, ['branch', '-D', branch]));
    }
  }

  async prepare(chain: ChainView<SoftwareState>, job: Job): Promise<SoftwareWorkspace> {
    const { repo, chainId, jobId, delivery, issue } = ids(chain, job);
    const path = this.deliveryPath(chainId, jobId, delivery);
    const localBranch = this.localBranch(issue, chainId, jobId, delivery);
    const remoteBranch = `factory/issue-${issue}`;
    const remoteUrl = this.opts.cloneUrlFor(repo);
    const cache = this.cachePath(repo);

    const ws: SoftwareWorkspace = await this.withCache(cache, async () => {
      await this.sanitizeLocked(cache);
      await this.ensureCache(repo);
      await this.git(cache, ['fetch', 'origin', '--prune']);
      const baseBranch = await this.detectBase(cache);

      let remoteHeadSha: string | null = null;
      try {
        remoteHeadSha = await this.git(cache, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${remoteBranch}^{commit}`]);
      } catch {
        remoteHeadSha = null;
      }
      const seedRef = remoteHeadSha ? `refs/remotes/origin/${remoteBranch}` : `refs/remotes/origin/${baseBranch}`;
      const seedSha = remoteHeadSha ?? (await this.git(cache, ['rev-parse', '--verify', `${seedRef}^{commit}`]));

      // Idempotent: a retry of the same delivery starts from a clean slate.
      await this.removeDelivery(cache, path, localBranch);
      await mkdir(join(this.opts.root, String(chainId)), { recursive: true });
      await this.git(cache, ['worktree', 'add', '-b', localBranch, path, seedSha]);

      return { repo, path, localBranch, remoteBranch, remoteUrl, remoteHeadSha, seedSha, baseBranch, cacheDir: cache };
    });
    if (isConflictRound(job)) ws.conflict = await this.mergeBase(ws);
    return ws;
  }

  /**
   * A conflict round: merges `origin/<baseBranch>` into the workspace's branch (a merge, so commits a
   * person pushed are kept and the later push stays a fast-forward) without committing, leaving the
   * conflicting files with conflict markers for the agent. The engine completes the merge commit
   * after the agent ran. A conflict the agent must not get (binary, deleted on one side, more than
   * MAX_CONFLICT_PATHS paths) is reported as a `refusal`.
   */
  async mergeBase(ws: SoftwareWorkspace): Promise<ConflictInfo> {
    const { baseBranch } = ws;
    const unmerged = () => this.git(ws.path, ['ls-files', '-u', '-z']).then(parseUnmerged);
    try {
      await this.git(ws.path, ['merge', '--no-commit', '--no-ff', '--no-verify', '-q', `refs/remotes/origin/${baseBranch}`]);
    } catch (e) {
      // A conflict exits 1 and leaves unmerged entries; a failure without any is a real one.
      if ((await unmerged().catch(() => [])).length === 0) throw e;
    }
    const entries = await unmerged();
    const paths = conflictingPaths(entries);
    if (paths.length === 0) return { baseBranch, paths };
    if (paths.length > MAX_CONFLICT_PATHS) return { baseBranch, paths: paths.slice(0, MAX_CONFLICT_PATHS), refusal: 'too_many' };
    if (structuralConflicts(entries).length > 0) return { baseBranch, paths, refusal: 'deleted_modified' };
    for (const p of paths) {
      if (await this.isBinaryFile(join(ws.path, p))) return { baseBranch, paths, refusal: 'binary' };
    }
    return { baseBranch, paths };
  }

  private async isBinaryFile(file: string): Promise<boolean> {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(8000);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return looksBinary(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  }

  async teardown(chain: ChainView<SoftwareState>, job: Job, outcome: 'ok' | 'failed'): Promise<void> {
    const { repo, chainId, jobId, delivery, issue } = ids(chain, job);
    if (outcome === 'failed' && this.opts.keepOnFailure) return;
    const cache = this.cachePath(repo);
    await this.withCache(cache, () =>
      this.removeDelivery(cache, this.deliveryPath(chainId, jobId, delivery), this.localBranch(issue, chainId, jobId, delivery)),
    );
  }

  /** Runs `fn` holding every cache lock (taken in a fixed order, so concurrent sweeps cannot deadlock). */
  private withCaches<T>(caches: string[], fn: () => Promise<T>): Promise<T> {
    const [first, ...rest] = caches;
    if (first === undefined) return fn();
    return this.withCache(first, () => this.withCaches(rest, fn));
  }

  /** True when the directory was modified within the sweep grace period (or in the future of `now`). */
  private async isRecent(path: string, now: number): Promise<boolean> {
    const grace = this.opts.sweepGraceMs ?? DEFAULT_SWEEP_GRACE_MS;
    if (grace <= 0) return false;
    try {
      return now - (await stat(path)).mtimeMs < grace;
    } catch {
      return false; // already gone
    }
  }

  /**
   * Removes delivery worktrees (`<root>/<chain>/j<job>-d<delivery>`) that belong to no live delivery.
   * `live` is a set of `${chainId}:${jobId}:${delivery}` keys, or a function answering for one key; a
   * function is asked again INSIDE the cache locks immediately before a directory is removed, so a
   * delivery claimed and prepared after the sweep started is never deleted under its agent. A
   * directory modified within `sweepGraceMs` of `now` (epoch ms) is kept as well.
   */
  async sweep(live: Set<string> | ((key: string) => boolean), now: number): Promise<string[]> {
    const isLive = typeof live === 'function' ? live : (key: string) => live.has(key);
    const removed: string[] = [];
    if (!existsSync(this.opts.root)) return removed;
    const caches = existsSync(join(this.opts.root, '.cache'))
      ? (await readdir(join(this.opts.root, '.cache')))
          .filter((n) => n.endsWith('.git'))
          .sort()
          .map((n) => join(this.opts.root, '.cache', n))
      : [];

    for (const chainDir of await readdir(this.opts.root, { withFileTypes: true })) {
      if (!chainDir.isDirectory() || !/^\d+$/.test(chainDir.name)) continue;
      for (const dDir of await readdir(join(this.opts.root, chainDir.name), { withFileTypes: true })) {
        const m = /^j(\d+)-d(\d+)$/.exec(dDir.name);
        if (!dDir.isDirectory() || !m) continue;
        const key = `${chainDir.name}:${m[1]}:${m[2]}`;
        if (isLive(key)) continue; // cheap first look
        const path = join(this.opts.root, chainDir.name, dDir.name);
        await this.withCaches(caches, async () => {
          // The deciding look, under the locks every prepare takes.
          if (isLive(key) || (await this.isRecent(path, now))) return;
          for (const cache of caches) {
            // Find the branch this worktree holds so it can be deleted too.
            let branch: string | null = null;
            try {
              const list = await this.git(cache, ['worktree', 'list', '--porcelain']);
              for (const block of list.split('\n\n')) {
                if (block.split('\n').includes(`worktree ${path}`)) {
                  branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
                }
              }
            } catch {
              /* ignore */
            }
            if (branch !== null) await this.removeDelivery(cache, path, branch);
          }
          await rm(path, { recursive: true, force: true });
          removed.push(path);
        });
      }
    }
    for (const cache of caches) await this.withCache(cache, () => attempt(this.git(cache, ['worktree', 'prune'])));
    return removed;
  }
}
