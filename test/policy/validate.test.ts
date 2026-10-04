import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FOLLOWUPS_DDL } from '../../src/engines/software/followups.js';
import { ExecGitPorts } from '../../src/engines/software/git-ports.js';
import { createSoftwareEngine } from '../../src/engines/software/index.js';
import { GitWorkspaceProvider } from '../../src/engines/software/workspace.js';
import { migrate, openDb } from '../../src/kernel/db.js';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { createKernel } from '../../src/kernel/kernel.js';
import type { Engine } from '../../src/kernel/types.js';
import type { Policy } from '../../src/policy/schema.js';
import { loadPolicies, PolicyStore } from '../../src/policy/store.js';
import { validatePolicies } from '../../src/policy/validate.js';
import { ClaudeCliRunner } from '../../src/runner/claude-cli.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import { FakeGitHost } from '../support/fake-github.js';

const engineWithKinds = (id: string, policyKinds: string[]) => ({ id, policyKinds }) as unknown as Engine<any>;

function registries() {
  const engines = new EngineRegistry();
  engines.register(engineWithKinds('software', ['execute', 'review']));
  const runners = new RunnerRegistry();
  runners.register({ name: 'strict', configSchema: z.object({ prompt: z.string() }), run: async () => ({}) });
  return { engines, runners };
}
const pol = (over: Partial<Policy>): Policy => ({
  id: 'p1', kind: 'execute', match: { labels: [] }, runner: 'strict', config: { prompt: 'x' }, default: true, ...over,
});

describe('validatePolicies', () => {
  it('accepts policies whose kind, runner and config are all valid', () => {
    const { engines, runners } = registries();
    expect(() => validatePolicies([pol({}), pol({ id: 'p2', kind: 'review' })], engines, runners)).not.toThrow();
  });

  it('rejects a kind that no registered engine declares, naming the policy', () => {
    const { engines, runners } = registries();
    expect(() => validatePolicies([pol({ id: 'odd', kind: 'deploy' })], engines, runners)).toThrow(
      /policy 'odd'.*kind 'deploy' is not declared by any registered engine/,
    );
  });

  it('rejects a runner that is not registered, naming the policy', () => {
    const { engines, runners } = registries();
    expect(() => validatePolicies([pol({ id: 'r1', runner: 'nope' })], engines, runners)).toThrow(/policy 'r1'.*unknown runner 'nope'/);
  });

  it("rejects a config that fails the runner's configSchema, naming the policy and the field", () => {
    const { engines, runners } = registries();
    expect(() => validatePolicies([pol({ id: 'c1', config: { prompt: 3 } })], engines, runners)).toThrow(
      /policy 'c1'.*invalid config for runner 'strict'.*prompt/,
    );
  });

  it('createKernel validates its policies before it opens anything', () => {
    const { engines, runners } = registries();
    expect(() =>
      createKernel({
        dbPath: ':memory:', engines, runners, policies: new PolicyStore([pol({ id: 'bad', runner: 'nope' })]),
        clock: () => 1, config: { leaseMs: 1, heartbeatMs: 1, maxDeliveries: 1 },
      }),
    ).toThrow(/policy 'bad'/);
  });

  it('the shipped policy files pass against the software engine and the claude-cli runner', () => {
    const db = openDb(':memory:');
    try {
      migrate(db, [FOLLOWUPS_DDL]);
      const policies = loadPolicies(join(import.meta.dirname, '../../policies'));
      const engines = new EngineRegistry();
      engines.register(
        createSoftwareEngine({
          db, host: new FakeGitHost(), git: new ExecGitPorts(),
          workspaces: new GitWorkspaceProvider({ cloneUrlFor: (r) => r, root: '/nonexistent', keepOnFailure: true }),
          policies: new PolicyStore(policies), config: { defaultProfile: 'supervised', requiredSections: [] }, now: () => 1,
        }),
      );
      const runners = new RunnerRegistry();
      runners.register(new ClaudeCliRunner());
      expect(policies.map((p) => p.id).sort()).toEqual(['software-execute', 'software-review']);
      expect(() => validatePolicies(policies, engines, runners)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a malformed claude-cli pluginDirs at startup, naming the policy and the field', () => {
    const engines = new EngineRegistry();
    engines.register(engineWithKinds('software', ['execute']));
    const runners = new RunnerRegistry();
    runners.register(new ClaudeCliRunner());
    const base = { prompt: 'x', allowedTools: ['Read'], maxBudgetUsd: 1, timeoutMs: 1000, inactivityTimeoutMs: 1000, resultFormat: 'json' };
    const mk = (pluginDirs: unknown) => pol({ id: 'pd', runner: 'claude-cli', config: { ...base, pluginDirs } });
    expect(() => validatePolicies([mk(['tools/ts-lsp'])], engines, runners)).not.toThrow();
    for (const bad of ['tools/ts-lsp', [3], ['']]) {
      expect(() => validatePolicies([mk(bad)], engines, runners)).toThrow(/policy 'pd'.*pluginDirs/);
    }
  });
});
