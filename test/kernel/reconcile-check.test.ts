import { afterEach, describe, expect, it } from 'vitest';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { createKernel, type Kernel } from '../../src/kernel/kernel.js';
import { chainEvents } from '../../src/kernel/events.js';
import type { Engine, ReconcileOutcome } from '../../src/kernel/types.js';
import { reconcileWaiting } from '../../src/kernel/worker-loop.js';
import { PolicyStore } from '../../src/policy/store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import { makeEchoEngine } from '../support/echo-engine.js';

const NOW = 1_700_000_000_000;

type Script = (chainId: number) => ReconcileOutcome<{ count: number }> | Promise<ReconcileOutcome<{ count: number }>>;

function setup(script: Script, redact?: (t: string) => string) {
  const echo = { ...makeEchoEngine('echo'), reconcile: (c: { id: number }) => script(c.id), ...(redact ? { redact } : {}) } as Engine<any>;
  const engines = new EngineRegistry();
  engines.register(echo);
  const runners = new RunnerRegistry();
  runners.register(new FakeRunner());
  const policies = new PolicyStore([
    { id: 'echo-default', kind: 'echo', match: { labels: [] }, runner: 'fake', config: {}, default: true },
  ]);
  const kernel = createKernel({
    dbPath: ':memory:',
    engines,
    runners,
    policies,
    clock: () => NOW,
    config: { leaseMs: 60_000, heartbeatMs: 1_000, maxDeliveries: 3 },
  });
  const errors: unknown[] = [];
  const waitingChain = async (key: string) => {
    const { chain } = await kernel.enqueue('echo', { key });
    kernel.deps.db.prepare(`UPDATE jobs SET status = 'succeeded' WHERE chain_id = ?`).run(chain.id);
    kernel.deps.db.prepare(`UPDATE chains SET status = 'waiting', updated_at = 5 WHERE id = ?`).run(chain.id);
    return chain.id;
  };
  const row = (id: number) =>
    kernel.deps.db.prepare('SELECT status, updated_at, last_checked_at, last_check_result FROM chains WHERE id = ?').get(id) as {
      status: string; updated_at: number; last_checked_at: number | null; last_check_result: string | null;
    };
  const pass = (onError = (e: unknown) => void errors.push(e)) => reconcileWaiting(kernel.deps, onError);
  return { kernel, errors, waitingChain, row, pass };
}

let kernels: Kernel[] = [];
afterEach(() => {
  for (const k of kernels) k.close();
  kernels = [];
});
const track = <T extends { kernel: Kernel }>(s: T): T => (kernels.push(s.kernel), s);

describe('reconcileWaiting records the check', () => {
  it.each<[string, ReconcileOutcome<{ count: number }>, string, string]>([
    ['none', { outcome: 'none' }, 'waiting', 'none'],
    ['unknown', { outcome: 'none', check: 'unknown' }, 'waiting', 'unknown'],
    ['update', { outcome: 'update', reason: 'r', engineState: { count: 3 } }, 'waiting', 'update'],
    ['completed', { outcome: 'completed', reason: 'merged' }, 'completed', 'completed'],
    ['cancelled', { outcome: 'cancelled', reason: 'closed' }, 'cancelled', 'cancelled'],
    [
      'new_work',
      { outcome: 'new_work', reason: 'r', engineState: { count: 1 }, job: { type: 'echo', attempt: 2, policyKind: 'echo', labels: [] } },
      'active',
      'new_work',
    ],
  ])('%s', async (_name, outcome, status, result) => {
    const s = track(setup(() => outcome));
    const id = await s.waitingChain('a');
    const before = chainEvents(s.kernel.deps.db, id).length;
    await s.pass();
    const r = s.row(id);
    expect(s.errors).toEqual([]);
    expect(r).toMatchObject({ status, last_checked_at: NOW, last_check_result: result });
    if (outcome.outcome === 'none') {
      // A plain check changes nothing else: status, updated_at and the events stay.
      expect(r.updated_at).toBe(5);
      expect(chainEvents(s.kernel.deps.db, id)).toHaveLength(before);
    }
  });

  it('records a thrown error, one line, redacted and capped at 200 characters', async () => {
    const s = track(
      setup(
        () => {
          throw new Error(`bad\nsecret-value ${'x'.repeat(300)}`);
        },
        (t) => t.replace('secret-value', '[redacted]'),
      ),
    );
    const id = await s.waitingChain('a');
    await s.pass();
    const r = s.row(id);
    expect(r.status).toBe('waiting');
    expect(r.last_checked_at).toBe(NOW);
    expect(r.last_check_result!.startsWith('error: bad [redacted] xxx')).toBe(true);
    expect(r.last_check_result).toHaveLength(200);
    expect(r.last_check_result!.endsWith('…')).toBe(true);
    expect(s.errors).toHaveLength(1);
  });

  it('records a transient failure the engine reports', async () => {
    const s = track(setup(() => ({ outcome: 'none', check: 'error: boom' })));
    const id = await s.waitingChain('a');
    await s.pass();
    expect(s.row(id).last_check_result).toBe('error: boom');
  });

  it('a failing write goes to onError and does not stop the other chains', async () => {
    const s = track(setup(() => ({ outcome: 'none' })));
    const a = await s.waitingChain('a');
    const b = await s.waitingChain('b');
    // Make the write fail for chain a only.
    s.kernel.deps.db.exec(`CREATE TRIGGER no_write BEFORE UPDATE OF last_checked_at ON chains WHEN NEW.id = ${a}
      BEGIN SELECT RAISE(ABORT, 'write refused'); END`);
    await s.pass();
    expect(s.errors).toHaveLength(1);
    expect(String(s.errors[0])).toContain('write refused');
    expect(s.row(a).last_checked_at).toBeNull();
    expect(s.row(b)).toMatchObject({ last_checked_at: NOW, last_check_result: 'none' });
  });

  it('does not touch a chain that completed while the call ran', async () => {
    let db!: Kernel['deps']['db'];
    const s = track(
      setup((chainId) => {
        db.prepare(`UPDATE chains SET status = 'completed' WHERE id = ?`).run(chainId);
        return { outcome: 'none' };
      }),
    );
    db = s.kernel.deps.db;
    const id = await s.waitingChain('a');
    await s.pass();
    expect(s.row(id)).toMatchObject({ status: 'completed', last_checked_at: null, last_check_result: null });
    expect(s.errors).toEqual([]);
  });

  it('does not record for a chain that is not waiting', async () => {
    const s = track(setup(() => ({ outcome: 'none' })));
    const { chain } = await s.kernel.enqueue('echo', { key: 'active' });
    await s.pass();
    expect(s.row(chain.id).last_checked_at).toBeNull();
  });
});
