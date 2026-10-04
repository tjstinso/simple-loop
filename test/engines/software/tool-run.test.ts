import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildToolEnv, buildVerifyFeedback, runCommand } from '../../../src/engines/software/tool-run.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-tool-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('buildToolEnv', () => {
  const secret = 'ghp_' + 'a'.repeat(36);
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    LANG: 'C.UTF-8',
    TERM: 'xterm',
    TZ: 'UTC',
    TMPDIR: '/tmp',
    HTTPS_PROXY: 'http://proxy:3128',
    SSL_CERT_FILE: '/etc/ca.pem',
    GH_TOKEN: secret,
    GITHUB_TOKEN: secret,
    GIT_ASKPASS: '/bin/askpass',
    SSH_AUTH_SOCK: '/run/ssh',
    ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(30),
    MY_FACTORY_TOKEN: secret,
    AWS_SECRET_ACCESS_KEY: 'abc',
  };

  it('keeps only the allow-list and never a secret', () => {
    const env = buildToolEnv(parent, { home: '/run/empty', withheld: ['MY_FACTORY_TOKEN'] });
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      TERM: 'xterm',
      TZ: 'UTC',
      TMPDIR: '/tmp',
      HTTPS_PROXY: 'http://proxy:3128',
      SSL_CERT_FILE: '/etc/ca.pem',
      HOME: '/run/empty',
      XDG_CONFIG_HOME: '/run/empty',
      XDG_DATA_HOME: '/run/empty',
      XDG_CACHE_HOME: '/run/empty',
      XDG_STATE_HOME: '/run/empty',
      CI: 'true',
    });
    expect(JSON.stringify(env)).not.toContain(secret);
  });

  it('withholds a token variable even when it is on the allow-list', () => {
    expect(buildToolEnv({ HTTPS_PROXY: 'x' }, { withheld: ['HTTPS_PROXY'] })).not.toHaveProperty('HTTPS_PROXY');
  });

  it('sets CI=true over a parent CI', () => {
    expect(buildToolEnv({ CI: 'false' }).CI).toBe('true');
  });
});

describe('runCommand', () => {
  const base = () => ({ cwd: tmp(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 10_000 });

  it('reports success and the output', async () => {
    const r = await runCommand(['node', '-e', 'console.log("hi"); console.error("err")'], base());
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, truncated: false });
    expect(r.output).toContain('hi');
    expect(r.output).toContain('err');
  });

  it('reports the exit code of a failure', async () => {
    const r = await runCommand(['node', '-e', 'console.log("boom"); process.exit(3)'], base());
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('boom');
  });

  it('runs in cwd with exactly the given environment and no shell', async () => {
    const o = base();
    const r = await runCommand(['node', '-e', 'console.log(process.cwd(), process.env.SECRET ?? "none", process.argv[1])', '$(echo injected)'], { ...o, env: { ...o.env, CI: 'true' } });
    expect(r.output).toContain('none');
    expect(r.output).toContain('$(echo injected)');
  });

  it('reports a program that cannot start', async () => {
    const r = await runCommand(['definitely-not-a-program-xyz'], base());
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeDefined();
  });

  it('kills the process group and its children on timeout', async () => {
    const o = base();
    const pidFile = join(o.cwd, 'child.pid');
    const script = `const {spawn}=require('child_process');const c=spawn('sleep',['60'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const r = await runCommand(['node', '-e', script], { ...o, timeoutMs: 1000 });
    expect(r.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(pid)).toBe(false);
  });

  it('kills the group on abort', async () => {
    const ac = new AbortController();
    const p = runCommand(['node', '-e', 'setInterval(()=>{},1000)'], { ...base(), signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('keeps only the last bytes of a large output', async () => {
    const r = await runCommand(['node', '-e', 'for(let i=0;i<5000;i++)console.log("line "+i)'], { ...base(), maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(1000);
    expect(r.output).toContain('line 4999');
    expect(r.output).not.toContain('line 0\n');
  });
});

describe('buildVerifyFeedback', () => {
  it('names the command and exit code and keeps the last 200 lines', () => {
    const out = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const f = buildVerifyFeedback(['npm', 'test'], 1, out);
    expect(f).toContain('npm test');
    expect(f).toContain('Exit code: 1');
    expect(f).toContain('untrusted');
    expect(f).toContain('without weakening');
    expect(f).toContain('line 499');
    expect(f).toContain('line 300');
    expect(f).not.toContain('line 299\n');
  });

  it('redacts a planted secret in the output and the known values', () => {
    const token = 'ghp_' + 'b'.repeat(36);
    const f = buildVerifyFeedback(['npm', 'test'], 1, `token ${token}\nvalue hunter2-secret-value`, ['hunter2-secret-value']);
    expect(f).not.toContain(token);
    expect(f).not.toContain('hunter2-secret-value');
    expect(f).toContain('[redacted]');
  });

  it('is capped at 20,000 characters and keeps the end', () => {
    const f = buildVerifyFeedback(['npm', 'test'], 1, Array.from({ length: 150 }, (_, i) => `${i} ${'x'.repeat(500)}`).join('\n'));
    expect(f.length).toBeLessThanOrEqual(20_000);
    expect(f).toContain('149 xxx');
  });
});

