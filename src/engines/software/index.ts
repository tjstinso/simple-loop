import type Database from 'better-sqlite3';
import { recordEvent } from '../../kernel/events.js';
import { pruneFiledFollowups, sweepUnfiledFollowups } from './followups.js';
import {
  EffectError,
  HandBackError,
  type ChainView,
  type DeadLetter,
  type Engine,
  type Job,
  type ReconcileOutcome,
  type WorkspaceProvider,
} from '../../kernel/types.js';
import type { PolicyStore } from '../../policy/store.js';
import type { Workspace } from '../../runner/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINE_TAIL_LINES, BaselineFailingError, buildToolEnv, buildVerifyFeedback, runCommand,
  type BaselineEntry, type RepoToolSettings,
} from './tool-run.js';
import { depCacheKey, isStandardInstall, pruneDepCache, restoreDepCache, storeDepCache } from './dep-cache.js';
import { validateRound, type RoundOutcome, type ValidationDeps } from './commit-validation.js';
import { defaultSleep, filesWithMarkers, isTransient, neutralizeSummary, oneLine, runSoftwareEffect, withHostRetry } from './effects.js';
import { planFeedbackRound, DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS } from './feedback.js';
import { postFeedbackReplies } from './replies.js';
import { GitHostError, type GitHost, type Pr } from './github.js';
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
import { buildCiFeedback, failingChecks, MAX_CI_EXCERPTS, CI_EXCERPT_LINES } from './ci.js';
import { MAX_CONFLICT_PATHS } from './conflict.js';
import { PROFILES } from './profiles.js';
import { SoftwareStateSchema, type SoftwareState } from './state.js';
import { softwareSubmit } from './submit.js';
import { redactSecrets } from './secret-scan.js';
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
    /** Whose pull request feedback counts (default OWNER, MEMBER, COLLABORATOR). */
    allowedAuthorAssociations?: string[];
    /** Human feedback rounds one chain accepts (default 5). */
    maxHumanRounds?: number;
    /** Conflict rounds (merging the base branch into the pull request) one chain gets (default 2). */
    maxConflictRounds?: number;
    /** CI rounds (revisions for failing required checks) one chain gets (default 2). */
    maxCiRounds?: number;
    /** Per repository (`owner/name`): setup and verification commands (a repository without an entry has none). */
    repos?: Record<string, RepoToolSettings>;
  };
  /** The environment the tool environment is built from (default `process.env`). */
  env?: () => NodeJS.ProcessEnv;
  /** The workspace root; the dependency cache lives in `<workspaceRoot>/.cache/deps` (none without it). */
  workspaceRoot?: string;
  /** Variable names that never reach a setup or verify command (the GitHub token variable). */
  withheldEnv?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  /** Reports an error that does not stop the work (a feedback reply that could not be posted). */
  onError?: (err: unknown, context: string) => void;
  /** Clock for stored rows (epoch ms); injected by the composition root. */
  now: () => number;
  /**
   * Exact secret values (evaluated at each push) for `commit_push`'s secret guard and the redaction
   * of the commit message and PR text; injected by the composition root (default: none).
   */
  secretValues?: () => readonly string[];
}

export { LABEL_DEAD_LETTER };

/** Added to the execute prompt for a repository with `verify`: the factory runs the full checks itself. */
export const VERIFY_PROMPT = [
  "The project's dependencies are installed.",
  'While working, run only targeted tests (the single test file for the code you are changing).',
  'Do not run the full type-check, build or test suite before finishing: the factory runs them after you finish and returns any failures to you.',
  'Finish as soon as the change is complete.',
].join(' ');

/** Consecutive maintenance passes a pull request may stay `unknown` before the engine moves on. */
const MAX_UNKNOWN_PASSES = 5;

export type SoftwareEngine = Engine<SoftwareState> & {
  /** Evicts the cached workspace of one delivery of one job (used by cleanup). */
  forgetWorkspace(chainId: number, jobId: number, delivery: number): void;
};

