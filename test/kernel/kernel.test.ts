import { describe, expect, it } from 'vitest';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { migrate, openDb } from '../../src/kernel/db.js';
import { createKernel } from '../../src/kernel/kernel.js';
import { PolicyStore } from '../../src/policy/store.js';
import { RunnerRegistry } from '../../src/runner/registry.js';

const base = () => ({
  engines: new EngineRegistry(),
  runners: new RunnerRegistry(),
  policies: new PolicyStore([]),
  clock: () => 1,
  config: { leaseMs: 1, heartbeatMs: 1, maxDeliveries: 1 },
});

describe('createKernel', () => {
  it('createKernel with an existing db uses that handle and close() does not close it', () => {
    const db = openDb(':memory:');
    migrate(db, []);
    const kernel = createKernel({ db, ...base() });
    expect(kernel.deps.db).toBe(db);
    kernel.close();
    expect(db.open).toBe(true);
    expect(db.prepare('SELECT 1 AS x').get()).toEqual({ x: 1 });
    db.close();
  });

  it('createKernel with a dbPath opens its own handle and close() closes it', () => {
    const kernel = createKernel({ dbPath: ':memory:', ...base() });
    kernel.close();
    expect(kernel.deps.db.open).toBe(false);
  });
});
