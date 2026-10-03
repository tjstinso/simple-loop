import { describe, expect, it } from 'vitest';
import { parseIssueUrl, softwareSubmit } from '../../../src/engines/software/submit.js';
import { GitHostError } from '../../../src/engines/software/github.js';
import { AmbiguousMatchError, NoPolicyError, PolicyStore } from '../../../src/policy/store.js';
import { FakeGitHost } from '../../support/fake-github.js';

const BODY = '## Goal\nDo it\n\n## Acceptance criteria\n- works\n';
const policy = (id: string, labels: string[] = [], def = false, kind = 'execute') =>
  ({ id, kind, match: { labels }, runner: 'fake', config: {}, default: def }) as any;
// Every software submit also resolves the review policy (R40), so the stores carry a review default.
const reviewDefault = policy('r-default', [], true, 'review');

function setup(over: { body?: string; labels?: string[]; state?: 'open' | 'closed'; policies?: PolicyStore } = {}) {
  const host = new FakeGitHost();
  const n = host.addIssue({ title: 't', body: over.body ?? BODY, labels: over.labels ?? [], state: over.state });
  const policies = over.policies ?? new PolicyStore([policy('p-default', [], true), reviewDefault]);
  const deps = {
    host,
    policies,
    config: { defaultProfile: 'supervised' as 'supervised' | 'automatic', requiredSections: ['## Goal', '## Acceptance criteria'] },
  };
  const url = `https://github.com/acme/widgets/issues/${n}`;
  return { host, deps, n, url };
}

describe('parseIssueUrl', () => {
  it('rejects a malformed issue URL', () => {
    for (const u of [
      'https://gitlab.com/a/b/issues/1',
      'https://github.com/a/b/issues/',
      'https://github.com/a/b/issues',
      'https://github.com/a/b/issues/1/extra',
      'https://github.com/a/b/pull/1',
      'https://github.com/a/b/issues/0',
      'https://github.com/a/b/issues/abc',
      'https://github.com/a/b/issues/1x',
      'https://github.com/./b/issues/1',
      'https://github.com/a/../issues/1',
      'https://github.com/a%20b/c/issues/1',
      'not a url',
      '',
    ]) {
      expect(() => parseIssueUrl(u), u).toThrow(Error);
    }
  });

  it('accepts www and a trailing slash', () => {
    expect(parseIssueUrl('https://github.com/o/r/issues/12')).toEqual({ repo: 'o/r', number: 12 });
    expect(parseIssueUrl('https://www.github.com/o/r.x/issues/12/')).toEqual({ repo: 'o/r.x', number: 12 });
  });
});

describe('softwareSubmit', () => {
  it('rejects an issue missing a required section and names the missing section', async () => {
    const s = setup({ body: '## Goal\nonly goal' });
    await expect(softwareSubmit({ issueUrl: s.url }, s.deps)).rejects.toThrow(/## Acceptance criteria/);
    const t = setup({ body: 'nothing here' });
    const err = await softwareSubmit({ issueUrl: t.url }, t.deps).catch((e) => e);
    expect(err.message).toContain('## Goal');
    expect(err.message).toContain('## Acceptance criteria');
  });

  it('rejects an empty body', async () => {
    const s = setup({ body: '  \n\t ' });
    await expect(softwareSubmit({ issueUrl: s.url }, s.deps)).rejects.toThrow(/empty/i);
  });

  it('rejects a closed issue', async () => {
    const s = setup({ state: 'closed' });
    await expect(softwareSubmit({ issueUrl: s.url }, s.deps)).rejects.toThrow(/closed/i);
  });

  it('selects the automatic profile from factory:profile:automatic, else the default', async () => {
    const a = setup({ labels: ['factory:profile:automatic'] });
    expect((await softwareSubmit({ issueUrl: a.url }, a.deps)).state.profile).toBe('automatic');
    const b = setup();
    expect((await softwareSubmit({ issueUrl: b.url }, b.deps)).state.profile).toBe('supervised');
    const c = setup();
    c.deps.config.defaultProfile = 'automatic';
    expect((await softwareSubmit({ issueUrl: c.url }, c.deps)).state.profile).toBe('automatic');
  });

  it('builds the first job as execute attempt 1 with the issue labels', async () => {
    const s = setup({ labels: ['bug', 'x'] });
    const r = await softwareSubmit({ issueUrl: s.url }, s.deps);
    expect(r.firstJob).toEqual({ type: 'execute', attempt: 1, policyKind: 'execute', labels: ['bug', 'x'] });
  });

  it('builds the initial state with branch, attempt 1, phase executing and the issue labels', async () => {
    const s = setup({ labels: ['bug'] });
    const r = await softwareSubmit({ issueUrl: s.url }, s.deps);
    expect(r.subjectKey).toBe(`acme/widgets#${s.n}`);
    expect(r.state).toEqual({
      repo: 'acme/widgets',
      issueNumber: s.n,
      labels: ['bug'],
      profile: 'supervised',
      branch: `factory/issue-${s.n}`,
      attempt: 1,
      phase: 'executing',
    });
  });

  it('propagates a policy match error and a GitHostError unchanged', async () => {
    const none = setup({ policies: new PolicyStore([]) });
    await expect(softwareSubmit({ issueUrl: none.url }, none.deps)).rejects.toBeInstanceOf(NoPolicyError);
    const amb = setup({
      labels: ['a', 'b'],
      policies: new PolicyStore([policy('pa', ['a']), policy('pb', ['b']), reviewDefault]),
    });
    await expect(softwareSubmit({ issueUrl: amb.url }, amb.deps)).rejects.toBeInstanceOf(AmbiguousMatchError);
    const h = setup();
    const e = new GitHostError('boom', 500);
    h.host.failNext('getIssue', e);
    await expect(softwareSubmit({ issueUrl: h.url }, h.deps)).rejects.toBe(e);
  });

  it('fails at submit, before any job exists, when no review policy or an ambiguous one matches', async () => {
    const none = setup({ policies: new PolicyStore([policy('p-default', [], true)]) });
    await expect(softwareSubmit({ issueUrl: none.url }, none.deps)).rejects.toBeInstanceOf(NoPolicyError);
    const amb = setup({
      labels: ['a', 'b'],
      policies: new PolicyStore([
        policy('p-default', [], true), reviewDefault, policy('ra', ['a'], false, 'review'), policy('rb', ['b'], false, 'review'),
      ]),
    });
    const err = await softwareSubmit({ issueUrl: amb.url }, amb.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousMatchError);
    expect((err as Error).message).toMatch(/review.*ra, rb/);
  });

  it('matches required section headings by line, not by substring in prose', async () => {
    const prose = setup({ body: 'We should discuss ## Goal later and ## Acceptance criteria too' });
    await expect(softwareSubmit({ issueUrl: prose.url }, prose.deps)).rejects.toThrow(/## Goal/);
    const ok = setup({ body: '  ## goal  \r\nx\n## ACCEPTANCE CRITERIA\ny' });
    await expect(softwareSubmit({ issueUrl: ok.url }, ok.deps)).resolves.toBeTruthy();
  });
});
