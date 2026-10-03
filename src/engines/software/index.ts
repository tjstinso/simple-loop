import type Database from 'better-sqlite3';
import { pruneFiledFollowups, sweepUnfiledFollowups } from './followups.js';
import type { ChainView, DeadLetter, Engine, Job, WorkspaceProvider } from '../../kernel/types.js';
import type { PolicyStore } from '../../policy/store.js';
import type { Workspace } from '../../runner/types.js';
import { defaultSleep, runSoftwareEffect, withHostRetry } from './effects.js';
import type { GitHost } from './github.js';
import type { GitPorts } from './git-ports.js';
import { buildSoftwareRunInput } from './run-input.js';
import {
  ExecutionResultSchema,
  LABEL_DEAD_LETTER,
  LABEL_IN_PROGRESS,
  LABEL_NEEDS_HUMAN,
  LABEL_READY_FOR_MERGE,
  ReviewVerdictSchema,
} from './schemas.js';
import { SoftwareStateSchema, type SoftwareState } from './state.js';
import { softwareSubmit } from './submit.js';
import { softwareTransition } from './transition.js';
import type { GitWorkspaceProvider, SoftwareWorkspace } from './workspace.js';

export interface SoftwareEngineDeps {
  host: GitHost;
  git: GitPorts;
  workspaces: GitWorkspaceProvider;
  policies: PolicyStore;
  db: Database.Database;
  config: {
    defaultProfile: 'supervised' | 'automatic';
    requiredSections: string[];
    /** Filed followup rows older than this are pruned (default 30). */
    historyRetentionDays?: number;
    /** Kept (dead-lettered) worktrees older than this are swept (default 7 days). */
    keptWorktreeMaxAgeMs?: number;
  };
  sleep?: (ms: number) => Promise<void>;
  /** Clock for stored rows (epoch ms); injected by the composition root. */
  now: () => number;
  /**
   * Exact secret values (evaluated at each push) for `commit_push`'s secret guard and the redaction
   * of the commit message and PR text; injected by the composition root (default: none).
   */
  secretValues?: () => readonly string[];
}

export { LABEL_DEAD_LETTER };

export type SoftwareEngine = Engine<SoftwareState> & {
  /** Evicts the cached workspace of one delivery of one job (used by cleanup). */
  forgetWorkspace(chainId: number, jobId: number, delivery: number): void;
};

