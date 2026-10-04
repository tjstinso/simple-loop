import { execFile, spawn } from 'node:child_process';
import { StaleDeliveryError } from '../../kernel/types.js';
import { conflictingPaths, parseUnmerged } from './conflict.js';
import { gitAuthEnv, NO_CREDENTIAL_HELPER_ARGS, type CommitIdentity, type GithubAuth } from './identity.js';
import type { SoftwareWorkspace } from './workspace.js';

/** The git side of the software engine's effects. */
export interface GitPorts {
  /**
   * `git add -A`, then commit only when the index differs from HEAD. Returns whether it committed.
   * While a merge is in progress (a conflict round) the merge commit is made even when the index
   * equals HEAD, and an unmerged path left in the index is an error naming the paths.
   */
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
  /**
   * Optional (without it only the verify commands run before the push and `commit_push` commits): what the validation round needs to know about the workspace (see `WorkspaceFacts`), read
   * with the scan's isolation. `firstParent` lists only the first-parent chain since the seed (a
   * conflict round, where the merged-in base commits are other people's).
   */
  inspect?(ws: SoftwareWorkspace, opts: { firstParent: boolean }): Promise<WorkspaceFacts>;
  /** Optional: the email every commit of the delivery must carry (the factory identity). */
  commitEmail?(): string;
}

/** One commit of `seed..HEAD`, newest first. */
export interface CommitFact {
  sha: string;
  parents: string[];
  authorEmail: string;
  committerEmail: string;
  subject: string;
}

/** The state of a workspace as the validation round sees it. */
export interface WorkspaceFacts {
  /** The checked-out local branch; null when HEAD is detached. */
  branch: string | null;
  head: string;
  seedIsAncestor: boolean;
  /** The commits of `seed..HEAD`, newest first (at most `MAX_INSPECTED_COMMITS`). */
  commits: CommitFact[];
  /** Number of commits in `seed..HEAD` (may exceed `commits.length`). */
  commitCount: number;
  /** Commits (shas) that add, change or remove a gitlink (submodule) entry. */
  gitlinkCommits: string[];
  /** Tracked changes and untracked files that are not ignored. */
  dirtyFiles: string[];
  /** The subset of `dirtyFiles` that are tracked. */
  trackedDirtyFiles: string[];
  /** A merge is in progress (a conflict round whose merge commit the engine has not made yet). */
  merging: boolean;
}

/** Most commits `inspect` reads in full; `commitCount` still counts all. */
export const MAX_INSPECTED_COMMITS = 200;

/** The `%x01<sha>%x02` + raw records of `git log --raw -z`: the commits that touch a gitlink (mode 160000). */
export function parseGitlinkCommits(out: string): string[] {
  const found: string[] = [];
  const re = /\u0001([0-9a-f]+)\u0002|:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*\0/g;
  let current = '';
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    if (m[1] !== undefined) current = m[1];
    else if ((m[2] === '160000' || m[3] === '160000') && !found.includes(current)) found.push(current);
  }
  return found;
}

/** Parses `git status --porcelain=v1 -z --untracked-files=all` into the dirty paths. */
export function parseStatus(out: string): { dirty: string[]; tracked: string[] } {
  const dirty: string[] = [];
  const tracked: string[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    const path = t.slice(3);
    // A rename or copy is followed by its source path.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++;
    dirty.push(path);
    if (xy !== '??') tracked.push(path);
  }
  return { dirty, tracked };
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

/**
 * The secret scan (and the HEAD it pins) must not depend on the worker's own git configuration: a
 * global or system `log.showRoot=false` hides an orphan root commit, `core.bigFileThreshold` or a
 * global attributes file can turn files binary. Scan commands therefore ignore the global and system
 * config and any config passed through the environment, and pin the settings that matter. (The push
 * itself keeps the operator's configuration: it needs the credential helper or ssh setup.)
 * They also see the real objects: `refs/replace/*` (which the agent can write in the shared cache)
 * and a graft file would let `log`/`cat-file` show a clean commit in place of the one `git push`
 * actually sends, since pack-objects ignores replacements.
 */
const SCAN_CONFIG = ['--no-replace-objects', '-c', 'core.attributesFile=/dev/null', '-c', 'log.showRoot=true', '-c', 'core.bigFileThreshold=1g'];

function scanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
  };
  for (const k of Object.keys(out)) {
    if (k === 'GIT_CONFIG_PARAMETERS' || k === 'GIT_CONFIG_COUNT' || k === 'GIT_CONFIG' || k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) {
      delete out[k];
    }
  }
  return out;
}

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

