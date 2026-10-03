import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import type { RunInput } from '../../src/runner/types.js';
import type { Job } from '../../src/kernel/types.js';
import { runnerContract } from './contract.js';

function input(type = 'build'): RunInput {
  const job: Job = {
    id: 1, chainId: 1, type, attempt: 1, status: 'running', policyId: 'p',
    payload: null, result: null, claimedBy: null, leaseExpiresAt: null, delivery: 1, error: null,
  };
  return { job, config: {}, subject: {}, workspace: { path: '/tmp/ws' } };
}

runnerContract(() => {
  const runner = new FakeRunner();
  runner.script('build', [{ ok: true }, { ok: true }, { ok: true }]);
  return { runner, validInput: input(), cleanup() {} };
});

describe('FakeRunner', () => {
  it('replays scripted results in order', async () => {
    const r = new FakeRunner();
    r.script('build', [1, 2]);
    const s = new AbortController().signal;
    expect(await r.run(input(), s)).toBe(1);
    expect(await r.run(input(), s)).toBe(2);
    expect(r.calls).toHaveLength(2);
  });

  it('throws when the script is exhausted', async () => {
    const r = new FakeRunner();
    r.script('build', [1]);
    const s = new AbortController().signal;
    await r.run(input(), s);
    await expect(r.run(input(), s)).rejects.toThrow(/exhausted/);
    await expect(r.run(input('other'), s)).rejects.toThrow(/no script/);
  });

  it('supports function scripts and Error results', async () => {
    const r = new FakeRunner();
    r.script('f', (i) => i.job.type);
    r.script('e', [new Error('boom')]);
    const s = new AbortController().signal;
    expect(await r.run(input('f'), s)).toBe('f');
    await expect(r.run(input('e'), s)).rejects.toThrow('boom');
  });
});

describe('RunnerRegistry', () => {
  it('registers and gets runners, throws on unknown', () => {
    const reg = new RunnerRegistry();
    const f = new FakeRunner();
    reg.register(f);
    expect(reg.get('fake')).toBe(f);
    expect(() => reg.get('nope')).toThrow(/nope/);
    expect(() => reg.register(f)).toThrow(/already/);
  });
});
