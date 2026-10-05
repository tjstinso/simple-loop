import { describe, expect, it } from 'vitest';
import { checkState, listCommits, validateRound, verifyDirtyFeedback, violationMessage, type StateExpectations, type ValidationDeps, type VerifyFailure } from '../../../src/engines/software/commit-validation.js';
import { parseGitlinkCommits, parseStatus, type CommitFact, type WorkspaceFacts } from '../../../src/engines/software/git-ports.js';

const sha = (c: string) => c.repeat(40);
const commit = (c: string, extra: Partial<CommitFact> = {}): CommitFact => ({
  sha: sha(c),
  parents: [sha('0')],
  authorEmail: 'factory@localhost',
  committerEmail: 'factory@localhost',
  subject: `commit ${c}`,
  ...extra,
});
const facts = (extra: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({
  branch: 'factory/b',
  head: sha('a'),
  seedIsAncestor: true,
  commits: [commit('a')],
  commitCount: 1,
  gitlinkCommits: [],
  dirtyFiles: [],
  trackedDirtyFiles: [],
  merging: false,
  ...extra,
});
const expectations: StateExpectations = { branch: 'factory/b', email: 'factory@localhost' };

describe('checkState', () => {
  it('accepts a clean state', () => {
    expect(checkState(facts(), expectations)).toBeNull();
  });

  it('refuses a detached HEAD and another branch', () => {
    expect(checkState(facts({ branch: null }), expectations)).toMatchObject({ check: 'branch' });
    expect(checkState(facts({ branch: 'other' }), expectations)).toMatchObject({ check: 'branch', reason: expect.stringContaining('other') });
  });

  it('refuses rewritten history', () => {
    expect(checkState(facts({ seedIsAncestor: false }), expectations)).toMatchObject({ check: 'history' });
  });

  it('refuses a merge commit outside a conflict round and allows it inside one', () => {
    const merge = facts({ commits: [commit('b', { parents: [sha('1'), sha('2')] })] });
    expect(checkState(merge, expectations)).toMatchObject({ check: 'merge_commit', commit: 'bbbbbbb' });
    expect(checkState(merge, { ...expectations, conflictHead: sha('a') })).toBeNull();
  });

  it('refuses an agent commit during a conflict round', () => {
    expect(checkState(facts(), { ...expectations, conflictHead: sha('9') })).toMatchObject({ check: 'conflict_commit' });
  });

  it('allows 50 commits and refuses 51', () => {
    expect(checkState(facts({ commitCount: 50 }), expectations)).toBeNull();
    expect(checkState(facts({ commitCount: 51 }), expectations)).toMatchObject({ check: 'commit_count' });
  });

  it('refuses a gitlink entry, naming the commit', () => {
    expect(checkState(facts({ gitlinkCommits: [sha('c')] }), expectations)).toMatchObject({ check: 'gitlink', commit: 'ccccccc' });
  });

  it('refuses another author or committer email', () => {
    expect(checkState(facts({ commits: [commit('a', { authorEmail: 'x@y.z' })] }), expectations)).toMatchObject({ check: 'identity', commit: 'aaaaaaa' });
    expect(checkState(facts({ commits: [commit('a', { committerEmail: 'x@y.z' })] }), expectations)).toMatchObject({ check: 'identity' });
  });

  it('names the check and the commit in the message', () => {
    expect(violationMessage({ check: 'identity', commit: 'abc1234', reason: 'r' })).toBe('commit validation failed (identity) at abc1234: r');
  });
});

describe('listCommits', () => {
  it('lists oldest first with short shas, at most 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => commit('a', { sha: String(i).padStart(2, '0').repeat(20), subject: `s${i}` }));
    const list = listCommits(facts({ commits: many, commitCount: 25 }));
    expect(list).toHaveLength(20);
    expect(list[0]).toEqual({ sha: '1919191', subject: 's19' });
    expect(list.at(-1)).toEqual({ sha: '0000000', subject: 's0' });
  });
});

describe('verifyDirtyFeedback', () => {
  it('names the files', () => {
    const t = verifyDirtyFeedback(['gen.txt', 'dir/out.json']);
    expect(t).toContain('- gen.txt');
    expect(t).toContain('- dir/out.json');
    expect(t).toContain('never amend');
  });
});

describe('git output parsers', () => {
  it('parses porcelain status, skipping the source of a rename', () => {
    const out = [' M a.txt', '?? new.txt', 'R  to.txt', 'from.txt', 'A  added.txt', ''].join('\0');
    expect(parseStatus(out)).toEqual({ dirty: ['a.txt', 'new.txt', 'to.txt', 'added.txt'], tracked: ['a.txt', 'to.txt', 'added.txt'] });
  });

  it('finds the commits that touch a gitlink', () => {
    const rec = (m: string, p: string) => `:000000 ${m} ${'0'.repeat(40)} ${'1'.repeat(40)} A\0${p}\0`;
    const out = `\u0001${sha('a')}\u0002\0${rec('100644', 'f')}\u0001${sha('b')}\u0002\0${rec('160000', 'sub')}`;
    expect(parseGitlinkCommits(out)).toEqual([sha('b')]);
  });
});

describe('validateRound', () => {
  const harness = (seed: string, f: WorkspaceFacts, failure: VerifyFailure | null = null) => {
    const events: Array<[string, Record<string, unknown>]> = [];
    let verifyCalls = 0;
    const deps: ValidationDeps = {
      expect: expectations,
      seedSha: seed,
      fallbackMessage: 'fallback',
      conflictRound: false,
      inspect: async () => f,
      commitAll: async () => undefined,
      markersLeft: async () => [],
      verify: async () => {
        verifyCalls++;
        return failure;
      },
      headSha: async () => f.head,
      events: (kind, detail) => events.push([kind, detail]),
    };
    return { deps, events, verifyCalls: () => verifyCalls };
  };
  const unchanged = facts({ head: sha('b'), commits: [], commitCount: 0 });

  it('verifies and records commit.validated with 0 commits when HEAD equals the seed', async () => {
    const h = harness(sha('b'), unchanged);
    const outcome = await validateRound(h.deps, undefined);
    expect(h.verifyCalls()).toBe(1);
    expect(outcome).toEqual({ kind: 'validated', head: sha('b'), commitCount: 0, commits: [] });
    expect(h.events).toEqual([['commit.validated', { commits: 0, head: sha('b').slice(0, 12) }]]);
  });

  it('fails the chain when verification fails on the unchanged seed', async () => {
    const h = harness(sha('b'), unchanged, { feedback: 'x', command: 'npm test', exitCode: 1 });
    await expect(validateRound(h.deps, undefined)).rejects.toThrow(/unchanged seed/);
    expect(h.events).toEqual([]);
  });

  it('verifies and records the commits when the agent kept its changes', async () => {
    const h = harness(sha('0'), facts());
    const outcome = await validateRound(h.deps, undefined);
    expect(h.verifyCalls()).toBe(1);
    expect(outcome).toMatchObject({ kind: 'validated', commitCount: 1 });
    expect(h.events).toEqual([['commit.validated', { commits: 1, head: sha('a').slice(0, 12) }]]);
  });
});
