import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deprecationWarnings, resolveBreakers, loadConfig } from '../../src/cli/config.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-cfg-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads defaults when no file exists', () => {
    const d = tmp();
    const c = loadConfig(undefined, d);
    expect(c).toEqual({
      dbPath: join(d, 'factory.db'),
      shippedPolicies: true,
      workspaceRoot: join(d, '.factory/workspaces'),
      defaultEngine: 'software',
      defaultProfile: 'supervised',
      requiredSections: ['## Goal', '## Acceptance criteria'],
      historyRetentionDays: 30,
      keepWorktreeOnFailure: true,
      keptWorktreeMaxAgeMs: 604800000,
      allowedAuthorAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      chainBudgetUsd: 25,
      leaseMs: 300000,
      heartbeatMs: 30000,
      maintenanceMs: 60000,
      maxDeliveries: 3,
      maxTransientRetries: 8,
      cloneUrlTemplate: 'https://github.com/{repo}.git',
      models: { allowed: ['haiku', 'sonnet'], byLabel: { 'factory:followup': 'haiku' } },
    });
  });

  it('resolves relative paths against the config file directory and makes the workspace root absolute', () => {
    const d = tmp();
    const sub = join(d, 'conf');
    mkdirSync(sub);
    writeFileSync(
      join(sub, 'my.json'),
      JSON.stringify({ dbPath: 'data/f.db', workspaceRoot: 'ws', policiesDir: '/abs/policies' }),
    );
    const c = loadConfig(join(sub, 'my.json'), d);
    expect(c.dbPath).toBe(resolve(sub, 'data/f.db'));
    expect(c.workspaceRoot).toBe(join(sub, 'ws'));
    expect(isAbsolute(c.workspaceRoot)).toBe(true);
    expect(c.policiesDir).toBe('/abs/policies');
  });

  it('accepts policiesDir, shippedPolicies and policyOverrides', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'factory.config.json'),
      JSON.stringify({ policiesDir: 'p', shippedPolicies: false, policyOverrides: { a: { config: { bare: false } } } }),
    );
    const c = loadConfig(undefined, d);
    expect(c.policiesDir).toBe(join(d, 'p'));
    expect(c.shippedPolicies).toBe(false);
    expect(c.policyOverrides).toEqual({ a: { config: { bare: false } } });
  });

  it('rejects an override of kind or match, naming the key', () => {
    const d = tmp();
    for (const key of ['kind', 'match']) {
      writeFileSync(
        join(d, 'factory.config.json'),
        JSON.stringify({ policyOverrides: { 'software-execute': { [key]: 'x' } } }),
      );
      expect(() => loadConfig(undefined, d)).toThrow(new RegExp(`policyOverrides\\.software-execute\\.${key}`));
    }
  });

  it('requires policiesDir when shippedPolicies is false', () => {
    const d = tmp();
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify({ shippedPolicies: false }));
    expect(() => loadConfig(undefined, d)).toThrow(/policiesDir/);
  });

  it('rejects an invalid config naming the field', () => {
    const d = tmp();
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify({ defaultProfile: 'reckless' }));
    expect(() => loadConfig(undefined, d)).toThrow(/defaultProfile/);
    writeFileSync(join(d, 'factory.config.json'), '{ not json');
    expect(() => loadConfig(undefined, d)).toThrow(/factory\.config\.json/);
  });

  describe('concurrency and timing keys', () => {
    const load = (cfg: unknown) => {
      const d = tmp();
      writeFileSync(join(d, 'factory.config.json'), JSON.stringify(cfg));
      return loadConfig(undefined, d);
    };

    it('accepts them and leaves maxConcurrentJobs unset by default', () => {
      expect(load({}).maxConcurrentJobs).toBeUndefined();
      expect(load({ maxConcurrentJobs: 2, leaseMs: 20_000, heartbeatMs: 5_000, maintenanceMs: 5_000, maxDeliveries: 1 })).toMatchObject({
        maxConcurrentJobs: 2, leaseMs: 20_000, heartbeatMs: 5_000, maintenanceMs: 5_000, maxDeliveries: 1,
      });
    });

    it('rejects values below the minimums, naming the key', () => {
      for (const [key, value] of [
        ['maxConcurrentJobs', 0], ['maxConcurrentJobs', 1.5], ['leaseMs', 9_999], ['heartbeatMs', 999],
        ['maintenanceMs', 4_999], ['maxDeliveries', 0], ['maxTransientRetries', 0],
      ] as const) {
        expect(() => load({ [key]: value }), `${key}=${value}`).toThrow(new RegExp(key));
      }
    });

    it('rejects a heartbeat that is not smaller than half the lease, naming both keys', () => {
      expect(() => load({ leaseMs: 20_000, heartbeatMs: 10_000 })).toThrow(/heartbeatMs.*leaseMs/);
      expect(() => load({ leaseMs: 20_000, heartbeatMs: 9_999 })).not.toThrow();
      expect(() => load({ heartbeatMs: 150_000 })).toThrow(/heartbeatMs.*leaseMs/);
    });

    it('still ignores unknown keys', () => {
      expect(load({ maxConcurrentJob: 1 }).maxConcurrentJobs).toBeUndefined();
    });
  });

  describe('unknown keys', () => {
    const load = (cfg: unknown, warn: (l: string) => void) => {
      const d = tmp();
      writeFileSync(join(d, 'factory.config.json'), JSON.stringify(cfg));
      return loadConfig(undefined, d, warn);
    };

    it('warns and still loads when warnUnknownKeys is not set or false', () => {
      for (const extra of [{}, { warnUnknownKeys: false }]) {
        const lines: string[] = [];
        const c = load({ maxConcurrentJob: 1, other: true, ...extra }, (l) => lines.push(l));
        expect(lines).toEqual(['Unknown config keys: maxConcurrentJob, other']);
        expect(c.maxConcurrentJobs).toBeUndefined();
      }
    });

    it('throws naming the keys when warnUnknownKeys is true', () => {
      const lines: string[] = [];
      expect(() => load({ maxConcurrentJob: 1, warnUnknownKeys: true }, (l) => lines.push(l))).toThrow(/Unknown config keys: maxConcurrentJob/);
      expect(lines).toEqual([]);
    });

    it('does not warn when all keys are known', () => {
      const lines: string[] = [];
      load({ maxConcurrentJobs: 1, warnUnknownKeys: true }, (l) => lines.push(l));
      expect(lines).toEqual([]);
    });
  });

  it('example config file parses to the defaults', () => {
    const d = tmp();
    const example = readFileSync(join(import.meta.dirname, '../../factory.config.example.json'), 'utf8');
    writeFileSync(join(d, 'factory.config.json'), example);
    expect(loadConfig(join(d, 'factory.config.json'), d)).toEqual(loadConfig(undefined, d));
  });
});

