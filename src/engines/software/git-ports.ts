import { execFile, spawn } from 'node:child_process';
import { StaleDeliveryError } from '../../kernel/types.js';
import type { SoftwareWorkspace } from './workspace.js';

/** The git side of the software engine's effects. */
export interface GitPorts {
  /** `git add -A`, then commit only when the index differs from HEAD. Returns whether it committed. */
  commitAll(ws: SoftwareWorkspace, message: string): Promise<boolean>;
  headSha(ws: SoftwareWorkspace): Promise<string>;
  /**
   * Push the commit `sha` (the one `commit_push` scanned, not whatever HEAD is by then) to
   * `refs/heads/<remoteBranch>` with `--force-with-lease` against `expectSha` (`null`: the branch
   * must not exist). A failed lease throws StaleDeliveryError.
   */
  push(ws: SoftwareWorkspace, args: { sha: string; remoteBranch: string; expectSha: string | null }): Promise<void>;
  /**
   * What a push of `sha` would publish beyond `ws.seedSha` (the range `seedSha..sha`, every commit
   * of it, so commits the agent made itself and files added then deleted again are included): the
   * added or modified paths, and the added lines plus each commit object exactly as stored (every
   * header, including ones only a hand-built commit has) and its message as git displays it.
   * Binary files are read as text too (`--text`). `truncated` is true when the text hit the scan cap.
   */
  addedChanges(ws: SoftwareWorkspace, sha: string): Promise<AddedChanges>;
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
  input?: string,
): Promise<{ code: number; stderr: string; stopped: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('git', [...SAFE_CONFIG, ...args], { cwd, env: { ...gitEnv(), ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    // git may exit without reading stdin (EPIPE); its exit code decides the outcome.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
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

  async push(ws: SoftwareWorkspace, a: { sha: string; remoteBranch: string; expectSha: string | null }): Promise<void> {
    if (!SHA_RE.test(a.sha)) throw new Error(`invalid sha to push: ${JSON.stringify(a.sha)}`);
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
      `${a.sha}:${ref}`,
    ], this.network);
    if (r.code === 0) return;
    if (r.code === -1) throw new Error(`git push failed: ${r.stderr}`);
    const out = `${r.stdout}\n${r.stderr}`;
    if (/\(stale info\)/.test(out)) {
      throw new StaleDeliveryError(`remote branch ${a.remoteBranch} moved under this delivery`);
    }
    throw new Error(`git push failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  }

  async addedChanges(ws: SoftwareWorkspace, sha: string): Promise<AddedChanges> {
    if (!SHA_RE.test(ws.seedSha)) throw new Error(`invalid seed sha: ${JSON.stringify(ws.seedSha)}`);
    if (!SHA_RE.test(sha)) throw new Error(`invalid sha to scan: ${JSON.stringify(sha)}`);
    const range = `${ws.seedSha}..${sha}`;
    // Every commit in the range against its first parent: a merge shows what it brings in.
    const perCommit = ['--no-color', '--diff-merges=first-parent', range];

    // Paths added, modified or type-changed by any commit (renames as delete + add, so a file renamed
    // to `.env` is listed). NUL-separated: odd names survive.
    const names = await run(ws.path, ['log', '--format=', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', ...perCommit], this.local);
    if (names.code !== 0) throw new Error(`git log failed: ${names.stderr.trim() || `exit ${names.code}`}`);
    const paths = [...new Set(names.stdout.split('\0').filter((p) => p !== ''))];

    const out = new CappedText(this.scanCap);
    const collect = async (args: string[], extraEnv: NodeJS.ProcessEnv, onLine: (line: string) => boolean, input?: string) => {
      if (out.truncated) return;
      const lines = lineSplitter(onLine, (pending) => out.overflows(pending));
      const r = await stream(ws.path, args, this.local, extraEnv, (chunk) => lines.push(chunk), input);
      if (r.stopped) return;
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      lines.end();
    };

    // The commit objects are pushed too. Read each exactly as stored (`cat-file --batch`): every
    // header, including an extra header a hand-built commit carries and the `encoding` header, which
    // `--pretty=raw` does not print. Then each message as git displays it (re-encoded to UTF-8).
    const commits = await run(ws.path, ['rev-list', range], this.local);
    if (commits.code !== 0) throw new Error(`git rev-list failed: ${commits.stderr.trim() || `exit ${commits.code}`}`);
    const shas = commits.stdout.split('\n').filter((l) => SHA_RE.test(l));
    if (shas.length > 0) await collect(['cat-file', '--batch'], {}, (line) => out.add(line), `${shas.join('\n')}\n`);
    await collect(['log', '--format=%B', ...perCommit], {}, (line) => out.add(line));

    // Added lines only (`+` lines inside hunks; the `+++` file header is outside them, so an added
    // line that itself starts with `++` is kept). `--text` diffs every file as text, so neither real
    // binary content nor a `-diff`/`binary` attribute (in the change or in the shared repository's
    // info/attributes) hides lines; no external diff and no textconv.
    let inHunk = false;
    await collect(
      ['log', '--format=', '-p', '--text', '--unified=0', '--no-ext-diff', '--no-textconv', '-M', ...perCommit],
      {},
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
