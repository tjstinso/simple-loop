import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { FOLLOWUPS_DDL } from '../../src/engines/software/followups.js';
import { ExecGitPorts } from '../../src/engines/software/git-ports.js';
import { createSoftwareEngine, type SoftwareEngine } from '../../src/engines/software/index.js';
import type { Followup } from '../../src/engines/software/schemas.js';
import type { SoftwareState } from '../../src/engines/software/state.js';
import { GitWorkspaceProvider, type SoftwareWorkspace } from '../../src/engines/software/workspace.js';
import { migrate, openDb } from '../../src/kernel/db.js';
import { listDeadLetters } from '../../src/kernel/dlq.js';
import { EngineRegistry } from '../../src/kernel/engine-registry.js';
import { createKernel, type Kernel } from '../../src/kernel/kernel.js';
import { processDelivery, type DeliveryOutcome } from '../../src/kernel/process-delivery.js';
import { claimNext, getChain, rowToJob, type JobRow } from '../../src/kernel/queue.js';
import { reapExpired, type ReapReport } from '../../src/kernel/reaper.js';
import type { Chain, ChainView, DeadLetter, Effect, Job, RunEffectContext } from '../../src/kernel/types.js';
import { runMaintenance } from '../../src/kernel/worker-loop.js';
import { PolicyStore } from '../../src/policy/store.js';
import { FakeRunner } from '../../src/runner/fake.js';
import { RunnerRegistry } from '../../src/runner/registry.js';
import type { RunInput } from '../../src/runner/types.js';
import { FakeGitHost } from './fake-github.js';
import { GIT_TEST_ENV, makeRemote, type TempRemote } from './temp-repo.js';

export const REPO = 'o/r';
export const LEASE_MS = 300_000;
export const KERNEL_CONFIG = { leaseMs: LEASE_MS, heartbeatMs: 30_000, maxDeliveries: 3 };
export const START_TIME = 1_700_000_000_000;
export const ISSUE_BODY = '## Goal\nMake the widget work.\n\n## Acceptance criteria\n- the widget works\n';

export interface HarnessOptions {
  defaultProfile?: 'supervised' | 'automatic';
  keptWorktreeMaxAgeMs?: number;
}

export interface DeliveryRecord {
  jobId: number;
  type: string;
  attempt: number;
  delivery: number;
  outcome: DeliveryOutcome;
}

export interface WorkspaceEvent {
  op: 'prepare' | 'teardown';
  jobId: number;
  type: string;
  delivery: number;
  path: string;
  outcome?: 'ok' | 'failed';
}

export interface ExecuteResult {
  status: 'ok' | 'error';
  summary: string;
  followups?: Followup[];
}

export interface ReviewResult {
  verdict: 'approve' | 'request_changes';
  feedback: string;
  followups?: Followup[];
}

/** Runs before the engine's own runEffect; may block (to simulate a hang) or throw. */
export type EffectHook = (effect: Effect, ctx: RunEffectContext<SoftwareState>) => void | Promise<void>;

export interface Harness {
  db: Database.Database;
  kernel: Kernel;
  engine: SoftwareEngine;
  host: FakeGitHost;
  runner: FakeRunner;
  remote: TempRemote;
  workspaceRoot: string;
  workspaces: GitWorkspaceProvider;
  /** Every prepare/teardown the engine asked the workspace provider for, in order. */
  workspaceLog: WorkspaceEvent[];
  /** Settable hook run before every effect (see EffectHook). */
  beforeEffect: EffectHook | null;
  clock(): number;
  advance(ms: number): number;

  submit(issueNumber: number, labels?: string[]): Promise<{ chain: Chain; job: Job }>;
  /** Claims the next queued job as worker `w1` (does not process it). */
  claim(): Job | null;
  /** Processes one claimed job with a fresh, never-aborted signal. */
  deliver(job: Job): Promise<DeliveryOutcome>;
  /** Claims and processes one job; null when nothing is queued. */
  runOne(): Promise<DeliveryRecord | null>;
  /** Claims and processes jobs until nothing is queued. No worker, no timers. */
  runUntilIdle(maxSteps?: number): Promise<DeliveryRecord[]>;
  /** Kernel reaper with injected no-op kills (nothing real is ever signalled). */
  reap(): ReapReport;
  /** Kernel maintenance (reap with no-op kills, surface reaper dead letters, sweep); returns reported errors. */
  maintain(): Promise<unknown[]>;

