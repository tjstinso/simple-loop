import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyStore, loadPolicies } from '../../src/policy/store.js';
import { AmbiguousMatchError, NoPolicyError } from '../../src/policy/matcher.js';
import type { Policy } from '../../src/policy/schema.js';

const p = (id: string, labels: string[], extra: Partial<Policy> = {}): Policy => ({
  id,
  kind: 'review',
  match: { labels },
  runner: 'r',
  config: {},
  ...extra,
});

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'policy-'));
  dirs.push(d);
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('policy matching', () => {
  it('matches when all policy labels are present', () => {
    const s = new PolicyStore([p('a', ['x', 'y']), p('d', [], { default: true })]);
    expect(s.match('review', ['x', 'y', 'z']).id).toBe('a');
    expect(s.byId('a').id).toBe('a');
  });
  it('falls back to the default policy of that kind', () => {
    const s = new PolicyStore([p('a', ['x']), p('d', [], { default: true })]);
    expect(s.match('review', ['q']).id).toBe('d');
  });
  it('throws AmbiguousMatchError when two non-default policies match', () => {
    const s = new PolicyStore([p('a', ['x']), p('b', ['y']), p('d', [], { default: true })]);
    expect(() => s.match('review', ['x', 'y'])).toThrow(AmbiguousMatchError);
  });
  it('throws NoPolicyError when nothing matches and no default exists', () => {
    const s = new PolicyStore([p('a', ['x'])]);
    expect(() => s.match('review', ['q'])).toThrow(NoPolicyError);
    expect(() => s.match('other', ['x'])).toThrow(NoPolicyError);
  });
});

describe('PolicyStore validation', () => {
  it('rejects two default policies of the same kind and names both ids', () => {
    const mk = () =>
      new PolicyStore([p('d1', [], { default: true }), p('d2', [], { default: true })]);
    expect(mk).toThrow(/d1.*d2/);
  });
  it('accepts one default per kind for different kinds, and a default of kind A is not returned for kind B', () => {
    const s = new PolicyStore([
      p('da', [], { default: true, kind: 'A' }),
      p('db', [], { default: true, kind: 'B' }),
    ]);
    expect(s.match('A', []).id).toBe('da');
    expect(s.match('B', []).id).toBe('db');
    expect(() => s.match('C', [])).toThrow(NoPolicyError);
  });
  it('rejects a default policy with non-empty match.labels', () => {
    expect(() => new PolicyStore([p('d', ['x'], { default: true })])).toThrow(/d/);
  });
  it('rejects a non-default policy with empty match.labels', () => {
    expect(() => new PolicyStore([p('n', [])])).toThrow(/n/);
  });
});

describe('loadPolicies', () => {
  it('loads valid yaml files', () => {
    const d = tmp({
      'a.yaml': 'id: a\nkind: review\nmatch:\n  labels: [x]\nrunner: r\nconfig:\n  k: 1\n',
    });
    expect(loadPolicies(d)).toHaveLength(1);
  });
  it('rejects a policy file that fails the schema and names the file', () => {
    const d = tmp({ 'bad.yaml': 'id: a\nkind: review\n' });
    expect(() => loadPolicies(d)).toThrow(/bad\.yaml/);
  });
  it('rejects duplicate policy ids', () => {
    const y = 'id: a\nkind: review\nmatch:\n  labels: []\nrunner: r\nconfig: {}\n';
    const d = tmp({ 'one.yaml': y, 'two.yaml': y });
    expect(() => loadPolicies(d)).toThrow(/duplicate.*one\.yaml.*two\.yaml/i);
  });
});

