import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PolicySchema, type Policy } from './schema.js';
import { matchPolicy } from './matcher.js';

export { AmbiguousMatchError, NoPolicyError } from './matcher.js';

/** The label prefix that selects a model for a chain's execute and review runs. */
export const MODEL_LABEL_PREFIX = 'factory:model:';

/** Which models labels may select: the allowed aliases and the labels that select one by default. */
export interface ModelSelection {
  allowed: string[];
  byLabel: Record<string, string>;
}

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  allowed: ['haiku', 'sonnet'],
  byLabel: { 'factory:followup': 'haiku' },
};

export interface NamedPolicy {
  /** The file name without its extension. */
  name: string;
  policy: Policy;
}

export function loadPolicies(dir: string): Policy[] {
  return loadNamedPolicies(dir).map((n) => n.policy);
}

export function loadNamedPolicies(dir: string): NamedPolicy[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  const policies: NamedPolicy[] = [];
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
    policies.push({ name: file.slice(0, -'.yaml'.length), policy: res.data });
  }
  return policies;
}

export class PolicyStore {
  private readonly policies: Policy[];
  private readonly ids = new Map<string, Policy>();

  private readonly models: ModelSelection;

  constructor(policies: Policy[], models: ModelSelection = DEFAULT_MODEL_SELECTION) {
    this.policies = policies;
    this.models = models;
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

  /** Every policy, in load order. */
  all(): Policy[] {
    return [...this.policies];
  }

  byId(id: string): Policy {
    const p = this.ids.get(id);
    if (!p) throw new Error(`unknown policy id '${id}'`);
    return p;
  }

  /**
   * The policy for `kind` and `labels`. For a `claude-cli` policy, `config.model` is replaced by the
   * model the labels choose (a copy: the stored policy is not changed): a `factory:model:<alias>`
   * label, else the first `models.byLabel` entry whose label is present, else the policy's own.
   */
  match(kind: string, labels: string[]): Policy {
    return this.withModel(matchPolicy(this.policies, kind, labels), labels);
  }

  /** The stored policy `id`, with the model its chain's `labels` choose (see `match`). */
  forLabels(id: string, labels: string[]): Policy {
    return this.withModel(this.byId(id), labels);
  }

  private withModel(policy: Policy, labels: string[]): Policy {
    if (policy.runner !== 'claude-cli') return policy;
    const model = this.chooseModel(labels);
    if (model === undefined) return policy;
    const config = typeof policy.config === 'object' && policy.config !== null ? policy.config : {};
    return { ...policy, config: { ...config, model } };
  }

  private chooseModel(labels: string[]): string | undefined {
    const explicit = [...new Set(labels.filter((l) => l.startsWith(MODEL_LABEL_PREFIX)))];
    if (explicit.length > 1) throw new Error(`multiple model labels: ${explicit.join(', ')}`);
    if (explicit.length === 1) {
      const alias = explicit[0]!.slice(MODEL_LABEL_PREFIX.length);
      if (!this.models.allowed.includes(alias)) {
        throw new Error(`model "${alias}" is not allowed (allowed: ${this.models.allowed.join(', ')})`);
      }
      return alias;
    }
    const have = new Set(labels);
    for (const [label, model] of Object.entries(this.models.byLabel)) {
      if (have.has(label)) return model;
    }
    return undefined;
  }
}
