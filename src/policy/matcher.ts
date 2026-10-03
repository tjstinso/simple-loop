import type { Policy } from './schema.js';

export class AmbiguousMatchError extends Error {
  constructor(kind: string, ids: string[]) {
    super(`ambiguous policy match for kind '${kind}': ${ids.join(', ')}`);
    this.name = 'AmbiguousMatchError';
  }
}

export class NoPolicyError extends Error {
  constructor(kind: string) {
    super(`no policy matches kind '${kind}' and no default exists`);
    this.name = 'NoPolicyError';
  }
}

export function matchPolicy(policies: Policy[], kind: string, labels: string[]): Policy {
  const have = new Set(labels);
  const ofKind = policies.filter((p) => p.kind === kind);
  const matches = ofKind.filter(
    (p) => !p.default && p.match.labels.every((l) => have.has(l)),
  );
  if (matches.length > 1) throw new AmbiguousMatchError(kind, matches.map((p) => p.id));
  if (matches.length === 1) return matches[0]!;
  const def = ofKind.find((p) => p.default);
  if (!def) throw new NoPolicyError(kind);
  return def;
}
