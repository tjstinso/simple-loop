import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  ChainView,
  DeadLetter,
  Effect,
  EffectFence,
  Engine,
  Job,
  RunEffectContext,
  Transition,
} from '../../src/kernel/types.js';
import type { Workspace } from '../../src/runner/types.js';

export interface EchoState {
  count: number;
}

export interface EchoOptions {
  /** Called for every effect before it is recorded; may throw or inspect the database. */
  onEffect?: (effect: Effect, fence: EffectFence, ctx: RunEffectContext<EchoState>) => void | Promise<void>;
  /** Called at the start of `transition`; may throw. */
  onTransition?: (chain: ChainView<EchoState>, job: Job, result: unknown) => void;
}

export interface EchoCalls {
  prepare: { chainId: number; jobId: number }[];
  buildRunInput: { chainId: number; jobId: number }[];
  transition: { chainId: number; jobId: number }[];
  effects: Effect[];
  cleanup: { chainId: number; jobId: number }[];
  surfaced: DeadLetter[];
}

export type EchoEngine = Engine<EchoState> & { calls: EchoCalls; notes: string[]; dir: string };

const EchoResult = z.object({ value: z.string() });

/**
 * A minimal engine for kernel tests. Each `echo` job's result `{ value }`
 * becomes a `note` effect; the chain runs two echo jobs and then completes.
 */
export function makeEchoEngine(id = 'echo', opts: EchoOptions = {}): EchoEngine {
  const calls: EchoCalls = {
    prepare: [],
    buildRunInput: [],
    transition: [],
    effects: [],
    cleanup: [],
    surfaced: [],
  };
  const notes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), `echo-engine-${id}-`));

  return {
    id,
    policyKinds: ['echo'],
    stateSchema: z.object({ count: z.number().int().nonnegative() }),
    resultSchemas: { echo: EchoResult },
    calls,
    notes,
    dir,

    async submit(input: unknown) {
      const { key } = z.object({ key: z.string().min(1) }).parse(input);
      return {
        subjectKey: `${id}:${key}`,
        state: { count: 0 },
        firstJob: { type: 'echo', attempt: 1, policyKind: 'echo', labels: [] },
      };
    },

    workspace: {
      async prepare(chain: ChainView<any>, job: Job): Promise<Workspace> {
        calls.prepare.push({ chainId: chain.id, jobId: job.id });
        return { path: dir };
      },
    },

    async buildRunInput(chain, job, workspace) {
      calls.buildRunInput.push({ chainId: chain.id, jobId: job.id });
      return { job, subject: { chainId: chain.id, count: chain.state.count }, workspace };
    },

    transition(chain, job, result): Transition<EchoState> {
      calls.transition.push({ chainId: chain.id, jobId: job.id });
      opts.onTransition?.(chain, job, result);
      const { value } = EchoResult.parse(result);
      const count = chain.state.count + 1;
      const more = count < 2;
      return {
        engineState: { count },
        chainStatus: more ? 'active' : 'completed',
        newJobs: more ? [{ type: 'echo', attempt: job.attempt + 1, policyKind: 'echo', labels: [] }] : [],
        effects: [{ kind: 'note', text: value }],
      };
    },

    async runEffect(effect, ctx) {
      calls.effects.push(effect);
      await opts.onEffect?.(effect, ctx.fence, ctx);
      if (effect.kind !== 'note') throw new Error(`echo: unknown effect kind ${effect.kind}`);
      notes.push(String(effect.text));
    },

    describe(chain) {
      return `${id}: ${chain.state.count} echo(es)`;
    },

    async surfaceDeadLetter(_chain, dl) {
      calls.surfaced.push(dl);
    },

    async cleanup(chain, job) {
      calls.cleanup.push({ chainId: chain.id, jobId: job.id });
    },
  };
}
