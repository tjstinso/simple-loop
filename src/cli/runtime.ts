import type Database from 'better-sqlite3';
import { FOLLOWUPS_DDL } from '../engines/software/followups.js';
import { ExecGitPorts } from '../engines/software/git-ports.js';
import { GhCliHost } from '../engines/software/github.js';
import { createSoftwareEngine } from '../engines/software/index.js';
import { secretEnvValues } from '../engines/software/secret-scan.js';
import { GitWorkspaceProvider } from '../engines/software/workspace.js';
import { migrate, openDb } from '../kernel/db.js';
import { EngineRegistry } from '../kernel/engine-registry.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import type { Policy } from '../policy/schema.js';
import { loadPolicies, PolicyStore } from '../policy/store.js';
import { ClaudeCliRunner } from '../runner/claude-cli.js';
import { RunnerRegistry } from '../runner/registry.js';
import type { FactoryConfig } from './config.js';

export interface Runtime {
  kernel: Kernel;
  db: Database.Database;
  defaultEngine: string;
  close(): void;
}

/** The variable names the claude-cli policies forward to the agent with `passEnv`. */
function passEnvNames(policies: readonly Policy[]): string[] {
  const names = new Set<string>();
  for (const p of policies) {
    if (p.runner !== 'claude-cli') continue;
    const passEnv = (p.config as { passEnv?: unknown } | null | undefined)?.passEnv;
    if (Array.isArray(passEnv)) for (const n of passEnv) if (typeof n === 'string') names.add(n);
  }
  return [...names];
}

/** The production composition root. Not used by tests. */
export function buildRuntime(config: FactoryConfig): Runtime {
  const clock = () => Date.now();
  const db = openDb(config.dbPath);
  try {
    migrate(db, [FOLLOWUPS_DDL]);
    const policies = new PolicyStore(loadPolicies(config.policiesDir));
    const forwarded = passEnvNames(policies.all());
    const runners = new RunnerRegistry();
    runners.register(new ClaudeCliRunner());
    const workspaces = new GitWorkspaceProvider({
      cloneUrlFor: (repo) => config.cloneUrlTemplate.replace('{repo}', repo),
      root: config.workspaceRoot,
      keepOnFailure: config.keepWorktreeOnFailure,
    });
    const engine = createSoftwareEngine({
      db,
      host: new GhCliHost(),
      git: new ExecGitPorts({ prepareForPush: (ws) => workspaces.sanitizeForPush(ws) }),
      workspaces,
      policies,
      config: {
        defaultProfile: config.defaultProfile,
        requiredSections: config.requiredSections,
        historyRetentionDays: config.historyRetentionDays,
        keptWorktreeMaxAgeMs: config.keptWorktreeMaxAgeMs,
        allowedAuthorAssociations: config.allowedAuthorAssociations,
        maxHumanRounds: config.maxHumanRounds,
      },
      now: clock,
      // The secret guard's exact values, read at each push: the model API key, every variable whose
      // name looks secret, and the claude-cli policies' passEnv variables.
      secretValues: () => secretEnvValues(process.env, forwarded),
    });
    const engines = new EngineRegistry();
    engines.register(engine);
    const kernel = createKernel({
      db,
      engines,
      runners,
      policies,
      clock,
      onError: (err, context) => console.error(`error: ${context}: ${err instanceof Error ? err.message : String(err)}`),
      config: {
        leaseMs: 300_000,
        heartbeatMs: 30_000,
        maxDeliveries: 3,
        historyRetentionDays: config.historyRetentionDays,
      },
    });
    return { kernel, db, defaultEngine: config.defaultEngine, close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}
