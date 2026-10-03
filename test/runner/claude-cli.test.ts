import { spawn as realSpawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner, childEnv, isInsideDir, removeScratchDir, worktreeClaudeMd } from '../../src/runner/claude-cli.js';
import { loadPolicies } from '../../src/policy/store.js';
import { parseStreamLine } from '../../src/runner/stream.js';
import type { RunHooks, RunInput } from '../../src/runner/types.js';
import type { Job } from '../../src/kernel/types.js';
import { readProcessStartTime } from '../../src/util/proc.js';
import { runnerContract } from './contract.js';

const STUB = resolve(import.meta.dirname, '../support/stub-claude.mjs');

const tmpDirs: string[] = [];
const pidsToReap: number[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

async function expectDead(pid: number): Promise<void> {
  expect(await waitFor(() => !isAlive(pid)), `pid ${pid} still alive`).toBe(true);
}

function readPids(file: string): { pid: number; grandchild: number | null } {
  const p = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; grandchild: number | null };
  pidsToReap.push(p.pid);
  if (p.grandchild) pidsToReap.push(p.grandchild);
  return p;
}

afterEach(() => {
  for (const pid of pidsToReap.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const job: Job = {
  id: 7, chainId: 1, type: 'build', attempt: 1, status: 'running', policyId: 'p',
  payload: null, result: null, claimedBy: null, leaseExpiresAt: null, delivery: 1, error: null,
};

function config(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'Do the thing.',
    allowedTools: ['Read', 'Edit', 'Bash(git *)'],
    maxBudgetUsd: 1.5,
    timeoutMs: 5000,
    inactivityTimeoutMs: 2000,
    resultFormat: 'execution',
    ...over,
  };
}

function input(over: Partial<RunInput> & { config?: unknown } = {}): RunInput {
  return {
    job,
    config: config(),
    subject: { issue: 42, title: 'Fix it' },
    workspace: { path: tmp('cli-ws-') },
    ...over,
  };
}

// Bare mode (the default) refuses to start without a model credential, so the stub runner
// supplies a fake ANTHROPIC_API_KEY through the constructor env (the stub never uses it).
function runner(mode: string, extraEnv: Record<string, string> = {}): ClaudeCliRunner {
  return new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: mode, ANTHROPIC_API_KEY: 'test-key', ...extraEnv } });
}

