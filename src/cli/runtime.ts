import type Database from 'better-sqlite3';
import { FOLLOWUPS_DDL } from '../engines/software/followups.js';
import { ExecGitPorts } from '../engines/software/git-ports.js';
import { GhCliHost } from '../engines/software/github.js';
import { createSoftwareEngine } from '../engines/software/index.js';
import { GitWorkspaceProvider } from '../engines/software/workspace.js';
import { migrate, openDb } from '../kernel/db.js';
import { EngineRegistry } from '../kernel/engine-registry.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
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

/** The production composition root. Not used by tests. */
export function buildRuntime(config: FactoryConfig): Runtime {
  const clock = () => Date.now();
  const db = openDb(config.dbPath);
  try {
    migrate(db, [FOLLOWUPS_DDL]);
    const policies = new PolicyStore(loadPolicies(config.policiesDir));
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
      git: new ExecGitPorts(),
      workspaces,
      policies,
      config: {
        defaultProfile: config.defaultProfile,
        requiredSections: config.requiredSections,
        historyRetentionDays: config.historyRetentionDays,
        keptWorktreeMaxAgeMs: config.keptWorktreeMaxAgeMs,
      },
      now: clock,
    });
    const engines = new EngineRegistry();
    engines.register(engine);
    const kernel = createKernel({
      db,
      engines,
      runners,
      policies,
      clock,
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
