import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/index.js';

const TOKEN_VAR = 'FACTORY_TEST_GH_TOKEN';

describe('lazy GitHub auth', () => {
  let dir: string;
  let tmp: string;
  let savedTmpdir: string | undefined;
  let out: string[];
  let err: string[];

  const authDirs = () => readdirSync(tmp).filter((n) => n.startsWith('factory-github-'));
  const cli = (args: string[], extra: { onSignal?: (s: 'SIGINT' | 'SIGTERM', h: () => void) => void } = {}) =>
    run(args, { cwd: dir, stdout: (l) => out.push(l), stderr: (l) => err.push(l), ...extra });

  const writeConfig = (withGithub: boolean) =>
    writeFileSync(
      join(dir, 'factory.config.json'),
      JSON.stringify({
        dbPath: join(dir, 'f.db'),
        workspaceRoot: join(dir, 'ws'),
        ...(withGithub ? { github: { tokenEnv: TOKEN_VAR, expectLogin: 'bot' } } : {}),
      }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-lazy-auth-'));
    tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    delete process.env[TOKEN_VAR];
    out = [];
    err = [];
    writeConfig(true);
  });

  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    delete process.env[TOKEN_VAR];
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([['status'], ['show', '1'], ['events'], ['workers'], ['dlq', 'list'], ['policies'], ['--help']])(
    'read-only command %s works without the token and creates no directory',
    async (...args) => {
      const code = await cli(args);
      // `show 1` reports a missing chain (1); everything else succeeds. None mentions the token.
      expect(code).toBe(args[0] === 'show' ? 1 : 0);
      expect(err.join('\n')).not.toContain(TOKEN_VAR);
      expect(authDirs()).toEqual([]);
    },
  );

  it.each([[['worker', '--id', 'w']], [['submit', 'https://github.com/o/r/issues/1']]])(
    '%s refuses without the token, naming the variable, and creates no directory',
    async (args) => {
      expect(await cli(args)).toBe(1);
      expect(err.join('\n')).toContain(TOKEN_VAR);
      expect(err.join('\n')).toContain('read-only');
      expect(out.join('\n')).not.toContain('started');
      expect(authDirs()).toEqual([]);
    },
  );

  it('removes the directory after a signal-driven worker shutdown', async () => {
    process.env[TOKEN_VAR] = 'tok-' + 'x'.repeat(20);
    // A stub `gh` answers the login check; nothing reaches the network.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '{"login":"bot"}'\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      await workerShutdown();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  async function workerShutdown(): Promise<void> {
    const handlers = new Map<string, () => void>();
    const exit = cli(['worker', '--poll-ms', '5', '--id', 'w'], { onSignal: (s, h) => void handlers.set(s, h) });
    for (let i = 0; i < 400 && !out.some((l) => l.includes('started')); i++) await new Promise((r) => setTimeout(r, 5));
    expect(authDirs()).toHaveLength(1);
    handlers.get('SIGTERM')!();
    expect(await exit).toBe(0);
    expect(authDirs()).toEqual([]);
  }

  it('works unchanged without a github configuration', async () => {
    writeConfig(false);
    expect(await cli(['status'])).toBe(0);
    expect(authDirs()).toEqual([]);
  });
});
