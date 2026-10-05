import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertPluginDirsUnchanged } from './plugin-check.js';
import { readProcessStartTime } from '../util/proc.js';
import { LineSplitter, StreamCollector, lastJsonBlock, parseStreamLine, truncate } from './stream.js';
import type { RunHooks, Runner, RunInput } from './types.js';

const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout overflows above this

/** Names `passEnv` may never forward: GitHub tokens, SSH agent, git overrides, the session bus. */
function isForbiddenPassEnv(name: string): boolean {
  return /^(GH_|GITHUB_|SSH_|GIT_|DBUS_)/.test(name) || name === 'XDG_RUNTIME_DIR';
}

const configSchema = z.object({
  prompt: z.string().min(1),
  allowedTools: z.array(z.string().min(1)),
  maxBudgetUsd: z.number().positive(),
  timeoutMs: z.number().int().positive().max(MAX_TIMER_MS),
  inactivityTimeoutMs: z.number().int().positive().max(MAX_TIMER_MS),
  resultFormat: z.enum(['execution', 'json']),
  permissionMode: z.string().min(1).optional(),
  /**
   * Passed as `--setting-sources` (comma-separated: user, project, local). The review policy sets
   * `user` so the branch under review cannot supply hooks or permission rules through its own
   * `.claude/settings.json`.
   */
  settingSources: z.string().min(1).optional(),
  /**
   * Bare mode (default): `claude --bare`, an allow-listed environment and an empty per-run HOME,
   * so the agent starts with no ambient credentials (see `bareChildEnv`). `false` is the weaker
   * opt-out: the parent environment minus a deny-list, with the operator's HOME (see `childEnv`).
   */
  bare: z.boolean().default(true),
  /**
   * Extra variable names forwarded from the worker's environment in bare mode (for example a
   * Bedrock or Vertex provider's credentials). Ignored when `bare` is false, where the whole
   * environment minus the deny-list is passed anyway.
   */
  passEnv: z
    .array(
      z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an upper-case environment variable name')
        .refine((n) => !isForbiddenPassEnv(n), 'GH_*, GITHUB_*, SSH_*, GIT_*, DBUS_* and XDG_RUNTIME_DIR cannot be passed'),
    )
    .optional(),
  /**
   * Plugin directories, each passed as one `--plugin-dir=<absolute path>` (for example a language
   * server plugin). Relative entries are resolved against the worktree and must stay inside it;
   * absolute entries are operator-controlled and taken as given. A relative entry must also match the
   * base branch (the agent could otherwise write code the CLI runs outside its tool permissions).
   * See `resolvePluginDirs` and `assertPluginDirsUnchanged`.
   */
  pluginDirs: z.array(z.string().min(1)).default([]),
});

export type ClaudeCliConfig = z.infer<typeof configSchema>;

export interface ExecutionResult {
  status: 'ok' | 'error';
  summary: string;
  costUsd?: number;
  steps: string[];
  followups?: { title: string; body: string }[];
  /** Passed through unchecked; the engine validates it against the feedback round. */
  feedbackResponses?: unknown;
  /** Passed through unchecked; the engine's result schema validates it. */
  ask?: unknown;
}

export interface ClaudeCliRunnerOptions {
  /** Executable to run (default `claude`). Tests point this at a stub script. */
  bin?: string;
  /**
   * Variables added to the child environment: after the deny-list (bare false), or after the
   * allow-list and `passEnv` but before the isolation variables (bare mode).
   */
  env?: Record<string, string>;
  /** Variable names removed from the child environment in every mode, even when in `passEnv` (the GitHub token variable). */
  withheldEnv?: readonly string[];
  /** Process spawner (default `child_process.spawn`). Tests inject one that throws. */
  spawn?: typeof spawn;
  /** Remover used by `removeScratchDir` (default `fs.rmSync`). Tests inject a failing one. */
  removeDir?: Remover;
}

export type Remover = (path: string, opts: Parameters<typeof rmSync>[1]) => void;

const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;

