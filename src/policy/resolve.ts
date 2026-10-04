import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDACTED, redactSecrets, SECRET_ENV_NAME } from '../engines/software/secret-scan.js';
import { PolicySchema, type Policy } from './schema.js';
import { loadNamedPolicies } from './store.js';

/** The keys of a policy an override may change. */
export const OVERRIDABLE_KEYS = ['runner', 'config'] as const;

export type PolicySource = 'shipped' | 'directory' | 'overridden';

export interface EffectivePolicy {
  name: string;
  source: PolicySource;
  policy: Policy;
}

export interface ResolveOptions {
  /** Directory of policy files; absent means none. */
  policiesDir?: string | undefined;
  /** Load the policies that ship with the package first (default true). */
  shippedPolicies?: boolean | undefined;
  /** Partial policies keyed by policy name. */
  policyOverrides?: Record<string, Record<string, unknown>> | undefined;
  /** Where the shipped policies live; defaults to the package's own `policies/` directory. */
  shippedDir?: string | undefined;
}

/** The first key of `override` that may not be overridden, or undefined. */
export function forbiddenOverrideKey(override: Record<string, unknown>): string | undefined {
  return Object.keys(override).find((k) => !(OVERRIDABLE_KEYS as readonly string[]).includes(k));
}

/** The package's `policies/` directory, found from this module's location (not the current directory). */
export function shippedPoliciesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
      if (name === 'software-factory') return join(dir, 'policies');
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('cannot locate the shipped policies directory');
    dir = parent;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; scalars and arrays in `over` replace the value in `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

/**
 * The effective policies: shipped (unless disabled), then `policiesDir` files (a file of the same
 * name replaces a shipped one whole), then `policyOverrides` merged over the result and validated
 * with the policy schema. Throws an error naming the policy and key on any problem.
 */
export function resolvePolicies(opts: ResolveOptions): EffectivePolicy[] {
  const byName = new Map<string, EffectivePolicy>();
  if (opts.shippedPolicies !== false) {
    for (const { name, policy } of loadNamedPolicies(opts.shippedDir ?? shippedPoliciesDir())) {
      byName.set(name, { name, source: 'shipped', policy });
    }
  }
  if (opts.policiesDir !== undefined) {
    for (const { name, policy } of loadNamedPolicies(opts.policiesDir)) {
      byName.set(name, { name, source: 'directory', policy });
    }
  }
  for (const [name, override] of Object.entries(opts.policyOverrides ?? {})) {
    const target = byName.get(name);
    if (!target) {
      throw new Error(
        `policyOverrides.${name}: no policy named '${name}' (known: ${[...byName.keys()].sort().join(', ') || 'none'})`,
      );
    }
    const bad = forbiddenOverrideKey(override);
    if (bad !== undefined) {
      throw new Error(`policyOverrides.${name}.${bad}: only ${OVERRIDABLE_KEYS.join(' and ')} may be overridden`);
    }
    const merged = deepMerge(target.policy, override);
    const res = PolicySchema.safeParse(merged);
    if (!res.success) {
      const detail = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`policy '${name}' after policyOverrides: ${detail}`);
    }
    byName.set(name, { name, source: 'overridden', policy: res.data });
  }
  return [...byName.values()];
}

/** `value` with secret-looking strings (token shapes, values under secret-looking keys) redacted. */
export function redactConfig(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return SECRET_ENV_NAME.test(key) ? REDACTED : redactSecrets(value, []);
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, key));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactConfig(v, k)]));
  return value;
}

/** The lines `factory policies` prints for one policy. */
export function describePolicy(e: EffectivePolicy): string[] {
  const p = e.policy;
  const config = JSON.stringify(redactConfig(p.config), null, 2).split('\n');
  return [
    `${e.name} source=${e.source} kind=${p.kind} labels=${p.match.labels.length === 0 ? '(none)' : p.match.labels.join(',')}`,
    `  runner: ${p.runner}`,
    '  config:',
    ...config.map((l) => `    ${l}`),
  ];
}
