import { EffectError } from '../../kernel/types.js';
import type { WorkspaceFacts } from './git-ports.js';

/** Most commits a delivery may hold on top of its seed. */
export const MAX_COMMITS = 50;
/** Most commits listed in the pull request body. */
export const MAX_LISTED_COMMITS = 20;

export type StateCheck = 'branch' | 'history' | 'merge_commit' | 'commit_count' | 'gitlink' | 'identity' | 'conflict_commit';

export interface StateViolation {
  check: StateCheck;
  /** The offending commit (short sha), when one is to blame. */
  commit?: string;
  reason: string;
}

export interface StateExpectations {
  /** The local branch HEAD must be on. */
  branch: string;
  /** The email every commit's author and committer must carry. */
  email: string;
  /** In a conflict round: the head the agent must have left alone (the seed, then the engine's merge commit). */
  conflictHead?: string;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * The state checks of the validation round, on facts read from the workspace: the first violation, or
 * null. Not retried by the caller: nothing the agent could add on top repairs rewritten history, a
 * switched branch or someone else's commit.
 */
export function checkState(f: WorkspaceFacts, x: StateExpectations): StateViolation | null {
  const conflictRound = x.conflictHead !== undefined;
  if (f.branch === null) return { check: 'branch', reason: 'HEAD is detached' };
  if (f.branch !== x.branch) return { check: 'branch', reason: `HEAD is on branch ${f.branch}, expected ${x.branch}` };
  if (!f.seedIsAncestor) return { check: 'history', reason: 'the seed commit is not an ancestor of HEAD (history was rewritten)' };
  if (conflictRound && f.head !== x.conflictHead) {
    return { check: 'conflict_commit', commit: short(f.head), reason: 'the agent committed during a conflict round; the engine completes the merge commit' };
  }
  if (!conflictRound) {
    const merge = f.commits.find((c) => c.parents.length > 1);
    if (merge) return { check: 'merge_commit', commit: short(merge.sha), reason: 'a merge commit outside a conflict round' };
  }
  if (f.commitCount > MAX_COMMITS) return { check: 'commit_count', reason: `${f.commitCount} commits since the seed, at most ${MAX_COMMITS} are allowed` };
  const gitlink = f.gitlinkCommits[0];
  if (gitlink !== undefined) return { check: 'gitlink', commit: short(gitlink), reason: 'a submodule (gitlink) entry was added or changed' };
  for (const c of f.commits) {
    if (c.authorEmail !== x.email) return { check: 'identity', commit: short(c.sha), reason: `the author of the commit is not the factory identity (${x.email})` };
    if (c.committerEmail !== x.email) return { check: 'identity', commit: short(c.sha), reason: `the committer of the commit is not the factory identity (${x.email})` };
  }
  return null;
}

export const violationMessage = (v: StateViolation): string =>
  `commit validation failed (${v.check})${v.commit === undefined ? '' : ` at ${v.commit}`}: ${v.reason}`;

/** Feedback for a verification that left tracked files modified. */
export function verifyDirtyFeedback(files: readonly string[]): string {
  const shown = files.slice(0, 50);
  return [
    "The factory ran the project's verification on your committed state and it left tracked files modified (a generated file that the run rewrote). Commit the up-to-date files with new commits (never amend, rebase or reset), or fix the generator so a run leaves the tree clean.",
    '',
    'Modified files:',
    ...shown.map((f) => `- ${f.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300)}`),
    ...(files.length > shown.length ? [`- ... and ${files.length - shown.length} more`] : []),
  ].join('\n');
}

export interface ListedCommit {
  sha: string;
  subject: string;
}

/** The commits for the pull request body: oldest first, short sha and a one-line subject, at most 20. */
export function listCommits(f: WorkspaceFacts): ListedCommit[] {
  return f.commits
    .slice(0, MAX_LISTED_COMMITS)
    .reverse()
    .map((c) => ({ sha: short(c.sha), subject: c.subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) }));
}

