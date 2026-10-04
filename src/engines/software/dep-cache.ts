import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from './tool-run.js';

export const DEP_CACHE_MAX_AGE_MS = 30 * 86_400_000;
export const DEP_CACHE_MAX_KEYS = 5;

/** `<workspaceRoot>/.cache/deps`: outside every worktree, so nothing an agent writes reaches it. */
export const depCacheDir = (workspaceRoot: string): string => join(workspaceRoot, '.cache', 'deps');

/** True for the standard install: a single `npm ci` command (flags allowed). */
export function isStandardInstall(setup: readonly (readonly string[])[] | undefined): boolean {
  return setup !== undefined && setup.length === 1 && setup[0]![0] === 'npm' && setup[0]![1] === 'ci';
}

/** The cache key: SHA-256 of `package-lock.json` plus the Node major version; null without a lockfile. */
export async function depCacheKey(workspacePath: string, nodeVersion: string = process.versions.node): Promise<string | null> {
  let lock: Buffer;
  try {
    lock = await readFile(join(workspacePath, 'package-lock.json'));
  } catch {
    return null;
  }
  return `${createHash('sha256').update(lock).digest('hex')}-node${nodeVersion.split('.')[0]}`;
}

export interface DepCacheOptions {
  workspaceRoot: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const copyTree = async (from: string, to: string, o: DepCacheOptions): Promise<boolean> => {
  const r = await runCommand(['cp', '-a', '--reflink=auto', from, to], {
    cwd: o.workspaceRoot,
    env: o.env,
    timeoutMs: o.timeoutMs ?? 300_000,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  return r.exitCode === 0;
};

/**
 * Copies the cached `node_modules` of `key` into the workspace (copy-on-write where the file system
 * supports it, a plain copy otherwise: never a link, so a change in the workspace cannot reach the
 * entry). A corrupt entry (no `.package-lock.json`, failed copy) is deleted and reported as a miss.
 */
export async function restoreDepCache(key: string, workspacePath: string, o: DepCacheOptions): Promise<'hit' | 'miss' | 'corrupt'> {
  const entry = join(depCacheDir(o.workspaceRoot), key);
  if (!existsSync(entry)) return 'miss';
  const target = join(workspacePath, 'node_modules');
  const ok = existsSync(join(entry, 'node_modules', '.package-lock.json')) && (await copyTree(join(entry, 'node_modules'), target, o));
  if (!ok) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await rm(entry, { recursive: true, force: true }).catch(() => undefined);
    return 'corrupt';
  }
  const now = new Date();
  await utimes(entry, now, now).catch(() => undefined);
  return 'hit';
}

/**
 * Stores the workspace's `node_modules` under `key`. Only called with a workspace the engine
 * prepared itself before the agent started. Written beside the entry and renamed into place, so a
 * reader never sees a half-written entry. Returns false when nothing was stored.
 */
export async function storeDepCache(key: string, workspacePath: string, o: DepCacheOptions): Promise<boolean> {
  const modules = join(workspacePath, 'node_modules');
  if (!existsSync(join(modules, '.package-lock.json'))) return false;
  const dir = depCacheDir(o.workspaceRoot);
  const entry = join(dir, key);
  if (existsSync(entry)) return false;
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(tmp);
    if (!(await copyTree(modules, join(tmp, 'node_modules'), o))) return false;
    await rename(tmp, entry);
    return true;
  } catch {
    return false;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Removes entries older than `maxAgeMs` (by last use) and all but the `maxKeys` most recently used. */
export async function pruneDepCache(
  workspaceRoot: string,
  now: number,
  maxAgeMs: number = DEP_CACHE_MAX_AGE_MS,
  maxKeys: number = DEP_CACHE_MAX_KEYS,
): Promise<string[]> {
  const dir = depCacheDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const entries: { name: string; mtime: number }[] = [];
  for (const name of await readdir(dir)) {
    const m = (await stat(join(dir, name))).mtimeMs;
    // Leftovers of an interrupted store go as soon as they are old enough to be nobody's work in progress.
    if (name.startsWith('.tmp-')) {
      if (now - m > 3_600_000) await rm(join(dir, name), { recursive: true, force: true });
      continue;
    }
    entries.push({ name, mtime: m });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const [i, e] of entries.entries()) {
    if (i >= maxKeys || now - e.mtime > maxAgeMs) {
      await rm(join(dir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
  }
  return removed;
}