/** The git subcommand of an argument list (after any leading global options), for messages. */
function subcommand(args: string[]): string {
  let i = 0;
  for (;;) {
    if (args[i] === '-c') i += 2;
    else if (args[i] === '--no-replace-objects') i += 1;
    else break;
  }
  return args[i] ?? 'command';
}

/** Runs git; `scan` isolates it from the worker's git configuration (see SCAN_CONFIG). */
function run(
  cwd: string,
  args: string[],
  timeoutMs: number,
  input?: string,
  scan = false,
  extraEnv: Record<string, string> = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...(scan ? SCAN_CONFIG : []), ...args],
      { cwd, env: scan ? scanEnv(gitEnv()) : { ...gitEnv(), ...extraEnv }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
        if (e.killed === true && e.signal === 'SIGKILL') {
          return resolve({ stdout: stdout ?? '', stderr: `git ${subcommand(args)} timed out after ${timeoutMs} ms`, code: -1 });
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
 * Runs a scan git command (isolated like `run` with `scan`), but hands stdout to `onData` chunk by
 * chunk instead of buffering it. When
 * `onData` returns false, git is killed and the result has `stopped: true` (its exit code is then
 * meaningless). A command still running at `timeoutMs` is killed and reported as code -1.
 */
function stream(
  cwd: string,
  args: string[],
  timeoutMs: number,
  onData: (chunk: Buffer) => boolean,
  input?: string,
): Promise<{ code: number; stderr: string; stopped: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('git', [...SAFE_CONFIG, ...SCAN_CONFIG, ...args], { cwd, env: scanEnv(gitEnv()), stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
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
      if (timedOut && !stopped) return resolve({ code: -1, stderr: `git ${subcommand(args)} timed out after ${timeoutMs} ms`, stopped });
      resolve({ code, stderr: err ?? stderr, stopped });
    };
    child.on('error', (e) => finish(1, e.message));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

/**
 * Collects lines up to `capBytes` of RAW bytes (each line's bytes plus its newline, before decoding:
 * an invalid UTF-8 byte counts as one byte, not as the three of U+FFFD). Lines are decoded as UTF-8
 * for scanning. `add` returns false once the cap is hit; whatever did not fit is dropped and
 * `truncated` is set.
 */
class CappedText {
  private readonly parts: string[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly capBytes: number) {}

  add(line: Buffer | string): boolean {
    if (this.truncated) return false;
    const size = (typeof line === 'string' ? Buffer.byteLength(line, 'utf8') : line.length) + 1;
    if (this.bytes + size > this.capBytes) {
      this.truncated = true;
      return false;
    }
    this.parts.push(typeof line === 'string' ? line : line.toString('utf8'));
    this.bytes += size;
    return true;
  }

  /** True when `pendingBytes` (an incomplete line) could no longer fit: stop reading. */
  overflows(pendingBytes: number): boolean {
    if (this.bytes + pendingBytes > this.capBytes) this.truncated = true;
    return this.truncated;
  }

  text(): string {
    return this.parts.join('\n');
  }
}

/**
 * Splits streamed chunks into lines at newline BYTES (a newline never occurs inside a UTF-8
 * multi-byte sequence), handing each complete line to `onLine` as raw bytes.
 */
function lineSplitter(onLine: (line: Buffer) => boolean, overflows: (pendingBytes: number) => boolean) {
  let rest: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): boolean {
      const buf = rest.length === 0 ? chunk : Buffer.concat([rest, chunk]);
      let start = 0;
      for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
        if (!onLine(buf.subarray(start, nl))) return false;
        start = nl + 1;
      }
      rest = Buffer.from(buf.subarray(start));
      return !overflows(rest.length);
    },
    end(): boolean {
      const last = rest;
      rest = Buffer.alloc(0);
      return last.length === 0 || onLine(last);
    },
  };
}

/** Minimum length of a printable run `StringsExtractor` keeps. */
export const MIN_STRING_RUN = 8;
const isPrintable = (b: number) => (b >= 0x20 && b <= 0x7e) || b === 0x09;

/**
 * Extracts printable strings from binary content, like `strings`: runs of at least MIN_STRING_RUN
 * printable ASCII bytes, and runs of printable characters interleaved with NUL bytes (UTF-16LE and
 * UTF-16BE, at both byte alignments). Streams: content can arrive in any number of chunks. Each run
 * is handed to `emit` as one line; `emit` returning false stops the extraction.
 */
class StringsExtractor {
  private ascii: number[] = [];
  // UTF-16 runs per alignment (index = the parity of the pair's first byte offset).
  private le: number[][] = [[], []];
  private be: number[][] = [[], []];
  private pos = 0;
  private prev = -1;
  stopped = false;

  constructor(private readonly emit: (run: string) => boolean) {}

  private flush(run: number[]): void {
    if (!this.stopped && run.length >= MIN_STRING_RUN && !this.emit(String.fromCharCode(...run))) this.stopped = true;
    run.length = 0;
  }

  private grow(run: number[], b: number): void {
    run.push(b);
    // One huge run: emit it in pieces so memory stays bounded (the cap still applies to the total).
    if (run.length >= 64 * 1024) this.flush(run);
  }

  push(chunk: Buffer): boolean {
    for (const b of chunk) {
      if (this.stopped) return false;
      if (isPrintable(b)) this.grow(this.ascii, b);
      else this.flush(this.ascii);
      if (this.prev !== -1) {
        // (prev, b) is a byte pair whose first byte sits at pos - 1.
        const parity = (this.pos - 1) & 1;
        const le = this.le[parity]!;
        const be = this.be[parity]!;
        if (isPrintable(this.prev) && b === 0) this.grow(le, this.prev);
        else this.flush(le);
        if (this.prev === 0 && isPrintable(b)) this.grow(be, b);
        else this.flush(be);
      }
      this.prev = b;
      this.pos++;
    }
    return !this.stopped;
  }

  end(): void {
    this.flush(this.ascii);
    for (const r of [...this.le, ...this.be]) this.flush(r);
  }
}

async function must(
  cwd: string,
  args: string[],
  timeoutMs: number,
  input?: string,
  scan = false,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const r = await run(cwd, args, timeoutMs, input, scan, extraEnv);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/**
 * Parses `git log --format=%x01 --raw --numstat --no-abbrev -z`: the changed paths, and the new blob
 * of every regular file (or symlink) that numstat reports as binary (`-\t-`).
 */
function parseChangeListing(out: string): { paths: string[]; binaryBlobs: string[] } {
  const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]$/;
  const NUMSTAT = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/;
  const paths = new Set<string>();
  const binaryBlobs = new Set<string>();
  let blobOf = new Map<string, string>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^\n+/, '');
    if (t === '') continue;
    if (t.startsWith('\u0001')) {
      blobOf = new Map();
      continue;
    }
    const raw = RAW.exec(t);
    if (raw) {
      const path = tokens[++i] ?? '';
      if (path === '') continue;
      paths.add(path);
      // Gitlinks (160000) point at commits in other repositories: nothing to read here.
      if (raw[2] !== '160000' && SHA_RE.test(raw[4]!)) blobOf.set(path, raw[4]!);
      continue;
    }
    const num = NUMSTAT.exec(t);
    if (num && num[1] === '-' && num[2] === '-') {
      const blob = blobOf.get(num[3]!);
      if (blob) binaryBlobs.add(blob);
    }
  }
  return { paths: [...paths], binaryBlobs: [...binaryBlobs] };
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
  /** The factory's GitHub identity: `git push` authenticates with its token (HTTPS, GIT_ASKPASS). */
  auth?: GithubAuth;
  /** Author and committer of the commits the engine makes (default `factory <factory@localhost>`). */
  identity?: CommitIdentity;
}

