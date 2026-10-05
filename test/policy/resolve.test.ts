import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import type { Engine } from '../../src/kernel/types.js';
import { validatePolicies } from '../../src/policy/validate.js';
import { ClaudeCliRunner } from '../../src/runner/claude-cli.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import { deepMerge, describePolicy, redactConfig, resolvePolicies, shippedPoliciesDir } from '../../src/policy/resolve.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'factory-resolve-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const yaml = (id: string, extra = '') =>
  `id: ${id}\nkind: execute\ndefault: true\nmatch:\n  labels: []\nrunner: claude-cli\nconfig:\n  bare: true\n${extra}`;
const find = (ps: ReturnType<typeof resolvePolicies>, name: string) => ps.find((p) => p.name === name)!;

describe('deepMerge', () => {
  it('merges nested objects, replaces arrays and scalars', () => {
    const base = { a: { x: 1, y: { z: 1, w: 2 } }, list: [1, 2], s: 'old' };
    const over = { a: { y: { z: 9 } }, list: [3], s: 'new', added: true };
    expect(deepMerge(base, over)).toEqual({ a: { x: 1, y: { z: 9, w: 2 } }, list: [3], s: 'new', added: true });
    expect(base.a.y.z).toBe(1);
  });
});

describe('resolvePolicies', () => {
  it('finds the shipped policies independent of the current directory', () => {
    const before = process.cwd();
    process.chdir(tmp());
    try {
      const ps = resolvePolicies({});
      expect(ps.map((p) => p.name).sort()).toEqual(['software-execute', 'software-review']);
      expect(ps.every((p) => p.source === 'shipped')).toBe(true);
      expect(shippedPoliciesDir()).toBe(join(import.meta.dirname, '../../policies'));
    } finally {
      process.chdir(before);
    }
  });

  it('lets a directory file shadow a shipped policy of the same name and adds other files', () => {
    const d = tmp();
    writeFileSync(join(d, 'software-execute.yaml'), yaml('software-execute', '  marker: mine\n'));
    writeFileSync(join(d, 'extra.yaml'), yaml('extra').replace('kind: execute\ndefault: true', 'kind: other\ndefault: true'));
    const ps = resolvePolicies({ policiesDir: d });
    expect(find(ps, 'software-execute').source).toBe('directory');
    expect((find(ps, 'software-execute').policy.config as { marker: string }).marker).toBe('mine');
    expect(find(ps, 'software-review').source).toBe('shipped');
    expect(find(ps, 'extra').source).toBe('directory');
  });

  it('uses only policiesDir with shippedPolicies false', () => {
    const d = tmp();
    writeFileSync(join(d, 'only.yaml'), yaml('only'));
    expect(resolvePolicies({ policiesDir: d, shippedPolicies: false }).map((p) => p.name)).toEqual(['only']);
  });

  it('applies overrides: nested merge, array and scalar replacement', () => {
    const ps = resolvePolicies({
      policyOverrides: {
        'software-execute': { config: { bare: false, allowedTools: ['Read'], maxBudgetUsd: 1 } },
        'software-review': { config: { bare: false } },
      },
    });
    const exec = find(ps, 'software-execute');
    const cfg = exec.policy.config as Record<string, unknown>;
    expect(exec.source).toBe('overridden');
    expect(cfg.bare).toBe(false);
    expect(cfg.allowedTools).toEqual(['Read']);
    expect(cfg.maxBudgetUsd).toBe(1);
    expect(cfg.timeoutMs).toBe(1800000);
    expect(typeof cfg.prompt).toBe('string');
    expect((find(ps, 'software-review').policy.config as { settingSources: string }).settingSources).toBe('user');
  });

  it('lets policyOverrides change the model and rejects an invalid one at load', () => {
    const ps = resolvePolicies({ policyOverrides: { 'software-review': { config: { model: 'sonnet' } } } });
    expect((find(ps, 'software-review').policy.config as { model: string }).model).toBe('sonnet');
    expect((find(ps, 'software-execute').policy.config as { model: string }).model).toBe('sonnet');
    const engines = new EngineRegistry();
    engines.register({ id: 'software', policyKinds: ['execute', 'review'] } as unknown as Engine<any>);
    const runners = new RunnerRegistry();
    runners.register(new ClaudeCliRunner());
    for (const bad of ['-x', 'a b', '', 'a'.repeat(101)]) {
      const bp = resolvePolicies({ policyOverrides: { 'software-review': { config: { model: bad } } } });
      expect(() =>
        validatePolicies(bp.map((x) => x.policy), engines, runners),
      ).toThrow(/software-review.*model/);
    }
  });

  it('rejects an override of kind or match, naming the key', () => {
    for (const key of ['kind', 'match']) {
      expect(() => resolvePolicies({ policyOverrides: { 'software-execute': { [key]: 'x' } } })).toThrow(
        new RegExp(`software-execute\\.${key}`),
      );
    }
  });

  it('rejects an override for an unknown policy name', () => {
    expect(() => resolvePolicies({ policyOverrides: { nope: { config: {} } } })).toThrow(/nope/);
  });

  it('rejects an invalid merged result naming the policy and key', () => {
    expect(() => resolvePolicies({ policyOverrides: { 'software-execute': { runner: 5 } } })).toThrow(
      /software-execute.*runner/,
    );
  });
});

describe('describePolicy', () => {
  it('prints name, source, labels, runner and config with secrets redacted', () => {
    const token = 'sk-ant-' + 'x'.repeat(30);
    const ps = resolvePolicies({
      policyOverrides: { 'software-execute': { config: { prompt: `use ${token}`, apiKey: 'plain-value', bare: false } } },
    });
    const text = describePolicy(find(ps, 'software-execute')).join('\n');
    expect(text).toContain('software-execute source=overridden kind=execute labels=(none)');
    expect(text).toContain('runner: claude-cli');
    expect(text).toContain('"bare": false');
    expect(text).toContain('"model": "sonnet"');
    expect(text).not.toContain(token);
    expect(text).not.toContain('plain-value');
    expect(text).toContain('[redacted]');
  });

  it('redactConfig leaves ordinary values alone', () => {
    expect(redactConfig({ n: 1, list: ['a'], o: { s: 'b' } })).toEqual({ n: 1, list: ['a'], o: { s: 'b' } });
  });
});