describe('shipped policies', () => {
  it('the review policy loads only user settings (never the project .claude/settings.json under review)', () => {
    const review = loadPolicies(join(import.meta.dirname, '../../policies')).find((x) => x.kind === 'review')!;
    expect((review.config as { settingSources?: string }).settingSources).toBe('user');
  });

  const shipped = () => loadPolicies(join(import.meta.dirname, '../../policies'));
  const promptOf = (kind: string) => (shipped().find((x) => x.kind === kind)!.config as { prompt: string }).prompt;

  it('each shipped prompt has exactly one json fence, it is valid JSON, and it comes last', () => {
    for (const kind of ['execute', 'review']) {
      const prompt = promptOf(kind);
      const fences = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)];
      expect(fences, kind).toHaveLength(1);
      expect((prompt.match(/```/g) ?? []).length, kind).toBe(2); // no other fenced block
      expect(() => JSON.parse(fences[0]![1]!), kind).not.toThrow();
      expect(prompt.trimEnd().endsWith('```'), kind).toBe(true);
    }
    const example = JSON.parse([...promptOf('review').matchAll(/```json\n([\s\S]*?)\n```/g)][0]![1]!) as { verdict: string };
    expect(example.verdict).toBe('approve');
    expect(promptOf('review')).toContain('request_changes');
  });

  it('the review prompt forbids diff drivers and --output', () => {
    const prompt = promptOf('review');
    expect(prompt).toContain('--no-ext-diff --no-textconv');
    for (const cmd of ['git diff', 'git show', 'git log -p']) expect(prompt).toContain(cmd);
    expect(prompt).toMatch(/never use `--output`/i);
  });
});

describe('model selection by label', () => {
  const claude = (id: string, kind: string, extra: Partial<Policy> = {}): Policy => ({
    id,
    kind,
    match: { labels: [] },
    runner: 'claude-cli',
    config: { prompt: 'x', model: kind === 'review' ? 'haiku' : 'sonnet' },
    default: true,
    ...extra,
  });
  const models = { allowed: ['haiku', 'sonnet'], byLabel: { 'factory:followup': 'haiku', 'size:big': 'sonnet' } };
  const store = () => new PolicyStore([claude('e', 'execute'), claude('r', 'review')], models);
  const modelOf = (kind: string, labels: string[]) => (store().match(kind, labels).config as { model?: string }).model;

  it.each([
    ['no label', 'execute', [], 'sonnet'],
    ['no label (review keeps its own)', 'review', [], 'haiku'],
    ['factory:model:haiku', 'execute', ['factory:model:haiku'], 'haiku'],
    ['factory:model:sonnet on review', 'review', ['factory:model:sonnet'], 'sonnet'],
    ['factory:followup', 'execute', ['factory:followup'], 'haiku'],
    ['explicit label wins over byLabel', 'execute', ['factory:followup', 'factory:model:sonnet'], 'sonnet'],
    ['first byLabel entry in config order wins', 'execute', ['size:big', 'factory:followup'], 'haiku'],
    ['the same model label twice', 'execute', ['factory:model:haiku', 'factory:model:haiku'], 'haiku'],
  ])('%s', (_name, kind, labels, model) => {
    expect(modelOf(kind, labels)).toBe(model);
  });

  it('rejects two different model labels', () => {
    expect(() => store().match('execute', ['factory:model:haiku', 'factory:model:sonnet'])).toThrow(
      /multiple model labels: factory:model:haiku, factory:model:sonnet/,
    );
  });

  it('rejects an alias outside the allowlist', () => {
    expect(() => store().match('execute', ['factory:model:opus'])).toThrow(
      'model "opus" is not allowed (allowed: haiku, sonnet)',
    );
  });

  it('leaves a policy of another runner untouched', () => {
    const s = new PolicyStore([claude('e', 'execute', { runner: 'fake', config: { model: 'x' } })], models);
    expect(s.match('execute', ['factory:model:haiku'])).toBe(s.byId('e'));
  });

  it('sets the model when the policy has none, and never mutates the stored policy', () => {
    const stored = claude('e', 'execute', { config: { prompt: 'x' } });
    const before = JSON.stringify(stored);
    const s = new PolicyStore([stored], models);
    const got = s.match('execute', ['factory:model:haiku']);
    expect(got.config).toEqual({ prompt: 'x', model: 'haiku' });
    expect(s.byId('e')).toBe(stored);
    expect(JSON.stringify(stored)).toBe(before);
  });
});
