import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { forbiddenOverrideKey, OVERRIDABLE_KEYS } from '../policy/resolve.js';

const GithubSchema = z
  .object({
    tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name').optional(),
    expectLogin: z.string().min(1).optional(),
    commitName: z.string().min(1).optional(),
    commitEmail: z.string().min(1).optional(),
  })
  .refine((g) => g.tokenEnv === undefined || g.expectLogin !== undefined, {
    message: 'expectLogin is required when tokenEnv is set',
    path: ['expectLogin'],
  });

const CommandSchema = z.array(z.string().min(1)).min(1);

/** What one repository needs to be built and tested; commands are argument arrays, never shell strings. */
export const RepoToolSchema = z
  .object({
    setup: z.array(CommandSchema).optional(),
    verify: z.array(CommandSchema).optional(),
    setupTimeoutMs: z.number().int().min(1).default(300_000),
    verifyTimeoutMs: z.number().int().min(1).default(600_000),
    maxVerifyRounds: z.number().int().min(1).default(3),
    verifyBaseline: z.boolean().default(true),
  })
  .strict();
export type RepoToolConfig = z.infer<typeof RepoToolSchema>;

const BreakerConfigSchema = z
  .object({
    failureThreshold: z.number().int().min(1).optional(),
    cooldownMs: z.number().int().min(1).optional(),
    maxOpens: z.number().int().min(1).optional(),
  })
  .strict();

/** Automatic intake: which repositories to watch for ready issues and how much work to take on. */
export const IntakeSchema = z
  .object({
    repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name')).min(1),
    readyLabel: z.string().min(1).default('factory:ready'),
    pollIntervalMs: z.number().int().min(5_000).default(60_000),
    maxOpenChains: z.number().int().min(1).default(2),
    allowedAuthorAssociations: z.array(z.string().min(1)).default(['OWNER', 'MEMBER', 'COLLABORATOR']),
  })
  .strict();
export type IntakeConfig = z.infer<typeof IntakeSchema>;

const ConfigSchema = z.object({
  dbPath: z.string().min(1).default('./factory.db'),
  policiesDir: z.string().min(1).optional(),
  shippedPolicies: z.boolean().default(true),
  policyOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  workspaceRoot: z.string().min(1).default('./.factory/workspaces'),
  defaultEngine: z.string().min(1).default('software'),
  defaultProfile: z.enum(['supervised', 'automatic']).default('supervised'),
  requiredSections: z.array(z.string()).default(['## Goal', '## Acceptance criteria']),
  historyRetentionDays: z.number().positive().default(30),
  keepWorktreeOnFailure: z.boolean().default(true),
  keptWorktreeMaxAgeMs: z.number().nonnegative().default(604_800_000),
  allowedAuthorAssociations: z.array(z.string().min(1)).default(['OWNER', 'MEMBER', 'COLLABORATOR']),
  // Deprecated for one release: aliases for `breakers.<class>.failureThreshold` (see `deprecationWarnings`).
  maxHumanRounds: z.number().int().min(1).optional(),
  maxConflictRounds: z.number().int().min(1).optional(),
  maxCiRounds: z.number().int().min(1).optional(),
  breakers: z.object({
    conflict: BreakerConfigSchema.optional(),
    ci: BreakerConfigSchema.optional(),
    human: BreakerConfigSchema.optional(),
    review: BreakerConfigSchema.optional(),
  }).strict().optional(),
  chainBudgetUsd: z.number().min(1).default(25),
  maxConcurrentJobs: z.number().int().min(1).optional(),
  leaseMs: z.number().int().min(10_000).default(300_000),
  heartbeatMs: z.number().int().min(1_000).default(30_000),
  maintenanceMs: z.number().int().min(5_000).default(60_000),
  maxDeliveries: z.number().int().min(1).default(3),
  maxTransientRetries: z.number().int().min(1).default(8),
  cloneUrlTemplate: z.string().min(1).default('https://github.com/{repo}.git'),
  github: GithubSchema.optional(),
  intake: IntakeSchema.optional(),
  repos: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name'), RepoToolSchema).optional(),
}).superRefine((c, ctx) => {
  for (const [name, override] of Object.entries(c.policyOverrides ?? {})) {
    const bad = forbiddenOverrideKey(override);
    if (bad !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['policyOverrides', name, bad],
        message: `only ${OVERRIDABLE_KEYS.join(' and ')} may be overridden`,
      });
    }
  }
  if (c.heartbeatMs >= c.leaseMs / 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['heartbeatMs'],
      message: `must be smaller than half of leaseMs (heartbeatMs ${c.heartbeatMs}, leaseMs ${c.leaseMs})`,
    });
  }
  // The token reaches git only through an HTTPS URL and the askpass helper; no credentials in the URL.
  if (c.github?.tokenEnv !== undefined && !/^https:\/\/[^@/]+\//.test(c.cloneUrlTemplate)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cloneUrlTemplate'],
      message: 'must be an https:// URL without credentials when github.tokenEnv is set',
    });
  }
});

