import { execFile, spawn } from 'node:child_process';
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
   * What a push of HEAD would publish beyond `ws.seedSha` (the range `seedSha..HEAD`, every commit
   * of it, so commits the agent made itself and files added then deleted again are included): the
   * added or modified paths, and the added lines plus each commit's author, committer and message.
   * Binary files contribute their paths only. `truncated` is true when the text hit the scan cap.
   */
  addedChanges(ws: SoftwareWorkspace): Promise<AddedChanges>;
  /**
   * Optional: called by `commit_push` before it commits and pushes, to make the engine's own git
   * commands independent of repository config the agent could have written (see
   * `GitWorkspaceProvider.sanitizeForPush`).
   */
  prepareForPush?(ws: SoftwareWorkspace): Promise<void>;
}

export interface AddedChanges {
  paths: string[];
  text: string;
  truncated: boolean;
}

/** Most text `addedChanges` captures (UTF-8 bytes); more is reported as `truncated`. */
export const SECRET_SCAN_CAP_BYTES = 5 * 1024 * 1024;

// The empty tree: as the attribute source it makes git ignore the change's own .gitattributes, so a
// `-diff` or `binary` attribute cannot hide a text file's lines from the scan (git >= 2.42; older
// versions ignore the variable).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

/**
 * Runs git like `run`, but hands stdout to `onData` chunk by chunk instead of buffering it. When
 * `onData` returns false, git is killed and the result has `stopped: true` (its exit code is then
 * meaningless). A command still running at `timeoutMs` is killed and reported as code -1.
 */
function stream(
  cwd: string,
  args: string[],
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv,
  onData: (chunk: string) => boolean,
): Promise<{ code: number; stderr: string; stopped: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('git', [...SAFE_CONFIG, ...args], { cwd, env: { ...gitEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stopped = false;
    let timedOut = false;
    let stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      if (!onData(chunk)) {
        stopped = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    const finish = (code: number, err?: string) => {
      clearTimeout(timer);
      if (timedOut && !stopped) return resolve({ code: -1, stderr: `git ${args[0]} timed out after ${timeoutMs} ms`, stopped });
      resolve({ code, stderr: err ?? stderr, stopped });
    };
    child.on('error', (e) => finish(1, e.message));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

/**
 * Collects text up to `capBytes` (UTF-8). `add` returns false once the cap is hit; whatever did not
 * fit is dropped and `truncated` is set.
 */
class CappedText {
  private readonly parts: string[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly capBytes: number) {}

  add(line: string): boolean {
    if (this.truncated) return false;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (this.bytes + size > this.capBytes) {
      this.truncated = true;
      return false;
    }
    this.parts.push(line);
    this.bytes += size;
    return true;
  }

  /** True when `pending` (an incomplete line) could no longer fit: stop reading. */
  overflows(pending: string): boolean {
    if (this.bytes + pending.length > this.capBytes) this.truncated = true;
    return this.truncated;
  }

  text(): string {
    return this.parts.join('\n');
  }
}

/** Splits streamed chunks into lines, handing each complete line to `onLine`. */
function lineSplitter(onLine: (line: string) => boolean, overflows: (pending: string) => boolean) {
  let rest = '';
  return {
    push(chunk: string): boolean {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) if (!onLine(l)) return false;
      return !overflows(rest);
    },
    end(): boolean {
      const last = rest;
      rest = '';
      return last === '' || onLine(last);
    },
  };
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
  /** Most text `addedChanges` captures (default SECRET_SCAN_CAP_BYTES). */
  scanCapBytes?: number;
}

export class ExecGitPorts implements GitPorts {
  private readonly local: number;
  private readonly network: number;
  private readonly scanCap: number;

  constructor(private readonly opts: ExecGitPortsOptions = {}) {
    this.local = opts.localTimeoutMs ?? GIT_LOCAL_TIMEOUT_MS;
    this.network = opts.networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
    this.scanCap = opts.scanCapBytes ?? SECRET_SCAN_CAP_BYTES;
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

  async addedChanges(ws: SoftwareWorkspace): Promise<AddedChanges> {
    if (!SHA_RE.test(ws.seedSha)) throw new Error(`invalid seed sha: ${JSON.stringify(ws.seedSha)}`);
    const range = `${ws.seedSha}..HEAD`;
    // Every commit in the range against its first parent: a merge shows what it brings in.
    const perCommit = ['--no-color', '--diff-merges=first-parent', range];

    // Paths added, modified or type-changed by any commit (renames as delete + add, so a file renamed
    // to `.env` is listed). NUL-separated: odd names survive.
    const names = await run(ws.path, ['log', '--format=', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', ...perCommit], this.local);
    if (names.code !== 0) throw new Error(`git log failed: ${names.stderr.trim() || `exit ${names.code}`}`);
    const paths = [...new Set(names.stdout.split('\0').filter((p) => p !== ''))];

    const out = new CappedText(this.scanCap);
    const collect = async (args: string[], extraEnv: NodeJS.ProcessEnv, onLine: (line: string) => boolean) => {
      if (out.truncated) return;
      const lines = lineSplitter(onLine, (pending) => out.overflows(pending));
      const r = await stream(ws.path, args, this.local, extraEnv, (chunk) => lines.push(chunk));
      if (r.stopped) return;
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      lines.end();
    };

    // Author, committer and message of each commit: pushed too.
    await collect(['log', '--format=%an%n%ae%n%cn%n%ce%n%B', ...perCommit], {}, (line) => out.add(line));

    // Added lines only (`+` lines inside hunks; the `+++` file header is outside them, so an added
    // line that itself starts with `++` is kept). No external diff, no textconv, and the attributes
    // come from the empty tree, so the change cannot hide its lines; binary files show no lines.
    const emptyTree = await must(ws.path, ['hash-object', '-t', 'tree', '--stdin'], this.local, '');
    if (!SHA_RE.test(emptyTree)) throw new Error('git hash-object returned no tree id');
    let inHunk = false;
    await collect(
      ['log', '--format=', '-p', '--unified=0', '--no-ext-diff', '--no-textconv', '-M', ...perCommit],
      { GIT_ATTR_SOURCE: emptyTree },
      (line) => {
        if (line.startsWith('diff --git ')) inHunk = false;
        else if (line.startsWith('@@')) inHunk = true;
        else if (inHunk && line.startsWith('+')) return out.add(line.slice(1));
        return true;
      },
    );
    return { paths, text: out.text(), truncated: out.truncated };
  }
}
