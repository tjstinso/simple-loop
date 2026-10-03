import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  dbPath: z.string().min(1).default('./factory.db'),
  policiesDir: z.string().min(1).default('./policies'),
  workspaceRoot: z.string().min(1).default('./.factory/workspaces'),
  defaultEngine: z.string().min(1).default('software'),
  defaultProfile: z.enum(['supervised', 'automatic']).default('supervised'),
  requiredSections: z.array(z.string()).default(['## Goal', '## Acceptance criteria']),
  historyRetentionDays: z.number().positive().default(30),
  keepWorktreeOnFailure: z.boolean().default(true),
  keptWorktreeMaxAgeMs: z.number().nonnegative().default(604_800_000),
  cloneUrlTemplate: z.string().min(1).default('https://github.com/{repo}.git'),
});

export type FactoryConfig = z.infer<typeof ConfigSchema>;

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
  return {
    ...c,
    dbPath: resolve(baseDir, c.dbPath),
    policiesDir: resolve(baseDir, c.policiesDir),
    workspaceRoot: resolve(baseDir, c.workspaceRoot),
  };
}