/**
 * Makes every directory under `root` (and `root`) owner-writable, so a tree holding a read-only
 * directory with contents (Go's module cache, an agent's `chmod 000`) can be removed. Never follows
 * symlinks: only entries `lstat` (or the `withFileTypes` dirent) reports as real directories are
 * changed or descended into, so nothing outside `root` is touched. Errors are ignored.
 */
function makeDirsWritable(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      chmodSync(dir, 0o700);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory()) stack.push(join(dir, e.name));
  }
}

/**
 * Best-effort removal of a per-run scratch directory that NEVER throws (it runs inside child-process
 * and timer callbacks, where a throw would crash the worker). `rm` retries ENOTEMPTY/EBUSY; on
 * EACCES/EPERM the tree's directories are made writable and removal is retried once. `rm` with
 * `recursive` removes symlinks without following them. Returns false when something was left: the
 * directory may then remain in the temp directory (see README "Credentials").
 */
export function removeScratchDir(dir: string, rm: Remover = rmSync): boolean {
  try {
    rm(dir, RM_OPTS);
    return true;
  } catch (e) {
    try {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === 'EACCES' || code === 'EPERM') makeDirsWritable(dir);
      rm(dir, RM_OPTS);
      return true;
    } catch {
      return false; // left in the temp directory; nothing to log to
    }
  }
}

/** Rejection for the inactivity watchdog and the hard wall-clock limit. */
export class RunnerTimeoutError extends Error {
  readonly reason = 'timeout' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RunnerTimeoutError';
  }
}

const SUMMARY_MAX = 4000;
const STDERR_TAIL = 2000;

const blockSchema = z.object({
  summary: z.string().optional(),
  followups: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
  feedbackResponses: z.unknown().optional(),
  ask: z.unknown().optional(),
});

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Variables the agent never sees, in every mode and even when listed in `passEnv`: the factory's GitHub
 * token (and the variable `github.tokenEnv` names) and the askpass helper that serves it.
 */
const WITHHELD_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS'];

function withhold(env: Record<string, string>, extra: readonly string[]): void {
  for (const k of [...WITHHELD_VARS, ...extra]) delete env[k];
}

/** Variables that hand the agent a way to authenticate as the operator (SSH agent, askpass helpers, ssh commands). */
const DROPPED_VARS = new Set(['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_SSH']);

/**
 * The agent's environment when `bare` is false (the weaker opt-out): the parent environment minus
 * GitHub tokens (`GH_*`, `GITHUB_*`) and the SSH/askpass variables, with git's global and system
 * config switched off (so a credential helper such as `gh auth setup-git` in ~/.gitconfig is not
 * used by default) and `gh` pointed at `ghConfigDir` (an empty directory, so the operator's `gh`
 * login is not found by default), plus `overrides`. Everything else is inherited, including HOME
 * (the claude CLI uses its own login there), XDG_RUNTIME_DIR and the session bus (so keyring
 * clients can reach the operator's keyring) and any cloud credentials in the environment. This
 * only stops the default lookups: an agent with a shell, running as the operator's OS user, can
 * still read any file the user can, such as ~/.config/gh/hosts.yml, ~/.ssh or ~/.gitconfig, by
 * its path (see README "Credentials").
 */
export function childEnv(
  overrides: Record<string, string> = {},
  ghConfigDir?: string,
  withheld: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (upper.startsWith('GH_') || upper.startsWith('GITHUB_')) continue; // covers GH_TOKEN, GITHUB_TOKEN
    if (DROPPED_VARS.has(upper)) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  if (ghConfigDir !== undefined) env.GH_CONFIG_DIR = ghConfigDir;
  const out = { ...env, ...overrides };
  withhold(out, withheld);
  return out;
}

