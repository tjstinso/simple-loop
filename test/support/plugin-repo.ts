import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GIT_TEST_ENV } from './temp-repo.js';

export interface PluginRepo {
  /** The worktree (also the repository's work tree). */
  path: string;
  /** Stands in for the shared cache: holds `refs/remotes/origin/main`. */
  base: { cacheDir: string; baseBranch: string };
  git(...args: string[]): string;
  cleanup(): void;
}

/** A temporary repository whose `refs/remotes/origin/main` holds `files` (relative path -> content). */
export function makePluginRepo(files: Record<string, string>): PluginRepo {
  const path = mkdtempSync(join(tmpdir(), 'factory-plug-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: path, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { path, base: { cacheDir: join(path, '.git'), baseBranch: 'main' }, git, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
