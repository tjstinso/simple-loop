import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PolicySchema, type Policy } from './schema.js';
import { matchPolicy } from './matcher.js';

export { AmbiguousMatchError, NoPolicyError } from './matcher.js';

export function loadPolicies(dir: string): Policy[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  const policies: Policy[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new Error(`policy file ${file}: invalid YAML: ${(e as Error).message}`);
    }
    const res = PolicySchema.safeParse(raw);
    if (!res.success) {
      const detail = res.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`policy file ${file}: ${detail}`);
    }
    const prior = seen.get(res.data.id);
    if (prior !== undefined) {
      throw new Error(`duplicate policy id '${res.data.id}' in ${prior} and ${file}`);
    }
    seen.set(res.data.id, file);
    policies.push(res.data);
  }
  return policies;
}

export class PolicyStore {
  private readonly policies: Policy[];
  private readonly ids = new Map<string, Policy>();

  constructor(policies: Policy[]) {
    this.policies = policies;
    const defaults = new Map<string, string>();
    for (const p of policies) {
      if (this.ids.has(p.id)) throw new Error(`duplicate policy id '${p.id}'`);
      this.ids.set(p.id, p);
      if (p.default) {
        if (p.match.labels.length > 0) {
          throw new Error(`default policy '${p.id}' must have empty match.labels`);
        }
        const prior = defaults.get(p.kind);
        if (prior !== undefined) {
          throw new Error(
            `multiple default policies for kind '${p.kind}': '${prior}' and '${p.id}'`,
          );
        }
        defaults.set(p.kind, p.id);
      } else if (p.match.labels.length === 0) {
        throw new Error(
          `non-default policy '${p.id}' must have non-empty match.labels (missing default: true?)`,
        );
      }
    }
  }

  byId(id: string): Policy {
    const p = this.ids.get(id);
    if (!p) throw new Error(`unknown policy id '${id}'`);
    return p;
  }

  match(kind: string, labels: string[]): Policy {
    return matchPolicy(this.policies, kind, labels);
  }
}