/** Variables bare mode takes from the worker's environment (plus the config's `passEnv`). */
const BARE_ALLOWED_VARS = new Set([
  'PATH', 'TERM', 'TZ', 'TMPDIR',
  // locale: LANG, LANGUAGE and the POSIX/glibc categories (an explicit list, not an LC_ prefix)
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export interface BareEnvOptions {
  /** The worker's environment (normally `process.env`). */
  parent: NodeJS.ProcessEnv;
  /** The constructor's `env`; applied after the allow-list and `passEnv`. */
  overrides?: Record<string, string>;
  passEnv?: readonly string[];
  /** Empty per-run directory used as HOME and for every XDG base directory. */
  home: string;
  /** Empty per-run directory for `gh`. */
  ghConfigDir: string;
  /** Extra variable names to remove (the `github.tokenEnv` variable), even when listed in `passEnv`. */
  withheld?: readonly string[];
}

/**
 * The agent's environment in bare mode, built from an allow-list: only `BARE_ALLOWED_VARS` (with an
 * explicit list of locale variables) and the names in `passEnv` are taken from `parent`, then `overrides`; HOME and XDG_CONFIG_HOME,
 * XDG_DATA_HOME, XDG_CACHE_HOME and XDG_STATE_HOME point at the empty `home`, git's global and
 * system config are off and `gh` uses the empty `ghConfigDir`. These isolation variables are set
 * last, so neither `passEnv` nor `overrides` can undo them. Nothing else from the parent reaches
 * the agent: no GH_* or GITHUB_* tokens, SSH_* (agent socket), GIT_* (askpass, ssh command), DBUS_*,
 * XDG_RUNTIME_DIR or GNOME_KEYRING_* (keyring discovery), KRB5*, AWS_*, GOOGLE_* or AZURE_*
 * unless a name is listed in `passEnv` (which refuses GH_*, GITHUB_*, SSH_*, GIT_*, DBUS_* and
 * XDG_RUNTIME_DIR). So the default lookups of git over HTTPS, gh and keyring clients find nothing.
 * Not ssh: OpenSSH finds `~/.ssh` through the user database, not HOME, so passphrase-less keys
 * there remain usable (git over SSH included). It
 * is not a sandbox: the agent still runs as the worker's OS user and can read or write any file
 * that user can by its absolute path, and ANTHROPIC_API_KEY is in its environment.
 */
export function bareChildEnv(opts: BareEnvOptions): Record<string, string> {
  const pass = new Set(opts.passEnv ?? []);
  for (const name of pass) {
    if (isForbiddenPassEnv(name)) throw new Error(`claude-cli passEnv: '${name}' cannot be passed to the agent`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.parent)) {
    if (v === undefined) continue;
    if (BARE_ALLOWED_VARS.has(k) || pass.has(k)) env[k] = v;
  }
  Object.assign(env, opts.overrides ?? {});
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) env[k] = opts.home;
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GH_CONFIG_DIR = opts.ghConfigDir;
  withhold(env, opts.withheld ?? []);
  return env;
}

/**
 * The error message when bare mode has no model credential: `--bare` never reads the claude CLI's
 * OAuth login or the keychain, so without one every run would fail inside the CLI.
 */
function missingCredentialMessage(): string {
  return (
    'claude-cli runs in bare mode (policy config `bare: true`), where the claude CLI does not use its own login: ' +
    'set ANTHROPIC_API_KEY in the worker\'s environment (preferably a dedicated, spend-limited key), or list your ' +
    'provider\'s credential variables (for example Bedrock or Vertex) in the policy config `passEnv`, ' +
    'or set `bare: false` in the policy config to use the weaker non-bare mode'
  );
}

/** True when a bare-mode child environment carries a model credential. */
function hasProviderCredential(env: Record<string, string>, passEnv: readonly string[]): boolean {
  if ((env.ANTHROPIC_API_KEY ?? '') !== '') return true;
  // An operator who forwards variables explicitly has configured a provider (Bedrock, Vertex, ...).
  return passEnv.some((n) => (env[n] ?? '') !== '');
}

/** True when `target` lies strictly inside `root` (path-component aware: `/a/tree-evil` is not in `/a/tree`). */
export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The worktree's own `<workspace>/CLAUDE.md` to pass with `--append-system-prompt-file` in bare
 * mode (where the CLI skips CLAUDE.md auto-discovery), or undefined. Only a regular file (by
 * `lstat`: a symlink is never passed, wherever it points) whose real path lies inside the
 * worktree's real path. `.claude/CLAUDE.md`, `CLAUDE.local.md` and `@` imports inside the file are
 * not passed or resolved.
 */
export function worktreeClaudeMd(workspace: string): string | undefined {
  const file = join(workspace, 'CLAUDE.md');
  try {
    if (!lstatSync(file).isFile()) return undefined;
    return isInsideDir(realpathSync(workspace), realpathSync(file)) ? file : undefined;
  } catch {
    return undefined; // no CLAUDE.md
  }
}

/**
 * The absolute plugin directories for `--plugin-dir`, in configured order. A relative entry is
 * resolved against the worktree and, after following symlinks, must be a directory inside the
 * worktree's real path. An absolute entry is operator configuration and only has to be an existing
 * directory. Throws an error naming the entry when one is missing, not a directory or refused, so
 * the agent never runs silently without a configured plugin.
 */
export function resolvePluginDirs(entries: readonly string[], workspace: string): string[] {
  return entries.map((entry) => {
    const abs = isAbsolute(entry) ? resolve(entry) : resolve(workspace, entry);
    let real: string;
    let isDir: boolean;
    try {
      real = realpathSync(abs);
      isDir = statSync(real).isDirectory();
    } catch {
      throw new Error(`claude-cli pluginDirs: '${entry}' does not exist (looked for ${abs})`);
    }
    if (!isDir) throw new Error(`claude-cli pluginDirs: '${entry}' is not a directory`);
    if (!isAbsolute(entry) && !isInsideDir(realpathSync(workspace), real)) {
      throw new Error(`claude-cli pluginDirs: '${entry}' resolves outside the worktree and is refused`);
    }
    return abs;
  });
}

export function buildPrompt(cfg: ClaudeCliConfig, input: RunInput): string {
  const subject = JSON.stringify(input.subject ?? null, null, 2);
  const addendum = input.promptAddendum !== undefined && input.promptAddendum !== '' ? `\n\n${input.promptAddendum}` : '';
  let prompt = `${cfg.prompt}${addendum}\n\n## Work item\n\n\`\`\`json\n${subject}\n\`\`\``;
  if (input.feedback !== undefined && input.feedback !== '') prompt += `\n\n## Feedback\n\n${input.feedback}`;
  return prompt;
}

/**
 * The claude CLI arguments. In bare mode, `--bare` skips hooks, plugins, auto-memory, keychain
 * reads and CLAUDE.md auto-discovery (per `claude --help`); `claudeMdFile`, when given, is passed
 * as `--append-system-prompt-file=<file>`, one of the options the help lists for supplying context
 * in bare mode. `pluginDirs` (already resolved) become `--plugin-dir` flags. No `--add-dir`: the worktree is already the child's working directory.
 */
export function buildArgs(cfg: ClaudeCliConfig, prompt: string, claudeMdFile?: string, pluginDirs: readonly string[] = []): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // `claude --help` (2.1.286) does not list this requirement, but Claude Code
    // has historically refused `-p --output-format stream-json` without
    // `--verbose`; it is harmless when not required, so always pass it.
    '--verbose',
    '--max-budget-usd',
    String(cfg.maxBudgetUsd),
    // Headless: tools in --allowedTools are pre-approved; anything else that
    // would prompt is denied immediately instead of waiting for an answer.
    '--permission-prompts',
    'none',
  ];
  if (cfg.bare) {
    args.push('--bare');
    // One argv element (`=` form), so a path can never be read as a separate option or argument.
    if (claudeMdFile !== undefined) args.push(`--append-system-prompt-file=${claudeMdFile}`);
  }
  // One argv element per plugin directory (`=` form, so the flag cannot swallow the prompt), in both modes.
  for (const dir of pluginDirs) args.push(`--plugin-dir=${dir}`);
  // `--allowedTools` is variadic; the `=` form stops it from swallowing the
  // positional prompt. Entries may contain spaces (e.g. `Bash(git *)`).
  if (cfg.allowedTools.length > 0) args.push(`--allowedTools=${cfg.allowedTools.join(',')}`);
  if (cfg.permissionMode !== undefined) args.push('--permission-mode', cfg.permissionMode);
  if (cfg.settingSources !== undefined) args.push('--setting-sources', cfg.settingSources);
  // `--` keeps a prompt that starts with `-` from being read as an option.
  args.push('--', prompt);
  return args;
}

