import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface TempRemote {
  url: string;
  path: string;
  cleanup(): void;
  commit(branch: string, file: string, content: string): string;
}

/** A bare repository with an initial `main` commit (README.md). */
export function makeRemote(): TempRemote {
  const dir = mkdtempSync(join(tmpdir(), 'factory-remote-'));
  const path = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  try {
    git(dir, ['init', '--bare', '-b', 'main', path]);
    git(dir, ['-c', 'init.defaultBranch=main', 'init', seed]);
    writeFileSync(join(seed, 'README.md'), 'hello\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'initial']);
    git(seed, ['push', path, 'HEAD:refs/heads/main']);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  let n = 0;
  return {
    url: path,
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    commit(branch, file, content) {
      const clone = join(dir, `clone-${n++}`);
      git(dir, ['clone', path, clone]);
      const exists = git(clone, ['ls-remote', '--heads', 'origin', branch]) !== '';
      git(clone, ['checkout', '-B', branch, exists ? `origin/${branch}` : 'origin/main']);
      mkdirSync(dirname(join(clone, file)), { recursive: true });
      writeFileSync(join(clone, file), content);
      git(clone, ['add', '.']);
      git(clone, ['commit', '-m', `add ${file}`]);
      const sha = git(clone, ['rev-parse', 'HEAD']);
      git(clone, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      rmSync(clone, { recursive: true, force: true });
      return sha;
    },
  };
}