  /** Scripts execute runs. `fn` usually writes a file with `write` and returns `ok(...)`. */
  scriptExecute(fn: (input: RunInput, call: number) => unknown): void;
  /** Scripts review runs: a list of verdicts in order, or a function. */
  scriptReview(script: ReviewResult[] | ((input: RunInput, call: number) => unknown)): void;
  /** Writes a file into the run's workspace (relative path). */
  write(input: RunInput, file: string, content: string): void;
  callsOf(type: string): RunInput[];

  chain(id?: number): ChainView<SoftwareState>;
  jobs(chainId?: number): Job[];
  deadLetters(): DeadLetter[];
  issueLabels(n: number): string[];
  comments(n: number): string[];
  pr(branch: string): { number: number; state: string; labels: string[]; head: string } | null;

  remoteBranches(): string[];
  remoteHead(branch: string): string | null;
  /** Commit shas of `branch`, newest first. */
  remoteLog(branch: string): string[];
  remoteFile(branch: string, path: string): string | null;
  remoteFiles(branch: string): string[];

  cleanup(): void;
}

export const ok = (summary = 'done', followups?: Followup[]): ExecuteResult =>
  followups ? { status: 'ok', summary, followups } : { status: 'ok', summary };

const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-harness-'));
  let remote: TempRemote | undefined;
  let db: Database.Database | undefined;
  try {
    remote = makeRemote();
    const r = remote;
    const workspaceRoot = join(tmp, 'ws');
    mkdirSync(workspaceRoot);
    db = openDb(join(tmp, 'factory.db'));
    migrate(db, [FOLLOWUPS_DDL]);
    const theDb = db;

    let now = START_TIME;
    const clock = () => now;

    const host = new FakeGitHost();
    // sweepGraceMs 0: the harness clock is fake (START_TIME), so file mtimes cannot be compared with it.
    const workspaces = new GitWorkspaceProvider({ cloneUrlFor: () => r.url, root: workspaceRoot, keepOnFailure: true, sweepGraceMs: 0 });
    // Wired as in the production composition root (src/cli/runtime.ts).
    const git = new ExecGitPorts({ prepareForPush: (ws) => workspaces.sanitizeForPush(ws) });

    // Record what the engine asks the provider to do (paths, deliveries, outcomes).
    const workspaceLog: WorkspaceEvent[] = [];
    const prepare = workspaces.prepare.bind(workspaces);
    const teardown = workspaces.teardown.bind(workspaces);
    workspaces.prepare = async (c: ChainView<SoftwareState>, j: Job) => {
      const ws = await prepare(c, j);
      workspaceLog.push({ op: 'prepare', jobId: j.id, type: j.type, delivery: j.delivery, path: ws.path });
      return ws;
    };
    workspaces.teardown = async (c: ChainView<SoftwareState>, j: Job, outcome: 'ok' | 'failed') => {
      workspaceLog.push({
        op: 'teardown', jobId: j.id, type: j.type, delivery: j.delivery, outcome,
        path: join(workspaceRoot, String(c.id), `j${j.id}-d${j.delivery}`),
      });
      return teardown(c, j, outcome);
    };

    const policies = new PolicyStore([
      { id: 'default-execute', kind: 'execute', match: { labels: [] }, runner: 'fake', config: {}, default: true },
      { id: 'default-review', kind: 'review', match: { labels: [] }, runner: 'fake', config: {}, default: true },
    ]);
    const runner = new FakeRunner();
    const runners = new RunnerRegistry();
    runners.register(runner);

    const engine = createSoftwareEngine({
      db: theDb,
      host,
      git,
      workspaces,
      policies,
      config: {
        defaultProfile: opts.defaultProfile ?? 'supervised',
        requiredSections: ['## Goal', '## Acceptance criteria'],
        ...(opts.keptWorktreeMaxAgeMs === undefined ? {} : { keptWorktreeMaxAgeMs: opts.keptWorktreeMaxAgeMs }),
      },
      now: clock,
      sleep: async () => {},
    });
    const runEffect = engine.runEffect.bind(engine);
    const engines = new EngineRegistry();
    engines.register(engine);
    const kernel = createKernel({ db: theDb, engines, runners, policies, clock, config: KERNEL_CONFIG });

    const gitR = (args: string[]): string =>
      execFileSync('git', args, { cwd: r.path, env: GIT_TEST_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const gitOrNull = (args: string[]): string | null => {
      try {
        return gitR(args);
      } catch {
        return null;
      }
    };

    const h: Harness = {
      db: theDb,
      kernel,
      engine,
      host,
      runner,
      remote: r,
      workspaceRoot,
      workspaces,
      workspaceLog,
      beforeEffect: null,
      clock,
      advance(ms) {
        now += ms;
        return now;
      },

      async submit(n, labels = []) {
        host.addIssue({ number: n, title: `Issue ${n}`, body: ISSUE_BODY, labels });
        return kernel.enqueue('software', { issueUrl: issueUrl(n) });
      },
      claim: () => claimNext(theDb, 'w1', clock(), LEASE_MS),
      deliver: (job) => processDelivery(kernel.deps, job, 'w1', new AbortController().signal),
      async runOne() {
        const job = h.claim();
        if (!job) return null;
        const outcome = await h.deliver(job);
        return { jobId: job.id, type: job.type, attempt: job.attempt, delivery: job.delivery, outcome };
      },
      async runUntilIdle(maxSteps = 50) {
        const out: DeliveryRecord[] = [];
        for (let i = 0; i < maxSteps; i++) {
          const rec = await h.runOne();
          if (!rec) return out;
          out.push(rec);
        }
        throw new Error(`runUntilIdle: still busy after ${maxSteps} deliveries`);
      },
      reap: () =>
        reapExpired(theDb, {
          now: clock(),
          maxDeliveries: KERNEL_CONFIG.maxDeliveries,
          isAlive: () => false,
          groupProbe: () => false,
          killGroup: () => {},
          killPid: () => {},
        }),

      async maintain() {
        const errors: unknown[] = [];
        await runMaintenance(kernel.deps, {
          onError: (err) => errors.push(err),
          reap: { isAlive: () => false, groupProbe: () => false, killGroup: () => {}, killPid: () => {} },
        });
        return errors;
      },

      scriptExecute(fn) {
        let call = 0;
        runner.script('execute', (input) => fn(input, call++));
      },
      scriptReview(script) {
        if (Array.isArray(script)) {
          runner.script('review', script);
          return;
        }
        let call = 0;
        runner.script('review', (input) => script(input, call++));
      },
      write(input, file, content) {
        const p = join(input.workspace.path, file);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      },
      callsOf: (type) => runner.calls.filter((c) => c.job.type === type),

      chain(id) {
        const cid = id ?? (theDb.prepare('SELECT max(id) AS id FROM chains').get() as { id: number }).id;
        const c = getChain(theDb, cid);
        return { id: c.id, engine: c.engine, subjectKey: c.subjectKey, status: c.status, state: c.engineState as SoftwareState };
      },
      jobs(chainId) {
        const rows = (
          chainId === undefined
            ? theDb.prepare('SELECT * FROM jobs ORDER BY id').all()
            : theDb.prepare('SELECT * FROM jobs WHERE chain_id = ? ORDER BY id').all(chainId)
        ) as JobRow[];
        return rows.map(rowToJob);
      },
      deadLetters: () => listDeadLetters(theDb),
      issueLabels: (n) => host.getLabels(n).sort(),
      comments: (n) => host.getComments(n),
      pr(branch) {
        const p = [...host.prs.values()].filter((x) => x.head === branch).sort((a, b) => b.number - a.number)[0];
        return p ? { number: p.number, state: p.state, labels: host.getLabels(p.number).sort(), head: p.head } : null;
      },

      remoteBranches: () =>
        gitR(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort(),
      remoteHead: (branch) => gitOrNull(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]),
      remoteLog: (branch) => gitR(['log', '--format=%H', `refs/heads/${branch}`]).split('\n').filter(Boolean),
      remoteFile: (branch, path) => gitOrNull(['show', `refs/heads/${branch}:${path}`]),
      remoteFiles: (branch) => gitR(['ls-tree', '-r', '--name-only', `refs/heads/${branch}`]).split('\n').filter(Boolean).sort(),

      cleanup() {
        try {
          theDb.close();
        } finally {
          r.cleanup();
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    };

    // PR heads follow the real remote branch, so the merge pin compares real shas.
    host.headShaOf = (branch) => h.remoteHead(branch);

    engine.runEffect = async (effect, ctx) => {
      if (h.beforeEffect) await h.beforeEffect(effect, ctx as RunEffectContext<SoftwareState>);
      return runEffect(effect, ctx);
    };
    return h;
  } catch (e) {
    try {
      db?.close();
    } finally {
      remote?.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
    throw e;
  }
}

/** A promise with its resolver exposed, for gating fake runs and hooks. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export type { SoftwareWorkspace };
