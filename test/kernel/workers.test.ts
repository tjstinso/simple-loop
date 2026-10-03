import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../../src/kernel/db.js';
import { readProcessStartTime } from '../../src/util/proc.js';
import {
  isProcessAlive,
  killProcessGroup,
  liveChildrenFor,
  markChildExited,
  reapOwnOrphans,
  recordChild,
  registerWorker,
  touchWorker,
} from '../../src/kernel/workers.js';

const NOW = 1_000_000;
const DEAD_PID = 2 ** 22 + 12345; // above Linux pid_max

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const leftovers: number[] = [];

/** Spawns a detached process-group leader that spawns a grandchild; returns both pids. */
async function spawnTree(): Promise<{ pid: number; grandchild: number }> {
  const script =
    "const {spawn}=require('child_process');" +
    "const g=spawn('sleep',['60'],{stdio:'ignore'});" +
    "process.stdout.write(String(g.pid)+'\\n');setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pid = child.pid as number;
  leftovers.push(pid);
  const grandchild = await new Promise<number>((resolve) => {
    child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim())));
  });
  leftovers.push(grandchild);
  child.unref();
  return { pid, grandchild };
}

describe('workers', () => {
  let db: Database.Database;
  let jobId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const chain = db
      .prepare(
        `INSERT INTO chains (engine, subject_key, status, engine_state, created_at, updated_at)
         VALUES ('e','s','active','{}',?,?)`,
      )
      .run(NOW, NOW);
    jobId = Number(
      db
        .prepare(
          `INSERT INTO jobs (chain_id, type, attempt, status, policy_id, created_at, updated_at)
           VALUES (?, 't', 1, 'running', 'p', ?, ?)`,
        )
        .run(chain.lastInsertRowid, NOW, NOW).lastInsertRowid,
    );
  });

  afterEach(() => {
    db.close();
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  const worker = (id = 'w1') =>
    registerWorker(db, { id, pid: process.pid, pgid: process.pid, startTime: 5, host: 'h' }, NOW);

  it('records a child and lists it as live until exited', () => {
    worker();
    touchWorker(db, 'w1', NOW + 10);
    expect(
      (db.prepare('SELECT last_seen_at FROM workers WHERE id=?').get('w1') as { last_seen_at: number })
        .last_seen_at,
    ).toBe(NOW + 10);
    const id = recordChild(
      db,
      { workerId: 'w1', jobId, delivery: 1, pid: 111, pgid: 111, startTime: 42 },
      NOW,
    );
    expect(liveChildrenFor(db, jobId, 1)).toEqual([
      {
        id,
        workerId: 'w1',
        jobId,
        delivery: 1,
        pid: 111,
        pgid: 111,
        startTime: 42,
        startedAt: NOW,
        exitedAt: null,
        exitCode: null,
      },
    ]);
    expect(liveChildrenFor(db, jobId, 2)).toEqual([]);
    markChildExited(db, id, 0, NOW + 5);
    expect(liveChildrenFor(db, jobId, 1)).toEqual([]);
  });

  it('isProcessAlive is false for a dead pid', () => {
    expect(isProcessAlive(DEAD_PID, 1)).toBe(false);
    expect(isProcessAlive(DEAD_PID, 0)).toBe(false);
  });

  it('isProcessAlive is false when the start time does not match (pid reuse)', () => {
    const real = readProcessStartTime(process.pid) as number;
    expect(isProcessAlive(process.pid, real)).toBe(true);
    expect(isProcessAlive(process.pid, 0)).toBe(true);
    expect(isProcessAlive(process.pid, real + 1)).toBe(false);
  });

  it('killProcessGroup terminates a spawned process group including grandchildren', async () => {
    const { pid, grandchild } = await spawnTree();
    expect(alive(pid) && alive(grandchild)).toBe(true);
    killProcessGroup(pid, 200);
    expect(await waitUntil(() => !alive(grandchild) && !alive(pid))).toBe(true);
    killProcessGroup(pid, 10); // already gone: must not throw
  });

  it("on startup a worker kills its previous incarnation's unexited children", async () => {
    worker();
    const { pid, grandchild } = await spawnTree();
    const start = readProcessStartTime(pid) as number;
    const live = recordChild(
      db,
      { workerId: 'w1', jobId, delivery: 1, pid, pgid: pid, startTime: start },
      NOW,
    );
    const gone = recordChild(
      db,
      { workerId: 'w1', jobId, delivery: 1, pid: DEAD_PID, pgid: DEAD_PID, startTime: 7 },
      NOW,
    );
    const done = recordChild(db, { workerId: 'w1', jobId, delivery: 1, pid: 1, pgid: 1, startTime: 1 }, NOW);
    markChildExited(db, done, 0, NOW);
    const reaped = reapOwnOrphans(db, 'w1', NOW + 100);
    expect([...reaped].sort()).toEqual([live, gone].sort());
    expect(await waitUntil(() => !alive(grandchild) && !alive(pid))).toBe(true);
    expect(liveChildrenFor(db, jobId, 1)).toEqual([]);
    const row = db
      .prepare('SELECT exited_at, exit_code FROM child_processes WHERE id=?')
      .get(live) as { exited_at: number; exit_code: number | null };
    expect(row).toEqual({ exited_at: NOW + 100, exit_code: null });
  });

  it("killProcessGroup refuses pgid 0, 1, negative and NaN, and the caller's own group, and the test process survives", () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const own = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2]);
      for (const bad of [0, 1, -5, Number.NaN, own]) killProcessGroup(bad, 10);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(alive(process.pid)).toBe(true);
  });

  it('reapOwnOrphans kills surviving group members after the leader has exited', async () => {
    worker();
    const script =
      "const {spawn}=require('child_process');" +
      "const g=spawn('sleep',['60'],{stdio:'ignore'});" +
      "process.stdout.write(String(g.pid)+'\\n',()=>process.exit(0));";
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = child.pid as number;
    leftovers.push(pid);
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim())));
    });
    leftovers.push(grandchild);
    expect(await waitUntil(() => !alive(pid))).toBe(true);
    expect(alive(grandchild)).toBe(true);
    const id = recordChild(db, { workerId: 'w1', jobId, delivery: 1, pid, pgid: pid, startTime: 1 }, NOW);
    expect(reapOwnOrphans(db, 'w1', NOW + 1)).toEqual([id]);
    expect(await waitUntil(() => !alive(grandchild))).toBe(true);
    expect(liveChildrenFor(db, jobId, 1)).toEqual([]);
  });
});
