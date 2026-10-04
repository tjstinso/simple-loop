import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/cli/config.js';
import { ExecGitPorts } from '../../../src/engines/software/git-ports.js';
import { GhCliHost, type ExecFn } from '../../../src/engines/software/github.js';
import {
  ASKPASS_TOKEN_VAR,
  createGithubAuth,
  createLazyGithubAuth,
  gitAuthEnv,
  readToken,
  verifyLogin,
  type GithubAuth,
} from '../../../src/engines/software/identity.js';
import { redactSecrets, REDACTED, secretEnvValues } from '../../../src/engines/software/secret-scan.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { GitWorkspaceProvider, type SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import type { ChainView, Job } from '../../../src/kernel/types.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from '../../support/temp-repo.js';

// Built by concatenation so no token-shaped literal appears in this file.
const TOKEN = 'gh' + 'p_' + 'a1B2'.repeat(9);

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('GhCliHost with a GitHub identity', () => {
  const calls: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
  const exec: ExecFn = async (_file, args, opts) => {
    calls.push({ args, env: opts?.env });
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', exitCode: 0 };
    if (args.join(' ') === 'api -X GET user') return { stdout: '{"login":"factory-bot"}', stderr: '', exitCode: 0 };
    return { stdout: '[]', stderr: '', exitCode: 0 };
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it('sets GH_TOKEN, GH_HOST and an isolated, empty GH_CONFIG_DIR on every call', async () => {
    const auth = createGithubAuth(TOKEN, tmp('factory-id-'));
    const host = new GhCliHost({ exec, auth });
    await host.findPrByHead('o/r', 'b');
    await host.findComment('o/r', 1, 'm');
    await host.setLabels('o/r', 1, [], ['x']);
    await host.listPrFeedback('o/r', 1);
    await host.findIssueByMarker('o/r', 'm', 'l');
    expect(await host.currentLogin().catch(() => '')).toBe('factory-bot');
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.env).toEqual({ GH_TOKEN: TOKEN, GH_CONFIG_DIR: auth.ghConfigDir, GH_HOST: 'github.com' });
      expect(c.args.join(' ')).not.toContain(TOKEN);
    }
    expect(readdirSync(auth.ghConfigDir)).toEqual([]);
  });

  it('adds no environment without a github identity (behavior unchanged)', async () => {
    await new GhCliHost({ exec }).findPrByHead('o/r', 'b');
    expect(calls[0]!.env).toBeUndefined();
  });
});

describe('the askpass helper', () => {
  it('returns the user name and the token from the environment, and holds no token itself', () => {
    const auth = createGithubAuth(TOKEN, tmp('factory-id-'));
    const env = { PATH: process.env.PATH ?? '', ...gitAuthEnv(auth) };
    const ask = (prompt: string) => execFileSync(auth.askpassPath, [prompt], { env, encoding: 'utf8' }).trim();
    expect(ask("Username for 'https://github.com': ")).toBe('x-access-token');
    expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(TOKEN);
    expect(readFileSync(auth.askpassPath, 'utf8')).not.toContain(TOKEN);
    expect(statSync(auth.askpassPath).mode & 0o077).toBe(0);
    expect(gitAuthEnv(auth)[ASKPASS_TOKEN_VAR]).toBe(TOKEN);
  });
});

const chain: ChainView<SoftwareState> = {
  id: 1, engine: 'software', subjectKey: 'k', status: 'active',
  state: { repo: 'acme/widgets', issueNumber: 7, labels: [], profile: 'supervised', branch: 'factory/issue-7', attempt: 1, phase: 'executing' },
};
const job: Job = {
  id: 1, chainId: 1, type: 'execute', attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null,
  claimedBy: 'w', leaseExpiresAt: null, delivery: 1, error: null,
};

