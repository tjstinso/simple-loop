import type Database from 'better-sqlite3';
import { recentEvents, type EventRow } from '../kernel/events.js';
import { costOf } from '../kernel/queue.js';

type Db = Database.Database;

/** The kernel's heartbeat interval (see the runtime); a worker is alive within twice this. */
export const HEARTBEAT_MS = 30_000;
export const FINISHED_LIMIT = 20;
export const EVENTS_PER_CHAIN = 10;

export type WaitingKind = 'worker' | 'running' | 'reviewer' | 'person_merge' | 'person_attention' | 'dead_letter' | 'stuck' | 'none';

export interface WaitingOn {
  kind: WaitingKind;
  /** The text shown to the operator: `a worker`, `a person: review and merge`, ... */
  label: string;
  detail: string;
  /** When the wait began (epoch ms), when known. */
  since: number | null;
  /** How long the job has been running (running, reviewer and stuck cases). */
  runningMs: number | null;
  leaseExpiresAt: number | null;
  jobId: number | null;
  workerId: string | null;
}

export interface WaitingJob {
  id: number;
  type: string;
  attempt: number;
  status: string;
  workerId: string | null;
  leaseExpiresAt: number | null;
  /** When the current delivery was claimed (running jobs). */
  startedAt: number | null;
  createdAt: number;
}

export interface WaitingInput {
  status: string;
  phase: string | null;
  branch: string | null;
  jobs: WaitingJob[];
  /** Worker id -> whether its heartbeat is recent. A worker that is not listed is dead. */
  workerAlive: Record<string, boolean>;
  deadLetter: { reason: string; error: string } | null;
  /** When the chain last became `waiting`. */
  waitingSince: number | null;
  now: number;
}

const none = (): WaitingOn => ({
  kind: 'none', label: 'nothing', detail: '', since: null, runningMs: null, leaseExpiresAt: null, jobId: null, workerId: null,
});

const isReview = (type: string): boolean => type === 'review';

const fmt = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

/** Pure: what an open chain is waiting on, derived from its status, phase and jobs. */
export function waitingOn(input: WaitingInput): WaitingOn {
  const { now } = input;
  const base = none();
  if (input.status === 'dead_lettered') {
    const dl = input.deadLetter;
    return { ...base, kind: 'dead_letter', label: 'a decision on the dead letter', detail: dl ? `${dl.reason}: ${dl.error.split('\n')[0] ?? ''}`.slice(0, 200) : 'no reason recorded', since: input.waitingSince };
  }
  const running = input.jobs.find((j) => j.status === 'running');
  if (running) {
    const workerOk = running.workerId !== null && input.workerAlive[running.workerId] === true;
    const leaseOk = running.leaseExpiresAt !== null && running.leaseExpiresAt > now;
    const runningMs = running.startedAt === null ? null : Math.max(0, now - running.startedAt);
    const common = { since: running.startedAt, runningMs, leaseExpiresAt: running.leaseExpiresAt, jobId: running.id, workerId: running.workerId };
    if (!workerOk || !leaseOk) {
      const why = !workerOk ? `worker ${running.workerId ?? '(none)'} is dead` : 'its lease has expired';
      return { ...base, ...common, kind: 'stuck', label: 'a stuck job', detail: `${running.type} job ${running.id}: ${why}` };
    }
    const detail = `${running.type} job ${running.id} (attempt ${running.attempt}) on ${running.workerId}${runningMs === null ? '' : `, running ${fmt(runningMs)}`}${running.leaseExpiresAt === null ? '' : `, lease expires ${new Date(running.leaseExpiresAt).toISOString()}`}`;
    return isReview(running.type)
      ? { ...base, ...common, kind: 'reviewer', label: 'a reviewer agent', detail }
      : { ...base, ...common, kind: 'running', label: 'running', detail };
  }
  const queued = input.jobs.find((j) => j.status === 'queued');
  if (queued) {
    const common = { since: queued.createdAt, jobId: queued.id };
    if (isReview(queued.type)) {
      return { ...base, ...common, kind: 'reviewer', label: 'a reviewer agent', detail: `review job ${queued.id} (attempt ${queued.attempt}) is queued` };
    }
    const live = Object.values(input.workerAlive).some(Boolean);
    const retry = queued.attempt > 1 ? ` (retry, attempt ${queued.attempt})` : '';
    return {
      ...base,
      ...common,
      kind: 'worker',
      label: 'a worker',
      detail: `${queued.type} job ${queued.id} is queued${retry}${live ? '' : '; no live worker'}`,
    };
  }
  if (input.phase === 'awaiting_merge') {
    const pr = input.branch === null ? 'the pull request' : `the pull request for ${input.branch}`;
    return { ...base, kind: 'person_merge', label: 'a person: review and merge', detail: `review and merge ${pr}`, since: input.waitingSince };
  }
  if (input.phase === 'needs_human') {
    return { ...base, kind: 'person_attention', label: 'a person: needs attention', detail: 'the factory handed this over to a person', since: input.waitingSince };
  }
  return base;
}