export class ExecGitPorts implements GitPorts {
  private readonly local: number;
  private readonly network: number;
  private readonly scanCap: number;
  private readonly commitEnv: Record<string, string>;
  private readonly pushConfig: string[];

  constructor(private readonly opts: ExecGitPortsOptions = {}) {
    this.local = opts.localTimeoutMs ?? GIT_LOCAL_TIMEOUT_MS;
    this.network = opts.networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
    this.scanCap = opts.scanCapBytes ?? SECRET_SCAN_CAP_BYTES;
    const id = opts.identity ?? { name: FACTORY_GIT_NAME, email: FACTORY_GIT_EMAIL };
    this.commitEnv = {
      GIT_AUTHOR_NAME: id.name,
      GIT_AUTHOR_EMAIL: id.email,
      GIT_COMMITTER_NAME: id.name,
      GIT_COMMITTER_EMAIL: id.email,
    };
    this.pushConfig = opts.auth === undefined ? [] : NO_CREDENTIAL_HELPER_ARGS;
  }

  async prepareForPush(ws: SoftwareWorkspace): Promise<void> {
    await this.opts.prepareForPush?.(ws);
  }

  async commitAll(ws: SoftwareWorkspace, message: string): Promise<boolean> {
    await must(ws.path, ['add', '-A'], this.local);
    const unmerged = conflictingPaths(parseUnmerged(await must(ws.path, ['ls-files', '-u', '-z'], this.local)));
    if (unmerged.length > 0) throw new Error(`unmerged paths remain in the index: ${unmerged.join(', ')}`);
    const merging = (await run(ws.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], this.local)).code === 0;
    const diff = await run(ws.path, ['diff', '--cached', '--quiet'], this.local);
    if (diff.code === 0 && !merging) return false;
    if (diff.code !== 1 && diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
    // Message on stdin: untrusted text never sits in argv.
    await must(ws.path, ['commit', '--quiet', '--no-verify', '--cleanup=whitespace', '-F', '-'], this.local, message, false, this.commitEnv);
    return true;
  }

