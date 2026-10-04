import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/cli/config.js';

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
      maxHumanRounds: 5,
      cloneUrlTemplate: 'https://github.com/{repo}.git',
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

  it('example config file parses to the defaults', () => {
    const d = tmp();
    const example = readFileSync(join(import.meta.dirname, '../../factory.config.example.json'), 'utf8');
    writeFileSync(join(d, 'factory.config.json'), example);
    expect(loadConfig(join(d, 'factory.config.json'), d)).toEqual(loadConfig(undefined, d));
  });
});