describe('loadConfig repos', () => {
  const load = (repos: unknown) => {
    const d = tmp();
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify({ repos }));
    return () => loadConfig(undefined, d);
  };

  it('applies the defaults of an entry', () => {
    const c = load({ 'o/r': { setup: [['npm', 'ci', '--ignore-scripts']], verify: [['npm', 'test']] } })();
    expect(c.repos?.['o/r']).toEqual({
      setup: [['npm', 'ci', '--ignore-scripts']],
      verify: [['npm', 'test']],
      setupTimeoutMs: 300_000,
      verifyTimeoutMs: 600_000,
      maxVerifyRounds: 3,
      verifyBaseline: true,
    });
    expect(load({ 'o/r': { verify: [['npm', 'test']], verifyBaseline: false } })().repos?.['o/r']?.verifyBaseline).toBe(false);
  });

  it('rejects unknown keys, bad commands, a bad name and maxVerifyRounds below 1', () => {
    expect(load({ 'o/r': { setpu: [] } })).toThrow(/repos\.o\/r/);
    expect(load({ 'o/r': { verify: ['npm test'] } })).toThrow(/repos/);
    expect(load({ 'o/r': { verify: [[]] } })).toThrow(/repos/);
    expect(load({ 'o/r': { verify: [['npm', '']] } })).toThrow(/repos/);
    expect(load({ 'o/r': { maxVerifyRounds: 0 } })).toThrow(/maxVerifyRounds/);
    expect(load({ 'noslash': {} })).toThrow(/repos\.noslash/);
  });
});