/** Every regular file under `dir` (the .git directories included). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe('git with a GitHub identity (local file remote)', () => {
  let remote: TempRemote;
  let root: string;
  let auth: GithubAuth;
  let ws: SoftwareWorkspace;
  const identity = { name: 'Factory Bot', email: 'bot@example.com' };

  beforeEach(async () => {
    remote = makeRemote();
    root = tmp('factory-id-ws-');
    auth = createGithubAuth(TOKEN, tmp('factory-id-'));
    ws = await new GitWorkspaceProvider({ cloneUrlFor: () => remote.url, root, keepOnFailure: false, auth, identity }).prepare(chain, job);
  });
  afterEach(() => remote.cleanup());

  it('commits with the configured identity and pushes; the token appears in no file, URL or config', async () => {
    const ports = new ExecGitPorts({ auth, identity });
    writeFileSync(join(ws.path, 'a.txt'), 'a\n');
    expect(await ports.commitAll(ws, 'work')).toBe(true);
    expect(git(ws.path, ['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe('Factory Bot <bot@example.com>|Factory Bot <bot@example.com>');
    const sha = await ports.headSha(ws);
    await ports.push(ws, { sha, remoteBranch: 'factory/issue-7', expectSha: null });
    expect(git(remote.path, ['rev-parse', 'refs/heads/factory/issue-7'])).toBe(sha);

    expect(ws.remoteUrl).not.toContain(TOKEN);
    expect(ws.remoteUrl).not.toMatch(/@/);
    expect(git(ws.cacheDir, ['config', '--get', 'user.name'])).toBe('Factory Bot');
    expect(git(ws.cacheDir, ['config', '--get', 'user.email'])).toBe('bot@example.com');
    expect(git(ws.cacheDir, ['config', '--list'])).not.toContain(TOKEN);
    for (const f of [...filesUnder(root), ...filesUnder(auth.ghConfigDir), auth.askpassPath]) {
      expect(readFileSync(f).includes(TOKEN), f).toBe(false);
    }
  });

  it('ExecGitPorts keeps the default factory identity without one configured', async () => {
    const ports = new ExecGitPorts();
    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    await ports.commitAll(ws, 'work');
    expect(git(ws.path, ['log', '-1', '--format=%an <%ae>'])).toBe('factory <factory@localhost>');
  });
});

describe('github configuration', () => {
  const load = (cfg: unknown) => {
    const d = tmp('factory-id-cfg-');
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify(cfg));
    return loadConfig(undefined, d);
  };

  it('has no github object by default', () => {
    expect(load({}).github).toBeUndefined();
  });

  it('accepts the four fields', () => {
    expect(load({ github: { tokenEnv: 'FACTORY_GH_TOKEN', expectLogin: 'bot', commitName: 'Bot', commitEmail: 'b@x.io' } }).github).toEqual({
      tokenEnv: 'FACTORY_GH_TOKEN', expectLogin: 'bot', commitName: 'Bot', commitEmail: 'b@x.io',
    });
  });

  it('requires expectLogin with tokenEnv, and an https URL without credentials', () => {
    expect(() => load({ github: { tokenEnv: 'FACTORY_GH_TOKEN' } })).toThrow(/expectLogin/);
    expect(() => load({ github: { tokenEnv: 'T', expectLogin: 'b' }, cloneUrlTemplate: 'git@github.com:{repo}.git' })).toThrow(/https/);
    expect(() => load({ github: { tokenEnv: 'T', expectLogin: 'b' }, cloneUrlTemplate: 'https://u:p@github.com/{repo}.git' })).toThrow(/https/);
  });
});

describe('startup checks', () => {
  it('a missing or empty token variable is an error naming the variable, never its value', () => {
    expect(() => readToken('FACTORY_GH_TOKEN', {})).toThrow(/FACTORY_GH_TOKEN/);
    expect(() => readToken('FACTORY_GH_TOKEN', { FACTORY_GH_TOKEN: '  ' })).toThrow(/FACTORY_GH_TOKEN/);
    expect(readToken('FACTORY_GH_TOKEN', { FACTORY_GH_TOKEN: TOKEN })).toBe(TOKEN);
  });

  it('refuses a login mismatch naming both logins, and accepts a match', async () => {
    const host = { currentLogin: async () => 'someone-else' };
    const err = await verifyLogin(host, 'factory-bot').then(() => null, (e: Error) => e);
    expect(err?.message).toContain('someone-else');
    expect(err?.message).toContain('factory-bot');
    await expect(verifyLogin({ currentLogin: async () => 'Factory-Bot' }, 'factory-bot')).resolves.toBeUndefined();
  });
});

describe('redaction of the token', () => {
  it('registers the token variable by name and replaces its value in published text', () => {
    const env = { MY_BOT_CREDS: TOKEN, PATH: '/bin' };
    const values = secretEnvValues(env, ['MY_BOT_CREDS']);
    expect(values).toContain(TOKEN);
    const text = `body ${TOKEN} end`;
    expect(redactSecrets(text, values)).toBe(`body ${REDACTED} end`);
  });
});

it('creates the per-worker directory', () => {
  const auth = createGithubAuth(TOKEN, tmp('factory-id-'));
  expect(existsSync(auth.askpassPath)).toBe(true);
});

describe('createLazyGithubAuth', () => {
  it('reads the token and creates the directory only on first use, and dispose removes it', () => {
    const base = mkdtempSync(join(tmpdir(), 'factory-lazy-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = base;
    try {
      const lazy = createLazyGithubAuth('X_TOKEN', { X_TOKEN: 'tok-' + 'y'.repeat(20) });
      expect(readdirSync(base)).toEqual([]);
      expect(lazy.auth.token).toBe('tok-' + 'y'.repeat(20));
      expect(readdirSync(base)).toHaveLength(1);
      lazy.dispose();
      lazy.dispose();
      expect(readdirSync(base)).toEqual([]);
      expect(() => createLazyGithubAuth('MISSING', {}).ensure()).toThrow(/MISSING/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
