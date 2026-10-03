import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCliRunner } from '../../src/runner/claude-cli.js';
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

function runner(mode: string, extraEnv: Record<string, string> = {}): ClaudeCliRunner {
  return new ClaudeCliRunner({ bin: STUB, env: { STUB_MODE: mode, ...extraEnv } });
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
    try {
      const inp = input({ config: config({ resultFormat: 'json' }) });
      const { env } = (await runner('echo', { EXTRA_OVERRIDE: 'yes' }).run(inp, signal())) as { env: Record<string, string> };
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GITHUB_PAT_EXTRA).toBeUndefined();
      expect(Object.keys(env).filter((k) => k.startsWith('GH_') || k.startsWith('GITHUB_'))).toEqual([]);
      expect(env.FACTORY_KEEP_ME).toBe('kept');
      expect(env.EXTRA_OVERRIDE).toBe('yes');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
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
    const r = new ClaudeCliRunner({ bin: join(tmpdir(), 'definitely-not-a-claude-binary') });
    await expect(r.run(input(), signal())).rejects.toThrow();
  });
});

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