/** Runs `fn` with `vars` set in process.env (undefined deletes), restoring the environment afterwards. */
async function withParentEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** Hooks that remember the spawned pid so afterEach can reap it on failure. */
function trackingHooks(): RunHooks & { spawned: { pid: number; pgid: number; startTime: number }[]; exits: [number, number | null][] } {
  const spawned: { pid: number; pgid: number; startTime: number }[] = [];
  const exits: [number, number | null][] = [];
  return {
    spawned,
    exits,
    onSpawn(c) {
      spawned.push(c);
      pidsToReap.push(c.pid);
    },
    onExit(pid, code) {
      exits.push([pid, code]);
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;

describe('parseStreamLine', () => {
  it('parses JSON objects with a string type and returns null for noise', () => {
    expect(parseStreamLine('{"type":"result","x":1}')).toEqual({ type: 'result', x: 1 });
    expect(parseStreamLine('  {"type":"system"}\r')).toEqual({ type: 'system' });
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('hello')).toBeNull();
    expect(parseStreamLine('[1,2]')).toBeNull();
    expect(parseStreamLine('{"no_type":1}')).toBeNull();
    expect(parseStreamLine('{"type":"result","sub')).toBeNull();
    expect(parseStreamLine('null')).toBeNull();
  });
});

describe('ClaudeCliRunner', () => {
  it('has name claude-cli and validates its config', () => {
    const r = new ClaudeCliRunner();
    expect(r.name).toBe('claude-cli');
    expect(r.configSchema.safeParse(config()).success).toBe(true);
    expect(r.configSchema.safeParse(config({ resultFormat: 'xml' })).success).toBe(false);
    expect(r.configSchema.safeParse({ prompt: 'x' }).success).toBe(false);
  });

  it('builds the command with -p, --output-format stream-json, --allowedTools and --max-budget-usd', async () => {
    const inp = input({ config: config({ resultFormat: 'json' }), feedback: 'Tests fail on CI.' });
    const res = (await runner('echo').run(inp, signal(), trackingHooks())) as { argv: string[]; cwd: string };
    const argv = res.argv;
    expect(argv).toContain('-p');
    expect(argv.join(' ')).toMatch(/--output-format stream-json/);
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--allowedTools=Read,Edit,Bash(git *)');
    expect(argv.join(' ')).toMatch(/--max-budget-usd 1\.5/);
    expect(argv).not.toContain('--permission-mode');
    const prompt = argv[argv.length - 1]!;
    expect(prompt.startsWith('Do the thing.')).toBe(true);
    expect(prompt).toContain('## Work item');
    expect(prompt).toContain(JSON.stringify({ issue: 42, title: 'Fix it' }, null, 2));
    expect(prompt).toContain('## Feedback\n\nTests fail on CI.');
    expect(prompt.indexOf('## Work item')).toBeLessThan(prompt.indexOf('## Feedback'));
    expect(res.cwd).toBe(inp.workspace.path);
  });

  it('passes --permission-mode only when the config sets it, and omits Feedback when absent', async () => {
    const inp = input({ config: config({ resultFormat: 'json', permissionMode: 'acceptEdits' }) });
    const { argv } = (await runner('echo').run(inp, signal(), trackingHooks())) as { argv: string[] };
    expect(argv.join(' ')).toMatch(/--permission-mode acceptEdits/);
    expect(argv[argv.length - 1]).not.toContain('## Feedback');
  });

  it('collects steps and costUsd from the event stream', async () => {
    const text = 'Done.\n```json\n{"summary":"first"}\n```\nthen\n```json\n{"summary":"Fixed the bug","followups":[{"title":"Docs","body":"Update README"}]}\n```';
    const res = await runner('steps', { STUB_STEPS: '4', STUB_RESULT_TEXT: text }).run(input(), signal(), trackingHooks());
    expect(res).toMatchObject({
      status: 'ok',
      summary: 'Fixed the bug',
      costUsd: 0.42,
      followups: [{ title: 'Docs', body: 'Update README' }],
    });
    const steps = (res as { steps: string[] }).steps;
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('Bash');
    expect(steps[3]).toContain('echo step 4');
  });

  it('uses the final assistant text as summary when there is no json block', async () => {
    const res = await runner('steps', { STUB_STEPS: '1', STUB_RESULT_TEXT: 'plain final words' }).run(input(), signal());
    expect(res).toMatchObject({ status: 'ok', summary: 'plain final words', costUsd: 0.42 });
    expect(res).not.toHaveProperty('followups');
  });

  it('truncates a very long summary', async () => {
    const res = (await runner('steps', { STUB_STEPS: '0', STUB_RESULT_TEXT: 'x'.repeat(50_000) }).run(input(), signal())) as { summary: string };
    expect(res.summary.length).toBeLessThanOrEqual(4000);
  });

  it('resolves status error for json resultFormat with no json block', async () => {
    const inp = input({ config: config({ resultFormat: 'json' }) });
    const res = await runner('steps', { STUB_RESULT_TEXT: 'no block here' }).run(inp, signal());
    expect(res).toMatchObject({ status: 'error' });
    expect((res as { summary: string }).summary).toMatch(/json/i);
  });

  it('resolves status error for an unparseable json block', async () => {
    const inp = input({ config: config({ resultFormat: 'json' }) });
    const res = await runner('steps', { STUB_RESULT_TEXT: '```json\n{not json\n```' }).run(inp, signal());
    expect(res).toMatchObject({ status: 'error' });
  });

  it('aborts and kills the process group after inactivityTimeoutMs of silence', async () => {
    const pidFile = join(tmp('cli-pids-'), 'pids.json');
    const hooks = trackingHooks();
    const started = Date.now();
    const err = await runner('silent', { STUB_PID_FILE: pidFile })
      .run(input({ config: config({ inactivityTimeoutMs: 300, timeoutMs: 10_000 }) }), signal(), hooks)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { reason?: string }).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(pidFile)).toBe(true);
    const { pid, grandchild } = readPids(pidFile);
    expect(hooks.spawned[0]!.pid).toBe(pid);
    await expectDead(pid);
    await expectDead(grandchild!);
  });

  it('enforces the hard timeoutMs even when events keep arriving', async () => {
    const pidFile = join(tmp('cli-pids-'), 'pids.json');
    const started = Date.now();
    const err = await runner('forever', { STUB_PID_FILE: pidFile })
      .run(input({ config: config({ inactivityTimeoutMs: 400, timeoutMs: 700 }) }), signal(), trackingHooks())
      .then(() => null, (e: unknown) => e);
    expect((err as { reason?: string }).reason).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
    const { pid, grandchild } = readPids(pidFile);
    await expectDead(pid);
    await expectDead(grandchild!);
  });

  it('kills the process group on AbortSignal', async () => {
    const pidFile = join(tmp('cli-pids-'), 'pids.json');
    const ac = new AbortController();
    const p = runner('silent', { STUB_PID_FILE: pidFile }).run(
      input({ config: config({ inactivityTimeoutMs: 10_000, timeoutMs: 10_000 }) }),
      ac.signal,
      trackingHooks(),
    );
    const settled = p.then(() => null, (e: unknown) => e);
    expect(await waitFor(() => existsSync(pidFile), 3000)).toBe(true);
    const { pid, grandchild } = readPids(pidFile);
    expect(isAlive(pid)).toBe(true);
    ac.abort(); // mid-run abort
    const err = await settled;
    expect(err).toMatchObject({ name: 'AbortError' });
    await expectDead(pid);
    await expectDead(grandchild!);
  });

  it('reaps processes left in the group after the child exits', async () => {
    const pidFile = join(tmp('cli-pids-'), 'pids.json');
    const res = await runner('orphan', { STUB_PID_FILE: pidFile }).run(input(), signal(), trackingHooks());
    expect(res).toMatchObject({ status: 'ok' });
    const { grandchild } = readPids(pidFile);
    await expectDead(grandchild!);
  });

  it('does not pass GH_TOKEN to the child', async () => {
    const saved = { ...process.env };
    process.env.GH_TOKEN = 'secret-gh';
    process.env.GITHUB_TOKEN = 'secret-github';
    process.env.GH_ENTERPRISE_TOKEN = 'secret-ent';
    process.env.GITHUB_PAT_EXTRA = 'secret-pat';
    process.env.FACTORY_KEEP_ME = 'kept';
    process.env.GH_CONFIG_DIR = '/home/operator/.config/gh';
    try {
      const inp = input({ config: config({ resultFormat: 'json', bare: false }) });
      const { env } = (await runner('echo', { EXTRA_OVERRIDE: 'yes' }).run(inp, signal())) as { env: Record<string, string> };
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GITHUB_PAT_EXTRA).toBeUndefined();
      // The only GH_ variable is the runner's own empty per-run GH_CONFIG_DIR (C1/R32), never the operator's.
      expect(Object.keys(env).filter((k) => (k.startsWith('GH_') && k !== 'GH_CONFIG_DIR') || k.startsWith('GITHUB_'))).toEqual([]);
      expect(env.GH_CONFIG_DIR).toMatch(/factory-gh-/);
      expect(env.FACTORY_KEEP_ME).toBe('kept');
      expect(env.EXTRA_OVERRIDE).toBe('yes');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('isolates git and gh config and drops SSH and askpass variables in the child environment', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      SSH_ASKPASS: '/bin/askpass',
      GIT_ASKPASS: '/bin/git-askpass',
      GIT_SSH_COMMAND: 'ssh -i key',
      GIT_SSH: '/bin/ssh',
      GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
      HOME: process.env.HOME ?? '/home/me',
    });
    try {
      const inp = input({ config: config({ resultFormat: 'json', bare: false }) });
      const { env } = (await runner('echo').run(inp, signal())) as { env: Record<string, string> };
      for (const k of ['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_SSH']) {
        expect(env[k], k).toBeUndefined();
      }
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.HOME).toBe(process.env.HOME); // claude needs its own login
      // A fresh, empty gh config directory per run, removed once the run settles.
      expect(env.GH_CONFIG_DIR).toMatch(/factory-gh-/);
      expect(existsSync(env.GH_CONFIG_DIR!)).toBe(false);
      const second = (await runner('echo').run(inp, signal())) as { env: Record<string, string> };
      expect(second.env.GH_CONFIG_DIR).not.toBe(env.GH_CONFIG_DIR);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('childEnv sets the isolation variables even when the parent has none of the dropped ones', () => {
    const env = childEnv({ EXTRA: '1' }, '/tmp/gh-x');
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GH_CONFIG_DIR: '/tmp/gh-x', EXTRA: '1' });
    expect(Object.keys(env).filter((k) => k.startsWith('GH_') && k !== 'GH_CONFIG_DIR')).toEqual([]);
  });

  it('the gh config directory is empty while the agent runs', async () => {
    const inp = input({ config: config({ resultFormat: 'json' }) });
    const res = (await runner('echo', { STUB_LIST_GH_CONFIG: '1' }).run(inp, signal())) as { ghConfigEntries: string[] | null };
    expect(res.ghConfigEntries).toEqual([]);
  });

  it('passes --setting-sources only when the config sets it', async () => {
    const without = (await runner('echo').run(input({ config: config({ resultFormat: 'json' }) }), signal())) as { argv: string[] };
    expect(without.argv).not.toContain('--setting-sources');
    const withIt = (await runner('echo').run(input({ config: config({ resultFormat: 'json', settingSources: 'user' }) }), signal())) as {
      argv: string[];
    };
    const i = withIt.argv.indexOf('--setting-sources');
    expect(i).toBeGreaterThan(-1);
    expect(withIt.argv[i + 1]).toBe('user');
    expect(withIt.argv.indexOf('--')).toBeGreaterThan(i);
  });

  it('resolves status error for a truncated final line, non-JSON noise, or no result event', async () => {
    for (const mode of ['truncated', 'noise', 'no-result']) {
      const res = await runner(mode).run(input(), signal(), trackingHooks());
      expect(res, mode).toMatchObject({ status: 'error' });
      expect(typeof (res as { summary: unknown }).summary, mode).toBe('string');
    }
    const json = await runner('truncated').run(input({ config: config({ resultFormat: 'json' }) }), signal());
    expect(json).toMatchObject({ status: 'error' });
  });

  it('resolves status error with the exit code for a non-zero exit with no result event', async () => {
    const res = await runner('exit-nonzero').run(input(), signal(), trackingHooks());
    expect(res).toMatchObject({ status: 'error' });
    expect((res as { summary: string }).summary).toMatch(/\b3\b/);
  });

  it('calls onSpawn and onExit with pid and pgid', async () => {
    const hooks = trackingHooks();
    await runner('steps').run(input(), signal(), hooks);
    expect(hooks.spawned).toHaveLength(1);
    const { pid, pgid, startTime } = hooks.spawned[0]!;
    expect(pid).toBeGreaterThan(0);
    expect(pgid).toBe(pid);
    if (process.platform === 'linux') expect(startTime).toBeGreaterThan(0);
    expect(startTime).toBeGreaterThanOrEqual(readProcessStartTime(process.pid) ?? 0);
    expect(hooks.exits).toEqual([[pid, 0]]);
  });

  it('rejects when the binary cannot be spawned', async () => {
    const r = new ClaudeCliRunner({ bin: join(tmpdir(), 'definitely-not-a-claude-binary'), env: { ANTHROPIC_API_KEY: 'test-key' } });
    await expect(r.run(input(), signal())).rejects.toThrow();
  });
});

