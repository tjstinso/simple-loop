import { describe, expect, it } from 'vitest';
import { GH_TIMEOUT_MS, GhCliHost, GitHostError, defaultExec, type ExecFn } from '../../../src/engines/software/github.js';
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
    expect((await gh.getPr(R, pr.number)).state).toBe('merged');
  });

  it('mergePr is a no-op on an already merged PR', async () => {
    const gh = new FakeGitHost();
    const pr = await gh.openPr(R, { head: 'h', base: 'main', title: 't', body: '' });
    await gh.mergePr(R, pr.number);
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
    expect(issue).toEqual({ number: 7, title: 'T', body: '', labels: ['a', 'b'], state: 'open' });
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
      number: 3, state: 'merged', headSha: 'abc', baseBranch: 'main',
    });
    expect(a.calls).toEqual([
      ['gh', ['pr', 'list', '--repo', R, '--head', 'feat', '--state', 'all', '--json', 'number,state,headRefOid,baseRefName', '--limit', '1']],
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
    expect(a.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash', '--delete-branch']]]);
    const b = stub([{}]);
    await new GhCliHost({ exec: b.exec, mergeMethod: 'rebase' }).mergePr(R, 9);
    expect(b.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--rebase', '--delete-branch']]]);
  });

  it('mergePr pins the reviewed head with --match-head-commit and deletes the branch unless disabled', async () => {
    const sha = 'a'.repeat(40);
    const a = stub([{}]);
    await new GhCliHost({ exec: a.exec }).mergePr(R, 9, { expectHeadSha: sha });
    expect(a.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash', '--delete-branch', '--match-head-commit', sha]]]);
    const b = stub([{}]);
    await new GhCliHost({ exec: b.exec, deleteBranch: false }).mergePr(R, 9);
    expect(b.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash']]]);
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
    expect(pr).toEqual({ number: 12, state: 'open', headSha: 'h1', baseBranch: 'main' });
    expect(calls).toEqual([['gh', ['api', '-X', 'POST', 'repos/o/r/pulls', '--input', '-']]]);
    expect(JSON.parse(inputs[0]!)).toEqual({ head: 'feat', base: 'main', title: 'T', body: 'B "q"\n' });
  });

  it('getPr maps open, closed and merged states', async () => {
    const mk = (extra: object) => JSON.stringify({ number: 3, head: { sha: 's' }, base: { ref: 'dev' }, ...extra });
    const open = stub([{ stdout: mk({ state: 'open', merged_at: null }) }]);
    const closed = stub([{ stdout: mk({ state: 'closed', merged_at: null }) }]);
    const merged = stub([{ stdout: mk({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' }) }]);
    expect((await new GhCliHost({ exec: open.exec }).getPr(R, 3)).state).toBe('open');
    expect((await new GhCliHost({ exec: closed.exec }).getPr(R, 3)).state).toBe('closed');
    expect(await new GhCliHost({ exec: merged.exec }).getPr(R, 3)).toEqual({ number: 3, state: 'merged', headSha: 's', baseBranch: 'dev' });
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

describe('getChecks', () => {
  const run = (name: string, status: string, conclusion: string | null) => ({
    name, status, conclusion, details_url: `https://ci.example/${name}`,
  });
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => run(`${prefix}${i}`, 'completed', 'success'));
  /** Answers by endpoint and page. */
  function host(runs: Record<number, unknown[]>, statuses: Record<number, unknown[]>) {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push(args);
      const page = Number(args.find((a) => a.startsWith('page='))!.slice(5));
      const isRuns = args[3]!.endsWith('/check-runs');
      return { stdout: JSON.stringify(isRuns ? { check_runs: runs[page] ?? [] } : { statuses: statuses[page] ?? [] }), stderr: '', exitCode: 0 };
    };
    return { gh: new GhCliHost({ exec }), calls };
  }

  it('reads check runs and legacy statuses of exactly the sha, paging both with page=', async () => {
    const { gh, calls } = host(
      { 1: many(100, 'a'), 2: many(2, 'b') },
      { 1: [{ context: 'ci/legacy', state: 'success', target_url: 'https://legacy.example' }] },
    );
    const r = await gh.getChecks(R, 'abc123');
    expect(r.checks).toHaveLength(103);
    expect(r.checks.at(-1)).toEqual({ name: 'ci/legacy', status: 'completed', conclusion: 'success', detailsUrl: 'https://legacy.example' });
    expect(r.state).toBe('passing');
    expect(calls.map((c) => [c[3], c.filter((a) => a.startsWith('page='))[0]])).toEqual([
      ['repos/o/r/commits/abc123/check-runs', 'page=1'],
      ['repos/o/r/commits/abc123/check-runs', 'page=2'],
      ['repos/o/r/commits/abc123/status', 'page=1'],
    ]);
  });

  it('pages the legacy statuses too', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: 'success' }));
    const { gh, calls } = host({}, { 1: full, 2: [{ context: 'last', state: 'pending' }] });
    const r = await gh.getChecks(R, 'abc');
    expect(r.checks).toHaveLength(101);
    expect(r.state).toBe('pending');
    expect(calls.filter((c) => c[3]!.endsWith('/status'))).toHaveLength(2);
  });

  it.each([
    ['passing', [run('a', 'completed', 'success'), run('b', 'completed', 'neutral'), run('c', 'completed', 'skipped')]],
    ['pending', [run('a', 'completed', 'success'), run('b', 'in_progress', null)]],
    ['pending', [run('a', 'queued', null)]],
    ['failing', [run('a', 'completed', 'failure')]],
    ['failing', [run('a', 'completed', 'timed_out')]],
    ['failing', [run('a', 'completed', 'cancelled')]],
    ['failing', [run('a', 'completed', 'action_required')]],
    ['failing', [run('a', 'completed', 'success'), run('b', 'queued', null), run('c', 'completed', 'failure')]],
    ['none', []],
  ])('state %s', async (state, runs) => {
    const { gh } = host({ 1: runs }, {});
    expect((await gh.getChecks(R, 'abc')).state).toBe(state);
  });

  it('maps legacy failure and error to failed checks and pending to unfinished ones', async () => {
    const { gh } = host({}, { 1: [{ context: 'a', state: 'error' }, { context: 'b', state: 'pending' }] });
    const r = await gh.getChecks(R, 'abc');
    expect(r.checks.map((c) => [c.status, c.conclusion])).toEqual([['completed', 'failure'], ['in_progress', null]]);
  });

  it('maps a failing gh call like the other calls (HTTP status kept)', async () => {
    const gh = new GhCliHost({ exec: async () => ({ stdout: '', stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }) });
    await expect(gh.getChecks(R, 'abc')).rejects.toMatchObject({ status: 404 });
  });

  it('passes the gh timeout', async () => {
    const seen: Array<number | undefined> = [];
    const gh = new GhCliHost({ exec: async (_f, _a, o) => (seen.push(o?.timeoutMs), { stdout: '{}', stderr: '', exitCode: 0 }), ghTimeoutMs: 1234 });
    await gh.getChecks(R, 'abc');
    expect(seen).toEqual([1234, 1234]);
  });

  it('getJobLog returns the log, or null when it is gone (4xx)', async () => {
    expect(await new GhCliHost({ exec: async () => ({ stdout: 'line\n', stderr: '', exitCode: 0 }) }).getJobLog(R, 5)).toBe('line\n');
    const gone = new GhCliHost({ exec: async () => ({ stdout: '', stderr: 'gone (HTTP 410)', exitCode: 1 }) });
    expect(await gone.getJobLog(R, 5)).toBeNull();
  });

  it('FakeGitHost returns the checks set for exactly that sha', async () => {
    const fake = new FakeGitHost();
    fake.setChecks('old', [{ name: 'a', status: 'completed', conclusion: 'success' }]);
    expect((await fake.getChecks(R, 'old')).state).toBe('passing');
    expect(await fake.getChecks(R, 'new')).toEqual({ state: 'none', checks: [] });
  });
});
