import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPluginDirsUnchanged } from '../../src/runner/plugin-check.js';
import { resolvePluginDirs } from '../../src/runner/claude-cli.js';
import { makePluginRepo, type PluginRepo } from '../support/plugin-repo.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function repo(): PluginRepo {
  const r = makePluginRepo({
    'plug/.claude-plugin/plugin.json': '{"name":"p"}\n',
    'plug/run.sh': '#!/bin/sh\necho hi\n',
    'plug/sub/data.txt': 'data\n',
    'other.txt': 'x\n',
  });
  cleanups.push(r.cleanup);
  return r;
}

async function check(r: PluginRepo, entries: string[]): Promise<void> {
  await assertPluginDirsUnchanged(entries, resolvePluginDirs(entries, r.path), r.path, r.base);
}

const REFUSED = /'plug'.*must match the base branch.*only after a person merges them/;

describe('assertPluginDirsUnchanged', () => {
  it('accepts an unchanged relative plugin directory, an empty list and absolute entries', async () => {
    const r = repo();
    await check(r, ['plug']);
    await check(r, []);
    const abs = mkdtempSync(join(tmpdir(), 'factory-abs-plug-'));
    cleanups.push(() => rmSync(abs, { recursive: true, force: true }));
    writeFileSync(join(abs, 'anything'), 'operator-owned');
    // absolute entries are not compared, and need no base
    await assertPluginDirsUnchanged([abs], resolvePluginDirs([abs], r.path), r.path, undefined);
  });

  it('refuses a modified manifest, an added, deleted, renamed or untracked file, naming the entry without contents', async () => {
    const mutations: Record<string, (p: string) => void> = {
      modified: (p) => writeFileSync(join(p, 'plug/.claude-plugin/plugin.json'), '{"name":"SECRETCONTENT"}\n'),
      added: (p) => writeFileSync(join(p, 'plug/new.sh'), 'evil'),
      deleted: (p) => rmSync(join(p, 'plug/run.sh')),
      renamed: (p) => renameSync(join(p, 'plug/run.sh'), join(p, 'plug/run2.sh')),
      untracked: (p) => writeFileSync(join(p, 'plug/sub/untracked.txt'), 'u'),
      'mode changed': (p) => chmodSync(join(p, 'plug/run.sh'), 0o755),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const r = repo();
      mutate(r.path);
      const err = await check(r, ['plug']).then(() => null, (e: Error) => e);
      expect(err, name).not.toBeNull();
      expect(err!.message, name).toMatch(REFUSED);
      expect(err!.message, name).not.toContain('SECRETCONTENT');
    }
  });

  it('refuses an ignored-but-present file, even when the agent hides it with .gitignore', async () => {
    const r = repo();
    writeFileSync(join(r.path, '.gitignore'), 'plug/hidden.sh\n');
    writeFileSync(join(r.path, 'plug/hidden.sh'), 'evil');
    await expect(check(r, ['plug'])).rejects.toThrow(REFUSED);
  });

  it('refuses a symlink inside the directory pointing outside it', async () => {
    const r = repo();
    const outside = mkdtempSync(join(tmpdir(), 'factory-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    symlinkSync(outside, join(r.path, 'plug/link'));
    await expect(check(r, ['plug'])).rejects.toThrow(REFUSED);
  });

  it('refuses a directory that is not in the base branch, and a relative entry without a known base', async () => {
    const r = repo();
    mkdirSync(join(r.path, 'fresh'));
    writeFileSync(join(r.path, 'fresh/x'), 'x');
    await expect(check(r, ['fresh'])).rejects.toThrow(/'fresh'.*not part of the base branch/);
    await expect(
      assertPluginDirsUnchanged(['plug'], resolvePluginDirs(['plug'], r.path), r.path, undefined),
    ).rejects.toThrow(REFUSED);
    await expect(
      assertPluginDirsUnchanged(['plug'], resolvePluginDirs(['plug'], r.path), r.path, { cacheDir: r.base.cacheDir, baseBranch: 'nope' }),
    ).rejects.toThrow(REFUSED);
  });

  it('leaves an unchanged directory behind a symlinked parent to the containment check', () => {
    const r = repo();
    const outside = mkdtempSync(join(tmpdir(), 'factory-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'plug'));
    symlinkSync(outside, join(r.path, 'linked'));
    expect(() => resolvePluginDirs(['linked/plug'], r.path)).toThrow(/'linked\/plug'.*outside the worktree/);
  });
});
