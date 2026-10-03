import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fileFollowups, storeFollowups } from './followups.js';
import { EffectError, StaleDeliveryError, type ChainView, type Effect, type EffectFence, type Job } from '../../kernel/types.js';
import { GitHostError, type GitHost, type Issue } from './github.js';
import type { GitPorts } from './git-ports.js';
import type { SoftwareEffect } from './schemas.js';
import { findingsOf, redactSecrets, scanPaths, scanText, SCAN_TRUNCATED_KIND } from './secret-scan.js';
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
  /**
   * Exact secret values the secret guard looks for in what `commit_push` would push, and redacts from
   * the commit message and the PR title and body (default: none, so only the patterns apply).
   */
  secretValues?: () => readonly string[];
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

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A pinned merge the host refused (or that kept failing): classified `runner_error` by `classified`. */
class PinnedMergeRefusedError extends GitHostError {
  constructor(cause: GitHostError) {
    super(cause.message, cause.status);
    this.name = 'PinnedMergeRefusedError';
  }
}

const isTransient = (e: GitHostError) => e.status === undefined || e.status === 429 || e.status >= 500;

/**
 * The host retry policy shared by effects and run-input building: `fn` is retried on a transient
 * GitHostError (no status, 429, 5xx) up to 3 attempts with 100 ms and 200 ms backoff. A 4xx, the
 * last transient failure and any other exception propagate unchanged.
 */
export async function withHostRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof GitHostError) || !isTransient(e) || attempt >= MAX_ATTEMPTS) throw e;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/**
 * Host failure classification. Retries the whole (check-before-act) effect body on a
 * transient GitHostError (withHostRetry), so a retried mutation always looks again first and a call
 * that succeeded server-side but failed client-side is not repeated. 4xx fails immediately. A final
 * GitHostError becomes EffectError(effect_error), except a refused pinned merge, which becomes
 * runner_error so one retry redoes the review on the current head (R46); StaleDeliveryError,
 * EffectError and non-GitHostError exceptions propagate unchanged.
 */
async function classified(ctx: EffectContext, body: () => Promise<void>): Promise<void> {
  try {
    await withHostRetry(body, ctx.sleep ?? defaultSleep);
  } catch (e) {
    if (e instanceof PinnedMergeRefusedError) throw new EffectError(`merge refused for the reviewed head: ${e.message}`, 'runner_error');
    if (e instanceof GitHostError) throw new EffectError(e.message, 'effect_error');
    throw e;
  }
}

/** The issue was closed while the chain ran: nothing more is published for it. Always `effect_error`. */
export class IssueClosedError extends EffectError {
  constructor(issueNumber: number) {
    super(`issue #${issueNumber} is closed`, 'effect_error');
    this.name = 'IssueClosedError';
  }
}

/** Re-reads the issue (inside the effect's retry wrapper) and refuses to continue when it is closed. */
async function openIssue(ctx: EffectContext): Promise<Issue> {
  const { repo, issueNumber } = ctx.chain.state;
  const issue = await ctx.host.getIssue(repo, issueNumber);
  if (issue.state !== 'open') throw new IssueClosedError(issueNumber);
  return issue;
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

const SUMMARY_MAX = 2000;
const ZERO_WIDTH_SPACE = '\u200b';
// GitHub closing keywords followed by an issue reference; the agent must not close other issues.
const CLOSING_REF = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+)#(?=\d)/gi;

/**
 * The agent's summary is untrusted text that goes into the PR body: cap it at 2000 characters, turn
 * every `@` into `@` + zero-width space (no mentions or team pings) and put a zero-width space after
 * the `#` of every closing-keyword reference (`Fixes #12` would close issue 12 on merge).
 */