export type FactoryConfig = z.infer<typeof ConfigSchema>;

const DEPRECATED_ROUNDS = [
  ['maxConflictRounds', 'conflict'],
  ['maxCiRounds', 'ci'],
  ['maxHumanRounds', 'human'],
] as const;

/** One warning per deprecated setting that is present, naming the replacement. */
export function deprecationWarnings(c: Pick<FactoryConfig, 'maxConflictRounds' | 'maxCiRounds' | 'maxHumanRounds'>): string[] {
  return DEPRECATED_ROUNDS.filter(([key]) => c[key] !== undefined).map(
    ([key, cls]) => `config: ${key} is deprecated and will be removed; use breakers.${cls}.failureThreshold instead`,
  );
}

/** The breaker settings per class: `breakers`, with the deprecated `max*Rounds` as the threshold when it is not set there. */
export function resolveBreakers(c: FactoryConfig): NonNullable<FactoryConfig['breakers']> {
  const out: NonNullable<FactoryConfig['breakers']> = {};
  for (const [key, cls] of DEPRECATED_ROUNDS) {
    const explicit = c.breakers?.[cls] ?? {};
    const alias = c[key];
    out[cls] = { ...explicit, ...(explicit.failureThreshold === undefined && alias !== undefined ? { failureThreshold: alias } : {}) };
  }
  if (c.breakers?.review !== undefined) out.review = c.breakers.review;
  return out;
}

export const DEFAULT_CONFIG_FILE = 'factory.config.json';

/**
 * Load the config from `path`, or `factory.config.json` in `cwd`. A missing default file yields
 * the defaults; an explicit path that does not exist is an error. Relative paths resolve against
 * the config file's directory (the cwd when there is no file).
 */
export function loadConfig(path: string | undefined, cwd: string): FactoryConfig {
  const file = path === undefined ? resolve(cwd, DEFAULT_CONFIG_FILE) : resolve(cwd, path);
  let raw: unknown = {};
  let baseDir = cwd;
  if (existsSync(file)) {
    baseDir = dirname(file);
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config ${file}: ${(e as Error).message}`);
    }
  } else if (path !== undefined) {
    throw new Error(`config ${file}: file not found`);
  }
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    const detail = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid config ${file}: ${detail}`);
  }
  const c = res.data;
  // Before policiesDir was optional it defaulted to ./policies; keep reading that directory when it exists.
  const legacyDir = resolve(baseDir, 'policies');
  const policiesDir = c.policiesDir === undefined ? (existsSync(legacyDir) ? legacyDir : undefined) : resolve(baseDir, c.policiesDir);
  if (policiesDir === undefined && !c.shippedPolicies) {
    throw new Error(`invalid config ${file}: policiesDir: is required when shippedPolicies is false`);
  }
  return {
    ...c,
    dbPath: resolve(baseDir, c.dbPath),
    ...(policiesDir === undefined ? {} : { policiesDir }),
    workspaceRoot: resolve(baseDir, c.workspaceRoot),
  };
}