export interface ChainOverview {
  id: number;
  subjectKey: string;
  subject: { repo: string; issueNumber: number } | null;
  engine: string;
  status: string;
  phase: string | null;
  attempt: number | null;
  createdAt: number;
  updatedAt: number;
  links: { issue: string | null; pullRequest: string | null };
  jobs: JobOverview[];
  events: EventRow[];
  totalCostUsd: number;
  /** Null for a finished chain. */
  waitingOn: WaitingOn | null;
}

export interface JobOverview {
  id: number;
  type: string;
  attempt: number;
  status: string;
  delivery: number;
  workerId: string | null;
  leaseExpiresAt: number | null;
  startedAt: number | null;
  costUsd: number | null;
}

export interface WorkerOverview {
  id: string;
  pid: number;
  host: string;
  alive: boolean;
  heartbeatAgeMs: number;
  currentJobId: number | null;
  currentChainId: number | null;
  currentDelivery: number | null;
}

export interface Overview {
  generatedAt: number;
  summary: { workers: number; aliveWorkers: number; runningJobs: number; waitingOnPerson: number };
  openChains: ChainOverview[];
  finishedChains: ChainOverview[];
  totalCostUsd: number;
  workers: WorkerOverview[];
}

interface ChainRow {
  id: number;
  engine: string;
  subject_key: string;
  status: string;
  engine_state: string;
  created_at: number;
  updated_at: number;
}

interface JobRow {
  id: number;
  chain_id: number;
  type: string;
  attempt: number;
  status: string;
  delivery: number;
  claimed_by: string | null;
  lease_expires_at: number | null;
  result: string | null;
  updated_at: number;
  created_at: number;
}