  commitEmail(): string {
    return this.commitEnv.GIT_AUTHOR_EMAIL!;
  }

  async inspect(ws: SoftwareWorkspace, o: { firstParent: boolean }): Promise<WorkspaceFacts> {
    if (!SHA_RE.test(ws.seedSha)) throw new Error(`invalid seed sha: ${JSON.stringify(ws.seedSha)}`);
    const branchRun = await run(ws.path, ['symbolic-ref', '-q', '--short', 'HEAD'], this.local, undefined, true);
    const head = await must(ws.path, ['rev-parse', '--verify', 'HEAD^{commit}'], this.local, undefined, true);
    const seedIsAncestor = (await run(ws.path, ['merge-base', '--is-ancestor', ws.seedSha, head], this.local, undefined, true)).code === 0;
    const range = `${ws.seedSha}..${head}`;
    const parent = o.firstParent ? ['--first-parent'] : [];
    // Unit separator between fields; the subject is one line.
    const log = seedIsAncestor
      ? await must(ws.path, ['log', ...parent, '-n', String(MAX_INSPECTED_COMMITS), '--format=%H%x1f%P%x1f%ae%x1f%ce%x1f%s%x1e', range], this.local, undefined, true)
      : '';
    const commits: CommitFact[] = log
      .split('\x1e')
      .map((r) => r.replace(/^\n+/, ''))
      .filter((r) => r !== '')
      .map((r) => {
        const [sha = '', parents = '', authorEmail = '', committerEmail = '', subject = ''] = r.split('\x1f');
        return { sha, parents: parents.split(' ').filter((p) => p !== ''), authorEmail, committerEmail, subject };
      });
    const commitCount = seedIsAncestor ? Number(await must(ws.path, ['rev-list', '--count', ...parent, range], this.local, undefined, true)) : 0;
    const raw = seedIsAncestor
      ? await must(ws.path, ['log', ...parent, '--format=%x01%H%x02', '--raw', '--no-abbrev', '--no-renames', '-z', '--diff-merges=first-parent', range], this.local, undefined, true)
      : '';
    const status = parseStatus(await run(ws.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], this.local, undefined, true).then((r) => {
      if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      return r.stdout;
    }));
    const merging = (await run(ws.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], this.local, undefined, true)).code === 0;
    return {
      branch: branchRun.code === 0 ? branchRun.stdout.trim() : null,
      head,
      seedIsAncestor,
      commits,
      commitCount,
      gitlinkCommits: parseGitlinkCommits(raw),
      dirtyFiles: status.dirty,
      trackedDirtyFiles: status.tracked,
      merging,
    };
  }

  async headSha(ws: SoftwareWorkspace): Promise<string> {
    // The sha commit_push scans and pushes: resolved with the scan's isolation.
    return must(ws.path, ['rev-parse', '--verify', 'HEAD^{commit}'], this.local, undefined, true);
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
    // The operator's config stays (credentials), but tags are never pushed along with the commit.
    const r = await run(ws.path, [
      ...this.pushConfig,
      '-c',
      'push.followTags=false',
      'push',
      '--no-verify',
      '--porcelain',
      `--force-with-lease=${ref}:${a.expectSha ?? ''}`,
      '--',
      ws.remoteUrl,
      `${a.sha}:${ref}`,
    ], this.network, undefined, false, this.opts.auth === undefined ? {} : gitAuthEnv(this.opts.auth));
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
    // to `.env` is listed), with their new blob and whether git considers them binary (numstat
    // `-\t-`). NUL-separated: odd names survive.
    const listing = await run(
      ws.path,
      ['log', '--format=%x01', '--raw', '--numstat', '--no-abbrev', '--no-renames', '--diff-filter=AMT', '-z', ...perCommit],
      this.local,
      undefined,
      true,
    );
    if (listing.code !== 0) throw new Error(`git log failed: ${listing.stderr.trim() || `exit ${listing.code}`}`);
    const { paths, binaryBlobs } = parseChangeListing(listing.stdout);

    const out = new CappedText(this.scanCap);
    const collect = async (args: string[], onLine: (line: Buffer) => boolean, input?: string) => {
      if (out.truncated) return;
      const lines = lineSplitter(onLine, (pending) => out.overflows(pending));
      const r = await stream(ws.path, args, this.local, (chunk) => lines.push(chunk), input);
      if (r.stopped) return;
      if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      lines.end();
    };

    // The commit objects are pushed too. Read each exactly as stored (`cat-file --batch`): every
    // header, including an extra header a hand-built commit carries and the `encoding` header, which
    // `--pretty=raw` does not print. Then each message as git displays it (re-encoded to UTF-8).
    const commits = await run(ws.path, ['rev-list', range], this.local, undefined, true);
    if (commits.code !== 0) throw new Error(`git rev-list failed: ${commits.stderr.trim() || `exit ${commits.code}`}`);
    const shas = commits.stdout.split('\n').filter((l) => SHA_RE.test(l));
    if (shas.length > 0) await collect(['cat-file', '--batch'], (line) => out.add(line), `${shas.join('\n')}\n`);
    await collect(['log', '--format=%B', ...perCommit], (line) => out.add(line));

    // Added lines of text files only (`+` lines inside hunks; the `+++` file header is outside them,
    // so an added line that itself starts with `++` is kept). No external diff and no textconv.
    let inHunk = false;
    const HUNK = Buffer.from('@@');
    const DIFF = Buffer.from('diff --git ');
    await collect(
      ['log', '--format=', '-p', '--unified=0', '--no-ext-diff', '--no-textconv', '-M', ...perCommit],
      (line) => {
        if (line.subarray(0, DIFF.length).equals(DIFF)) inHunk = false;
        else if (line.subarray(0, 2).equals(HUNK)) inHunk = true;
        else if (inHunk && line[0] === 0x2b) return out.add(line.subarray(1));
        return true;
      },
    );

    // Files git considers binary (real binary content, or a `-diff`/`binary` attribute, from the
    // change or the shared repository's info/attributes): their printable strings, ASCII and UTF-16,
    // from the whole new blob, under their own cap. Random-like assets yield few strings.
    const strings = new CappedText(this.scanCap);
    for (const blob of binaryBlobs) {
      if (strings.truncated) break;
      const extractor = new StringsExtractor((run) => strings.add(run));
      const r = await stream(ws.path, ['cat-file', 'blob', blob], this.local, (chunk) => extractor.push(chunk));
      if (r.stopped) break;
      if (r.code !== 0) throw new Error(`git cat-file failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      extractor.end();
    }
    const text = [out.text(), strings.text()].filter((t) => t !== '').join('\n');
    return { paths, text, truncated: out.truncated || strings.truncated };
  }
}
