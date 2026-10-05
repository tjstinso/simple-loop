import { describe, expect, it } from 'vitest';
import { AutoMergeRefusedError, GH_TIMEOUT_MS, GhCliHost, GitHostError, defaultExec, type ExecFn } from '../../../src/engines/software/github.js';
import { FakeGitHost } from '../../support/fake-github.js';

const R = 'o/r';

describe('FakeGitHost', () => {
  it('findPrByHead returns the existing PR', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'feat', base: 'main', title: 't', body: 'b' });
    expect(await gh.findPrByHead(R, 'feat')).toEqual(pr);
    expect(await gh.findPrByHead(R, 'other')).toBeNull();
  });

  it('setLabels adds and removes without duplicates', async () => {
    const gh = new FakeGitHost();
    gh.addIssue({ number: 1, title: 't', body: '', labels: ['a', 'b'] });
    await gh.setLabels(R, 1, ['b', 'c', 'c'], ['a', 'zzz']);
    expect(gh.getLabels(1).sort()).toEqual(['b', 'c']);
    await gh.setLabels(R, 1, ['b', 'c'], ['a']);
    expect(gh.getLabels(1).sort()).toEqual(['b', 'c']);
  });

  it('findComment sees a marker already posted', async () => {
    const gh = new FakeGitHost();
    gh.addIssue({ number: 1, title: 't', body: '', labels: [] });
    expect(await gh.findComment(R, 1, '<!-- m -->')).toBe(false);
    await gh.comment(R, 1, 'hello <!-- m -->');
    expect(await gh.findComment(R, 1, '<!-- m -->')).toBe(true);
    expect(gh.getComments(1)).toEqual(['hello <!-- m -->']);
  });

  it('listIssuesByLabel returns open labeled issues oldest first with their author association', async () => {
    const gh = new FakeGitHost();
    gh.addIssue({ number: 5, title: 'e', body: '', labels: ['x'], authorAssociation: 'OWNER' });
    gh.addIssue({ number: 2, title: 'b', body: '', labels: ['x'] });
    gh.addIssue({ number: 3, title: 'closed', body: '', labels: ['x'], state: 'closed' });
    gh.addIssue({ number: 4, title: 'other', body: '', labels: ['y'] });
    const list = await gh.listIssuesByLabel(R, 'x');
    expect(list.map((i) => [i.number, i.authorAssociation])).toEqual([[2, 'NONE'], [5, 'OWNER']]);
    expect(await gh.listIssuesByLabel(R, 'none')).toEqual([]);
  });

  it('failNext makes the next call throw GitHostError', async () => {
    const gh = new FakeGitHost();
    gh.addIssue({ number: 1, title: 't', body: '', labels: [] });
    gh.failNext('getIssue', new GitHostError('boom', 500));
    await expect(gh.getIssue(R, 1)).rejects.toMatchObject({ message: 'boom', status: 500 });
    expect((await gh.getIssue(R, 1)).number).toBe(1);
  });

  it('shares one number space between issues and PRs', async () => {
    const gh = new FakeGitHost();
    const a = await gh.createIssue(R, { title: 'a', body: 'x', labels: [] });
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    const b = await gh.createIssue(R, { title: 'b', body: 'y', labels: ['l'] });
    expect([a, pr.number, b]).toEqual([1, 2, 3]);
    await gh.setLabels(R, pr.number, ['x'], []);
    expect(gh.getLabels(pr.number)).toEqual(['x']);
    await expect(gh.getIssue(R, 99)).rejects.toMatchObject({ status: 404, message: 'Not Found' });
  });

  it('mergePr refuses (409) when the PR head is not the expected sha, and merges when it is', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    gh.setPrHead(pr.number, 'new-head');
    await expect(gh.mergePr(R, pr.number, { expectHeadSha: 'reviewed-head' })).rejects.toMatchObject({
      message: 'head commit changed', status: 409,
    });
    expect((await gh.getPr(R, pr.number)).state).toBe('open');
    await gh.mergePr(R, pr.number, { expectHeadSha: 'new-head' });
    expect(gh.autoMergeEnabled(pr.number)).toBe(true);
  });

  it('mergePr enables auto-merge: the PR merges only once the required checks pass', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    await gh.mergePr(R, pr.number);
    expect((await gh.getPr(R, pr.number)).state).toBe('open');
    gh.passRequiredChecks();
    expect((await gh.getPr(R, pr.number)).state).toBe('merged');
    const later = await gh.openPr(R, { head: 'h2', base: 'main', title: 't', body: '' });
    await gh.mergePr(R, later.number); // checks already pass: merges at once
    expect((await gh.getPr(R, later.number)).state).toBe('merged');
  });

  it('mergePr throws AutoMergeRefusedError when auto-merge is not allowed', async () => {
    const gh = new FakeGitHost();
    gh.autoMergeAllowed = false;
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    await expect(gh.mergePr(R, pr.number)).rejects.toBeInstanceOf(AutoMergeRefusedError);
  });

  it('mergePr is a no-op on an already merged PR', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    gh.markMerged(pr.number);
    await gh.mergePr(R, pr.number);
    expect((await gh.getPr(R, pr.number)).state).toBe('merged');
  });

  it('findIssueByMarker searches bodies', async () => {
    const gh = new FakeGitHost();
    await gh.createIssue(R, { title: 'a', body: 'x <!-- k -->', labels: [] });
    expect(await gh.findIssueByMarker(R, '<!-- k -->')).toBe(1);
    expect(await gh.findIssueByMarker(R, '<!-- nope -->')).toBeNull();
  });

  it('findIssueByMarker honors the label filter', async () => {
    const gh = new FakeGitHost();
    gh.addIssue({ title: 'a', body: '<!-- k -->', labels: [] });
    gh.addIssue({ title: 'b', body: '<!-- k -->', labels: ['factory:followup'] });
    expect(await gh.findIssueByMarker(R, '<!-- k -->')).toBe(1);
    expect(await gh.findIssueByMarker(R, '<!-- k -->', 'factory:followup')).toBe(2);
    expect(await gh.findIssueByMarker(R, '<!-- k -->', 'other')).toBeNull();
  });
});

