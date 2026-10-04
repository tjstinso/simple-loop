import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The `github` object of the configuration: the factory's own GitHub identity. */
export interface GithubSettings {
  /** Name of the environment variable holding the identity's token. */
  tokenEnv?: string | undefined;
  /** The login the token must resolve to. */
  expectLogin?: string | undefined;
  commitName?: string | undefined;
  commitEmail?: string | undefined;
}

/** What the host adapter and the git commands authenticate with. */
export interface GithubAuth {
  token: string;
  /** An empty directory used as `GH_CONFIG_DIR`, so the operator's own `gh` login is never found. */
  ghConfigDir: string;
  /** The GIT_ASKPASS helper script (it holds no token). */
  askpassPath: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

/** The variable the askpass helper reads the token from (set only in git's child environment). */
export const ASKPASS_TOKEN_VAR = 'FACTORY_GIT_ASKPASS_TOKEN';

/** Resets git's credential helper list, so an operator's helper (for example `gh auth setup-git`) is never asked first. */
export const NO_CREDENTIAL_HELPER_ARGS = ['-c', 'credential.helper='];

/** The token held in `env[name]`; a missing or empty variable is an error naming the variable, never its value. */
export function readToken(name: string, env: Readonly<Record<string, string | undefined>>): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`github.tokenEnv: the environment variable ${name} is not set or is empty`);
  }
  return value;
}

const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$${ASKPASS_TOKEN_VAR}" ;;
esac
`;

/**
 * Creates the per-worker directory with the empty `gh` config directory and the askpass helper. The
 * helper reads the token from the environment of the git process; nothing secret is written to disk.
 */
export function createGithubAuth(token: string, baseDir: string = tmpdir()): GithubAuth {
  const dir = mkdtempSync(join(baseDir, 'factory-github-'));
  const ghConfigDir = join(dir, 'gh');
  mkdirSync(ghConfigDir, { mode: 0o700 });
  const askpassPath = join(dir, 'askpass.sh');
  writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
  return { token, ghConfigDir, askpassPath };
}

/** The environment that makes a git command authenticate over HTTPS with the token. */
export function gitAuthEnv(auth: GithubAuth): Record<string, string> {
  return { GIT_ASKPASS: auth.askpassPath, GIT_TERMINAL_PROMPT: '0', [ASKPASS_TOKEN_VAR]: auth.token };
}

/** The environment of every `gh` call: the token, an isolated config directory and github.com. */
export function ghAuthEnv(auth: GithubAuth): Record<string, string> {
  return { GH_TOKEN: auth.token, GH_CONFIG_DIR: auth.ghConfigDir, GH_HOST: 'github.com' };
}

/** Refuses to start when the token resolves to another login than `expectLogin` (logins are case-insensitive). */
export async function verifyLogin(host: { currentLogin(): Promise<string> }, expectLogin: string): Promise<void> {
  const actual = await host.currentLogin();
  if (actual.toLowerCase() !== expectLogin.toLowerCase()) {
    throw new Error(`the GitHub token resolves to the login '${actual}', but github.expectLogin is '${expectLogin}'`);
  }
}
