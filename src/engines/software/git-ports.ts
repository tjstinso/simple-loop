import { execFile } from 'node:child_process';
import { StaleDeliveryError } from '../../kernel/types.js';
import type { SoftwareWorkspace } from './workspace.js';

/** The git side of the software engine's effects. */
export interface GitPorts {
  /** `git add -A`, then commit only when the index differs from HEAD. Returns whether it committed. */
  commitAll(ws: SoftwareWorkspace, message: string): Promise<boolean>;
  headSha(ws: SoftwareWorkspace): Promise<string>;
  /**
   * Push HEAD to `refs/heads/<remoteBranch>` with `--force-with-lease` against `expectSha`
   * (`null`: the branch must not exist). A failed lease throws StaleDeliveryError.
   */
  push(ws: SoftwareWorkspace, args: { remoteBranch: string; expectSha: string | null }): Promise<void>;
  /**
   * Optional: called by `commit_push` before it commits and pushes, to make the engine's own git
   * commands independent of repository config the agent could have written (see
   * `GitWorkspaceProvider.sanitizeForPush`).
   */
  prepareForPush?(ws: SoftwareWorkspace): Promise<void>;
}

/** Limits for one git command; a hung command is killed (SIGKILL). Network ones stay below the cache lock's stale age. */
export const GIT_LOCAL_TIMEOUT_MS = 60_000;
export const GIT_NETWORK_TIMEOUT_MS = 300_000;
/** ssh must fail instead of prompting (host key, passphrase) when the worker has no terminal. */
export const GIT_SSH_BATCH = 'ssh -o BatchMode=yes';

export const FACTORY_GIT_NAME = 'factory';
export const FACTORY_GIT_EMAIL = 'factory@localhost';

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A plain ref path: no leading '-', no whitespace or ref metacharacters, no '..'.
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

// Neutralize hooks and signing the agent (or a user's global config) might have set up.
const SAFE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false'];

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: GIT_SSH_BATCH,
    GIT_AUTHOR_NAME: FACTORY_GIT_NAME,
    GIT_AUTHOR_EMAIL: FACTORY_GIT_EMAIL,
    GIT_COMMITTER_NAME: FACTORY_GIT_NAME,
    GIT_COMMITTER_EMAIL: FACTORY_GIT_EMAIL,
  };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
}

function run(cwd: string, args: string[], timeoutMs: number, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
        if (e.killed === true && e.signal === 'SIGKILL') {
          return resolve({ stdout: stdout ?? '', stderr: `git ${args[0]} timed out after ${timeoutMs} ms`, code: -1 });
        }
        const code = e.code;
        resolve({ stdout: stdout ?? '', stderr: String(stderr || err.message), code: typeof code === 'number' ? code : 1 });
      },
    );
    // git may exit without reading stdin (EPIPE); its exit code decides the outcome.
    child.stdin?.on('error', () => undefined);
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

async function must(cwd: string, args: string[], timeoutMs: number, input?: string): Promise<string> {
  const r = await run(cwd, args, timeoutMs, input);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export interface ExecGitPortsOptions {
  /** Run by `prepareForPush`; the composition root passes `GitWorkspaceProvider.sanitizeForPush`. */
  prepareForPush?: (ws: SoftwareWorkspace) => Promise<void>;
  /** Limit for local git commands (default GIT_LOCAL_TIMEOUT_MS). */
  localTimeoutMs?: number;
  /** Limit for `git push` (default GIT_NETWORK_TIMEOUT_MS). */
  networkTimeoutMs?: number;
}

export class ExecGitPorts implements GitPorts {
  private readonly local: number;
  private readonly network: number;

  constructor(private readonly opts: ExecGitPortsOptions = {}) {
    this.local = opts.localTimeoutMs ?? GIT_LOCAL_TIMEOUT_MS;
    this.network = opts.networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
  }

  async prepareForPush(ws: SoftwareWorkspace): Promise<void> {
    await this.opts.prepareForPush?.(ws);
  }

  async commitAll(ws: SoftwareWorkspace, message: string): Promise<boolean> {
    await must(ws.path, ['add', '-A'], this.local);
    const diff = await run(ws.path, ['diff', '--cached', '--quiet'], this.local);
    if (diff.code === 0) return false;
    if (diff.code !== 1) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
    // Message on stdin: untrusted text never sits in argv.
    await must(ws.path, ['commit', '--quiet', '--no-verify', '--cleanup=whitespace', '-F', '-'], this.local, message);
    return true;
  }

  async headSha(ws: SoftwareWorkspace): Promise<string> {
    return must(ws.path, ['rev-parse', '--verify', 'HEAD^{commit}'], this.local);
  }

  async push(ws: SoftwareWorkspace, a: { remoteBranch: string; expectSha: string | null }): Promise<void> {
    if (!BRANCH_RE.test(a.remoteBranch) || a.remoteBranch.includes('..') || a.remoteBranch.endsWith('.lock')) {
      throw new Error(`invalid remote branch: ${JSON.stringify(a.remoteBranch)}`);
    }
    if (a.expectSha !== null && !SHA_RE.test(a.expectSha)) {
      throw new Error(`invalid expected sha: ${JSON.stringify(a.expectSha)}`);
    }
    const ref = `refs/heads/${a.remoteBranch}`;
    const r = await run(ws.path, [
      'push',
      '--no-verify',
      '--porcelain',
      `--force-with-lease=${ref}:${a.expectSha ?? ''}`,
      '--',
      ws.remoteUrl,
      `HEAD:${ref}`,
    ], this.network);
    if (r.code === 0) return;
    if (r.code === -1) throw new Error(`git push failed: ${r.stderr}`);
    const out = `${r.stdout}\n${r.stderr}`;
    if (/\(stale info\)/.test(out)) {
      throw new StaleDeliveryError(`remote branch ${a.remoteBranch} moved under this delivery`);
    }
    throw new Error(`git push failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  }
}