describe('ClaudeCliRunner bare mode (R47)', () => {
  const ALLOWED = new Set([
    'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES',
    'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
    'TERM', 'TZ', 'TMPDIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // set by the runner itself
    'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GH_CONFIG_DIR',
    // the test's constructor env
    'STUB_MODE', 'STUB_LIST_HOME', 'STUB_LIST_GH_CONFIG',
  ]);

  it('the config schema defaults bare to true', () => {
    const parsed = new ClaudeCliRunner().configSchema.parse(config()) as { bare: boolean };
    expect(parsed.bare).toBe(true);
  });

  it('bare mode adds --bare and no --add-dir', async () => {
    const inp = input({ config: config({ resultFormat: 'json', settingSources: 'user' }) });
    const { argv } = (await runner('echo').run(inp, signal())) as { argv: string[] };
    expect(argv).toContain('--bare');
    // the worktree is already the child's cwd; --add-dir would add nothing the agent needs
    expect(argv.filter((a) => a.startsWith('--add-dir'))).toEqual([]);
    // still headless stream-json with the allow-list, the budget and the setting sources
    expect(argv).toContain('-p');
    expect(argv.join(' ')).toMatch(/--output-format stream-json/);
    expect(argv).toContain('--verbose');
    expect(argv.join(' ')).toMatch(/--permission-prompts none/);
    expect(argv).toContain('--allowedTools=Read,Edit,Bash(git *)');
    expect(argv.join(' ')).toMatch(/--max-budget-usd 1\.5/);
    expect(argv.join(' ')).toMatch(/--setting-sources user/);
    // every option comes before the `--` that precedes the prompt
    expect(argv.indexOf('--bare')).toBeLessThan(argv.indexOf('--'));
  });

  it('bare mode passes the worktree CLAUDE.md as --append-system-prompt-file, only a regular file inside the worktree', async () => {
    const run = async (ws: string, over: Record<string, unknown> = {}) =>
      ((await runner('echo').run(input({ workspace: { path: ws }, config: config({ resultFormat: 'json', ...over }) }), signal())) as { argv: string[] }).argv;
    const extra = (argv: string[]) => argv.filter((a) => a.startsWith('--add-dir') || a.includes('system-prompt'));

    const withFile = tmp('cli-ws-md-');
    writeFileSync(join(withFile, 'CLAUDE.md'), '# rules');
    const argv = await run(withFile);
    const flag = `--append-system-prompt-file=${join(withFile, 'CLAUDE.md')}`;
    expect(extra(argv)).toEqual([flag]); // a single argv element
    expect(argv.indexOf(flag)).toBeLessThan(argv.indexOf('--'));

    const without = tmp('cli-ws-nomd-');
    expect(extra(await run(without))).toEqual([]); // nothing extra

    const dirNamed = tmp('cli-ws-mddir-');
    mkdirSync(join(dirNamed, 'CLAUDE.md'));
    expect(extra(await run(dirNamed))).toEqual([]); // not a regular file

    const inside = tmp('cli-ws-inlink-');
    writeFileSync(join(inside, 'RULES.md'), '# rules');
    symlinkSync(join(inside, 'RULES.md'), join(inside, 'CLAUDE.md'));
    expect(extra(await run(inside))).toEqual([]); // any symlink is skipped

    const outsideWs = tmp('cli-ws-outlink-');
    const outside = join(tmp('cli-outside-'), 'secret.md');
    writeFileSync(outside, 'outside the worktree');
    symlinkSync(outside, join(outsideWs, 'CLAUDE.md'));
    const out = await run(outsideWs);
    expect(extra(out)).toEqual([]);
    expect(out.some((a) => a.includes('secret.md') || a.includes('cli-outside-'))).toBe(false);
    expect(out).toContain('--bare');

    const dangling = tmp('cli-ws-dangling-');
    symlinkSync(join(tmpdir(), 'no-such-claude-md-target'), join(dangling, 'CLAUDE.md'));
    expect(extra(await run(dangling))).toEqual([]);

    // bare false: no CLAUDE.md flag (the CLI discovers CLAUDE.md itself there)
    expect(extra(await run(withFile, { bare: false }))).toEqual([]);
  });

  it('the worktree containment check is not fooled by a sibling with the same prefix', () => {
    const parent = tmp('cli-prefix-');
    const tree = join(parent, 'tree');
    const evil = join(parent, 'tree-evil');
    mkdirSync(tree);
    mkdirSync(evil);
    writeFileSync(join(evil, 'CLAUDE.md'), 'evil');
    expect(isInsideDir(tree, join(evil, 'CLAUDE.md'))).toBe(false);
    expect(isInsideDir(tree, join(tree, 'CLAUDE.md'))).toBe(true);
    expect(isInsideDir(tree, tree)).toBe(false);
    expect(isInsideDir(tree, join(tree, '..', 'tree-evil', 'CLAUDE.md'))).toBe(false);
    // a worktree reached through a symlinked path still contains its own regular CLAUDE.md
    writeFileSync(join(tree, 'CLAUDE.md'), '# rules');
    const linkToTree = join(parent, 'link-to-tree');
    symlinkSync(tree, linkToTree);
    expect(worktreeClaudeMd(linkToTree)).toBe(join(linkToTree, 'CLAUDE.md'));
    expect(worktreeClaudeMd(join(parent, 'tree-nothing'))).toBeUndefined();
  });

  it('bare mode passes only allow-listed environment variables', async () => {
    const realHome = process.env.HOME ?? '/home/real';
    await withParentEnv(
      {
        GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret', SSH_AUTH_SOCK: '/tmp/agent.sock',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000',
        GIT_ASKPASS: '/bin/askpass', AWS_SECRET_ACCESS_KEY: 'aws-secret', GNOME_KEYRING_CONTROL: '/run/user/1000/keyring',
        KRB5CCNAME: 'FILE:/tmp/krb', GOOGLE_APPLICATION_CREDENTIALS: '/x.json', AZURE_CLIENT_SECRET: 'az',
        FACTORY_RANDOM: 'not-allowed', HOME: '/home/real', ANTHROPIC_API_KEY: 'sk-parent', HTTPS_PROXY: 'http://proxy:3128',
        LC_ALL: 'C.UTF-8', LC_TIME: 'C', LANGUAGE: 'en', LC_FOO: 'not-a-category', GH_CONFIG_DIR: '/home/real/.config/gh', XDG_CONFIG_HOME: '/home/real/.config',
      },
      async () => {
        const r = new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: 'echo', STUB_LIST_HOME: '1' } });
        const res = (await r.run(input({ config: config({ resultFormat: 'json' }) }), signal())) as {
          env: Record<string, string>;
          homeEntries: Record<string, string[] | null>;
        };
        const env = res.env;
        const unexpected = Object.keys(env).filter((k) => !ALLOWED.has(k));
        expect(unexpected).toEqual([]);
        expect(env.ANTHROPIC_API_KEY).toBe('sk-parent');
        expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
        expect(env.LC_ALL).toBe('C.UTF-8');
        expect(env.LC_TIME).toBe('C');
        expect(env.LANGUAGE).toBe('en');
        expect(env.LC_FOO).toBeUndefined(); // only the POSIX/glibc locale categories, not an LC_ prefix
        for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GIT_ASKPASS',
          'AWS_SECRET_ACCESS_KEY', 'GNOME_KEYRING_CONTROL', 'KRB5CCNAME', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'FACTORY_RANDOM']) {
          expect(env[k], k).toBeUndefined();
        }
        expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
        expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(env.HOME).not.toBe('/home/real');
        expect(env.HOME).not.toBe(realHome);
        expect(env.HOME).toMatch(/factory-run-/);
        const scratch = join(env.HOME!, '..');
        for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
          expect(env[k]!.startsWith(scratch), k).toBe(true);
        }
        expect(env.GH_CONFIG_DIR!.startsWith(scratch)).toBe(true);
        // HOME and the XDG directories are empty when the agent starts
        for (const [k, entries] of Object.entries(res.homeEntries)) expect(entries, k).toEqual([]);
        // and the whole scratch directory is gone once the run settled
        expect(existsSync(scratch)).toBe(false);
      },
    );
  });

  it('bare mode removes the scratch HOME after normal exit, abort, timeout and spawn failure', async () => {
    const scratchRoot = tmp('cli-tmpdir-');
    await withParentEnv({ TMPDIR: scratchRoot }, async () => {
      const leftovers = () => readdirSync(scratchRoot).filter((e) => e.startsWith('factory-'));
      // normal exit
      const ok = (await runner('echo').run(input({ config: config({ resultFormat: 'json' }) }), signal())) as { env: Record<string, string> };
      expect(ok.env.HOME!.startsWith(scratchRoot)).toBe(true);
      expect(existsSync(ok.env.HOME!)).toBe(false);
      expect(leftovers()).toEqual([]);

      // timeout
      const pidFile = join(tmp('cli-pids-'), 'pids.json');
      const err = await runner('silent', { STUB_PID_FILE: pidFile })
        .run(input({ config: config({ inactivityTimeoutMs: 300, timeoutMs: 10_000 }) }), signal(), trackingHooks())
        .then(() => null, (e: unknown) => e);
      expect((err as { reason?: string }).reason).toBe('timeout');
      const timedOut = JSON.parse(readFileSync(pidFile, 'utf8')) as { home: string };
      readPids(pidFile);
      expect(timedOut.home.startsWith(scratchRoot)).toBe(true);
      expect(existsSync(timedOut.home)).toBe(false);
      expect(leftovers()).toEqual([]);

      // abort
      const pidFile2 = join(tmp('cli-pids-'), 'pids.json');
      const ac = new AbortController();
      const p = runner('silent', { STUB_PID_FILE: pidFile2 })
        .run(input({ config: config({ inactivityTimeoutMs: 10_000, timeoutMs: 10_000 }) }), ac.signal, trackingHooks())
        .then(() => null, (e: unknown) => e);
      expect(await waitFor(() => existsSync(pidFile2), 3000)).toBe(true);
      const aborted = JSON.parse(readFileSync(pidFile2, 'utf8')) as { home: string };
      readPids(pidFile2);
      expect(existsSync(aborted.home)).toBe(true); // present while the agent runs
      ac.abort();
      expect(await p).toMatchObject({ name: 'AbortError' });
      expect(existsSync(aborted.home)).toBe(false);
      expect(leftovers()).toEqual([]);

      // spawn failure
      const bad = new ClaudeCliRunner({ bin: join(scratchRoot, 'no-such-claude'), env: { ANTHROPIC_API_KEY: 'k' } });
      await expect(bad.run(input(), signal())).rejects.toThrow();
      expect(leftovers()).toEqual([]);
    });
  });

  it('passEnv forwards named variables and rejects forbidden names', async () => {
    const schema = new ClaudeCliRunner().configSchema;
    expect(schema.safeParse(config({ passEnv: ['AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK'] })).success).toBe(true);
    for (const bad of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
      'lower_case', '1ABC', 'A-B', '']) {
      expect(schema.safeParse(config({ passEnv: [bad] })).success, bad).toBe(false);
    }
    await withParentEnv({ AWS_REGION: 'eu-west-1', AWS_SECRET_ACCESS_KEY: 'aws-secret', MY_PROVIDER_VAR: 'v' }, async () => {
      const { env } = (await runner('echo').run(
        input({ config: config({ resultFormat: 'json', passEnv: ['AWS_REGION', 'MY_PROVIDER_VAR', 'NOT_SET_ANYWHERE'] }) }),
        signal(),
      )) as { env: Record<string, string> };
      expect(env.AWS_REGION).toBe('eu-west-1');
      expect(env.MY_PROVIDER_VAR).toBe('v');
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined(); // not named
      expect('NOT_SET_ANYWHERE' in env).toBe(false);
    });
    // runtime: a config that skipped startup validation is still refused before anything is spawned
    const hooks = trackingHooks();
    await expect(runner('echo').run(input({ config: config({ passEnv: ['GH_TOKEN'] }) }), signal(), hooks)).rejects.toThrow(/passEnv/);
    expect(hooks.spawned).toEqual([]);
  });

  it('bare mode fails fast with a clear message without ANTHROPIC_API_KEY', async () => {
    const scratchRoot = tmp('cli-tmpdir-');
    await withParentEnv({ ANTHROPIC_API_KEY: undefined, TMPDIR: scratchRoot }, async () => {
      const hooks = trackingHooks();
      const r = new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: 'echo' } });
      const err = await r.run(input(), signal(), hooks).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/ANTHROPIC_API_KEY/);
      expect((err as Error).message).toMatch(/passEnv/);
      expect((err as Error).message).toMatch(/bare/);
      expect(hooks.spawned).toEqual([]);
      expect(readdirSync(scratchRoot).filter((e) => e.startsWith('factory-'))).toEqual([]); // no scratch HOME was created
      // an empty key is not a key
      process.env.ANTHROPIC_API_KEY = '';
      await expect(r.run(input(), signal())).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });
    await withParentEnv({ ANTHROPIC_API_KEY: undefined, MY_PROVIDER_SWITCH: '1' }, async () => {
      const r = new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: 'echo' } });
      // a provider credential forwarded through passEnv satisfies the check
      const res = (await r.run(input({ config: config({ resultFormat: 'json', passEnv: ['MY_PROVIDER_SWITCH'] }) }), signal())) as {
        env: Record<string, string>;
      };
      expect(res.env.MY_PROVIDER_SWITCH).toBe('1');
      // bare false does not check: the claude CLI uses its own login there
      const deny = (await r.run(input({ config: config({ resultFormat: 'json', bare: false }) }), signal())) as { argv: string[] };
      expect(deny.argv).not.toContain('--bare');
    });
  });

  it('bare false keeps the previous deny-list behavior and no --bare', async () => {
    await withParentEnv({ GH_TOKEN: 'gh-secret', SSH_AUTH_SOCK: '/tmp/a.sock', FACTORY_KEEP_ME: 'kept', HOME: '/home/real' }, async () => {
      const res = (await runner('echo').run(input({ config: config({ resultFormat: 'json', bare: false }) }), signal())) as {
        argv: string[];
        env: Record<string, string>;
      };
      expect(res.argv).not.toContain('--bare');
      expect(res.argv.filter((a) => a.startsWith('--add-dir') || a.includes('system-prompt'))).toEqual([]);
      expect(res.env).toEqual(childEnv({ STUB_MODE: 'echo', ANTHROPIC_API_KEY: 'test-key' }, res.env.GH_CONFIG_DIR));
      expect(res.env.HOME).toBe('/home/real');
      expect(res.env.FACTORY_KEEP_ME).toBe('kept');
      expect(res.env.GH_TOKEN).toBeUndefined();
      expect(res.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(res.env.GH_CONFIG_DIR).toMatch(/factory-gh-/);
    });
  });

  it('the shipped policies set bare true and validate', () => {
    const schema = new ClaudeCliRunner().configSchema;
    const policies = loadPolicies(join(import.meta.dirname, '../../policies'));
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect((p.config as { bare?: unknown }).bare, p.id).toBe(true);
      expect(schema.safeParse(p.config).success, p.id).toBe(true);
    }
  });
});