export function createSoftwareEngine(deps: SoftwareEngineDeps): SoftwareEngine {
  const cache = new Map<string, SoftwareWorkspace>();
  // `delivery` restarts at 1 for every job, so a delivery is identified by (chain, job, delivery).
  const key = (chainId: number, jobId: number, delivery: number) => `${chainId}:${jobId}:${delivery}`;
  /** What each verify command did on the unmodified tree, per delivery (only for a passing baseline). */
  const baselines = new Map<string, BaselineEntry[]>();
  const forget = (chainId: number, jobId: number, delivery: number) => {
    cache.delete(key(chainId, jobId, delivery));
    baselines.delete(key(chainId, jobId, delivery));
  };
  const allowedAuthorAssociations = deps.config.allowedAuthorAssociations ?? [...DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS];
  const maxHumanRounds = Math.max(1, deps.config.maxHumanRounds ?? 5);
  const maxConflictRounds = Math.max(1, deps.config.maxConflictRounds ?? 2);
  const maxCiRounds = Math.max(1, deps.config.maxCiRounds ?? 2);
  // Passes in a row a chain's pull request reported `unknown` mergeability (not persisted: a restart starts counting again).
  const unknownPasses = new Map<number, number>();
  const unknownLogged = new Set<number>();
  const historyRetentionDays = deps.config.historyRetentionDays ?? 30;
  const keptWorktreeMaxAgeMs = deps.config.keptWorktreeMaxAgeMs ?? 7 * 86_400_000;
  /** Agent-written text on its way to GitHub (or a dead letter): named patterns and known values redacted. */
  const redact = (text: string) => redactSecrets(text, deps.secretValues?.() ?? []);
  /** What the maintenance pass records for a transient host failure (the pass redacts nothing itself here). */
  const transientCheck = (e: Error) => `error: ${redact(e.message.replace(/\s+/g, ' ').trim())}`;

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

  /** Posts `text` plus the hidden `marker` unless a comment with the marker exists. */
  async function commentOnce(repo: string, issueNumber: number, marker: string, text: string): Promise<void> {
    const sleep = deps.sleep ?? defaultSleep;
    await withHostRetry(async () => {
      if (await deps.host.findComment(repo, issueNumber, marker)) return;
      await deps.host.comment(repo, issueNumber, `${text}\n\n${marker}`);
    }, sleep);
  }

  /**
   * Posts the replies of an earlier round that could not be posted (no reply marker yet) and names
   * unanswered items. Null when nothing is pending or nothing changed (the next pass tries again).
   */
  async function retryPendingReplies(s: SoftwareState, chainId: number, pr: Pr): Promise<ReconcileOutcome<SoftwareState> | null> {
    const pending = s.pendingReplies ?? [];
    const unanswered = s.pendingUnanswered;
    if (pending.length === 0 && (unanswered?.ids.length ?? 0) === 0) return null;
    const result = await postFeedbackReplies(
      {
        host: deps.host,
        repo: s.repo,
        chainId,
        pr: pr.number,
        headSha: pr.headSha,
        redact,
        neutralize: neutralizeSummary,
        retry: (fn) => withHostRetry(fn, deps.sleep ?? defaultSleep),
        assertCurrent: () => undefined,
        events: (kind, detail) => recordEvent(deps.db, { at: deps.now(), chainId, kind, engine: 'software', detail: detail ?? {} }),
        onError: (err, context) => deps.onError?.(err, context),
      },
      pending,
      unanswered,
    );
    if (result.pendingReplies.length === pending.length && result.pendingUnanswered.ids.length === (unanswered?.ids.length ?? 0)) return null;
    return { outcome: 'update', reason: 'feedback replies posted', engineState: { ...s, ...result } };
  }

  /**
   * The factory's pull request is open and waiting: starts a revision when a person left feedback
   * since `feedbackHandledAt`, or hands over (`needs_human`) when the chain used its human rounds.
   */
  async function reconcileFeedback(s: SoftwareState, chainId: number, prNumber: number): Promise<ReconcileOutcome<SoftwareState>> {
    let feedback;
    try {
      feedback = await deps.host.listPrFeedback(s.repo, prNumber);
    } catch (e) {
      // Transient host failure: the next maintenance pass retries.
      if (e instanceof GitHostError && isTransient(e)) return { outcome: 'none', check: transientCheck(e) };
      throw e;
    }
    const plan = planFeedbackRound(feedback, s, { allowedAuthorAssociations });
    if (!plan.round) return { outcome: 'none' };
    const rounds = s.humanRounds ?? 0;
    if (rounds >= maxHumanRounds) {
      await commentOnce(
        s.repo,
        prNumber,
        `<!-- factory:chain=${chainId} event=human-round-limit -->`,
        `The factory has already revised this pull request for ${rounds} round(s) of feedback, the most it accepts for one chain, so it will not act on newer feedback. A person has to take over.`,
      );
      await deps.host.setLabels(s.repo, prNumber, [LABEL_NEEDS_HUMAN], []);
      return {
        outcome: 'update',
        reason: `human feedback rounds exhausted (${maxHumanRounds})`,
        engineState: { ...s, phase: 'needs_human', feedbackHandledAt: plan.newestAt },
      };
    }
    const attempt = s.attempt + 1;
    const round = rounds + 1;
    return {
      outcome: 'new_work',
      reason: `feedback round ${round}`,
      engineState: {
        ...s,
        phase: 'executing',
        attempt,
        attemptBase: s.attempt,
        humanRounds: round,
        feedbackHandledAt: plan.newestAt,
        conflictActive: false,
        ciActive: false,
      },
      job: { type: 'execute', attempt, policyKind: 'execute', labels: s.labels, payload: { feedback: plan.text, humanRound: round, feedbackItems: plan.refs } },
    };
  }

  /**
   * The waiting chain's pull request stopped being mergeable: starts a conflict round (the base branch
   * is merged into the branch and the agent resolves the conflicts), or hands over when the chain used
   * its conflict rounds. Null when there is nothing to do for conflicts (feedback is looked at next).
   */
  async function reconcileConflict(s: SoftwareState, chainId: number, pr: Pr): Promise<ReconcileOutcome<SoftwareState> | null> {
    const event = (kind: string, detail: Record<string, unknown>) =>
      recordEvent(deps.db, { at: deps.now(), chainId, kind, engine: 'software', detail });
    if (pr.mergeable === 'mergeable') {
      unknownPasses.delete(chainId);
      unknownLogged.delete(chainId);
      return null;
    }
    if (pr.mergeable === 'unknown') {
      // GitHub is still computing it: look again next pass, a few times.
      const n = (unknownPasses.get(chainId) ?? 0) + 1;
      unknownPasses.set(chainId, n);
      if (n <= MAX_UNKNOWN_PASSES) return { outcome: 'none', check: 'unknown' };
      if (!unknownLogged.has(chainId)) {
        unknownLogged.add(chainId);
        event('conflict.gave_up', { reason: `mergeability still unknown after ${MAX_UNKNOWN_PASSES} checks` });
      }
      return null;
    }
    unknownPasses.delete(chainId);
    unknownLogged.delete(chainId);
    if (s.conflictGaveUp) return null;
    const rounds = s.conflictRounds ?? 0;
    if (rounds >= maxConflictRounds) {
      await commentOnce(
        s.repo,
        pr.number,
        `<!-- factory:chain=${chainId} event=conflict-round-limit -->`,
        `This pull request conflicts with \`${pr.baseBranch}\` again, but the factory already resolved conflicts ${rounds} time(s), the most it does for one chain (\`maxConflictRounds\`). A person has to resolve the conflicts.`,
      );
      await deps.host.setLabels(s.repo, s.issueNumber, [LABEL_NEEDS_HUMAN], []);
      event('conflict.gave_up', { reason: `conflict rounds exhausted (${maxConflictRounds})` });
      return {
        outcome: 'update',
        reason: `conflict rounds exhausted (${maxConflictRounds})`,
        engineState: { ...s, phase: 'needs_human', conflictGaveUp: true },
      };
    }
    const attempt = s.attempt + 1;
    const round = rounds + 1;
    return {
      outcome: 'new_work',
      reason: `conflict round ${round}`,
      engineState: { ...s, phase: 'executing', attempt, attemptBase: s.attempt, conflictRounds: round, conflictActive: true, ciActive: false },
      job: { type: 'execute', attempt, policyKind: 'execute', labels: s.labels, payload: { conflictRound: round } },
    };
  }

  /**
   * The waiting chain's pull request still has the commit the chain pushed, and the required checks of
   * exactly that commit failed: starts a CI round (the agent gets the failing checks and the end of
   * their logs), or hands over when the chain used its CI rounds. Null when there is nothing to do:
   * checks pending, passing or absent, another head, or a transient host failure (retried next pass).
   * Merging stays with GitHub's branch protection; nothing here blocks or performs a merge.
   */
  async function reconcileCi(s: SoftwareState, chainId: number, pr: Pr): Promise<ReconcileOutcome<SoftwareState> | null> {
    if (s.phase !== 'awaiting_merge' || !s.lastPushedSha || pr.headSha !== s.lastPushedSha) return null;
    const event = (kind: string, detail: Record<string, unknown>) =>
      recordEvent(deps.db, { at: deps.now(), chainId, kind, engine: 'software', detail });
    let status;
    try {
      status = await deps.host.getChecks(s.repo, pr.headSha);
    } catch (e) {
      if (e instanceof GitHostError && isTransient(e)) return { outcome: 'none', check: transientCheck(e) };
      throw e;
    }
    if (status.state !== 'failing') return null;
    const failing = failingChecks(status);
    const names = failing.map((c) => redact(c.name));
    const rounds = s.ciRounds ?? 0;
    if (rounds >= maxCiRounds) {
      const list = names.map((n) => `\`${n.replace(/[`\s]+/g, ' ').trim().slice(0, 100)}\``).join(', ');
      await commentOnce(
        s.repo,
        pr.number,
        `<!-- factory:chain=${chainId} event=ci-round-limit -->`,
        `The required checks failed again (${list}), but the factory already revised this pull request for failing checks ${rounds} time(s), the most it does for one chain (\`maxCiRounds\`). A person has to fix them.`,
      );
      await deps.host.setLabels(s.repo, s.issueNumber, [LABEL_NEEDS_HUMAN], []);
      event('ci.gave_up', { reason: `ci rounds exhausted (${maxCiRounds})`, checks: names });
      return { outcome: 'update', reason: `ci rounds exhausted (${maxCiRounds})`, engineState: { ...s, phase: 'needs_human' } };
    }
    // Logs are best effort: a check without a run (or whose log cannot be read) is listed without one.
    const excerpts = new Map<string, string>();
    const byRun = new Map<number, string | null>();
    for (const c of failing.slice(0, MAX_CI_EXCERPTS)) {
      if (c.runId === undefined) continue;
      if (!byRun.has(c.runId)) {
        try {
          byRun.set(c.runId, await deps.host.getFailedLogExcerpt(s.repo, c.runId, CI_EXCERPT_LINES));
        } catch {
          byRun.set(c.runId, null);
        }
      }
      const log = byRun.get(c.runId);
      if (log) excerpts.set(c.name, log);
    }
    const feedback = buildCiFeedback(status, excerpts, deps.secretValues?.() ?? []);
    const attempt = s.attempt + 1;
    const round = rounds + 1;
    event('ci.failed', { checks: names, round });
    return {
      outcome: 'new_work',
      reason: `ci round ${round}`,
      engineState: { ...s, phase: 'executing', attempt, attemptBase: s.attempt, ciRounds: round, ciActive: true, conflictActive: false },
      job: { type: 'execute', attempt, policyKind: 'execute', labels: s.labels, payload: { feedback, ciRound: round } },
    };
  }

  /**
   * Called when the workspace of a conflict round shows the agent has nothing to do: a person has to
   * take over (a conflict the agent must not get), or nothing conflicts any more. Ends the job with
   * the chain waiting again.
   */
  async function handBackConflict(chain: ChainView<SoftwareState>, job: Job, info: NonNullable<SoftwareWorkspace['conflict']>): Promise<never> {
    const s = chain.state;
    const event = (kind: string, detail: Record<string, unknown>) =>
      recordEvent(deps.db, { at: deps.now(), chainId: chain.id, jobId: job.id, delivery: job.delivery, kind, engine: 'software', detail });
    const pr = await withHostRetry(() => deps.host.findPrByHead(s.repo, s.branch), deps.sleep ?? defaultSleep);
    if (info.refusal === undefined) {
      // Merged by itself, or a person resolved it, before the round got going: nothing to do.
      if (pr) {
        const ready = PROFILES[s.profile].onApprove === 'merge' ? [] : [LABEL_READY_FOR_MERGE];
        await deps.host.setLabels(s.repo, pr.number, ready, [LABEL_IN_PROGRESS]);
      }
      await deps.host.setLabels(s.repo, s.issueNumber, [], [LABEL_IN_PROGRESS]);
      throw new HandBackError('nothing conflicts any more', { ...s, phase: 'awaiting_merge', conflictActive: false });
    }
    const why = {
      binary: 'a conflicting file is binary',
      deleted_modified: 'a file was deleted on one side and modified on the other',
      too_many: `more than ${MAX_CONFLICT_PATHS} files conflict`,
    }[info.refusal];
    if (pr) {
      await commentOnce(
        s.repo,
        pr.number,
        `<!-- factory:chain=${chain.id} event=conflict-gave-up -->`,
        `This pull request conflicts with \`${info.baseBranch}\`, and the factory does not resolve it itself: ${why}. A person has to resolve the conflicts.`,
      );
    }
    await deps.host.setLabels(s.repo, s.issueNumber, [LABEL_NEEDS_HUMAN], [LABEL_IN_PROGRESS]);
    event('conflict.gave_up', { reason: why });
    throw new HandBackError(`conflict not resolvable by the agent: ${why}`, {
      ...s,
      phase: 'needs_human',
      conflictActive: false,
      conflictGaveUp: true,
    });
  }

  const jobEvent = (chain: ChainView<any>, job: Job, kind: string, detail: Record<string, unknown>) =>
    recordEvent(deps.db, { at: deps.now(), chainId: chain.id, jobId: job.id, delivery: job.delivery, kind, engine: 'software', detail });
  const show = (argv: readonly string[]) => redact(argv.join(' ')).slice(0, 200);

  /**
   * Runs `commands` in order in the workspace with the tool environment (an empty per-run HOME that
   * is removed afterwards). Stops at the first command that does not exit 0.
   */
  async function runCommands(
    ws: Workspace,
    commands: string[][],
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ failed?: { argv: string[]; exitCode: number | null; output: string; timedOut: boolean; spawnError?: string } }> {
    const home = await mkdtemp(join(tmpdir(), 'factory-tool-home-'));
    try {
      const env = buildToolEnv(deps.env?.() ?? process.env, { home, ...(deps.withheldEnv === undefined ? {} : { withheld: deps.withheldEnv }) });
      for (const argv of commands) {
        const r = await runCommand(argv, { cwd: ws.path, env, timeoutMs, ...(signal === undefined ? {} : { signal }) });
        if (r.exitCode !== 0) return { failed: { argv, exitCode: r.exitCode, output: r.output, timedOut: r.timedOut, ...(r.spawnError === undefined ? {} : { spawnError: r.spawnError }) } };
      }
      return {};
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The repository's `setup` commands; a failure throws an error naming the command, never its output. */
  async function runSetup(chain: ChainView<SoftwareState>, job: Job, ws: Workspace, signal: AbortSignal | undefined): Promise<void> {
    const cfg = deps.config.repos?.[chain.state.repo];
    const commands = cfg?.setup ?? [];
    if (commands.length === 0) return;
    const started = Date.now();
    const r = await runCommands(ws, commands, cfg?.setupTimeoutMs ?? 300_000, signal);
    const ms = Date.now() - started;
    jobEvent(chain, job, 'workspace.setup', {
      commands: commands.map((c) => c[0]),
      durationMs: ms,
      ok: r.failed === undefined,
      ...(r.failed === undefined ? {} : { failed: show(r.failed.argv), exitCode: r.failed.exitCode }),
    });
    if (r.failed) {
      const f = r.failed;
      const why = f.timedOut ? 'timed out' : f.spawnError !== undefined ? 'could not start' : `exit code ${f.exitCode}`;
      throw new Error(`setup command failed (${why}): ${show(f.argv)}`);
    }
  }

  /** Runs every verify command once on the unmodified tree; a command that fails does not stop the others. */
  async function runBaseline(ws: Workspace, commands: string[][], timeoutMs: number, signal: AbortSignal | undefined): Promise<BaselineEntry[]> {
    const home = await mkdtemp(join(tmpdir(), 'factory-tool-home-'));
    try {
      const env = buildToolEnv(deps.env?.() ?? process.env, { home, ...(deps.withheldEnv === undefined ? {} : { withheld: deps.withheldEnv }) });
      const entries: BaselineEntry[] = [];
      for (const argv of commands) {
        const r = await runCommand(argv, { cwd: ws.path, env, timeoutMs, ...(signal === undefined ? {} : { signal }) });
        if (signal?.aborted) throw new Error('aborted');
        const text = r.spawnError ?? r.output;
        entries.push({
          command: argv.join(' ').slice(0, 300),
          status: r.exitCode === 0 ? 'pass' : 'fail',
          output: redact(text.split('\n').slice(-BASELINE_TAIL_LINES).join('\n')),
        });
      }
      return entries;
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The tool environment for the cache's `cp` (only the allow-listed variables, an empty HOME is not needed). */
  const cacheOptions = (signal: AbortSignal | undefined) => ({
    workspaceRoot: deps.workspaceRoot!,
    env: buildToolEnv(deps.env?.() ?? process.env, deps.withheldEnv === undefined ? {} : { withheld: deps.withheldEnv }),
    ...(signal === undefined ? {} : { signal }),
  });

  /**
   * Primes a workspace the engine just prepared, before any agent touches it: the dependencies (from
   * the cache when the setup is the standard install, else by running `setup`) and, for an execute
   * job, the baseline verification of the unmodified tree. A red baseline throws
   * `BaselineFailingError` (retried like a transient failure, no agent started).
   */
  async function prime(chain: ChainView<SoftwareState>, job: Job, ws: Workspace, signal: AbortSignal | undefined): Promise<void> {
    const cfg = deps.config.repos?.[chain.state.repo];
    const setup = cfg?.setup ?? [];
    const verify = cfg?.verify ?? [];
    const conflicted = ((ws as SoftwareWorkspace).conflict?.paths.length ?? 0) > 0;
    const wantBaseline = job.type === 'execute' && verify.length > 0 && cfg?.verifyBaseline !== false && !conflicted;
    if (setup.length === 0 && !wantBaseline) return;

    let cacheState: 'hit' | 'miss' | 'corrupt' | 'none' = 'none';
    let keyPrefix: string | undefined;
    const setupStarted = Date.now();
    if (setup.length > 0) {
      const cacheKey = deps.workspaceRoot !== undefined && isStandardInstall(setup) ? await depCacheKey(ws.path) : null;
      if (cacheKey !== null) {
        keyPrefix = cacheKey.slice(0, 12);
        cacheState = await restoreDepCache(cacheKey, ws.path, cacheOptions(signal)).catch(() => 'corrupt' as const);
      }
      if (cacheState !== 'hit') {
        await runSetup(chain, job, ws, signal);
        // Stored only now, from the tree the engine prepared before the agent started.
        if (cacheKey !== null) await storeDepCache(cacheKey, ws.path, cacheOptions(signal)).catch(() => false);
      }
    }
    const setupDurationMs = Date.now() - setupStarted;

    let baseline: 'pass' | 'fail' | 'skipped' = 'skipped';
    let baselineDurationMs: number | undefined;
    let entries: BaselineEntry[] = [];
    if (wantBaseline) {
      const started = Date.now();
      entries = await runBaseline(ws, verify, cfg?.verifyTimeoutMs ?? 600_000, signal);
      baselineDurationMs = Date.now() - started;
      baseline = entries.every((e) => e.status === 'pass') ? 'pass' : 'fail';
    }
    const failing = entries.find((e) => e.status === 'fail');
    jobEvent(chain, job, 'workspace.primed', {
      cache: cacheState,
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
      setupDurationMs,
      baseline,
      ...(baselineDurationMs === undefined ? {} : { baselineDurationMs }),
      ...(failing === undefined ? {} : { failed: redact(failing.command) }),
    });
    if (failing) {
      await announceBaselineFailure(chain, redact(failing.command));
      throw new BaselineFailingError(redact(failing.command));
    }
    if (wantBaseline) baselines.set(key(chain.id, job.id, job.delivery), entries);
  }

  /** One comment per chain on the pull request (the issue for a first attempt) naming the red command. */
  async function announceBaselineFailure(chain: ChainView<SoftwareState>, command: string): Promise<void> {
    const s = chain.state;
    try {
      const sleep = deps.sleep ?? defaultSleep;
      const pr = await withHostRetry(() => deps.host.findPrByHead(s.repo, s.branch), sleep);
      await commentOnce(
        s.repo,
        pr?.number ?? s.issueNumber,
        `<!-- factory:chain=${chain.id} event=baseline-failing -->`,
        `The factory did not start the agent: the verification already fails on the unmodified base branch, so the base branch or the environment is red, not the change. Failing command: \`${command}\`. The factory retries later.`,
      );
    } catch (e) {
      deps.onError?.(e, `baseline comment for chain ${chain.id}`);
    }
  }

  const workspace: WorkspaceProvider = {
    async prepare(chain: ChainView<any>, job: Job, signal?: AbortSignal): Promise<Workspace> {
      const ws = await deps.workspaces.prepare(chain, job);
      const conflict = (ws as SoftwareWorkspace).conflict;
      if (conflict && job.type === 'execute') {
        recordEvent(deps.db, {
          at: deps.now(),
          chainId: chain.id,
          jobId: job.id,
          delivery: job.delivery,
          kind: 'conflict.detected',
          engine: 'software',
          detail: {
            baseBranch: conflict.baseBranch,
            round: (job.payload as { conflictRound?: unknown }).conflictRound,
            paths: conflict.paths.length,
          },
        });
        if (conflict.refusal !== undefined || conflict.paths.length === 0) await handBackConflict(chain, job, conflict);
      }
      await prime(chain, job, ws, signal);
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
      const input = buildSoftwareRunInput(chain, job, ws as SoftwareWorkspace, issue, pr);
      const base = baselines.get(key(chain.id, job.id, job.delivery));
      if (base !== undefined) input.baseline = base;
      if (job.type === 'execute' && (deps.config.repos?.[s.repo]?.verify?.length ?? 0) > 0) input.promptAddendum = VERIFY_PROMPT;
      return input;
    },

    async verify(chain, job, ws, result, rerun, signal) {
      const cfg = deps.config.repos?.[chain.state.repo];
      const commands = cfg?.verify ?? [];
      const first = result as { status?: string; costUsd?: number };
      const sws = ws as SoftwareWorkspace;
      if (job.type !== 'execute' || first.status !== 'ok') return result;
      const maxRounds = Math.max(1, cfg?.maxVerifyRounds ?? 3);
      const timeoutMs = cfg?.verifyTimeoutMs ?? 600_000;
      const sleep = deps.sleep ?? defaultSleep;
      const conflictRound = ((job.payload as { conflictRound?: unknown } | null | undefined)?.conflictRound ?? null) !== null;
      const issue = await withHostRetry(() => deps.host.getIssue(chain.state.repo, chain.state.issueNumber), sleep);
      const title = oneLine(redact(issue.title)) || `#${chain.state.issueNumber}`;
      let current = result as Record<string, unknown> & { status?: string; costUsd?: number };
      let cost: number | undefined = first.costUsd;
      let verifyMs = 0;
      let rounds = 0;
      let conflictHead: string | undefined = conflictRound ? sws.seedSha : undefined;
      const record = (kind: string, detail: Record<string, unknown>) => jobEvent(chain, job, kind, detail);
      for (let round = 0; ; round++) {
        const validation: ValidationDeps = {
          expect: { branch: sws.localBranch, email: deps.git.commitEmail?.() ?? '' },
          seedSha: sws.seedSha,
          fallbackMessage: `factory: ${title} (attempt ${job.attempt})`,
          conflictRound,
          prepare: async () => deps.git.prepareForPush?.(sws),
          inspect: () => deps.git.inspect!(sws, { firstParent: conflictRound }),
          commitAll: (message) => deps.git.commitAll(sws, message),
          markersLeft: () => filesWithMarkers(sws),
          headSha: () => deps.git.headSha(sws),
          events: (kind, detail) => record(kind, Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]))),
          verify: async () => {
            if (commands.length === 0) return null;
            record('verify.started', { commands: commands.map((c) => c[0]), round });
            const started = Date.now();
            const r = await runCommands(ws, commands, timeoutMs, signal);
            const ms = Date.now() - started;
            verifyMs += ms;
            if (signal.aborted) throw new Error('aborted');
            if (!r.failed) {
              record('verify.passed', { round, durationMs: ms });
              return null;
            }
            const f = r.failed;
            record('verify.failed', { command: show(f.argv), exitCode: f.exitCode, round, durationMs: ms });
            if (round >= maxRounds) {
              throw new EffectError(`verification failed after ${round} round(s) of fixes: ${show(f.argv)} (exit code ${f.exitCode ?? 'none'})`, 'runner_error');
            }
            const feedback = buildVerifyFeedback(f.argv, f.exitCode, f.spawnError ?? f.output, deps.secretValues?.() ?? [], baselines.get(key(chain.id, job.id, job.delivery)));
            return { feedback, command: show(f.argv), exitCode: f.exitCode };
          },
        };
        let outcome: RoundOutcome;
        if (deps.git.inspect === undefined) {
          // Ports without validation support: only the verify commands run, `commit_push` commits.
          const failure = await validation.verify();
          if (failure === null) break;
          outcome = { kind: 'fix', head: '', ...failure };
        } else {
          outcome = await validateRound(validation, conflictHead);
        }
        if (outcome?.kind === 'validated') {
          current = { ...current, validatedSha: outcome.head, commitCount: outcome.commitCount, commits: outcome.commits };
          break;
        }
        if (conflictRound) conflictHead = outcome.head;
        if (round >= maxRounds) {
          throw new EffectError(`validation failed after ${round} round(s) of fixes: ${outcome.command ?? 'verification'}`, 'runner_error');
        }
        rounds++;
        const next = (await rerun(outcome.feedback)) as typeof current;
        if (typeof next.costUsd === 'number') cost = (cost ?? 0) + next.costUsd;
        // The rerun answers the same attempt: feedbackResponses and followups it leaves out stay as the previous run reported them.
        const { feedbackResponses, followups } = current;
        current = { ...next };
        if (current.feedbackResponses === undefined && feedbackResponses !== undefined) current.feedbackResponses = feedbackResponses;
        if (current.followups === undefined && followups !== undefined) current.followups = followups;
        if (next.status !== 'ok') break;
      }
      return { ...current, ...(cost === undefined ? {} : { costUsd: cost }), verifyDurationMs: verifyMs, verifyRounds: rounds };
    },

    transition(chain, job, result) {
      try {
        const t = softwareTransition(chain, job, result);
        // The one event the pure transition cannot carry as an effect: recorded once per job (a
        // retry that keeps the result computes the same verdict again).
        if (job.type === 'review') {
          const v = (result as { verdict?: unknown }).verdict;
          const seen = deps.db.prepare(`SELECT 1 FROM events WHERE job_id = ? AND kind = 'review.verdict'`).get(job.id);
          if (!seen && typeof v === 'string') {
            recordEvent(deps.db, {
              at: deps.now(),
              chainId: chain.id,
              jobId: job.id,
              delivery: job.delivery,
              kind: 'review.verdict',
              engine: 'software',
              detail: { verdict: v, attempt: job.attempt },
            });
          }
        }
        return t;
      } catch (e) {
        // An execute result with status `error` carries the agent's summary as the message.
        if (e instanceof EffectError) throw new EffectError(redact(e.message), e.reason);
        throw e;
      }
    },

    async runEffect(effect, ctx) {
      return runSoftwareEffect(
        effect,
        {
          chain: ctx.chain,
          job: ctx.job,
          workspace: cache.get(key(ctx.chain.id, ctx.job.id, ctx.job.delivery)) ?? null,
          host: deps.host,
          git: deps.git,
          sleep: deps.sleep,
          followups: { db: deps.db, now: deps.now },
          now: deps.now,
          secretValues: deps.secretValues,
          onError: deps.onError,
          events: (kind, detail) =>
            recordEvent(deps.db, {
              at: deps.now(),
              chainId: ctx.chain.id,
              jobId: ctx.job.id,
              delivery: ctx.job.delivery,
              kind,
              engine: 'software',
              detail,
            }),
        },
        ctx.fence,
      );
    },

    async afterEnqueue(chain: ChainView<SoftwareState>, job: Job) {
      const s = chain.state;
      await commentOnce(
        s.repo,
        s.issueNumber,
        `<!-- factory:chain=${chain.id} event=queued -->`,
        `The factory queued this issue (chain ${chain.id}, job ${job.id}).`,
      );
    },

    async onJobStart(chain: ChainView<SoftwareState>, job: Job) {
      const s = chain.state;
      const errors: unknown[] = [];
      try {
        await deps.host.setLabels(s.repo, s.issueNumber, [LABEL_IN_PROGRESS], [LABEL_DEAD_LETTER]);
        recordEvent(deps.db, {
          at: deps.now(),
          chainId: chain.id,
          jobId: job.id,
          delivery: job.delivery,
          kind: 'labels.changed',
          engine: 'software',
          detail: { target: 'issue', add: [LABEL_IN_PROGRESS], remove: [LABEL_DEAD_LETTER], at: 'claim' },
        });
      } catch (e) {
        errors.push(e);
      }
      const payload = job.payload as { humanRound?: unknown; conflictRound?: unknown; ciRound?: unknown } | null | undefined;
      if (job.type === 'execute' && (typeof payload?.humanRound === 'number' || typeof payload?.conflictRound === 'number' || typeof payload?.ciRound === 'number')) {
        // A person's feedback, a conflict or a failing check is being worked: the pull request is no longer ready for merge.
        try {
          const pr = await deps.host.findPrByHead(s.repo, s.branch);
          if (pr) await deps.host.setLabels(s.repo, pr.number, [], [LABEL_READY_FOR_MERGE, LABEL_NEEDS_HUMAN]);
        } catch (e) {
          errors.push(e);
        }
      }
      if (job.type === 'execute' && job.attempt === 1) {
        try {
          await commentOnce(
            s.repo,
            s.issueNumber,
            `<!-- factory:chain=${chain.id} event=started -->`,
            `The factory started work on this issue (chain ${chain.id}).`,
          );
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length > 0) throw errors[0];
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
        redact(dl.error).replaceAll('```', "'''"),
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

    redact,

    async reconcile(chain) {
      const s = chain.state;
      if (s.phase !== 'awaiting_merge' && s.phase !== 'needs_human') return { outcome: 'none' };
      let pr;
      try {
        pr = await deps.host.findPrByHead(s.repo, s.branch);
      } catch (e) {
        // Transient host failure: the next maintenance pass retries.
        if (e instanceof GitHostError && isTransient(e)) return { outcome: 'none', check: transientCheck(e) };
        throw e;
      }
      if (!pr) return { outcome: 'none' };
      if (pr.state === 'open') {
        const replied = await retryPendingReplies(s, chain.id, pr);
        if (replied) return replied;
        // A conflict comes first; feedback is looked at on a later pass or when there is no conflict.
        // Then failing CI checks, then feedback (each on a later pass when an earlier one started a round).
        const conflict = await reconcileConflict(s, chain.id, pr);
        if (conflict) return conflict;
        const ci = await reconcileCi(s, chain.id, pr);
        return ci ?? reconcileFeedback(s, chain.id, pr.number);
      }
      if (pr.state === 'merged') return { outcome: 'completed', reason: `Pull request #${pr.number} was merged` };
      return {
        outcome: 'cancelled',
        reason: `Pull request #${pr.number} was closed without merging; this chain was cancelled`,
      };
    },

    finalState: (state) => ({ ...state, phase: 'merged' }),

    async afterReconcile(chain, outcome) {
      const s = chain.state;
      const errors: unknown[] = [];
      try {
        await deps.host.setLabels(s.repo, s.issueNumber, [], [
          LABEL_READY_FOR_MERGE,
          LABEL_NEEDS_HUMAN,
          LABEL_IN_PROGRESS,
          LABEL_DEAD_LETTER,
        ]);
      } catch (e) {
        errors.push(e);
      }
      try {
        const marker = `<!-- factory:chain=${chain.id} event=reconcile -->`;
        if (!(await deps.host.findComment(s.repo, s.issueNumber, marker))) {
          await deps.host.comment(s.repo, s.issueNumber, `${outcome.reason}.\n\n${marker}`);
        }
      } catch (e) {
        errors.push(e);
      }
      if (errors.length > 0) throw errors[0];
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
      await step(() => sweepUnfiledFollowups(deps.db, deps.host, now, redact));
      await step(() => pruneFiledFollowups(deps.db, now, historyRetentionDays));
      await step(() => deps.workspaces.sweep(isLiveDelivery(now), now));
      if (deps.workspaceRoot !== undefined) await step(() => pruneDepCache(deps.workspaceRoot!, now));
      if (errors.length > 0) throw errors[0];
    },

    forgetWorkspace: forget,
  };
}