export function neutralizeSummary(s: string): string {
  const capped = s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
  return capped.replaceAll('@', `@${ZERO_WIDTH_SPACE}`).replace(CLOSING_REF, `$1$2#${ZERO_WIDTH_SPACE}`);
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

const secretValuesOf = (ctx: EffectContext): readonly string[] => ctx.secretValues?.() ?? [];

/**
 * The secret guard: refuses (runner_error, nothing pushed) when what a push of HEAD would publish
 * beyond the seed has a secret-looking file name, a line matching a known token pattern or an exact
 * secret value, or was too large to scan whole. The message names only the kinds, never the text.
 */
async function assertNoSecrets(ctx: EffectContext, ws: SoftwareWorkspace, sha: string): Promise<void> {
  const changes = await ctx.git.addedChanges(ws, sha);
  const values = secretValuesOf(ctx);
  const kinds = [
    ...scanPaths(changes.paths),
    ...scanText(changes.paths.join('\n'), values),
    ...scanText(changes.text, values),
    // UTF-16 text (and other NUL-padded encodings) only matches once the NUL bytes are gone.
    ...(changes.text.includes('\0') ? scanText(changes.text.replaceAll('\0', ''), values) : []),
    ...(changes.truncated ? [{ kind: SCAN_TRUNCATED_KIND }] : []),
  ].map((f) => f.kind);
  if (kinds.length === 0) return;
  const list = findingsOf(kinds).map((f) => f.kind).join(', ');
  throw new EffectError(`refusing to push: the change contains a secret (${list}); the matched text is not shown`, 'runner_error');
}

/** An issue title for a commit message or PR title: one line, secrets redacted. */
function titleOf(ctx: EffectContext, issue: Issue): string {
  return oneLine(redactSecrets(issue.title, secretValuesOf(ctx))) || `#${ctx.chain.state.issueNumber}`;
}

async function commitPush(ctx: EffectContext, fence: EffectFence): Promise<void> {
  const ws = requireWorkspace(ctx);
  const { repo, issueNumber, branch } = ctx.chain.state;
  const issue = await ctx.host.getIssue(repo, issueNumber);
  const title = titleOf(ctx, issue);
  // The agent could have written the shared repository config: sanitize before any engine git command.
  await ctx.git.prepareForPush?.(ws);
  await ctx.git.commitAll(ws, `factory: ${title} (attempt ${ctx.job.attempt})`);
  // Pinned: the push sends exactly the commit that was scanned, even if HEAD moves meanwhile.
  const head = await ctx.git.headSha(ws);
  if (head === ws.seedSha) {
    // Nothing new in this delivery. If the branch was already published (e.g. a rerun after a
    // crash that followed the push), the work is on the remote: succeed so open_pr can proceed.
    if (ws.remoteHeadSha !== null) return;
    throw new EffectError('no changes produced', 'runner_error');
  }
  await assertNoSecrets(ctx, ws, head);
  fence.assertCurrent();
  try {
    await ctx.git.push(ws, { sha: head, remoteBranch: branch, expectSha: ws.remoteHeadSha });
  } catch (e) {
    if (!(e instanceof StaleDeliveryError)) throw e;
    // The lease was rejected: the branch moved since this delivery was seeded. If a newer delivery
    // owns the job (a zombie), assertCurrent throws StaleDeliveryError and nothing is written. If this
    // delivery is still current, someone else moved the branch (a human push, another chain): fail
    // the job now instead of leaving it running until its lease expires.
    fence.assertCurrent();
    throw new EffectError('remote branch moved by someone else', 'runner_error');
  }
}

async function openPr(ctx: EffectContext, fence: EffectFence): Promise<void> {
  const ws = requireWorkspace(ctx);
  const { repo, issueNumber, branch } = ctx.chain.state;
  const issue = await openIssue(ctx);
  const existing = await ctx.host.findPrByHead(repo, branch);
  if (existing?.state === 'open') return;
  const summary = summaryOf(ctx.job);
  const marker = `<!-- factory:chain=${ctx.chain.id} job=${ctx.job.id} event=open-pr -->`;
  // Redacted before neutralizing and capping, so a secret is never cut in half and kept.
  const safeSummary = summary ? neutralizeSummary(redactSecrets(summary, secretValuesOf(ctx))) : null;
  const body = [`Closes #${issueNumber}`, ...(safeSummary ? [safeSummary] : []), marker].join('\n\n');
  fence.assertCurrent();
  await ctx.host.openPr(repo, { head: branch, base: ws.baseBranch, title: titleOf(ctx, issue), body });
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
  // `automatic` must not merge code for an issue someone closed meanwhile.
  await openIssue(ctx);
  // The merge is pinned to the head the reviewer saw: the review delivery was seeded from it. Without
  // the workspace (crash resume, effect_error retry) that head is unknown: never merge unpinned. A
  // runner_error dead letter clears the verdict on retry, so the review reruns on the current head.
  if (!ctx.workspace) throw new EffectError('cannot verify the reviewed head; the review will be redone', 'runner_error');
  fence.assertCurrent();
  try {
    await ctx.host.mergePr(repo, pr.number, { expectHeadSha: ctx.workspace.seedSha });
  } catch (err) {
    // Still a GitHostError (same status), so a transient one is retried before `classified` turns it
    // into runner_error (real gh reports a refused pinned merge without an HTTP status).
    if (err instanceof GitHostError) throw new PinnedMergeRefusedError(err);
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
 * bugs propagate. Rows are stored with INSERT OR IGNORE (replays never duplicate rows). Each row is
 * claimed (time-limited, atomic) before filing so a concurrent sweep or another worker skips it, and
 * the marker lookup before createIssue covers a crash after create but before record. A claim that
 * outlives its TTL (crashed filer) can be taken over, so duplicates are prevented, not merely unlikely,
 * except when a filer stalls past the TTL.
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
 * The effects that publish from the delivery's workspace. When one of them fails for an execute job,
 * its retry must rerun the agent: a retry that kept the result would skip `prepare`, find no
 * workspace and fail again. So their git and host failures are `runner_error` (retry clears the
 * result), not `effect_error` (retry keeps it). StaleDeliveryError still propagates unchanged.
 */
const WORKSPACE_EFFECTS = new Set(['commit_push', 'open_pr']);

async function asRunnerError(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    // A closed issue is not something a rerun of the agent can fix (R38): it stays effect_error.
    if (e instanceof StaleDeliveryError || e instanceof IssueClosedError) throw e;
    if (e instanceof EffectError) {
      if (e.reason === 'runner_error') throw e;
      throw new EffectError(e.message, 'runner_error');
    }
    throw new EffectError(e instanceof Error ? e.message : String(e), 'runner_error');
  }
}

/**
 * Runs one software effect: idempotent (looks before acting), fenced (the fence is checked
 * at the start and again immediately before each externally visible mutation), with host
 * failures classified into EffectError reasons (`commit_push` and `open_pr` of an execute job fail
 * as `runner_error`, see WORKSPACE_EFFECTS; so does a `merge_pr` with no reviewed head to pin or
 * whose pinned merge is refused, R46). StaleDeliveryError always propagates.
 */
export async function runSoftwareEffect(effect: Effect, ctx: EffectContext, fence: EffectFence): Promise<void> {
  if (effect?.kind === 'file_followups') return fileFollowupsEffect(effect, ctx, fence);
  const e = parse(effect);
  fence.assertCurrent();
  const run = () => runClassified(e, ctx, fence);
  if (ctx.job.type === 'execute' && WORKSPACE_EFFECTS.has(e.kind)) return asRunnerError(run);
  return run();
}

async function runClassified(e: Supported, ctx: EffectContext, fence: EffectFence): Promise<void> {
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