interface Outcome {
  collector: StreamCollector;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function failureReason(o: Outcome): string | null {
  const r = o.collector.result;
  let reason: string | null = null;
  if (o.signal !== null) reason = `claude was killed by signal ${o.signal}`;
  else if (r === null) {
    reason = o.code !== 0
      ? `claude exited with code ${o.code} without a result event`
      : 'claude output ended without a result event';
  } else if (!o.collector.succeeded()) {
    const subtype = typeof r.subtype === 'string' ? r.subtype : 'unknown';
    const text = o.collector.finalText();
    reason = `claude reported an error result (${subtype})${text ? `: ${text}` : ''}`;
  } else if (o.code !== 0) reason = `claude exited with code ${o.code}`;
  if (reason === null) return null;
  const stderr = o.stderr.trim();
  return truncate(stderr ? `${reason}; stderr: ${stderr}` : reason, SUMMARY_MAX);
}

function buildResult(cfg: ClaudeCliConfig, o: Outcome): unknown {
  const failure = failureReason(o);
  const text = o.collector.finalText();
  const block = lastJsonBlock(text);

  if (cfg.resultFormat === 'json') {
    if (failure !== null) return { status: 'error', summary: failure };
    if (!block.ok) return { status: 'error', summary: block.reason };
    // The model's own cost is not part of its answer: record it with the result.
    const cost = o.collector.costUsd();
    const v = block.value;
    if (cost !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v) && !('costUsd' in v)) {
      return { ...v, costUsd: cost };
    }
    return v;
  }

