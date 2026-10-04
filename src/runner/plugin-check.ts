import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Where the base branch lives: the shared cache repository and the branch name inside it. */
export interface PluginBase {
  cacheDir: string;
  baseBranch: string;
}

const PLUGIN_GIT_TIMEOUT_MS = 60_000;
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * Runs git against the shared cache with the hardening of the scan commands: argument array, no
 * shell, global and system config off, replace objects ignored, hooks off, a timeout.
 */
function gitInCache(cacheDir: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_DIR: cacheDir,
  };
  for (const k of ['GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG']) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) delete env[k];
  return new Promise((res, rej) => {
    execFile(
      'git',
      ['--no-replace-objects', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: cacheDir, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: PLUGIN_GIT_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
        if (e?.killed === true && e.signal === 'SIGKILL') rej(new Error(`git ${args[0]} timed out after ${PLUGIN_GIT_TIMEOUT_MS} ms`));
        else if (err) rej(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`));
        else res(stdout);
      },
    );
  });
}

function blobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Every file under `dir` as `posix path -> {mode kind, blob}`; null as soon as anything but plain files and directories is found. */
function readTree(dir: string): Map<string, { exec: boolean; blob: string }> | null {
  const out = new Map<string, { exec: boolean; blob: string }>();
  const walk = (abs: string, prefix: string): boolean => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      const name = prefix === '' ? e.name : `${prefix}/${e.name}`;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        if (!walk(p, name)) return false;
      } else if (st.isFile()) {
        out.set(name, { exec: (st.mode & 0o111) !== 0, blob: blobId(readFileSync(p)) });
      } else {
        return false; // symlink, device, socket, ...
      }
    }
    return true;
  };
  return walk(dir, '') ? out : null;
}

/**
 * Refuses a relative plugin directory the agent could have modified. `resolved` are the absolute
 * entries from `resolvePluginDirs` (same order as `entries`). Each relative one must match the
 * base branch exactly: the same files with the same content and executable bits, no extra, ignored
 * or missing files, and no symlinks. The comparison reads the files on disk against
 * `git ls-tree` of `refs/remotes/origin/<baseBranch>` in the shared cache, so nothing the agent can
 * write in the worktree (its `.git` file, index, `.gitignore`) influences it. Absolute entries are
 * operator configuration and are not checked. Errors name the entry and never include file contents.
 */
export async function assertPluginDirsUnchanged(
  entries: readonly string[],
  resolved: readonly string[],
  workspace: string,
  base: PluginBase | undefined,
): Promise<void> {
  const root = realpathSync(workspace);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (isAbsolute(entry)) continue;
    const refuse = (why: string): never => {
      throw new Error(
        `claude-cli pluginDirs: '${entry}' ${why}; a relative plugin directory must match the base branch, ` +
          'because plugin changes take effect only after a person merges them',
      );
    };
    if (base === undefined || !BRANCH_RE.test(base.baseBranch) || base.baseBranch.includes('..')) {
      refuse('cannot be checked against the base branch (no base branch or cache known to the runner)');
    }
    const rel = relative(root, realpathSync(resolved[i]!)).split(sep).join('/');
    let listing: string;
    try {
      listing = await gitInCache(base!.cacheDir, ['ls-tree', '-r', '-z', `refs/remotes/origin/${base!.baseBranch}`, '--', rel]);
    } catch {
      return refuse('cannot be checked against the base branch (git failed)');
    }
    const expected = new Map<string, { exec: boolean; blob: string }>();
    for (const rec of listing.split('\0')) {
      if (rec === '') continue;
      const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
      if (!m || m[1] === '120000' || m[2] !== 'blob') return refuse('contains a symlink or submodule in the base branch');
      expected.set(m[4]!.slice(rel.length + 1), { exec: m[1] === '100755', blob: m[3]! });
    }
    if (expected.size === 0) refuse('is not part of the base branch');
    const actual = readTree(resolve(root, rel));
    if (actual === null) refuse('contains a symlink or special file');
    const same =
      actual!.size === expected.size &&
      [...expected].every(([name, e]) => {
        const a = actual!.get(name);
        return a !== undefined && a.blob === e.blob && a.exec === e.exec;
      });
    if (!same) refuse('differs from the base branch');
  }
}
