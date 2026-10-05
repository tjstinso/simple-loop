import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_MS, isWorkerAlive } from '../../src/kernel/inspect.js';

const NOW = 1_700_000_000_000;
const here = hostname();
const gone = () => false;
const exists = () => true;

describe('isWorkerAlive', () => {
  it('is alive when idle for an hour on this host as long as its process exists', () => {
    const w = { pid: 10, host: here, last_seen_at: NOW - 3_600_000 };
    expect(isWorkerAlive(w, NOW, { pidExists: exists })).toBe(true);
  });

  it('is dead when its process is gone, even with a fresh heartbeat', () => {
    const w = { pid: 10, host: here, last_seen_at: NOW - 1000 };
    expect(isWorkerAlive(w, NOW, { pidExists: gone })).toBe(false);
  });

  it('uses the heartbeat for a worker on another host', () => {
    const fresh = { pid: 1, host: 'elsewhere', last_seen_at: NOW - (2 * HEARTBEAT_MS - 1) };
    const stale = { pid: 1, host: 'elsewhere', last_seen_at: NOW - 2 * HEARTBEAT_MS };
    // The local pid probe is ignored for a foreign host.
    expect(isWorkerAlive(fresh, NOW, { pidExists: gone })).toBe(true);
    expect(isWorkerAlive(stale, NOW, { pidExists: exists })).toBe(false);
  });

  it('probes with process.kill(pid, 0) by default', () => {
    expect(isWorkerAlive({ pid: process.pid, host: here, last_seen_at: 0 }, NOW)).toBe(true);
    expect(isWorkerAlive({ pid: 2 ** 22 + 12345, host: here, last_seen_at: NOW }, NOW)).toBe(false);
  });

  it('is dead when the recorded start time differs (reused pid)', () => {
    const w = { pid: 10, host: here, last_seen_at: NOW, process_start_time: '5000' };
    expect(isWorkerAlive(w, NOW, { readStartTime: () => 9000, pidExists: exists })).toBe(false);
  });

  it('is alive when the recorded start time matches', () => {
    const w = { pid: 10, host: here, last_seen_at: NOW, process_start_time: '5000' };
    expect(isWorkerAlive(w, NOW, { readStartTime: () => 5000 })).toBe(true);
  });

  it('is dead when the start time cannot be read', () => {
    const w = { pid: 10, host: here, last_seen_at: NOW, process_start_time: '5000' };
    expect(isWorkerAlive(w, NOW, { readStartTime: () => null, pidExists: exists })).toBe(false);
  });

  it('falls back to the pid probe when no start time was recorded', () => {
    const w = { pid: 10, host: here, last_seen_at: NOW, process_start_time: '0' };
    expect(isWorkerAlive(w, NOW, { pidExists: exists })).toBe(true);
  });
});
