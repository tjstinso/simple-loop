import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSoftwareEffect, type EffectContext } from '../../../src/engines/software/effects.js';
import {
  FOLLOWUPS_DDL,
  fileFollowups,
  pruneFiledFollowups,
  storeFollowups,
  sweepUnfiledFollowups,
} from '../../../src/engines/software/followups.js';
import { GitHostError } from '../../../src/engines/software/github.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import { migrate, openDb } from '../../../src/kernel/db.js';
import type { ChainView, EffectFence, Job } from '../../../src/kernel/types.js';
import { FakeGitHost } from '../../support/fake-github.js';

const REPO = 'acme/widgets';
const DAY = 86_400_000;
const args = { jobId: 42, chainId: 3, repo: REPO, issueNumber: 7 };
const marker = (pos: number) => `<!-- factory:chain=3 job=42 followup=${pos} -->`;

let db: Database.Database;
let host: FakeGitHost;

interface Row {
  position: number;
  title: string;
  body: string;
  filed_issue_number: number | null;
  created_at: number;
}
const rows = () => db.prepare('SELECT * FROM followups ORDER BY job_id, position').all() as Row[];

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db, [FOLLOWUPS_DDL]);
  host = new FakeGitHost();
});

describe('followups', () => {
  it('stores followups from a result and skips blank titles but keeps positions', () => {
    const ids = storeFollowups(
      db,
      args,
      [
        { title: 'first', body: 'a' },
        { title: '   ', body: 'blank' },
        { title: 'third', body: 'c' },
      ],
      1000,
    );
    expect(ids).toHaveLength(2);
    expect(rows().map((r) => [r.position, r.title, r.filed_issue_number, r.created_at])).toEqual([
      [0, 'first', null, 1000],
      [2, 'third', null, 1000],
    ]);
  });

  it('storing the same followups twice does not duplicate rows', () => {
    const items = [{ title: 'first', body: 'a' }];
    const a = storeFollowups(db, args, items, 1000);
    const b = storeFollowups(db, args, items, 2000);
    expect(b).toEqual(a);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.created_at).toBe(1000);
  });

  it('files each followup once with the followup label, a reference to the issue and the marker', async () => {
    storeFollowups(db, args, [{ title: 'first', body: 'do a' }, { title: 'second', body: 'do b' }], 1000);
    await fileFollowups(db, host, 42);
    await fileFollowups(db, host, 42);
    const filed = rows().map((r) => r.filed_issue_number);
    expect(filed.every((n) => n !== null)).toBe(true);
    expect(host.issues.size).toBe(2);
    const n = filed[0]!;
    expect(host.getLabels(n)).toEqual(['factory:followup']);
    const issue = host.issues.get(n)!;
    expect(issue.title).toBe('first');
    expect(issue.body).toBe(`do a\n\nDiscovered while working on #7.\n${marker(0)}`);
  });

  it('does not create an issue when the marker issue already exists and records its number', async () => {
    storeFollowups(db, args, [{ title: 'first', body: 'do a' }], 1000);
    const existing = host.addIssue({ title: 'first', body: `do a\n\n${marker(0)}`, labels: ['factory:followup'] });
    const before = host.issues.size;
    await fileFollowups(db, host, 42);
    expect(host.issues.size).toBe(before);
    expect(rows()[0]!.filed_issue_number).toBe(existing);
  });

  it('a GitHostError while filing leaves filed_issue_number null, continues with the next item and does not throw', async () => {
    storeFollowups(db, args, [{ title: 'first', body: 'a' }, { title: 'second', body: 'b' }], 1000);
    host.failNext('createIssue', new GitHostError('boom', 500));
    await expect(fileFollowups(db, host, 42)).resolves.toBeUndefined();
    const r = rows();
    expect(r[0]!.filed_issue_number).toBeNull();
    expect(r[1]!.filed_issue_number).not.toBeNull();
  });

  it('a non-GitHostError propagates', async () => {
    storeFollowups(db, args, [{ title: 'first', body: 'a' }], 1000);
    host.failNext('createIssue', new TypeError('bug'));
    await expect(fileFollowups(db, host, 42)).rejects.toThrow('bug');
    expect(rows()[0]!.filed_issue_number).toBeNull();
  });

  it('the sweep files previously unfiled rows', async () => {
    storeFollowups(db, args, [{ title: 'first', body: 'a' }], 1000);
    storeFollowups(db, { ...args, jobId: 50 }, [{ title: 'other', body: 'b' }], 1000);
    host.failNext('createIssue', new GitHostError('down', 503));
    await fileFollowups(db, host, 42);
    expect(rows().filter((r) => r.filed_issue_number === null)).toHaveLength(2);
    const filed = await sweepUnfiledFollowups(db, host, 5000);
    expect(filed).toBe(2);
    expect(rows().every((r) => r.filed_issue_number !== null)).toBe(true);
  });

  it('pruning deletes old filed rows but never unfiled rows', () => {
    storeFollowups(db, args, [{ title: 'old filed', body: 'a' }, { title: 'old unfiled', body: 'b' }], 0);
    storeFollowups(db, { ...args, jobId: 43 }, [{ title: 'recent filed', body: 'c' }], 29 * DAY);
    db.prepare("UPDATE followups SET filed_issue_number = 100 WHERE title IN ('old filed', 'recent filed')").run();
    const deleted = pruneFiledFollowups(db, 31 * DAY, 30);
    expect(deleted).toBe(1);
    expect(rows().map((r) => r.title)).toEqual(['old unfiled', 'recent filed']);
  });

  describe('file_followups effect', () => {
    const chain: ChainView<SoftwareState> = {
      id: 3, engine: 'software', subjectKey: 'k', status: 'active',
      state: { repo: REPO, issueNumber: 7, labels: [], profile: 'supervised', branch: 'b', attempt: 1, phase: 'executing' },
    };
    const job: Job = {
      id: 42, chainId: 3, type: 'execute', attempt: 1, status: 'running', policyId: 'p', payload: {}, result: null,
      claimedBy: 'w', leaseExpiresAt: null, delivery: 1, error: null,
    };
    const fence: EffectFence = { jobId: 42, delivery: 1, assertCurrent: () => {} };
    const ctx = (withDb: boolean): EffectContext => ({
      chain, job, workspace: null, host, git: {} as never, sleep: async () => {},
      ...(withDb ? { followups: { db, now: () => 1234 } } : {}),
    });
    const effect = { kind: 'file_followups', followups: [{ title: 'one', body: 'x' }, { title: '', body: 'y' }, { title: 'two', body: 'z' }] };

    it('the file_followups effect stores and files, and replaying it creates no duplicates', async () => {
      await runSoftwareEffect(effect, ctx(true), fence);
      await runSoftwareEffect(effect, ctx(true), fence);
      expect(rows().map((r) => [r.position, r.created_at])).toEqual([[0, 1234], [2, 1234]]);
      expect(rows().every((r) => r.filed_issue_number !== null)).toBe(true);
      expect(host.issues.size).toBe(2);
      expect([...host.issues.values()][1]!.body).toContain(marker(2));
    });

    it('file_followups without a database throws', async () => {
      await expect(runSoftwareEffect(effect, ctx(false), fence)).rejects.toThrow('file_followups needs a database');
    });
  });
});