  const parsed = block.ok ? blockSchema.safeParse(block.value) : null;
  const fromBlock = parsed?.success ? parsed.data : undefined;
  const result: ExecutionResult = {
    status: failure === null ? 'ok' : 'error',
    summary: truncate(failure ?? fromBlock?.summary ?? text ?? '', SUMMARY_MAX),
    steps: [...o.collector.steps],
  };
  const cost = o.collector.costUsd();
  if (cost !== undefined) result.costUsd = cost;
  if (fromBlock?.followups !== undefined) result.followups = fromBlock.followups;
  if (fromBlock?.feedbackResponses !== undefined) result.feedbackResponses = fromBlock.feedbackResponses;
  if (fromBlock?.ask !== undefined) result.ask = fromBlock.ask;
  return result;
}

/**
 * Runs `claude -p` headless in the job's workspace, reading stream-json events.
 * The child runs detached (its own process group) so timeouts and aborts can
 * kill the whole tree.
 */
export class ClaudeCliRunner implements Runner {
  readonly name = 'claude-cli';
  readonly configSchema = configSchema;
  private readonly bin: string;
  private readonly env: Record<string, string>;
  private readonly withheld: readonly string[];
  private readonly spawn: typeof spawn;
  private readonly removeDir: Remover;

  constructor(opts: ClaudeCliRunnerOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.env = opts.env ?? {};
    this.withheld = opts.withheldEnv ?? [];
    this.spawn = opts.spawn ?? spawn;
    this.removeDir = opts.removeDir ?? rmSync;
  }

