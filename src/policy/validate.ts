import type { EngineRegistry } from '../kernel/engine-registry.js';
import type { RunnerRegistry } from '../runner/registry.js';
import type { Policy } from './schema.js';

/**
 * Startup check (spec section 6): every policy's `kind` is declared by a registered engine's
 * `policyKinds`, its `runner` is registered, and its `config` passes that runner's `configSchema`.
 * Throws one error listing every problem, each naming the policy id; returns quietly otherwise.
 */
export function validatePolicies(policies: Policy[], engines: EngineRegistry, runners: RunnerRegistry): void {
  const kinds = new Set(engines.ids().flatMap((id) => engines.get(id).policyKinds));
  const problems: string[] = [];
  for (const p of policies) {
    if (!kinds.has(p.kind)) {
      problems.push(
        `policy '${p.id}': kind '${p.kind}' is not declared by any registered engine (known kinds: ${[...kinds].sort().join(', ') || 'none'})`,
      );
    }
    if (!runners.has(p.runner)) {
      problems.push(`policy '${p.id}': unknown runner '${p.runner}'`);
      continue;
    }
    const checked = runners.get(p.runner).configSchema.safeParse(p.config);
    if (!checked.success) {
      const detail = checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      problems.push(`policy '${p.id}': invalid config for runner '${p.runner}': ${detail}`);
    }
  }
  if (problems.length > 0) throw new Error(`invalid policies: ${problems.join('; ')}`);
}
