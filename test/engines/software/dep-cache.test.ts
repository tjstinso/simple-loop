import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { depCacheDir, depCacheKey, isStandardInstall, pruneDepCache, restoreDepCache, storeDepCache } from '../../../src/engines/software/dep-cache.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-depcache-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const env = { PATH: process.env.PATH ?? '' };
/** A workspace whose "install" (a fake) wrote node_modules. */
function workspace(root: string, name: string, lock = '{"a":1}'): string {
  const ws = join(root, name);
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'package-lock.json'), lock);
  writeFileSync(join(ws, 'node_modules', '.package-lock.json'), '{}');
  writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'original');
  return ws;
}
const opts = (root: string) => ({ workspaceRoot: root, env });

describe('dependency cache', () => {
  it('recognises only the standard install', () => {
    expect(isStandardInstall([['npm', 'ci']])).toBe(true);
    expect(isStandardInstall([['npm', 'ci', '--ignore-scripts']])).toBe(true);
    expect(isStandardInstall([['npm', 'install']])).toBe(false);
    expect(isStandardInstall([['npm', 'ci'], ['npm', 'run', 'prepare']])).toBe(false);
    expect(isStandardInstall(undefined)).toBe(false);
  });

  it('keys on the lockfile hash and the Node major version', async () => {
    const root = tmp();
    const a = workspace(root, 'a', 'one');
    const b = workspace(root, 'b', 'two');
    const keyA = (await depCacheKey(a, '22.3.0'))!;
    expect(keyA).toMatch(/^[0-9a-f]{64}-node22$/);
    expect(await depCacheKey(a, '22.9.1')).toBe(keyA);
    expect(await depCacheKey(a, '20.1.0')).not.toBe(keyA);
    expect(await depCacheKey(b, '22.3.0')).not.toBe(keyA);
    expect(await depCacheKey(join(root, 'nowhere'))).toBeNull();
  });

  it('a miss stores the entry and a hit copies it without running anything', async () => {
    const root = tmp();
    const first = workspace(root, 'first');
    expect(await restoreDepCache('k', first, opts(root))).toBe('miss');
    expect(await storeDepCache('k', first, opts(root))).toBe(true);
    expect(existsSync(join(depCacheDir(root), 'k', 'node_modules', 'pkg', 'index.js'))).toBe(true);

    const second = join(root, 'second');
    mkdirSync(second);
    expect(await restoreDepCache('k', second, opts(root))).toBe('hit');
    expect(readFileSync(join(second, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('original');
  });

  it('a change in a workspace copy never reaches the cache entry', async () => {
    const root = tmp();
    await storeDepCache('k', workspace(root, 'first'), opts(root));
    const second = join(root, 'second');
    mkdirSync(second);
    await restoreDepCache('k', second, opts(root));
    writeFileSync(join(second, 'node_modules', 'pkg', 'index.js'), 'tampered');
    expect(readFileSync(join(depCacheDir(root), 'k', 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('original');
    expect(statSync(join(second, 'node_modules', 'pkg', 'index.js')).nlink).toBe(1);
  });

  it('does not overwrite an existing entry and stores nothing without an install', async () => {
    const root = tmp();
    await storeDepCache('k', workspace(root, 'first'), opts(root));
    const other = workspace(root, 'other');
    writeFileSync(join(other, 'node_modules', 'pkg', 'index.js'), 'different');
    expect(await storeDepCache('k', other, opts(root))).toBe(false);
    expect(readFileSync(join(depCacheDir(root), 'k', 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('original');
    const bare = join(root, 'bare');
    mkdirSync(bare);
    expect(await storeDepCache('z', bare, opts(root))).toBe(false);
    expect(readdirSync(depCacheDir(root))).toEqual(['k']);
  });

  it('deletes a corrupt entry and reports it', async () => {
    const root = tmp();
    await storeDepCache('k', workspace(root, 'first'), opts(root));
    rmSync(join(depCacheDir(root), 'k', 'node_modules', '.package-lock.json'));
    const ws = join(root, 'second');
    mkdirSync(ws);
    expect(await restoreDepCache('k', ws, opts(root))).toBe('corrupt');
    expect(existsSync(join(depCacheDir(root), 'k'))).toBe(false);
    expect(existsSync(join(ws, 'node_modules'))).toBe(false);
  });

  it('a failed copy is corrupt too', async () => {
    const root = tmp();
    await storeDepCache('k', workspace(root, 'first'), opts(root));
    const ws = join(root, 'second');
    mkdirSync(ws);
    expect(await restoreDepCache('k', ws, { workspaceRoot: root, env: { PATH: '/nonexistent' } })).toBe('corrupt');
    expect(existsSync(join(depCacheDir(root), 'k'))).toBe(false);
  });

  it('prunes entries older than 30 days and all but 5 keys', async () => {
    const root = tmp();
    const now = Date.now();
    const day = 86_400_000;
    const make = (name: string, ageDays: number) => {
      const d = join(depCacheDir(root), name);
      mkdirSync(d, { recursive: true });
      const t = new Date(now - ageDays * day);
      utimesSync(d, t, t);
    };
    make('old', 31);
    for (let i = 0; i < 7; i++) make(`k${i}`, i + 1);
    const removed = await pruneDepCache(root, now);
    expect(removed.sort()).toEqual(['k5', 'k6', 'old']);
    expect(readdirSync(depCacheDir(root)).sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(await pruneDepCache(join(root, 'missing'), now)).toEqual([]);
  });
});
