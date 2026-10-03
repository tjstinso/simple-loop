import type Database from 'better-sqlite3';
import { pruneFiledFollowups, sweepUnfiledFollowups } from './followups.js';
import type { ChainView, DeadLetter, Engine, Job, WorkspaceProvider } from '../../kernel/types.js';
import type { PolicyStore } from '../../policy/store.js';
import type { Workspace } from '../../runner/types.js';
import { runSoftwareEffect } from './effects.js';
import type { GitHost } from './github.js';
import type { GitPorts } from './git-ports.js';
import { ExecutionResultSchema, LABEL_IN_PROGRESS, ReviewVerdictSchema } from './schemas.js';
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
}

export const LABEL_DEAD_LETTER = 'factory:dead-letter';

export type SoftwareEngine = Engine<SoftwareState> & {
  /** Evicts the cached workspace of one delivery (used by cleanup). */
  forgetWorkspace(chainId: number, delivery: number): void;
};

export function createSoftwareEngine(deps: SoftwareEngineDeps): SoftwareEngine {
  const cache = new Map<string, SoftwareWorkspace>();
  const key = (chainId: number, delivery: number) => `${chainId}:${delivery}`;
  const forget = (chainId: number, delivery: number) => void cache.delete(key(chainId, delivery));
  const historyRetentionDays = deps.config.historyRetentionDays ?? 30;
  const keptWorktreeMaxAgeMs = deps.config.keptWorktreeMaxAgeMs ?? 7 * 86_400_000;

  /** Deliveries whose workspace must survive a sweep: running jobs and recently dead-lettered (kept) ones. */
  function liveDeliveries(now: number): Set<string> {
    const rows = deps.db
      .prepare(
        `SELECT chain_id, delivery FROM jobs WHERE status = 'running'
         UNION
         SELECT j.chain_id, j.delivery FROM jobs j
           JOIN dead_letters d ON d.job_id = j.id
          WHERE j.status = 'failed' AND d.resolved_at IS NULL AND d.created_at > ?`,
      )
      .all(now - keptWorktreeMaxAgeMs) as Array<{ chain_id: number; delivery: number }>;
    return new Set(rows.map((r) => key(r.chain_id, r.delivery)));
  }

  const workspace: WorkspaceProvider = {
    async prepare(chain: ChainView<any>, job: Job): Promise<Workspace> {
      const ws = await deps.workspaces.prepare(chain, job);
      cache.set(key(chain.id, job.delivery), ws as SoftwareWorkspace);
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

    // Placeholder: implemented by Task 20.
    async buildRunInput() {
      throw new Error('buildRunInput is implemented in Task 20');
    },

    transition: softwareTransition,

    async runEffect(effect, ctx) {
      await runSoftwareEffect(
        effect,
        {
          chain: ctx.chain,
          job: ctx.job,
          workspace: cache.get(key(ctx.chain.id, ctx.job.delivery)) ?? null,
          host: deps.host,
          git: deps.git,
          sleep: deps.sleep,
          followups: { db: deps.db, now: deps.now },
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

    async cleanup(chain, job) {
      // The CURRENT status decides: only a dead-lettered job keeps its workspace (debugging).
      // A succeeded, aborted (still running, delivery lost) or stale delivery is removed.
      const row = deps.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined;
      const outcome = row?.status === 'failed' ? 'failed' : 'ok';
      forget(chain.id, job.delivery);
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
      await step(() => deps.workspaces.sweep(liveDeliveries(now)));
      if (errors.length > 0) throw errors[0];
    },

    forgetWorkspace: forget,
  };
}