  async run(input: RunInput, signal: AbortSignal, hooks?: RunHooks): Promise<unknown> {
    if (signal.aborted) throw abortError();
    // Configuration problems throw before anything is created or spawned (the kernel dead-letters
    // them as runner_error with this message).
    const cfg = configSchema.parse(input.config);
    const passEnv = cfg.passEnv ?? [];
    if (cfg.bare) {
      // Check the credential on the allow-listed environment before creating any directory.
      const probe = bareChildEnv({ parent: process.env, overrides: this.env, passEnv, home: '', ghConfigDir: '', withheld: this.withheld });
      if (!hasProviderCredential(probe, passEnv)) throw new Error(missingCredentialMessage());
    }
    const claudeMdFile = cfg.bare ? worktreeClaudeMd(input.workspace.path) : undefined;
    const pluginDirs = resolvePluginDirs(cfg.pluginDirs, input.workspace.path);
    await assertPluginDirsUnchanged(cfg.pluginDirs, pluginDirs, input.workspace.path, input.pluginBase);
    const args = buildArgs(cfg, buildPrompt(cfg, input), claudeMdFile, pluginDirs);

    return new Promise<unknown>((resolve, reject) => {
      const collector = new StreamCollector();
      const splitter = new LineSplitter();
      let stderr = '';
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let settled = false;
      let inactivityTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;

      // Fresh, empty per-run directories, removed best-effort (never throwing) once the run settles
      // (every path below goes through settle(), or removes them itself when spawn throws). Bare mode: `<scratch>/home`
      // (HOME and the XDG base directories) and `<scratch>/gh`; otherwise one gh config directory.
      const scratch = mkdtempSync(join(tmpdir(), cfg.bare ? 'factory-run-' : 'factory-gh-'));
      const removeScratch = (): void => {
        removeScratchDir(scratch, this.removeDir);
      };
      let child;
      try {
        let env: Record<string, string>;
        if (cfg.bare) {
          const home = join(scratch, 'home');
          const ghConfigDir = join(scratch, 'gh');
          mkdirSync(home);
          mkdirSync(ghConfigDir);
          env = bareChildEnv({ parent: process.env, overrides: this.env, passEnv, home, ghConfigDir, withheld: this.withheld });
        } else {
          env = childEnv(this.env, scratch, this.withheld);
        }
        child = this.spawn(this.bin, args, {
          cwd: input.workspace.path,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        removeScratch();
        reject(err);
        return;
      }
      const pid = child.pid;

      const killGroup = (): void => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* ESRCH: the group is already gone */
        }
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(inactivityTimer);
        clearTimeout(hardTimer);
        signal.removeEventListener('abort', onAbort);
        removeScratch();
        fn();
      };
      const fail = (err: unknown): void => {
        // Kill first, so no process of the run is still writing into the scratch directory when
        // settle() removes it.
        killGroup();
        settle(() => reject(err));
      };
      const onAbort = (): void => fail(abortError());
      const armInactivity = (): void => {
        if (settled) return;
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () => fail(new RunnerTimeoutError(`no output from claude for ${cfg.inactivityTimeoutMs} ms`)),
          cfg.inactivityTimeoutMs,
        );
      };
      const handleLine = (line: string): void => {
        const ev = parseStreamLine(line);
        if (ev === null) return;
        armInactivity();
        collector.add(ev);
      };

      child.on('error', fail); // e.g. ENOENT; `close` may follow and is ignored
      child.stdout.on('data', (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });
      child.on('exit', (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        // Reap anything the child left behind in its group; this also closes
        // pipes a background grandchild may hold, so `close` can fire.
        killGroup();
        if (pid !== undefined && hooks?.onExit) {
          try {
            hooks.onExit(pid, code);
          } catch (err) {
            fail(err);
          }
        }
      });
      child.on('close', () => {
        const rest = splitter.end();
        if (rest !== null) handleLine(rest);
        settle(() => {
          try {
            resolve(buildResult(cfg, { collector, code: exitCode, signal: exitSignal, stderr }));
          } catch (err) {
            reject(err);
          }
        });
      });

      if (pid === undefined) return; // spawn failed; the `error` event settles

      signal.addEventListener('abort', onAbort, { once: true });
      hardTimer = setTimeout(
        () => fail(new RunnerTimeoutError(`claude exceeded the ${cfg.timeoutMs} ms time limit`)),
        cfg.timeoutMs,
      );
      armInactivity();
      try {
        // A detached child leads its own process group, so pgid === pid.
        hooks?.onSpawn?.({ pid, pgid: pid, startTime: readProcessStartTime(pid) ?? 0 });
      } catch (err) {
        fail(err);
      }
    });
  }
}
