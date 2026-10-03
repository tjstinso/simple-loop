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
  config: { defaultProfile: 'supervised' | 'automatic'; requiredSections: string[] };
  sleep?: (ms: number) => Promise<void>;
}

export const LABEL_DEAD_LETTER = 'factory:dead-letter';

export type SoftwareEngine = Engine<SoftwareState> & {
  /** Evicts the cached workspace of one delivery (used by cleanup). */
  forgetWorkspace(chainId: number, delivery: number): void;
};

export function createSoftwareEngine(deps: SoftwareEngineDeps): SoftwareEngine {
  const cache = new Map<string, SoftwareWorkspace>();
  const key = (chainId: number, delivery: number) => `${chainId}:${delivery}`;

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

    // Placeholder: implemented by Task 19.
    cleanup: async () => {},

    forgetWorkspace(chainId, delivery) {
      cache.delete(key(chainId, delivery));
    },
  };
}