export function createSoftwareEngine(deps: SoftwareEngineDeps): SoftwareEngine {
  const cache = new Map<string, SoftwareWorkspace>();
  // `delivery` restarts at 1 for every job, so a delivery is identified by (chain, job, delivery).
  const key = (chainId: number, jobId: number, delivery: number) => `${chainId}:${jobId}:${delivery}`;
  const forget = (chainId: number, jobId: number, delivery: number) => void cache.delete(key(chainId, jobId, delivery));
  const historyRetentionDays = deps.config.historyRetentionDays ?? 30;
  const keptWorktreeMaxAgeMs = deps.config.keptWorktreeMaxAgeMs ?? 7 * 86_400_000;

  /**
   * Deliveries whose workspace must survive a sweep: running jobs and recently dead-lettered (kept)
   * ones. Re-queries the database on every call: the provider asks again inside its lock right
   * before removing a directory, so a delivery claimed after the sweep started is seen.
   */
  function isLiveDelivery(now: number): (k: string) => boolean {
    const stmt = deps.db.prepare(
      `SELECT 1 FROM jobs WHERE status = 'running' AND chain_id = ? AND id = ? AND delivery = ?
       UNION ALL
       SELECT 1 FROM jobs j
         JOIN dead_letters d ON d.job_id = j.id
        WHERE j.status = 'failed' AND d.resolved_at IS NULL AND d.created_at > ?
          AND j.chain_id = ? AND j.id = ? AND j.delivery = ?
       LIMIT 1`,
    );
    return (k: string): boolean => {
      const m = /^(\d+):(\d+):(\d+)$/.exec(k);
      if (!m) return false;
      const [c, j, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return stmt.get(c, j, d, now - keptWorktreeMaxAgeMs, c, j, d) !== undefined;
    };
  }

  const workspace: WorkspaceProvider = {
    async prepare(chain: ChainView<any>, job: Job): Promise<Workspace> {
      const ws = await deps.workspaces.prepare(chain, job);
      cache.set(key(chain.id, job.id, job.delivery), ws as SoftwareWorkspace);
      return ws;
    },
  };

  return {
    id: 'software',
    policyKinds: ['execute', 'review'],
    stateSchema: SoftwareStateSchema,
    resultSchemas: { execute: ExecutionResultSchema, review: ReviewVerdictSchema },

    submit: (input: unknown) =>
      softwareSubmit(input as { issueUrl: string }, {
        host: deps.host,
        policies: deps.policies,
        config: deps.config,
      }),

    workspace,

    async buildRunInput(chain, job, ws) {
      const s = chain.state;
      // Transient GitHub failures are retried like the effects' (a final failure dead-letters as runner_error).
      const sleep = deps.sleep ?? defaultSleep;
      const issue = await withHostRetry(() => deps.host.getIssue(s.repo, s.issueNumber), sleep);
      // Closing the issue stops the chain: dead-lettered (runner_error) before the agent spends budget.
      if (issue.state !== 'open') throw new Error(`issue #${s.issueNumber} is closed`);
      let pr: { number: number; baseBranch: string } | null = null;
      if (job.type === 'review') {
        const found = await withHostRetry(() => deps.host.findPrByHead(s.repo, s.branch), sleep);
        if (!found) throw new Error(`no PR found for review of ${s.branch}`);
        pr = { number: found.number, baseBranch: (ws as SoftwareWorkspace).baseBranch };
      }
      return buildSoftwareRunInput(chain, job, ws as SoftwareWorkspace, issue, pr);
    },

    transition: softwareTransition,

    async runEffect(effect, ctx) {
      await runSoftwareEffect(
        effect,
        {
          chain: ctx.chain,
          job: ctx.job,
          workspace: cache.get(key(ctx.chain.id, ctx.job.id, ctx.job.delivery)) ?? null,
          host: deps.host,
          git: deps.git,
          sleep: deps.sleep,
          followups: { db: deps.db, now: deps.now },
          secretValues: deps.secretValues,
        },
        ctx.fence,
      );
    },

    describe(chain) {
      const s = chain.state;
      return `${s.repo}#${s.issueNumber} phase=${s.phase} attempt=${s.attempt} profile=${s.profile}`;
    },

    async surfaceDeadLetter(chain: ChainView<SoftwareState>, dl: DeadLetter) {
      const s = chain.state;
      await deps.host.setLabels(s.repo, s.issueNumber, [LABEL_DEAD_LETTER], [LABEL_IN_PROGRESS]);
      const marker = `<!-- factory:chain=${chain.id} job=${dl.jobId} event=dead-letter -->`;
      if (await deps.host.findComment(s.repo, s.issueNumber, marker)) return;
      const body = [
        `The factory dead-lettered job ${dl.jobId} (reason: ${dl.reason}).`,
        '',
        'Error:',
        '```',
        dl.error.replaceAll('```', "'''"),
        '```',
        '',
        marker,
      ].join('\n');
      await deps.host.comment(s.repo, s.issueNumber, body);
    },

    async afterRetry(chain: ChainView<SoftwareState>) {
      // The retried chain is back in progress: undo surfaceDeadLetter's labels on the issue.
      const s = chain.state;
      await deps.host.setLabels(s.repo, s.issueNumber, [LABEL_IN_PROGRESS], [LABEL_DEAD_LETTER]);
    },

    async afterCancel(chain: ChainView<SoftwareState>) {
      // The chain was ended by hand (`factory cancel` or `dlq discard`): no factory status applies any more.
      const s = chain.state;
      await deps.host.setLabels(s.repo, s.issueNumber, [], [
        LABEL_IN_PROGRESS,
        LABEL_NEEDS_HUMAN,
        LABEL_DEAD_LETTER,
        LABEL_READY_FOR_MERGE,
      ]);
    },

    async cleanup(chain, job) {
      // The CURRENT status decides: only a dead-lettered job keeps its workspace (debugging).
      // A succeeded, aborted (still running, delivery lost) or stale delivery is removed.
      const row = deps.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined;
      const outcome = row?.status === 'failed' ? 'failed' : 'ok';
      forget(chain.id, job.id, job.delivery);
      await deps.workspaces.teardown(chain, job, outcome);
    },

    async sweep(now) {
      const errors: unknown[] = [];
      const step = async (fn: () => unknown) => {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      };
      await step(() => sweepUnfiledFollowups(deps.db, deps.host, now));
      await step(() => pruneFiledFollowups(deps.db, now, historyRetentionDays));
      await step(() => deps.workspaces.sweep(isLiveDelivery(now), now));
      if (errors.length > 0) throw errors[0];
    },

    forgetWorkspace: forget,
  };
}
