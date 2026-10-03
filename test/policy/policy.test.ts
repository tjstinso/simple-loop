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