export interface VerifyFailure {
  feedback: string;
  command?: string;
  exitCode?: number | null;
}

/** What one validation round hands back. */
export type RoundOutcome =
  | { kind: 'validated'; head: string; commitCount: number; commits: ListedCommit[] }
  /** The validation failed in a way the agent can fix with new commits. */
  | { kind: 'fix'; feedback: string; head: string; command?: string; exitCode?: number | null };

export interface ValidationDeps {
  expect: StateExpectations;
  seedSha: string;
  /** A message for the engine's own commit of uncommitted changes (title, attempt). */
  fallbackMessage: string;
  conflictRound: boolean;
  inspect(): Promise<WorkspaceFacts>;
  /** Commits everything (and completes a merge in progress). */
  commitAll(message: string): Promise<unknown>;
  /** Conflicted files that still hold a conflict marker (a conflict round only). */
  markersLeft(): Promise<string[]>;
  /** Runs the repository's verify commands on the current checkout; null when they pass (or there are none). */
  verify(): Promise<VerifyFailure | null>;
  /** Sanitizes repository config the agent may have written, before any engine git command. */
  prepare?(): Promise<void>;
  headSha(): Promise<string>;
  events(kind: string, detail: Record<string, unknown>): void;
}

function reject(deps: ValidationDeps, v: StateViolation): never {
  deps.events('commit.rejected', { check: v.check, ...(v.commit === undefined ? {} : { commit: v.commit }), reason: v.reason.slice(0, 200) });
  throw new EffectError(violationMessage(v), 'runner_error');
}

/**
 * One validation round, in order: state checks, the uncommitted-changes fallback, verification of the
 * committed state, then the check that HEAD did not move while verifying. A state violation throws
 * (`runner_error`, not retried); a verification failure is returned for a fix round. The secret scan
 * and the push happen in `commit_push`, pinned to the head returned here.
 */
export async function validateRound(deps: ValidationDeps, conflictHead: string | undefined): Promise<RoundOutcome> {
  await deps.prepare?.();
  const expect: StateExpectations = { ...deps.expect, ...(conflictHead === undefined ? {} : { conflictHead }) };
  let facts = await deps.inspect();
  const first = checkState(facts, expect);
  if (first) reject(deps, first);

  if (deps.conflictRound) {
    const left = await deps.markersLeft();
    if (left.length > 0) throw new EffectError(`refusing to push: conflict markers remain in ${left.join(', ')}`, 'runner_error');
  }
  if (facts.dirtyFiles.length > 0 || facts.merging) {
    await deps.commitAll(deps.fallbackMessage);
    // In a conflict round the engine's commit is the expected one, not a fallback for a forgetful agent.
    if (!deps.conflictRound) deps.events('commit.fallback', { files: facts.dirtyFiles.length });
    facts = await deps.inspect();
    // The engine's commit may itself add a gitlink (a nested repository) or sit on a moved HEAD.
    const after = checkState(facts, { ...deps.expect, ...(deps.conflictRound ? { conflictHead: facts.head } : {}) });
    if (after) reject(deps, after);
  }
  const head = facts.head;
  if (head === deps.seedSha) return { kind: 'validated', head, commitCount: 0, commits: [] };

  const failure = await deps.verify();
  if (failure) return { kind: 'fix', ...failure, head };
  const after = await deps.inspect();
  if (after.trackedDirtyFiles.length > 0) {
    deps.events('verify.dirty', { files: after.trackedDirtyFiles.length });
    return { kind: 'fix', feedback: verifyDirtyFeedback(after.trackedDirtyFiles), head, command: 'verify_dirty' };
  }
  if ((await deps.headSha()) !== head) {
    throw new EffectError('HEAD moved while the committed state was verified', 'runner_error');
  }
  deps.events('commit.validated', { commits: facts.commitCount, head: head.slice(0, 12) });
  return { kind: 'validated', head, commitCount: facts.commitCount, commits: listCommits(facts) };
}
