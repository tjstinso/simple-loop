import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fileFollowups, storeFollowups } from './followups.js';
import { EffectError, type ChainView, type Effect, type EffectFence, type Job } from '../../kernel/types.js';
import { GitHostError, type GitHost } from './github.js';
import type { GitPorts } from './git-ports.js';
import type { SoftwareEffect } from './schemas.js';
import type { SoftwareState } from './state.js';
import type { SoftwareWorkspace } from './workspace.js';

export interface EffectContext {
  chain: ChainView<SoftwareState>;
  job: Job;
  /** Null when post-processing resumed in a new delivery whose workspace was never prepared. */
  workspace: SoftwareWorkspace | null;
  host: GitHost;
  git: GitPorts;
  /** Injectable backoff delay (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Required by the file_followups effect only. */
  followups?: { db: Database.Database; now: () => number };
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

const Target = z.enum(['issue', 'pr']);
const EffectSchemas = {
  commit_push: z.object({ kind: z.literal('commit_push') }),
  open_pr: z.object({ kind: z.literal('open_pr') }),
  set_labels: z.object({ kind: z.literal('set_labels'), target: Target, add: z.array(z.string()), remove: z.array(z.string()) }),
  merge_pr: z.object({ kind: z.literal('merge_pr') }),
  comment: z.object({ kind: z.literal('comment'), target: Target, body: z.string(), marker: z.string().min(1) }),
} as const;
type Supported = Exclude<SoftwareEffect, { kind: 'file_followups' }>;

function parse(effect: Effect): Supported {
  const kind = effect?.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(EffectSchemas, kind)) {
    throw new Error(`unsupported effect: ${String(kind)}`);
  }
  const r = EffectSchemas[kind as keyof typeof EffectSchemas].safeParse(effect);
  if (!r.success) throw new Error(`invalid ${kind} effect: ${r.error.message}`);
  return r.data as Supported;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isTransient = (e: GitHostError) => e.status === undefined || e.status === 429 || e.status >= 500;

/**
 * Host failure classification. Retries the whole (check-before-act) effect body on a
 * transient GitHostError, so a retried mutation always looks again first and a call that
 * succeeded server-side but failed client-side is not repeated. 4xx fails immediately.
 * StaleDeliveryError, EffectError and non-GitHostError exceptions propagate unchanged.
 */
async function classified(ctx: EffectContext, body: () => Promise<void>): Promise<void> {
  const sleep = ctx.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await body();
    } catch (e) {
      if (!(e instanceof GitHostError)) throw e;
      if (!isTransient(e) || attempt >= MAX_ATTEMPTS) throw new EffectError(e.message, 'effect_error');
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

function requireWorkspace(ctx: EffectContext): SoftwareWorkspace {
  if (!ctx.workspace) throw new EffectError('workspace for this delivery is gone; retry will rerun the agent', 'runner_error');
  return ctx.workspace;
}

/** One line, no control characters, bounded: issue titles are untrusted. */
function oneLine(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function summaryOf(job: Job): string | null {
  const r = job.result;
  if (r && typeof r === 'object' && typeof (r as { summary?: unknown }).summary === 'string') {
    const s = (r as { summary: string }).summary.trim();
    return s === '' ? null : s;
  }
  return null;
}

async function prNumber(ctx: EffectContext, missing: string): Promise<number> {
  const { repo, branch } = ctx.chain.state;
  const pr = await ctx.host.findPrByHead(repo, branch);
  if (!pr) throw new EffectError(missing, 'effect_error');
  return pr.number;
}

async function targetNumber(ctx: EffectContext, target: 'issue' | 'pr', missing: string): Promise<number> {
  return target === 'issue' ? ctx.chain.state.issueNumber : prNumber(ctx, missing);
}

async function commitPush(ctx: EffectContext, fence: EffectFence): Promise<void> {
  const ws = requireWorkspace(ctx);
  const { repo, issueNumber, branch } = ctx.chain.state;
  const issue = await ctx.host.getIssue(repo, issueNumber);
  const title = oneLine(issue.title) || `#${issueNumber}`;
  await ctx.git.commitAll(ws, `factory: ${title} (attempt ${ctx.job.attempt})`);
  if ((await ctx.git.headSha(ws)) === ws.seedSha) {
    // Nothing new in this delivery. If the branch was already published (e.g. a rerun after a
    // crash that followed the push), the work is on the remote: succeed so open_pr can proceed.
    if (ws.remoteHeadSha !== null) return;
    throw new EffectError('no changes produced', 'runner_error');
  }
  fence.assertCurrent();
  await ctx.git.push(ws, { remoteBranch: branch, expectSha: ws.remoteHeadSha });
}

async function openPr(ctx: EffectContext, fence: EffectFence): Promise<void> {
  const ws = requireWorkspace(ctx);
  const { repo, issueNumber, branch } = ctx.chain.state;
  const existing = await ctx.host.findPrByHead(repo, branch);
  if (existing?.state === 'open') return;
  const issue = await ctx.host.getIssue(repo, issueNumber);
  const summary = summaryOf(ctx.job);
  const marker = `<!-- factory:chain=${ctx.chain.id} job=${ctx.job.id} event=open-pr -->`;
  const body = [`Closes #${issueNumber}`, ...(summary ? [summary] : []), marker].join('\n\n');
  fence.assertCurrent();
  await ctx.host.openPr(repo, { head: branch, base: ws.baseBranch, title: oneLine(issue.title) || `#${issueNumber}`, body });
}

async function setLabels(ctx: EffectContext, fence: EffectFence, e: Extract<Supported, { kind: 'set_labels' }>): Promise<void> {
  const n = await targetNumber(ctx, e.target, 'no PR found for label target');
  fence.assertCurrent();
  await ctx.host.setLabels(ctx.chain.state.repo, n, e.add, e.remove);
}

async function mergePr(ctx: EffectContext, fence: EffectFence): Promise<void> {
  const { repo, branch } = ctx.chain.state;
  const pr = await ctx.host.findPrByHead(repo, branch);
  if (!pr) throw new EffectError('no PR found to merge', 'effect_error');
  if (pr.state === 'merged') return;
  if (pr.state === 'closed') throw new EffectError('PR is closed and cannot be merged', 'effect_error');
  fence.assertCurrent();
  try {
    await ctx.host.mergePr(repo, pr.number);
  } catch (err) {
    if (err instanceof GitHostError && (err.status === 405 || err.status === 409)) {
      throw new EffectError(`merge refused: ${err.message}`, 'effect_error');
    }
    throw err;
  }
}

async function comment(ctx: EffectContext, fence: EffectFence, e: Extract<Supported, { kind: 'comment' }>): Promise<void> {
  const { repo } = ctx.chain.state;
  const n = await targetNumber(ctx, e.target, 'no PR found for comment target');
  if (await ctx.host.findComment(repo, n, e.marker)) return;
  fence.assertCurrent();
  await ctx.host.comment(repo, n, `${e.body}\n\n${e.marker}`);
}

const FollowupsEffect = z.object({
  kind: z.literal('file_followups'),
  followups: z.array(z.object({ title: z.string(), body: z.string() })),
});

/**
 * Stores, then files. Deliberately outside `classified`: GitHostErrors are absorbed per item
 * (rows stay unfiled for the sweep), so this effect never fails the job; StaleDeliveryError and
 * bugs propagate. Replaying after a crash at any point never duplicates rows or issues.
 */
async function fileFollowupsEffect(effect: Effect, ctx: EffectContext, fence: EffectFence): Promise<void> {
  const r = FollowupsEffect.safeParse(effect);
  if (!r.success) throw new Error(`invalid file_followups effect: ${r.error.message}`);
  if (!ctx.followups) throw new Error('file_followups needs a database');
  fence.assertCurrent();
  const { db, now } = ctx.followups;
  const { repo, issueNumber } = ctx.chain.state;
  storeFollowups(db, { jobId: ctx.job.id, chainId: ctx.chain.id, repo, issueNumber }, r.data.followups, now());
  await fileFollowups(db, ctx.host, ctx.job.id, now(), () => fence.assertCurrent());
}

/**
 * Runs one software effect: idempotent (looks before acting), fenced (the fence is checked
 * at the start and again immediately before each externally visible mutation), with host
 * failures classified into EffectError reasons. StaleDeliveryError always propagates.
 */
export async function runSoftwareEffect(effect: Effect, ctx: EffectContext, fence: EffectFence): Promise<void> {
  if (effect?.kind === 'file_followups') return fileFollowupsEffect(effect, ctx, fence);
  const e = parse(effect);
  fence.assertCurrent();
  await classified(ctx, () => {
    switch (e.kind) {
      case 'commit_push':
        return commitPush(ctx, fence);
      case 'open_pr':
        return openPr(ctx, fence);
      case 'set_labels':
        return setLabels(ctx, fence, e);
      case 'merge_pr':
        return mergePr(ctx, fence);
      case 'comment':
        return comment(ctx, fence, e);
    }
  });
}
