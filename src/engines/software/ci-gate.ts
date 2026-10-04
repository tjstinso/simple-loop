import type Database from 'better-sqlite3';
import { recordEvent } from '../../kernel/events.js';
import type { ChainView, ReconcileOutcome } from '../../kernel/types.js';
import { buildCiFailureFeedback, evaluateCi, failingNames, isFailing, jobIdOf } from './ci.js';
import { isTransient, withHostRetry } from './effects.js';
import { GitHostError, type Check, type ChecksStatus, type GitHost, type Pr } from './github.js';
import { PROFILES } from './profiles.js';
import { LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN } from './schemas.js';
import type { SoftwareState } from './state.js';
import { withoutCi } from './transition.js';

export interface CiGateDeps {
  host: GitHost;
  db: Database.Database;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Agent- and CI-written text on its way to GitHub, an event or a job payload: secrets redacted. */
  redact: (text: string) => string;
}

const none: ReconcileOutcome = { outcome: 'none' };

/**
 * The CI gate of the maintenance pass. In `awaiting_ci` (automatic profile) it reads the checks of the
 * reviewed head and merges (pinned to that head), keeps waiting, asks for a revision or hands over to
 * a person. In `awaiting_merge` (supervised profile) it only posts the CI result once. Every
 * side effect looks before it acts, so a pass that is repeated or raced posts and merges nothing twice.
 */
