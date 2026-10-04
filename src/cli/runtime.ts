import type Database from 'better-sqlite3';
import { FOLLOWUPS_DDL } from '../engines/software/followups.js';
import { ExecGitPorts, FACTORY_GIT_EMAIL, FACTORY_GIT_NAME } from '../engines/software/git-ports.js';
import { GhCliHost } from '../engines/software/github.js';
import { createLazyGithubAuth, verifyLogin, type GithubAuth, type LazyGithubAuth } from '../engines/software/identity.js';
import { createSoftwareEngine } from '../engines/software/index.js';
import { secretEnvValues } from '../engines/software/secret-scan.js';
import { GitWorkspaceProvider } from '../engines/software/workspace.js';
import { migrate, openDb } from '../kernel/db.js';
import { EngineRegistry } from '../kernel/engine-registry.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import type { Policy } from '../policy/schema.js';
import { resolvePolicies, type EffectivePolicy } from '../policy/resolve.js';
import { PolicyStore } from '../policy/store.js';
import { ClaudeCliRunner } from '../runner/claude-cli.js';
import { RunnerRegistry } from '../runner/registry.js';
import type { FactoryConfig } from './config.js';

export interface Runtime {
  kernel: Kernel;
  db: Database.Database;
  defaultEngine: string;
  /** The policies in effect (name, source and merged value), for `factory policies`. */
  effectivePolicies?: EffectivePolicy[];
  /** Reads the GitHub token and creates the auth directory now; throws when the token is missing. A no-op without `github.tokenEnv`. */
  requireGithub?(): void;
  /** Checks the factory's GitHub identity (the token's login against `github.expectLogin`); run at worker start. */
  verifyIdentity?(): Promise<void>;
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
  let lazy: LazyGithubAuth | undefined;
  try {
    migrate(db, [FOLLOWUPS_DDL]);
    const effectivePolicies = resolvePolicies({
      policiesDir: config.policiesDir,
      shippedPolicies: config.shippedPolicies,
      policyOverrides: config.policyOverrides,
    });
    const policies = new PolicyStore(effectivePolicies.map((e) => e.policy));
    const forwarded = passEnvNames(policies.all());
    const gh = config.github;
    const tokenEnv = gh?.tokenEnv;
    let auth: GithubAuth | undefined;
    if (tokenEnv !== undefined) {
      lazy = createLazyGithubAuth(tokenEnv, process.env);
      auth = lazy.auth;
    }
    const identity =
      gh?.commitName !== undefined || gh?.commitEmail !== undefined
        ? { name: gh.commitName ?? FACTORY_GIT_NAME, email: gh.commitEmail ?? FACTORY_GIT_EMAIL }
        : undefined;
    const runners = new RunnerRegistry();
    runners.register(new ClaudeCliRunner(tokenEnv === undefined ? {} : { withheldEnv: [tokenEnv] }));
    const workspaces = new GitWorkspaceProvider({
      ...(auth === undefined ? {} : { auth }),
      ...(identity === undefined ? {} : { identity }),
      cloneUrlFor: (repo) => config.cloneUrlTemplate.replace('{repo}', repo),
      root: config.workspaceRoot,
      keepOnFailure: config.keepWorktreeOnFailure,
    });
    const host = new GhCliHost(auth === undefined ? {} : { auth });
    const engine = createSoftwareEngine({
      db,
      host,
      git: new ExecGitPorts({
        ...(auth === undefined ? {} : { auth }),
        ...(identity === undefined ? {} : { identity }),
        prepareForPush: (ws) => workspaces.sanitizeForPush(ws),
      }),
      workspaces,
      policies,
      config: {
        defaultProfile: config.defaultProfile,
        requiredSections: config.requiredSections,
        historyRetentionDays: config.historyRetentionDays,
        keptWorktreeMaxAgeMs: config.keptWorktreeMaxAgeMs,
        allowedAuthorAssociations: config.allowedAuthorAssociations,
        maxHumanRounds: config.maxHumanRounds,
        maxConflictRounds: config.maxConflictRounds,
      },
      now: clock,
      onError: (err, context) => console.error(`error: ${context}: ${err instanceof Error ? err.message : String(err)}`),
      // The secret guard's exact values, read at each push: the model API key, every variable whose
      // name looks secret, the claude-cli policies' passEnv variables and the factory's GitHub token.
      secretValues: () => secretEnvValues(process.env, tokenEnv === undefined ? forwarded : [...forwarded, tokenEnv]),
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
    const expectLogin = gh?.expectLogin;
    return {
      kernel,
      db,
      defaultEngine: config.defaultEngine,
      effectivePolicies,
      ...(lazy !== undefined ? { requireGithub: () => void lazy?.ensure() } : {}),
      ...(auth !== undefined && expectLogin !== undefined ? { verifyIdentity: () => verifyLogin(host, expectLogin) } : {}),
      close: () => {
        lazy?.dispose();
        db.close();
      },
    };
  } catch (e) {
    lazy?.dispose();
    db.close();
    throw e;
  }
}
