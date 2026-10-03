import { describe, expect, it } from 'vitest';
import { GhCliHost, GitHostError, type ExecFn } from '../../../src/engines/software/github.js';
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
});

type Call = [string, string[]];
function stub(responses: Array<{ stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: Call[] = [];
  let i = 0;
  const exec: ExecFn = async (file, args) => {
    calls.push([file, args]);
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { exec, calls };
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
    expect(a.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--squash']]]);
    const b = stub([{}]);
    await new GhCliHost({ exec: b.exec, mergeMethod: 'rebase' }).mergePr(R, 9);
    expect(b.calls).toEqual([['gh', ['pr', 'merge', '9', '--repo', R, '--rebase']]]);
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
    expect(calls[0]![1]).toEqual(['api', '-X', 'GET', 'search/issues', '-f', 'q=repo:o/r in:body "<!-- k -->"', '-f', 'per_page=100']);
  });
});