describe('scratch directory removal (R49a)', () => {
  it('removing a scratch HOME that contains a read-only directory with contents does not throw and removes it', () => {
    const scratch = tmp('factory-run-');
    const ro = join(scratch, 'home', 'go', 'pkg', 'mod', 'example.com@v1');
    mkdirSync(ro, { recursive: true });
    writeFileSync(join(ro, 'file.go'), 'package x');
    const locked = join(scratch, 'home', 'locked');
    mkdirSync(join(locked, 'inner'), { recursive: true });
    writeFileSync(join(locked, 'inner', 'f'), 'x');
    chmodSync(ro, 0o555); // like Go's module cache
    chmodSync(join(scratch, 'home', 'go'), 0o555);
    chmodSync(locked, 0o000); // like an agent's `chmod 000`
    try {
      expect(() => removeScratchDir(scratch)).not.toThrow();
      expect(existsSync(scratch)).toBe(false);
    } finally {
      for (const d of [locked, join(scratch, 'home', 'go'), ro]) {
        try {
          chmodSync(d, 0o700);
        } catch {
          /* already removed */
        }
      }
    }
  });

  it('a symlink in the scratch HOME is not followed', () => {
    const scratch = tmp('factory-run-');
    const sentinel = tmp('cli-sentinel-');
    mkdirSync(join(sentinel, 'sub'));
    writeFileSync(join(sentinel, 'sub', 'keep.txt'), 'keep');
    chmodSync(join(sentinel, 'sub'), 0o555);
    mkdirSync(join(scratch, 'home'));
    symlinkSync(sentinel, join(scratch, 'home', 'link'));
    symlinkSync(join(sentinel, 'sub'), join(scratch, 'home', 'link-sub'));
    // force the permission-fixing walk as well
    const ro = join(scratch, 'home', 'ro');
    mkdirSync(join(ro, 'x'), { recursive: true });
    chmodSync(ro, 0o000);
    try {
      removeScratchDir(scratch);
      expect(existsSync(scratch)).toBe(false);
      expect(readFileSync(join(sentinel, 'sub', 'keep.txt'), 'utf8')).toBe('keep');
      expect(statMode(join(sentinel, 'sub'))).toBe(0o555); // not chmodded through the link
    } finally {
      chmodSync(join(sentinel, 'sub'), 0o700);
      try {
        chmodSync(ro, 0o700);
      } catch {
        /* removed */
      }
    }
  });

  it('removal never throws even when it cannot remove something', async () => {
    const failing = (): never => {
      const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    };
    const scratch = tmp('factory-run-');
    expect(() => removeScratchDir(scratch, failing)).not.toThrow();
    const other = (): never => {
      throw new Error('anything else');
    };
    expect(() => removeScratchDir(scratch, other)).not.toThrow();
    // through the runner: a run whose scratch cannot be removed still resolves its result
    const scratchRoot = tmp('cli-tmpdir-');
    await withParentEnv({ TMPDIR: scratchRoot }, async () => {
      const r = new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: 'steps', ANTHROPIC_API_KEY: 'k' }, removeDir: failing });
      await expect(r.run(input(), signal())).resolves.toMatchObject({ status: 'ok' });
      const t = new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: 'silent', ANTHROPIC_API_KEY: 'k' }, removeDir: failing });
      const err = await t
        .run(input({ config: config({ inactivityTimeoutMs: 200, timeoutMs: 10_000 }) }), signal(), trackingHooks())
        .then(() => null, (e: unknown) => e);
      expect((err as { reason?: string }).reason).toBe('timeout');
    });
  });

  it('on timeout the process group is killed before the scratch directory is removed', async () => {
    const order: string[] = [];
    const kill = vi.spyOn(process, 'kill');
    const hooks = trackingHooks();
    const remover = (p: string, o: Parameters<typeof rmSync>[1]): void => {
      const pid = hooks.spawned[0]?.pid;
      const killedGroup = kill.mock.calls.some(([target, sig]) => pid !== undefined && target === -pid && sig === 'SIGKILL');
      order.push(killedGroup ? 'remove-after-kill' : 'remove-before-kill');
      rmSync(p, o);
    };
    const r = new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: 'silent', ANTHROPIC_API_KEY: 'k' }, removeDir: remover });
    const err = await r
      .run(input({ config: config({ inactivityTimeoutMs: 200, timeoutMs: 10_000 }) }), signal(), hooks)
      .then(() => null, (e: unknown) => e);
    expect((err as { reason?: string }).reason).toBe('timeout');
    expect(order[0]).toBe('remove-after-kill');
  });

  it('the synchronous spawn-throw path removes the scratch directory', async () => {
    const scratchRoot = tmp('cli-tmpdir-');
    await withParentEnv({ TMPDIR: scratchRoot }, async () => {
      for (const bare of [true, false]) {
        let seenHome: string | undefined;
        const throwing = ((_bin: string, _args: string[], opts: { env: Record<string, string> }) => {
          seenHome = opts.env.HOME;
          expect(readdirSync(scratchRoot).filter((e) => e.startsWith('factory-'))).toHaveLength(1);
          throw new Error('spawn exploded');
        }) as unknown as typeof realSpawn;
        const r = new ClaudeCliRunner({ bin: STUB, env: { ANTHROPIC_API_KEY: 'k' }, spawn: throwing });
        await expect(r.run(input({ config: config({ bare }) }), signal())).rejects.toThrow('spawn exploded');
        expect(seenHome).toBeDefined();
        expect(readdirSync(scratchRoot).filter((e) => e.startsWith('factory-')), String(bare)).toEqual([]);
      }
    });
  });
});

function statMode(p: string): number {
  return statSync(p).mode & 0o777;
}

runnerContract(() => {
  const ws = mkdtempSync(join(tmpdir(), 'cli-contract-'));
  return {
    runner: runner('steps'),
    validInput: { ...input(), workspace: { path: ws } },
    cleanup() {
      rmSync(ws, { recursive: true, force: true });
    },
  };
});