export function createCiGate(deps: CiGateDeps) {
  const { host, db, redact } = deps;

  const event = (chain: ChainView<SoftwareState>, kind: string, detail: Record<string, unknown>) =>
    recordEvent(db, { at: deps.now(), chainId: chain.id, kind, engine: 'software', detail });

  const lastEvent = (chainId: number, kind: string): Record<string, unknown> | null => {
    const row = db
      .prepare(`SELECT detail FROM events WHERE chain_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
      .get(chainId, kind) as { detail: string } | undefined;
    return row ? (JSON.parse(row.detail) as Record<string, unknown>) : null;
  };
  const lastCiKind = (chainId: number): { kind: string; detail: Record<string, unknown> } | null => {
    const row = db
      .prepare(`SELECT kind, detail FROM events WHERE chain_id = ? AND kind LIKE 'ci.%' ORDER BY id DESC LIMIT 1`)
      .get(chainId) as { kind: string; detail: string } | undefined;
    return row ? { kind: row.kind, detail: JSON.parse(row.detail) as Record<string, unknown> } : null;
  };

  const names = (failing: readonly Check[]) => failingNames(failing).map(redact);

  /** Records `ci.checked` when the result differs from the last one recorded for this chain. */
  function recordChecked(chain: ChainView<SoftwareState>, sha: string, checks: ChecksStatus): void {
    const failing = names(checks.checks.filter(isFailing));
    const detail = { sha, state: checks.state, failing };
    const prev = lastEvent(chain.id, 'ci.checked');
    if (prev && prev.sha === sha && prev.state === detail.state && JSON.stringify(prev.failing) === JSON.stringify(failing)) return;
    event(chain, 'ci.checked', detail);
  }

  async function commentOnce(chain: ChainView<SoftwareState>, prNumber: number, marker: string, text: string): Promise<void> {
    const { repo } = chain.state;
    await withHostRetry(async () => {
      if (await host.findComment(repo, prNumber, marker)) return;
      await host.comment(repo, prNumber, `${redact(text)}\n\n${marker}`);
    }, deps.sleep);
  }

  async function needsHuman(chain: ChainView<SoftwareState>, pr: Pr, marker: string, text: string, reason: string): Promise<ReconcileOutcome> {
    const s = chain.state;
    await commentOnce(chain, pr.number, marker, text);
    await withHostRetry(async () => {
      await host.setLabels(s.repo, pr.number, [LABEL_NEEDS_HUMAN], [LABEL_IN_PROGRESS]);
      await host.setLabels(s.repo, s.issueNumber, [], [LABEL_IN_PROGRESS]);
    }, deps.sleep);
    return {
      outcome: 'update',
      state: { ...withoutCi(s), phase: 'needs_human' } satisfies SoftwareState,
      status: 'waiting',
      newJobs: [],
      reason,
    };
  }

  /** The last lines of the log of every failing GitHub Actions job; a log that cannot be read is skipped. */
  async function logsOf(repo: string, failing: readonly Check[]): Promise<Record<string, string>> {
    const logs: Record<string, string> = {};
    for (const c of failing.slice(0, 5)) {
      const id = jobIdOf(c.detailsUrl);
      if (id === null) continue;
      try {
        const log = await host.getJobLog(repo, id);
        if (log !== null) logs[c.name] = log;
      } catch {
        // No excerpt: the feedback still names the check, its conclusion and its URL.
      }
    }
    return logs;
  }

  async function merge(chain: ChainView<SoftwareState>, pr: Pr, sha: string): Promise<ReconcileOutcome> {
    const s = chain.state;
    const issue = await withHostRetry(() => host.getIssue(s.repo, s.issueNumber), deps.sleep);
    // `automatic` must not merge code for an issue someone closed meanwhile.
    if (issue.state !== 'open') return { outcome: 'cancelled', reason: `Issue #${s.issueNumber} was closed; this chain was cancelled` };
    event(chain, 'merge.requested', { pr: pr.number });
    try {
      await withHostRetry(() => host.mergePr(s.repo, pr.number, { expectHeadSha: sha }), deps.sleep);
    } catch (e) {
      if (!(e instanceof GitHostError)) throw e;
      // A refused pinned merge: when the head moved, nobody reviewed what is there now.
      const now = await host.getPr(s.repo, pr.number);
      if (now.headSha !== sha) {
        return needsHuman(
          chain,
          pr,
          `<!-- factory:chain=${chain.id} event=ci-head-moved sha=${sha} -->`,
          `The pull request head changed after the review (reviewed ${sha.slice(0, 7)}, now ${now.headSha.slice(0, 7)}), so the factory did not merge it. A person needs to look at it.`,
          'the head moved after the review',
        );
      }
      if (isTransient(e)) return none;
      throw e;
    }
    return { outcome: 'completed', reason: `CI passed on ${sha.slice(0, 7)} and pull request #${pr.number} was merged` };
  }

  async function gate(chain: ChainView<SoftwareState>, pr: Pr): Promise<ReconcileOutcome> {
    const s = chain.state;
    const { reviewedSha: sha, ci } = s;
    if (!sha || !ci) throw new Error(`chain ${chain.id} is awaiting CI without a reviewed head or a CI policy`);
    // Checks of exactly the reviewed head, never of the branch's current one.
    const checks = await withHostRetry(() => host.getChecks(s.repo, sha), deps.sleep);
    recordChecked(chain, sha, checks);
    const waitedMs = deps.now() - (s.ciSince ?? deps.now());
    const d = evaluateCi(checks, ci, waitedMs);
    switch (d.action) {
      case 'merge':
        return merge(chain, pr, sha);
      case 'wait': {
        const last = lastCiKind(chain.id);
        if (!(last?.kind === 'ci.waiting' && last.detail.sha === sha)) {
          event(chain, 'ci.waiting', { sha, since: s.ciSince ?? null, waitMinutes: ci.waitMinutes });
        }
        return none;
      }
      case 'timeout':
        event(chain, 'ci.timeout', { sha, waitMinutes: ci.waitMinutes });
        return needsHuman(
          chain,
          pr,
          `<!-- factory:chain=${chain.id} event=ci-timeout sha=${sha} -->`,
          `CI did not finish within ${ci.waitMinutes} minutes for ${sha.slice(0, 7)}, so the factory did not merge this pull request. A person needs to look at it.`,
          `CI did not finish within ${ci.waitMinutes} minutes`,
        );
      case 'hold': {
        event(chain, 'ci.failed', { sha, action: 'hold', failing: names(d.failing), reason: d.reason });
        return needsHuman(
          chain,
          pr,
          `<!-- factory:chain=${chain.id} event=ci-hold sha=${sha} -->`,
          `The factory did not merge this pull request: ${d.reason}.${d.failing.length ? `\n\nFailing checks: ${names(d.failing).join(', ')}` : ''}`,
          d.reason,
        );
      }
      case 'revise': {
        const attempt = s.attempt + 1;
        const revise = s.attempt < PROFILES[s.profile].maxAttempts;
        event(chain, 'ci.failed', { sha, action: revise ? 'revise' : 'needs_human', failing: names(d.failing), attempt: s.attempt });
        if (!revise) {
          return needsHuman(
            chain,
            pr,
            `<!-- factory:chain=${chain.id} event=ci-failed sha=${sha} -->`,
            `CI failed on ${sha.slice(0, 7)} and the factory used all ${s.attempt} attempts. Failing checks: ${names(d.failing).join(', ')}`,
            `CI failed after ${s.attempt} attempts`,
          );
        }
        const feedback = buildCiFailureFeedback(d.failing, await logsOf(s.repo, d.failing), redact);
        return {
          outcome: 'update',
          state: { ...withoutCi(s), attempt, phase: 'executing' } satisfies SoftwareState,
          status: 'active',
          newJobs: [{ type: 'execute', attempt, policyKind: 'execute', labels: [...s.labels], payload: { feedback } }],
          reason: `CI failed on ${sha.slice(0, 7)}: ${names(d.failing).join(', ')}`,
        };
      }
    }
  }

  /** Supervised profile: the CI result of the reviewed head, posted once as a comment on the pull request. */
  async function report(chain: ChainView<SoftwareState>, pr: Pr): Promise<ReconcileOutcome> {
    const s = chain.state;
    const sha = s.reviewedSha;
    if (!sha || !s.ci) return none;
    const marker = `<!-- factory:chain=${chain.id} event=ci-result sha=${sha} -->`;
    if (await withHostRetry(() => host.findComment(s.repo, pr.number, marker), deps.sleep)) return none;
    const checks = await withHostRetry(() => host.getChecks(s.repo, sha), deps.sleep);
    recordChecked(chain, sha, checks);
    // Still pending (or no checks yet): the comment follows when the state changes.
    if (checks.state !== 'passing' && checks.state !== 'failing') return none;
    const lines = checks.checks.map((c) => `- ${redact(c.name)}: ${c.conclusion ?? c.status}${c.detailsUrl ? ` (${c.detailsUrl})` : ''}`);
    await commentOnce(chain, pr.number, marker, `CI ${checks.state} on ${sha.slice(0, 7)}:\n\n${lines.join('\n')}`);
    return none;
  }

  return {
    /** The reconcile answer for an open pull request of a chain in `awaiting_ci` or `awaiting_merge`. */
    async check(chain: ChainView<SoftwareState>, pr: Pr): Promise<ReconcileOutcome> {
      try {
        if (chain.state.phase === 'awaiting_ci') return await gate(chain, pr);
        if (chain.state.phase === 'awaiting_merge') return await report(chain, pr);
        return none;
      } catch (e) {
        // Transient host failure: the next maintenance pass retries.
        if (e instanceof GitHostError && isTransient(e)) return none;
        throw e;
      }
    },
  };
}