describe('breaker settings', () => {
  const load = (cfg: object) => {
    const d = tmp();
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify(cfg));
    return loadConfig(undefined, d);
  };

  it('defaults chainBudgetUsd to 25 and refuses less than 1', () => {
    expect(load({}).chainBudgetUsd).toBe(25);
    expect(() => load({ chainBudgetUsd: 0.5 })).toThrow(/chainBudgetUsd/);
  });

  it('takes failureThreshold, cooldownMs and maxOpens per class and refuses unknown keys', () => {
    const c = load({ breakers: { ci: { failureThreshold: 4, cooldownMs: 1000, maxOpens: 2 } } });
    expect(resolveBreakers(c).ci).toEqual({ failureThreshold: 4, cooldownMs: 1000, maxOpens: 2 });
    expect(() => load({ breakers: { nope: {} } })).toThrow();
  });

  it('the deprecated max*Rounds settings are aliases for failureThreshold, with a warning naming the replacement', () => {
    const c = load({ maxConflictRounds: 4, maxCiRounds: 5, maxHumanRounds: 6, breakers: { ci: { failureThreshold: 9 } } });
    expect(deprecationWarnings(c)).toEqual([
      expect.stringContaining('breakers.conflict.failureThreshold'),
      expect.stringContaining('breakers.ci.failureThreshold'),
      expect.stringContaining('breakers.human.failureThreshold'),
    ]);
    const b = resolveBreakers(c);
    expect(b.conflict).toEqual({ failureThreshold: 4 });
    expect(b.human).toEqual({ failureThreshold: 6 });
    // An explicit breakers value wins over the alias.
    expect(b.ci).toEqual({ failureThreshold: 9 });
    expect(deprecationWarnings(load({}))).toEqual([]);
  });
});

describe('intake block', () => {
  const load = (intake?: unknown) => {
    const d = tmp();
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify(intake === undefined ? {} : { intake }));
    return loadConfig(undefined, d);
  };

  it('is absent without the block', () => {
    expect(load().intake).toBeUndefined();
  });

  it('applies the defaults', () => {
    expect(load({ repos: ['o/r'] }).intake).toEqual({
      repos: ['o/r'],
      readyLabel: 'factory:ready',
      pollIntervalMs: 60_000,
      maxOpenChains: 2,
      allowedAuthorAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    });
  });

  it('accepts overrides', () => {
    const c = load({ repos: ['o/r', 'a/b'], readyLabel: 'go', pollIntervalMs: 5000, maxOpenChains: 1, allowedAuthorAssociations: ['OWNER'] });
    expect(c.intake).toMatchObject({ readyLabel: 'go', pollIntervalMs: 5000, maxOpenChains: 1, allowedAuthorAssociations: ['OWNER'] });
  });

  it.each([
    [{ repos: [] }],
    [{ repos: ['nope'] }],
    [{ repos: ['o/r'], pollIntervalMs: 4999 }],
    [{ repos: ['o/r'], maxOpenChains: 0 }],
    [{ repos: ['o/r'], extra: 1 }],
    [{}],
  ])('rejects %j', (intake) => {
    expect(() => load(intake)).toThrow(/invalid config/);
  });
});

describe('models block', () => {
  const load = (models?: unknown) => {
    const d = tmp();
    writeFileSync(join(d, 'factory.config.json'), JSON.stringify(models === undefined ? {} : { models }));
    return loadConfig(undefined, d).models;
  };

  it('defaults to haiku and sonnet, with factory:followup on haiku', () => {
    expect(load()).toEqual({ allowed: ['haiku', 'sonnet'], byLabel: { 'factory:followup': 'haiku' } });
    expect(load({ allowed: ['haiku', 'opus'] }).byLabel).toEqual({ 'factory:followup': 'haiku' });
  });

  it('accepts a custom allowlist and map', () => {
    const models = { allowed: ['haiku', 'opus'], byLabel: { 'size:small': 'haiku', 'size:large': 'opus' } };
    expect(load(models)).toEqual(models);
  });

  it('rejects a byLabel value outside allowed, naming the key', () => {
    expect(() => load({ allowed: ['haiku'], byLabel: { 'size:large': 'opus' } })).toThrow(/models\.byLabel\.size:large/);
  });

  it('rejects an unknown key and a malformed alias', () => {
    expect(() => load({ extra: 1 })).toThrow(/models/);
    expect(() => load({ allowed: ['--bad'] })).toThrow(/models\.allowed/);
  });
});