const threadsPage = (nodes: object[], next: string | null = null) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } } });
const thread = (id: string, isResolved: boolean, ...ids: number[]) => ({ id, isResolved, comments: { nodes: ids.map((databaseId) => ({ databaseId })) } });

describe('FakeGitHost review threads', () => {
  it('replies in the thread of an inline comment, resolves the thread and reports it resolved', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    const id = gh.addReviewComment(pr.number, { createdAt: '2026-01-01T00:00:00Z', body: 'rename' });
    await gh.replyToReviewComment(R, pr.number, id, 'done');
    const threadId = gh.threadOf(pr.number, id)!;
    let threads = await gh.listReviewThreads(R, pr.number);
    expect(threads).toEqual([{ id: threadId, resolved: false, commentIds: [id, id + 1] }]);
    await gh.resolveReviewThread(R, threadId);
    await gh.resolveReviewThread(R, threadId); // resolving again is a no-op
    threads = await gh.listReviewThreads(R, pr.number);
    expect(threads[0]!.resolved).toBe(true);
    const f = await gh.listPrFeedback(R, pr.number);
    expect(f.reviewComments.map((c) => [c.author, c.threadId, c.threadResolved])).toEqual([['alice', threadId, true], ['factory', threadId, true]]);
    await expect(gh.replyToReviewComment(R, pr.number, 999, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('failNext makes a thread call fail', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    gh.failNext('listReviewThreads', new GitHostError('boom', 502));
    await expect(gh.listReviewThreads(R, pr.number)).rejects.toMatchObject({ status: 502 });
  });
});

describe('FakeGitHost listPrFeedback', () => {
  it('returns the added reviews and comments, with the factory comments as conversation comments', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    const reviewId = gh.addReview(pr.number, { state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z', body: 'fix' });
    gh.addReviewComment(pr.number, { createdAt: '2026-01-01T00:00:01Z', reviewId, path: 'a.ts', line: 3, body: 'here' });
    gh.addConversationComment(pr.number, { createdAt: '2026-01-01T00:00:02Z', body: 'hi', authorAssociation: 'NONE' });
    await gh.comment(R, pr.number, 'ours <!-- factory: -->');
    const f = await gh.listPrFeedback(R, pr.number);
    expect(f.reviews).toMatchObject([{ id: reviewId, state: 'CHANGES_REQUESTED', author: 'alice', authorAssociation: 'COLLABORATOR' }]);
    expect(f.reviewComments).toMatchObject([{ reviewId, path: 'a.ts', line: 3, body: 'here' }]);
    expect(f.comments.map((c) => c.body)).toEqual(['ours <!-- factory: -->', 'hi']);
    await expect(gh.listPrFeedback(R, 99)).rejects.toMatchObject({ status: 404 });
  });
});

type Call = [string, string[]];
function stub(responses: Array<{ stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: Call[] = [];
  const inputs: Array<string | undefined> = [];
  let i = 0;
  const exec: ExecFn = async (file, args, opts) => {
    calls.push([file, args]);
    inputs.push(opts?.input);
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { exec, calls, inputs };
}

describe('GhCliHost', () => {
  it('maps gh JSON output to Issue', async () => {
    const { exec, calls } = stub([
      { stdout: JSON.stringify({ number: 7, title: 'T', body: null, state: 'open', labels: [{ name: 'a' }, { name: 'b' }] }) },
    ]);
    const issue = await new GhCliHost({ exec }).getIssue(R, 7);
    expect(issue).toEqual({ number: 7, title: 'T', body: '', labels: ['a', 'b'], state: 'open', authorAssociation: 'NONE' });
    expect(calls).toEqual([['gh', ['api', '-X', 'GET', 'repos/o/r/issues/7']]]);
  });

  it('maps a 404 to GitHostError with status 404', async () => {
    const { exec } = stub([{ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }]);
    const err = await new GhCliHost({ exec }).getIssue(R, 1).catch((e) => e);
    expect(err).toBeInstanceOf(GitHostError);
    expect(err.status).toBe(404);
  });

  it('findPrByHead maps MERGED to merged and returns null for an empty list', async () => {
    const a = stub([{ stdout: JSON.stringify([{ number: 3, state: 'MERGED', headRefOid: 'abc', baseRefName: 'main' }]) }]);
    expect(await new GhCliHost({ exec: a.exec }).findPrByHead(R, 'feat')).toEqual({
      number: 3, state: 'merged', headSha: 'abc', baseBranch: 'main', mergeable: 'unknown',
    });
    expect(a.calls).toEqual([
      ['gh', ['pr', 'list', '--repo', R, '--head', 'feat', '--state', 'all', '--json', 'number,state,headRefOid,baseRefName,mergeable', '--limit', '1']],
    ]);
    const b = stub([{ stdout: '[]' }]);
    expect(await new GhCliHost({ exec: b.exec }).findPrByHead(R, 'feat')).toBeNull();
  });

  it('setLabels ignores a 404 when removing an absent label', async () => {
    const { exec, calls } = stub([
      { stdout: '[]' },
      { exitCode: 1, stderr: 'gh: Label does not exist (HTTP 404)' },
    ]);
    await new GhCliHost({ exec }).setLabels(R, 5, ['x y'], ['gone/1']);
    expect(calls[0]).toEqual(['gh', ['api', '-X', 'POST', 'repos/o/r/issues/5/labels', '--input', '-']]);
    expect(calls[1]).toEqual(['gh', ['api', '-X', 'DELETE', 'repos/o/r/issues/5/labels/gone%2F1']]);
  });

  it('setLabels propagates non-404 errors on remove', async () => {
    const { exec } = stub([{ exitCode: 1, stderr: 'gh: boom (HTTP 500)' }]);
    await expect(new GhCliHost({ exec }).setLabels(R, 5, [], ['a'])).rejects.toMatchObject({ status: 500 });
  });

  it('invalid JSON from gh becomes GitHostError', async () => {
    const { exec } = stub([{ stdout: 'not json' }]);
    await expect(new GhCliHost({ exec }).getIssue(R, 1)).rejects.toBeInstanceOf(GitHostError);
  });

  it('mergePr passes the configured merge method', async () => {
    const a = stub([{}]);
    await new GhCliHost({ exec: a.exec }).mergePr(R, 9);
    expect(a.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash', '--auto', '--delete-branch']]]);
    const b = stub([{}]);
    await new GhCliHost({ exec: b.exec, mergeMethod: 'rebase' }).mergePr(R, 9);
    expect(b.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--rebase', '--auto', '--delete-branch']]]);
  });

  it('mergePr pins the reviewed head with --match-head-commit and deletes the branch unless disabled', async () => {
    const sha = 'a'.repeat(40);
    const a = stub([{}]);
    await new GhCliHost({ exec: a.exec }).mergePr(R, 9, { expectHeadSha: sha });
    expect(a.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash', '--auto', '--delete-branch', '--match-head-commit', sha]]]);
    const b = stub([{}]);
    await new GhCliHost({ exec: b.exec, deleteBranch: false }).mergePr(R, 9);
    expect(b.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash', '--auto']]]);
  });

  it.each([
    'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)',
    'GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)',
    'X Pull request #9 is not in the correct state to enable auto-merge',
    'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)',
  ])('mergePr maps the refusal "%s" to AutoMergeRefusedError', async (stderr) => {
    const a = stub([{ stderr, exitCode: 1 }]);
    await expect(new GhCliHost({ exec: a.exec }).mergePr(R, 9)).rejects.toBeInstanceOf(AutoMergeRefusedError);
  });

  it('mergePr leaves other failures a plain GitHostError', async () => {
    const a = stub([{ stderr: 'HTTP 502 Bad Gateway', exitCode: 1 }]);
    const err = await new GhCliHost({ exec: a.exec }).mergePr(R, 9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostError);
    expect(err).not.toBeInstanceOf(AutoMergeRefusedError);
  });

  it('findComment pages until it finds the marker', async () => {
    const page1 = Array.from({ length: 100 }, () => ({ body: 'nope' }));
    const { exec, calls } = stub([
      { stdout: JSON.stringify(page1) },
      { stdout: JSON.stringify([{ body: 'x <!-- m --> y' }]) },
    ]);
    expect(await new GhCliHost({ exec }).findComment(R, 4, '<!-- m -->')).toBe(true);
    expect(calls.map((c) => c[1])).toEqual([
      ['api', '-X', 'GET', 'repos/o/r/issues/4/comments', '-f', 'per_page=100', '-f', 'page=1'],
      ['api', '-X', 'GET', 'repos/o/r/issues/4/comments', '-f', 'per_page=100', '-f', 'page=2'],
    ]);
  });

  describe('listIssuesByLabel', () => {
    const item = (n: number, extra: object = {}) => ({ number: n, title: `t${n}`, body: 'b', state: 'open', labels: [{ name: 'factory:ready' }], author_association: 'MEMBER', ...extra });
    const items = (from: number, count: number) => JSON.stringify(Array.from({ length: count }, (_, i) => item(from + i)));
    const pageArgs = (page: number) => [
      'api', '-X', 'GET', 'repos/o/r/issues',
      '-f', 'state=open', '-f', 'labels=factory:ready', '-f', 'sort=created', '-f', 'direction=asc', '-f', 'per_page=100', '-f', `page=${page}`,
    ];

    it('maps issues with their author association', async () => {
      const { exec, calls } = stub([{ stdout: JSON.stringify([item(3), item(4, { author_association: undefined })]) }]);
      const list = await new GhCliHost({ exec }).listIssuesByLabel(R, 'factory:ready');
      expect(list.map((i) => [i.number, i.authorAssociation, i.labels])).toEqual([[3, 'MEMBER', ['factory:ready']], [4, 'NONE', ['factory:ready']]]);
      expect(calls.map((c) => c[1])).toEqual([pageArgs(1)]);
    });

    it('asks for the next page after exactly 100 items and stops at the empty page', async () => {
      const { exec, calls } = stub([{ stdout: items(1, 100) }, { stdout: '[]' }]);
      expect(await new GhCliHost({ exec }).listIssuesByLabel(R, 'factory:ready')).toHaveLength(100);
      expect(calls.map((c) => c[1])).toEqual([pageArgs(1), pageArgs(2)]);
    });

    it('stops at a short last page', async () => {
      const { exec, calls } = stub([{ stdout: items(1, 100) }, { stdout: items(101, 3) }, { stdout: '[]' }]);
      expect(await new GhCliHost({ exec }).listIssuesByLabel(R, 'factory:ready')).toHaveLength(103);
      expect(calls).toHaveLength(2);
    });

    it('excludes pull requests and orders by number', async () => {
      const { exec } = stub([{ stdout: JSON.stringify([item(9), item(5, { pull_request: { url: 'x' } }), item(2)]) }]);
      const list = await new GhCliHost({ exec }).listIssuesByLabel(R, 'factory:ready');
      expect(list.map((i) => i.number)).toEqual([2, 9]);
    });

    it('maps failures like the other calls', async () => {
      const failed = stub([{ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }]);
      await expect(new GhCliHost({ exec: failed.exec }).listIssuesByLabel(R, 'l')).rejects.toMatchObject({ name: 'GitHostError', status: 404 });
      const timedOut: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 1, timedOut: true });
      await expect(new GhCliHost({ exec: timedOut, ghTimeoutMs: 5 }).listIssuesByLabel(R, 'l')).rejects.toThrow(/timed out/);
    });
  });

  describe('listPrFeedback', () => {
    const page = (n: number, make: (i: number) => object) => JSON.stringify(Array.from({ length: n }, (_, i) => make(i)));

    it('maps reviews, inline review comments and conversation comments with manual paging', async () => {
      const review = (i: number) => ({
        id: i + 1, user: { login: 'bob' }, author_association: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'b', submitted_at: '2026-01-01T00:00:00Z',
      });
      const { exec, calls } = stub([
        { stdout: page(100, review) },
        { stdout: JSON.stringify([{ ...review(100), state: 'APPROVED' }]) },
        {
          stdout: JSON.stringify([
            {
              id: 50, user: { login: 'carol' }, author_association: 'OWNER', path: 'src/a.ts', line: 12, original_line: 9,
              diff_hunk: '@@ -1 +1 @@', body: 'rename', created_at: '2026-01-02T00:00:00Z', pull_request_review_id: 7,
            },
            { id: 51, user: null, path: 'b.ts', line: null, original_line: 4, body: null, created_at: '2026-01-02T00:00:01Z' },
          ]),
        },
        { stdout: page(100, (i) => ({ id: 100 + i, user: { login: 'dan' }, author_association: 'NONE', body: 'x', created_at: '2026-01-03T00:00:00Z' })) },
        { stdout: JSON.stringify([{ id: 300, user: { login: 'erin' }, author_association: 'COLLABORATOR', body: 'last', created_at: '2026-01-04T00:00:00Z' }]) },
        { stdout: threadsPage([thread('T1', true, 50)]) },
      ]);
      const f = await new GhCliHost({ exec }).listPrFeedback(R, 9);
      expect(calls.map((c) => c[1])).toEqual([
        ['api', '-X', 'GET', 'repos/o/r/pulls/9/reviews', '-f', 'per_page=100', '-f', 'page=1'],
        ['api', '-X', 'GET', 'repos/o/r/pulls/9/reviews', '-f', 'per_page=100', '-f', 'page=2'],
        ['api', '-X', 'GET', 'repos/o/r/pulls/9/comments', '-f', 'per_page=100', '-f', 'page=1'],
        ['api', '-X', 'GET', 'repos/o/r/issues/9/comments', '-f', 'per_page=100', '-f', 'page=1'],
        ['api', '-X', 'GET', 'repos/o/r/issues/9/comments', '-f', 'per_page=100', '-f', 'page=2'],
        ['api', 'graphql', '--input', '-'],
      ]);
      expect(f.reviews).toHaveLength(101);
      expect(f.reviews[0]).toEqual({
        id: 1, author: 'bob', authorAssociation: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'b', submittedAt: '2026-01-01T00:00:00Z',
      });
      expect(f.reviews[100]!.state).toBe('APPROVED');
      expect(f.reviewComments).toEqual([
        {
          id: 50, author: 'carol', authorAssociation: 'OWNER', path: 'src/a.ts', line: 12, diffHunk: '@@ -1 +1 @@', body: 'rename',
          createdAt: '2026-01-02T00:00:00Z', reviewId: 7, threadId: 'T1', threadResolved: true,
        },
        {
          id: 51, author: '', authorAssociation: 'NONE', path: 'b.ts', line: 4, diffHunk: '', body: '',
          createdAt: '2026-01-02T00:00:01Z', reviewId: null, threadId: null, threadResolved: false,
        },
      ]);
      expect(f.comments).toHaveLength(101);
      expect(f.comments[100]).toEqual({ id: 300, author: 'erin', authorAssociation: 'COLLABORATOR', body: 'last', createdAt: '2026-01-04T00:00:00Z' });
    });

    it('treats an unknown review state as a comment and maps errors like the other calls', async () => {
      const ok = stub([
        { stdout: JSON.stringify([{ id: 1, user: { login: 'a' }, state: 'PENDING', body: 'x', submitted_at: 't' }]) },
        { stdout: '[]' },
        { stdout: '[]' },
        { stdout: threadsPage([]) },
      ]);
      expect((await new GhCliHost({ exec: ok.exec }).listPrFeedback(R, 1)).reviews[0]!.state).toBe('COMMENTED');
      const bad = stub([{ stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }]);
      await expect(new GhCliHost({ exec: bad.exec }).listPrFeedback(R, 1)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('review threads', () => {
    it('replies through the REST replies endpoint with the body on stdin', async () => {
      const { exec, calls, inputs } = stub([{ stdout: '{}' }]);
      await new GhCliHost({ exec }).replyToReviewComment(R, 9, 55, 'thanks <!-- m -->');
      expect(calls[0]![1]).toEqual(['api', '-X', 'POST', 'repos/o/r/pulls/9/comments/55/replies', '--input', '-']);
      expect(JSON.parse(inputs[0]!)).toEqual({ body: 'thanks <!-- m -->' });
    });

    it('pages the review threads of a pull request through GraphQL', async () => {
      const { exec, inputs } = stub([
        { stdout: threadsPage([thread('T1', false, 1, 2), thread('T2', true, 3)], 'CUR1') },
        { stdout: threadsPage([thread('T3', false, 4)]) },
      ]);
      expect(await new GhCliHost({ exec }).listReviewThreads(R, 9)).toEqual([
        { id: 'T1', resolved: false, commentIds: [1, 2] },
        { id: 'T2', resolved: true, commentIds: [3] },
        { id: 'T3', resolved: false, commentIds: [4] },
      ]);
      expect(inputs.map((i) => JSON.parse(i!).variables)).toEqual([
        { owner: 'o', name: 'r', number: 9, after: null },
        { owner: 'o', name: 'r', number: 9, after: 'CUR1' },
      ]);
    });

    it('resolves a thread with the resolveReviewThread mutation', async () => {
      const { exec, calls, inputs } = stub([{ stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"T1","isResolved":true}}}}' }]);
      await new GhCliHost({ exec }).resolveReviewThread(R, 'T1');
      expect(calls[0]![1]).toEqual(['api', 'graphql', '--input', '-']);
      const sent = JSON.parse(inputs[0]!);
      expect(sent.query).toContain('resolveReviewThread');
      expect(sent.variables).toEqual({ threadId: 'T1' });
    });

    it('reports GraphQL errors without a status (transient) and a missing pull request as 404', async () => {
      const gql = stub([{ stdout: '{"errors":[{"message":"Something went wrong"}]}' }]);
      const err = await new GhCliHost({ exec: gql.exec }).resolveReviewThread(R, 'T1').catch((e) => e);
      expect(err).toBeInstanceOf(GitHostError);
      expect(err.status).toBeUndefined();
      const bad = stub([{ stderr: 'gh: Bad Gateway (HTTP 502)', exitCode: 1 }]);
      await expect(new GhCliHost({ exec: bad.exec }).listReviewThreads(R, 9)).rejects.toMatchObject({ status: 502 });
      const none = stub([{ stdout: '{"data":{"repository":{"pullRequest":null}}}' }]);
      await expect(new GhCliHost({ exec: none.exec }).listReviewThreads(R, 9)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('findIssueByMarker returns the lowest matching number', async () => {
    const { exec, calls } = stub([{ stdout: JSON.stringify({ items: [{ number: 9 }, { number: 4 }, { number: 6, pull_request: {} }] }) }]);
    expect(await new GhCliHost({ exec }).findIssueByMarker(R, '<!-- k -->')).toBe(4);
    expect(calls[0]![1]).toEqual(['api', '-X', 'GET', 'search/issues', '-f', 'q=repo:o/r is:issue in:body "<!-- k -->"', '-f', 'per_page=100']);
  });

  it('findIssueByMarker with a label lists issues, skips PRs, pages and returns the lowest match', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: 100 + i, body: 'nope' }));
    const page2 = [
      { number: 50, body: 'has <!-- k -->', pull_request: {} },
      { number: 30, body: 'has <!-- k -->' },
      { number: 20, body: null },
      { number: 40, body: 'also <!-- k -->' },
    ];
    const { exec, calls } = stub([{ stdout: JSON.stringify(page1) }, { stdout: JSON.stringify(page2) }]);
    expect(await new GhCliHost({ exec }).findIssueByMarker(R, '<!-- k -->', 'factory:followup')).toBe(30);
    expect(calls.map((c) => c[1])).toEqual([
      ['api', '-X', 'GET', 'repos/o/r/issues', '-f', 'state=all', '-f', 'labels=factory:followup', '-f', 'per_page=100', '-f', 'page=1'],
      ['api', '-X', 'GET', 'repos/o/r/issues', '-f', 'state=all', '-f', 'labels=factory:followup', '-f', 'per_page=100', '-f', 'page=2'],
    ]);
    const none = stub([{ stdout: '[]' }]);
    expect(await new GhCliHost({ exec: none.exec }).findIssueByMarker(R, '<!-- k -->', 'l')).toBeNull();
  });

  it('findIssueByMarker without a label falls back to search with is:issue', async () => {
    const { exec, calls } = stub([{ stdout: JSON.stringify({ items: [] }) }]);
    expect(await new GhCliHost({ exec }).findIssueByMarker(R, '<!-- k -->')).toBeNull();
    expect(calls[0]![1]).toContain('q=repo:o/r is:issue in:body "<!-- k -->"');
  });

  it('openPr sends head, base, title and body on stdin', async () => {
    const { exec, calls, inputs } = stub([
      { stdout: JSON.stringify({ number: 12, state: 'open', merged: false, head: { sha: 'h1' }, base: { ref: 'main' } }) },
    ]);
    const pr = await new GhCliHost({ exec }).openPr(R, { head: 'feat', base: 'main', title: 'T', body: 'B "q"\n' });
    expect(pr).toEqual({ number: 12, state: 'open', headSha: 'h1', baseBranch: 'main', mergeable: 'unknown' });
    expect(calls).toEqual([['gh', ['api', '-X', 'POST', 'repos/o/r/pulls', '--input', '-']]]);
    expect(JSON.parse(inputs[0]!)).toEqual({ head: 'feat', base: 'main', title: 'T', body: 'B "q"\n' });
  });

  it('getPr maps mergeable and mergeable_state to mergeable, conflicting or unknown', async () => {
    const mk = (extra: object) =>
      JSON.stringify({ number: 3, state: 'open', merged_at: null, head: { sha: 's' }, base: { ref: 'dev' }, ...extra });
    const read = async (extra: object) => (await new GhCliHost({ exec: stub([{ stdout: mk(extra) }]).exec }).getPr(R, 3)).mergeable;
    expect(await read({ mergeable: true, mergeable_state: 'clean' })).toBe('mergeable');
    expect(await read({ mergeable: true, mergeable_state: 'behind' })).toBe('mergeable');
    expect(await read({ mergeable: false, mergeable_state: 'dirty' })).toBe('conflicting');
    expect(await read({ mergeable: null, mergeable_state: 'unknown' })).toBe('unknown');
    expect(await read({ mergeable: false, mergeable_state: 'blocked' })).toBe('unknown');
    expect(await read({})).toBe('unknown');
  });

  it('findPrByHead maps MERGEABLE, CONFLICTING and UNKNOWN', async () => {
    const read = async (m: string) => {
      const a = stub([{ stdout: JSON.stringify([{ number: 3, state: 'OPEN', headRefOid: 'abc', baseRefName: 'main', mergeable: m }]) }]);
      return (await new GhCliHost({ exec: a.exec }).findPrByHead(R, 'feat'))!.mergeable;
    };
    expect(await read('MERGEABLE')).toBe('mergeable');
    expect(await read('CONFLICTING')).toBe('conflicting');
    expect(await read('UNKNOWN')).toBe('unknown');
  });

  it('getPr maps open, closed and merged states', async () => {
    const mk = (extra: object) => JSON.stringify({ number: 3, head: { sha: 's' }, base: { ref: 'dev' }, ...extra });
    const open = stub([{ stdout: mk({ state: 'open', merged_at: null }) }]);
    const closed = stub([{ stdout: mk({ state: 'closed', merged_at: null }) }]);
    const merged = stub([{ stdout: mk({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }) }]);
    expect((await new GhCliHost({ exec: open.exec }).getPr(R, 3)).state).toBe('open');
    expect((await new GhCliHost({ exec: closed.exec }).getPr(R, 3)).state).toBe('closed');
    expect(await new GhCliHost({ exec: merged.exec }).getPr(R, 3)).toEqual({ number: 3, state: 'merged', headSha: 's', baseBranch: 'dev', mergeable: 'unknown' });
    expect(merged.calls).toEqual([['gh', ['api', '-X', 'GET', 'repos/o/r/pulls/3']]]);
  });

  it('comment posts the body on stdin', async () => {
    const { exec, calls, inputs } = stub([{ stdout: '{}' }]);
    await new GhCliHost({ exec }).comment(R, 8, 'hi <!-- m -->');
    expect(calls).toEqual([['gh', ['api', '-X', 'POST', 'repos/o/r/issues/8/comments', '--input', '-']]]);
    expect(JSON.parse(inputs[0]!)).toEqual({ body: 'hi <!-- m -->' });
  });

  it('createIssue sends title, body and labels and returns the number', async () => {
    const { exec, calls, inputs } = stub([{ stdout: JSON.stringify({ number: 21 }) }]);
    expect(await new GhCliHost({ exec }).createIssue(R, { title: 'T', body: 'B', labels: ['a', 'b'] })).toBe(21);
    expect(calls).toEqual([['gh', ['api', '-X', 'POST', 'repos/o/r/issues', '--input', '-']]]);
    expect(JSON.parse(inputs[0]!)).toEqual({ title: 'T', body: 'B', labels: ['a', 'b'] });
  });

  it('setLabels sends a deduplicated labels array on stdin when adding', async () => {
    const { exec, inputs } = stub([{ stdout: '[]' }]);
    await new GhCliHost({ exec }).setLabels(R, 5, ['a', 'b', 'a'], []);
    expect(JSON.parse(inputs[0]!)).toEqual({ labels: ['a', 'b'] });
  });
});

describe('gh subprocess timeouts', () => {
  it('GhCliHost passes ghTimeoutMs (default 60 s) to every gh call', async () => {
    expect(GH_TIMEOUT_MS).toBe(60_000);
    const seen: Array<number | undefined> = [];
    const exec: ExecFn = async (_f, _a, opts) => {
      seen.push(opts?.timeoutMs);
      return { stdout: JSON.stringify({ number: 1, title: 't', body: '', state: 'open', labels: [] }), stderr: '', exitCode: 0 };
    };
    await new GhCliHost({ exec }).getIssue(R, 1);
    await new GhCliHost({ exec, ghTimeoutMs: 1234 }).getIssue(R, 1);
    expect(seen).toEqual([60_000, 1234]);
  });

  it('a timed-out gh call is a GitHostError without status (transient)', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 1, timedOut: true });
    const err = await new GhCliHost({ exec, ghTimeoutMs: 5 }).getIssue(R, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostError);
    expect((err as GitHostError).status).toBeUndefined();
    expect((err as Error).message).toMatch(/gh api timed out after 5 ms/);
  });

  it('defaultExec kills a hung child at its timeout and reports timedOut', async () => {
    const started = process.hrtime.bigint();
    const r = await defaultExec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
    const ok = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 5_000 });
    expect(ok).toMatchObject({ stdout: 'hi', exitCode: 0 });
    expect(ok.timedOut).toBeFalsy();
  });
});

describe('FakeGitHost checks', () => {
  it('derives the state from the checks of exactly that sha', async () => {
    const gh = new FakeGitHost();
    expect(await gh.getChecks(R, 'abc1234')).toEqual({ state: 'none', checks: [] });
    gh.setChecks('abc1234', [{ name: 'a', status: 'completed', conclusion: 'success' }]);
    expect((await gh.getChecks(R, 'abc1234')).state).toBe('passing');
    expect((await gh.getChecks(R, 'def5678')).state).toBe('none');
    gh.setFailedLog(4, 'l1\nl2\nl3');
    expect(await gh.getFailedLogExcerpt(R, 4, 2)).toBe('l2\nl3');
    await expect(gh.getFailedLogExcerpt(R, 5, 2)).rejects.toMatchObject({ status: 404 });
    gh.failNext('getChecks', new GitHostError('boom', 502));
    await expect(gh.getChecks(R, 'abc1234')).rejects.toMatchObject({ status: 502 });
  });
});

describe('GhCliHost getChecks', () => {
  const SHA = 'abc1234def';
  const run = (i: number, over: object = {}) => ({
    name: `job ${i}`, status: 'completed', conclusion: 'success', details_url: `https://github.com/o/r/actions/runs/${1000 + i}/job/${i}`, ...over,
  });
  const runs = (list: object[]) => JSON.stringify({ total_count: list.length, check_runs: list });
  const statuses = (list: object[]) => JSON.stringify({ state: 'pending', statuses: list });

  it('pages both endpoints by hand and maps runs and legacy statuses', async () => {
    const { exec, calls } = stub([
      { stdout: runs(Array.from({ length: 100 }, (_, i) => run(i))) },
      { stdout: runs([run(100, { conclusion: 'failure' })]) },
      { stdout: statuses(Array.from({ length: 100 }, (_, i) => ({ context: `ci/${i}`, state: 'success' }))) },
      { stdout: statuses([{ context: 'ci/last', state: 'error', target_url: 'https://ci.example/x' }]) },
    ]);
    const r = await new GhCliHost({ exec }).getChecks(R, SHA);
    expect(calls.map((c) => c[1])).toEqual([
      ['api', '-X', 'GET', `repos/o/r/commits/${SHA}/check-runs`, '-f', 'per_page=100', '-f', 'page=1'],
      ['api', '-X', 'GET', `repos/o/r/commits/${SHA}/check-runs`, '-f', 'per_page=100', '-f', 'page=2'],
      ['api', '-X', 'GET', `repos/o/r/commits/${SHA}/status`, '-f', 'per_page=100', '-f', 'page=1'],
      ['api', '-X', 'GET', `repos/o/r/commits/${SHA}/status`, '-f', 'per_page=100', '-f', 'page=2'],
    ]);
    expect(r.checks).toHaveLength(202);
    expect(r.state).toBe('failing');
    expect(r.checks[100]).toEqual({
      name: 'job 100', status: 'completed', conclusion: 'failure', detailsUrl: 'https://github.com/o/r/actions/runs/1100/job/100', runId: 1100,
    });
    expect(r.checks[201]).toEqual({ name: 'ci/last', status: 'completed', conclusion: 'failure', detailsUrl: 'https://ci.example/x' });
  });

  const stateOf = async (checkRuns: object[], st: object[] = []) => {
    const { exec } = stub([{ stdout: runs(checkRuns) }, { stdout: statuses(st) }]);
    return (await new GhCliHost({ exec }).getChecks(R, SHA)).state;
  };

  it('none without checks', async () => expect(await stateOf([])).toBe('none'));
  it('passing when all completed with success, neutral or skipped', async () => {
    expect(await stateOf([run(1), run(2, { conclusion: 'neutral' }), run(3, { conclusion: 'skipped' })], [{ context: 'c', state: 'success' }])).toBe('passing');
  });
  it('pending when a check is not completed', async () => {
    expect(await stateOf([run(1), run(2, { status: 'in_progress', conclusion: null })])).toBe('pending');
    expect(await stateOf([run(1), run(2, { status: 'queued', conclusion: null })])).toBe('pending');
    expect(await stateOf([run(1)], [{ context: 'c', state: 'pending' }])).toBe('pending');
  });
  it.each(['failure', 'timed_out', 'cancelled', 'action_required'])('failing on %s', async (conclusion) => {
    expect(await stateOf([run(1, { conclusion })])).toBe('failing');
  });
  it('a mix of failing, pending and passing is failing', async () => {
    expect(await stateOf([run(1), run(2, { status: 'in_progress', conclusion: null }), run(3, { conclusion: 'failure' })])).toBe('failing');
  });

  it('refuses a value that is not a sha and maps failures like the other calls', async () => {
    const { exec } = stub([{ stderr: 'boom (HTTP 502)', exitCode: 1 }]);
    await expect(new GhCliHost({ exec }).getChecks(R, '../x')).rejects.toBeInstanceOf(GitHostError);
    await expect(new GhCliHost({ exec }).getChecks(R, SHA)).rejects.toMatchObject({ status: 502 });
  });

  it('reads the end of the failing log with gh run view --log-failed', async () => {
    const { exec, calls } = stub([{ stdout: `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')}\n` }]);
    expect(await new GhCliHost({ exec }).getFailedLogExcerpt(R, 77, 3)).toBe('l8\nl9\nl10');
    expect(calls[0]![1]).toEqual(['run', 'view', '77', '--repo', R, '--log-failed']);
  });
});
