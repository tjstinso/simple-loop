import { StaleDeliveryError } from '../../kernel/types.js';
import type { GitHost } from './github.js';
import type { PendingReply, SoftwareState } from './state.js';

/** What posting replies needs from its caller: the host, redaction, the retry policy and reporting. */
export interface ReplyEnv {
  host: GitHost;
  repo: string;
  chainId: number;
  /** The pull request the feedback is on. */
  pr: number;
  /** The pull request head at posting time: `changed` replies name its short sha. */
  headSha: string;
  /** Secret redaction of agent text. */
  redact(text: string): string;
  /** Mentions and closing keywords made harmless, text capped (agent text goes to GitHub). */
  neutralize(text: string): string;
  /** Retries a host call on transient errors. */
  retry<T>(fn: () => Promise<T>): Promise<T>;
  /** Throws StaleDeliveryError when this delivery no longer owns the job; no-op outside a job. */
  assertCurrent(): void;
  events(kind: string, detail?: Record<string, unknown>): void;
  onError(err: unknown, context: string): void;
}

export type RepliesState = Pick<SoftwareState, 'pendingReplies' | 'pendingUnanswered'>;

/** Hidden marker of the reply to one original comment or review: it makes the reply post only once. */
export const replyMarker = (r: Pick<PendingReply, 'kind' | 'numId'>): string =>
  `<!-- factory:reply ${r.kind === 'review' ? 'review' : 'comment'}=${r.numId} -->`;

const noAnswerMarker = (chainId: number, round: number): string => `<!-- factory:chain=${chainId} event=feedback-no-answer-${round} -->`;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Posts the answers of a feedback round, as the factory identity: a threaded reply for an inline
 * comment, one quoting conversation comment for a conversation comment or a review body, and a
 * resolved thread for `changed` and `explained` inline answers (`declined` stays open). A reply whose
 * marker is already on the pull request is not posted again, an already resolved thread is left
 * alone. Failures never throw (StaleDeliveryError aside): they are reported and the item stays in the
 * returned state for the next maintenance pass. Items the agent did not answer are named in one comment.
 */
export async function postFeedbackReplies(
  env: ReplyEnv,
  replies: readonly PendingReply[],
  unanswered: { round: number; ids: string[] } | undefined,
): Promise<{ pendingReplies: PendingReply[]; pendingUnanswered: { round: number; ids: string[] } }> {
  const fail = (what: string, id: string, e: unknown) => {
    if (e instanceof StaleDeliveryError) throw e;
    env.onError(e, `feedback reply: ${what}`);
    env.events('feedback.reply_failed', { id, error: oneLine(env.redact(e instanceof Error ? e.message : String(e))) });
  };
  const bodiesOnPr = async (): Promise<string[]> => {
    const f = await env.host.listPrFeedback(env.repo, env.pr);
    return [...f.reviewComments.map((c) => c.body), ...f.comments.map((c) => c.body)];
  };

  const remaining: PendingReply[] = [];
  let known: string[] | null = null;
  if (replies.length > 0) {
    try {
      known = await env.retry(bodiesOnPr);
    } catch (e) {
      fail('listing the pull request', replies[0]!.id, e);
      return { pendingReplies: replies.map((r) => stamp(r, env)), pendingUnanswered: unanswered ?? { round: 0, ids: [] } };
    }
  }

  for (const r of replies) {
    const item = stamp(r, env);
    try {
      const marker = replyMarker(item);
      let looked = false;
      const posted = await env.retry(async () => {
        // The first attempt trusts the listing made above; a retry looks again (the call may have landed).
        const present = looked ? (await bodiesOnPr()).some((b) => b.includes(marker)) : (known ?? []).some((b) => b.includes(marker));
        if (present) return false;
        looked = true;
        env.assertCurrent();
        const text = env.neutralize(env.redact(item.reply));
        const sha = item.action === 'changed' && item.sha ? ` (commit ${item.sha})` : '';
        if (item.kind === 'inline') {
          await env.host.replyToReviewComment(env.repo, env.pr, item.numId, `${text}${sha}\n\n${marker}`);
        } else {
          const quote = env.neutralize(env.redact(item.quote));
          await env.host.comment(env.repo, env.pr, `> ${quote}\n\n${text}${sha}\n\n${marker}`);
        }
        return true;
      });
      if (posted) env.events('feedback.replied', { id: item.id, action: item.action });
      if (item.kind === 'inline' && item.action !== 'declined') await resolveThreadOf(env, item.numId);
    } catch (e) {
      fail('posting', item.id, e);
      remaining.push(item);
    }
  }

  let left = { round: unanswered?.round ?? 0, ids: [] as string[] };
  if (unanswered && unanswered.ids.length > 0) {
    const marker = noAnswerMarker(env.chainId, unanswered.round);
    try {
      await env.retry(async () => {
        if (await env.host.findComment(env.repo, env.pr, marker)) return;
        env.assertCurrent();
        await env.host.comment(
          env.repo,
          env.pr,
          `The factory produced no answer for: ${unanswered.ids.join(', ')}. These items are not replied to and their threads stay unresolved.\n\n${marker}`,
        );
      });
    } catch (e) {
      fail('naming unanswered items', unanswered.ids.join(', '), e);
      left = { round: unanswered.round, ids: unanswered.ids };
    }
  }
  return { pendingReplies: remaining, pendingUnanswered: left };
}

/** The head sha is fixed on the first attempt, so a retry names the commit that was pushed then. */
function stamp(r: PendingReply, env: ReplyEnv): PendingReply {
  return r.action === 'changed' && r.sha === undefined && env.headSha !== '' ? { ...r, sha: env.headSha.slice(0, 7) } : r;
}

/** Resolves the review thread holding the comment; a missing or already resolved thread is a no-op. */
async function resolveThreadOf(env: ReplyEnv, commentId: number): Promise<void> {
  const threads = await env.retry(() => env.host.listReviewThreads(env.repo, env.pr));
  const thread = threads.find((t) => t.commentIds.includes(commentId));
  if (!thread || thread.resolved) return;
  env.assertCurrent();
  await env.retry(() => env.host.resolveReviewThread(env.repo, thread.id));
  env.events('feedback.resolved', { thread: thread.id });
}
