/** Most conflicting paths a conflict round hands to the agent; more than this goes to a person. */
export const MAX_CONFLICT_PATHS = 50;

/** Why a merge conflict is not given to the agent. */
export type ConflictRefusal = 'binary' | 'deleted_modified' | 'too_many';

/** One unmerged index entry as `git ls-files -u -z` lists it. */
export interface UnmergedEntry {
  mode: string;
  sha: string;
  stage: number;
  path: string;
}

/** What merging the base branch into the pull request branch left in the workspace. */
export interface ConflictInfo {
  baseBranch: string;
  /** Conflicting paths, sorted (empty when the merge was clean or there was nothing to merge). */
  paths: string[];
  /** Set when the conflict must go to a person; the agent does not run. */
  refusal?: ConflictRefusal;
}

/** Parses `git ls-files -u -z` (`<mode> <sha> <stage>\t<path>` entries separated by NUL). */
export function parseUnmerged(out: string): UnmergedEntry[] {
  const entries: UnmergedEntry[] = [];
  for (const rec of out.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(rec);
    if (m) entries.push({ mode: m[1]!, sha: m[2]!, stage: Number(m[3]), path: m[4]! });
  }
  return entries;
}

/** The distinct unmerged paths, sorted. */
export function conflictingPaths(entries: readonly UnmergedEntry[]): string[] {
  return [...new Set(entries.map((e) => e.path))].sort();
}

/**
 * Paths whose conflict is not a plain two-sided text edit: one side deleted the file (a stage 2 or 3
 * entry is missing), or the entry is a symlink or submodule. Binary content is judged by the caller.
 */
export function structuralConflicts(entries: readonly UnmergedEntry[]): string[] {
  const byPath = new Map<string, UnmergedEntry[]>();
  for (const e of entries) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  const out: string[] = [];
  for (const [path, list] of byPath) {
    const stages = new Set(list.map((e) => e.stage));
    const special = list.some((e) => e.mode === '120000' || e.mode === '160000');
    if (!stages.has(2) || !stages.has(3) || special) out.push(path);
  }
  return out.sort();
}

/** git's own binary heuristic: a NUL byte in the first 8000 bytes. */
export const looksBinary = (head: Buffer): boolean => head.subarray(0, 8000).includes(0);

const MARKER = /^(<{7} |={7}$|>{7} )/;

/** True when a line of `text` is a conflict marker (`<<<<<<< `, `=======` or `>>>>>>> `). */
export function hasConflictMarkers(text: string): boolean {
  return text.split(/\r?\n/).some((line) => MARKER.test(line));
}

const safePath = (p: string): string => p.replace(/[\u0000-\u001f\u007f]+/g, ' ');

/** The task text for the agent: names the base branch and the paths, and says how to resolve. */
export function conflictFeedback(baseBranch: string, paths: readonly string[]): string {
  return [
    `The pull request branch conflicts with its base branch \`${baseBranch}\`, which moved on. The factory merged \`origin/${baseBranch}\` into your workspace and left conflict markers in these files:`,
    '',
    ...paths.map((p) => `- ${safePath(p)}`),
    '',
    'Resolve every conflict keeping the intent of both sides. Leave no conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in any file. Do not reformat unrelated code.',
    'Only edit files: do not run git commands (the factory completes the merge commit itself).',
  ].join('\n');
}