function parseState(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function subjectOf(key: string, state: Record<string, unknown>): { repo: string; issueNumber: number } | null {
  const repo = str(state.repo);
  const n = int(state.issueNumber);
  if (repo !== null && n !== null) return { repo, issueNumber: n };
  const m = /^(.+)#([0-9]+)$/.exec(key);
  return m ? { repo: m[1]!, issueNumber: Number(m[2]) } : null;
}

/** Everything the dashboard shows, from one read-only pass over the database. */
export function buildOverview(db: Db, now: number, opts: { heartbeatMs?: number } = {}): Overview {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  const workerRows = db.prepare('SELECT * FROM workers ORDER BY id').all() as {
    id: string; pid: number; host: string; last_seen_at: number; current_job_id: number | null; current_delivery: number | null;
  }[];
  const workerAlive: Record<string, boolean> = {};
  const workers: WorkerOverview[] = workerRows.map((w) => {
    const alive = now - w.last_seen_at <= 2 * heartbeatMs;
    workerAlive[w.id] = alive;
    const chain =
      w.current_job_id === null
        ? undefined
        : (db.prepare('SELECT chain_id FROM jobs WHERE id = ?').get(w.current_job_id) as { chain_id: number } | undefined);
    return {
      id: w.id,
      pid: w.pid,
      host: w.host,
      alive,
      heartbeatAgeMs: Math.max(0, now - w.last_seen_at),
      currentJobId: w.current_job_id,
      currentChainId: chain?.chain_id ?? null,
      currentDelivery: w.current_delivery,
    };
  });

  const toChain = (c: ChainRow, open: boolean): ChainOverview => {
    const state = parseState(c.engine_state);
    const subject = subjectOf(c.subject_key, state);
    const phase = str(state.phase);
    const branch = str(state.branch);
    const events = recentEvents(db, { chainId: c.id, limit: EVENTS_PER_CHAIN });
    const hasPr = (db.prepare(`SELECT 1 FROM events WHERE chain_id = ? AND kind = 'pr.opened' LIMIT 1`).get(c.id) as unknown) !== undefined;
    const jobRows = db.prepare('SELECT * FROM jobs WHERE chain_id = ? ORDER BY id').all(c.id) as JobRow[];
    const jobs: JobOverview[] = jobRows.map((j) => {
      const claimed =
        j.status === 'running'
          ? (db
              .prepare(`SELECT MAX(at) AS at FROM events WHERE job_id = ? AND kind = 'job.claimed' AND (delivery IS NULL OR delivery = ?)`)
              .get(j.id, j.delivery) as { at: number | null }).at ?? j.updated_at
          : null;
      return {
        id: j.id,
        type: j.type,
        attempt: j.attempt,
        status: j.status,
        delivery: j.delivery,
        workerId: j.status === 'running' ? j.claimed_by : null,
        leaseExpiresAt: j.status === 'running' ? j.lease_expires_at : null,
        startedAt: claimed,
        costUsd: costOf(j.result) ?? null,
      };
    });
    let waiting: WaitingOn | null = null;
    if (open) {
      const dl =
        c.status === 'dead_lettered'
          ? (db
              .prepare('SELECT reason, error, created_at FROM dead_letters WHERE chain_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1')
              .get(c.id) as { reason: string; error: string; created_at: number } | undefined)
          : undefined;
      const lastWaiting = (db.prepare(`SELECT MAX(at) AS at FROM events WHERE chain_id = ? AND kind = 'chain.waiting'`).get(c.id) as { at: number | null }).at;
      waiting = waitingOn({
        status: c.status,
        phase,
        branch,
        jobs: jobRows.map((j, i) => ({
          id: j.id, type: j.type, attempt: j.attempt, status: j.status, workerId: j.claimed_by,
          leaseExpiresAt: j.lease_expires_at, startedAt: jobs[i]!.startedAt, createdAt: j.created_at,
        })),
        workerAlive,
        deadLetter: dl ? { reason: dl.reason, error: dl.error } : null,
        waitingSince: dl?.created_at ?? lastWaiting ?? c.updated_at,
        now,
      });
    }
    const prVisible = hasPr || phase === 'awaiting_merge' || phase === 'merged';
    return {
      id: c.id,
      subjectKey: c.subject_key,
      subject,
      engine: c.engine,
      status: c.status,
      phase,
      attempt: int(state.attempt),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      links: {
        issue: subject ? `https://github.com/${subject.repo}/issues/${subject.issueNumber}` : null,
        // The pull request number is not recorded, so this is a search for the pull request of the chain's branch.
        pullRequest: subject && branch !== null && prVisible ? `https://github.com/${subject.repo}/pulls?q=${encodeURIComponent(`is:pr head:${branch}`)}` : null,
      },
      jobs,
      events,
      totalCostUsd: jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0),
      waitingOn: waiting,
    };
  };

  const openRows = db
    .prepare(`SELECT * FROM chains WHERE status IN ('active','waiting','dead_lettered') ORDER BY id`)
    .all() as ChainRow[];
  const finishedRows = db
    .prepare(`SELECT * FROM chains WHERE status IN ('completed','cancelled') ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(FINISHED_LIMIT) as ChainRow[];
  const openChains = openRows.map((c) => toChain(c, true));
  const finishedChains = finishedRows.map((c) => toChain(c, false));
  const totalCostUsd = (
    db.prepare(`SELECT result FROM jobs`).all() as { result: string | null }[]
  ).reduce((sum, r) => sum + (costOf(r.result) ?? 0), 0);

  return {
    generatedAt: now,
    summary: {
      workers: workers.length,
      aliveWorkers: workers.filter((w) => w.alive).length,
      runningJobs: openChains.reduce((n, c) => n + c.jobs.filter((j) => j.status === 'running').length, 0),
      waitingOnPerson: openChains.filter((c) => c.waitingOn?.kind === 'person_merge' || c.waitingOn?.kind === 'person_attention' || c.waitingOn?.kind === 'dead_letter').length,
    },
    openChains,
    finishedChains,
    totalCostUsd,
    workers,
  };
}
