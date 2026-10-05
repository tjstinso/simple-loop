import { execFile } from 'node:child_process';
import { ghAuthEnv, type GithubAuth } from './identity.js';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  /** GitHub's `author_association` of the issue's author (`NONE` when unknown). */
  authorAssociation: string;
}

/** Whether GitHub can merge the pull request into its base: `unknown` while GitHub is still computing it. */
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';

export interface Pr {
  number: number;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  baseBranch: string;
  mergeable: Mergeable;
}

/** REST `mergeable` and `mergeable_state`: `false` with `dirty` is a conflict, `null` is still computing. */
export function mergeableFromRest(mergeable: boolean | null | undefined, mergeableState: string | null | undefined): Mergeable {
  if (mergeable === true) return 'mergeable';
  if (mergeable === false && mergeableState === 'dirty') return 'conflicting';
  return 'unknown';
}

/** `gh pr list --json mergeable`: MERGEABLE, CONFLICTING or UNKNOWN. */
function mergeableFromCli(v: string | null | undefined): Mergeable {
  const m = String(v ?? '').toUpperCase();
  return m === 'MERGEABLE' ? 'mergeable' : m === 'CONFLICTING' ? 'conflicting' : 'unknown';
}

export type PrReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export interface PrReview {
  id: number;
  author: string;
  authorAssociation: string;
  state: PrReviewState;
  body: string;
  submittedAt: string;
}

export interface PrReviewComment {
  id: number;
  author: string;
  authorAssociation: string;
  path: string;
  /** The line the comment is on (null when the comment is outdated or on a whole file). */
  line: number | null;
  diffHunk: string;
  body: string;
  createdAt: string;
  /** The review the comment belongs to (null when unknown). */
  reviewId: number | null;
  /** The review thread the comment belongs to (GraphQL node id; absent or null when unknown). */
  threadId?: string | null;
  /** Whether that thread is resolved (absent: not resolved). */
  threadResolved?: boolean;
}

/** A review thread of a pull request: GraphQL node id, resolved flag and the REST ids of its comments. */
export interface PrReviewThread {
  id: string;
  resolved: boolean;
  commentIds: number[];
}

export interface PrConversationComment {
  id: number;
  author: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
}

/** What people said on a pull request: untrusted text, every item carries its `authorAssociation`. */
export interface PrFeedback {
  reviews: PrReview[];
  reviewComments: PrReviewComment[];
  comments: PrConversationComment[];
}

/** One check of a commit: a check run, or a status of the legacy status API. */
export interface CheckInfo {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  /** `success`, `failure`, `timed_out`, ... once completed, else null. */
  conclusion: string | null;
  detailsUrl?: string;
  /** The Actions workflow run the check belongs to (parsed from its details url), when it has one. */
  runId?: number;
}

export interface ChecksStatus {
  state: 'passing' | 'pending' | 'failing' | 'none';
  checks: CheckInfo[];
}

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** Whether a completed check counts as a failure (an unknown conclusion counts as neither passing nor failing). */
export const isFailingCheck = (c: CheckInfo): boolean => c.status === 'completed' && FAILING_CONCLUSIONS.has(c.conclusion ?? '');

/** The overall state: any failure wins, then any unfinished check, then all passing; no checks is `none`. */
export function summarizeChecks(checks: readonly CheckInfo[]): ChecksStatus['state'] {
  if (checks.length === 0) return 'none';
  if (checks.some(isFailingCheck)) return 'failing';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return checks.every((c) => PASSING_CONCLUSIONS.has(c.conclusion ?? '')) ? 'passing' : 'pending';
}

export interface GitHost {
  getIssue(repo: string, n: number): Promise<Issue>;
  /** The open issues (no pull requests) with the label, oldest first by number, all pages. */
  listIssuesByLabel(repo: string, label: string): Promise<Issue[]>;
  findPrByHead(repo: string, branch: string): Promise<Pr | null>;
  openPr(repo: string, args: { head: string; base: string; title: string; body: string }): Promise<Pr>;
  getPr(repo: string, n: number): Promise<Pr>;
  setLabels(repo: string, n: number, add: string[], remove: string[]): Promise<void>;
  findComment(repo: string, n: number, marker: string): Promise<boolean>;
  comment(repo: string, n: number, body: string): Promise<void>;
  findIssueByMarker(repo: string, marker: string, label?: string): Promise<number | null>;
  createIssue(repo: string, args: { title: string; body: string; labels: string[] }): Promise<number>;
  /**
   * Merge the PR. With `expectHeadSha`, refuse (GitHostError) when the PR head is no longer that
   * commit, so code nobody reviewed is never merged. Enables auto-merge: the pull request merges later,
   * when the branch protection's required checks pass. Throws AutoMergeRefusedError when GitHub refuses.
   */
  mergePr(repo: string, n: number, opts?: { expectHeadSha?: string }): Promise<void>;
  /** The checks of a commit (check runs and legacy statuses, all pages) and their overall state. */
  getChecks(repo: string, sha: string): Promise<ChecksStatus>;
  /** The last `maxLines` lines of the failing jobs' log of an Actions workflow run (untrusted text). */
  getFailedLogExcerpt(repo: string, runId: number, maxLines: number): Promise<string>;
  /** The reviews, inline review comments and conversation comments of a pull request, all pages. */
  listPrFeedback(repo: string, prNumber: number): Promise<PrFeedback>;
  /** The review threads of a pull request with their comment ids (GraphQL, all pages). */
  listReviewThreads(repo: string, prNumber: number): Promise<PrReviewThread[]>;
  /** Replies in the thread of an inline review comment (REST). */
  replyToReviewComment(repo: string, prNumber: number, commentId: number, body: string): Promise<void>;
  /** Resolves a review thread by its node id (GraphQL); resolving a resolved thread is a no-op. */
  resolveReviewThread(repo: string, threadId: string): Promise<void>;
}

export class GitHostError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHostError';
    if (status !== undefined) this.status = status;
  }
}

/**
 * GitHub refused to enable auto-merge: the repository setting is off, branch protection forbids it, or
 * the head moved since the review. Never transient: a person has to merge.
 */
export class AutoMergeRefusedError extends GitHostError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'AutoMergeRefusedError';
  }
}

// What `gh pr merge --auto` prints when GitHub refuses to enable auto-merge for the pull request.
const AUTO_MERGE_REFUSED = [
  /auto[- ]?merge is not allowed/i,
  /protected branch rules not configured/i,
  /not in the correct state to enable auto[- ]?merge/i,
  /head branch was modified/i,
  /expected head sha didn.t match/i,
];

/** Default limit for one `gh` call; a hung call is killed (SIGKILL) and fails as a transient error. */
export const GH_TIMEOUT_MS = 60_000;

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts?.timeoutMs ?? 0,
        killSignal: 'SIGKILL',
        ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0 });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
        const code = e.code;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr || err.message,
          exitCode: typeof code === 'number' ? code : 1,
          timedOut: opts?.timeoutMs !== undefined && opts.timeoutMs > 0 && e.killed === true && e.signal === 'SIGKILL',
        });
      },
    );
    // gh may exit without reading stdin (EPIPE); its exit code decides the outcome.
    child.stdin?.on('error', () => undefined);
    if (opts?.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

export type MergeMethod = 'squash' | 'merge' | 'rebase';

// ---- Pure command builders. Every flag the adapter depends on lives here. ----
// REST via `gh api` is used wherever a stable endpoint exists: uniform JSON,
// issues and PRs share labels/comments endpoints, and failures print "(HTTP nnn)".
// Request bodies go through `--input -` (JSON on stdin) so arbitrary text never
// needs shell or flag escaping and nothing is placed on the command line.

export const buildGetUserArgs = (): string[] => ['api', '-X', 'GET', 'user'];

export const buildGetIssueArgs = (repo: string, n: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/issues/${n}`,
];

export const buildGetPrArgs = (repo: string, n: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/pulls/${n}`,
];

// `gh pr list` is used here because the REST pulls endpoint needs an
// `owner:branch` head filter, while --head takes a plain branch name.
export const buildFindPrArgs = (repo: string, branch: string): string[] => [
  'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
  '--json', 'number,state,headRefOid,baseRefName,mergeable', '--limit', '1',
];

export const buildOpenPrArgs = (repo: string): string[] => [
  'api', '-X', 'POST', `repos/${repo}/pulls`, '--input', '-',
];

export const buildAddLabelsArgs = (repo: string, n: number): string[] => [
  'api', '-X', 'POST', `repos/${repo}/issues/${n}/labels`, '--input', '-',
];

export const buildRemoveLabelArgs = (repo: string, n: number, label: string): string[] => [
  'api', '-X', 'DELETE', `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`,
];

export const buildListCommentsArgs = (repo: string, n: number, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/issues/${n}/comments`, '-f', 'per_page=100', '-f', `page=${page}`,
];

export const buildListReviewsArgs = (repo: string, n: number, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/pulls/${n}/reviews`, '-f', 'per_page=100', '-f', `page=${page}`,
];

export const buildListReviewCommentsArgs = (repo: string, n: number, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/pulls/${n}/comments`, '-f', 'per_page=100', '-f', `page=${page}`,
];

export const buildListCheckRunsArgs = (repo: string, sha: string, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/commits/${sha}/check-runs`, '-f', 'per_page=100', '-f', `page=${page}`,
];

export const buildListStatusesArgs = (repo: string, sha: string, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/commits/${sha}/status`, '-f', 'per_page=100', '-f', `page=${page}`,
];

export const buildFailedLogArgs = (repo: string, runId: number): string[] => [
  'run', 'view', String(runId), '--repo', repo, '--log-failed',
];

export const buildCommentArgs = (repo: string, n: number): string[] => [
  'api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-',
];

export const buildReplyToReviewCommentArgs = (repo: string, n: number, commentId: number): string[] => [
  'api', '-X', 'POST', `repos/${repo}/pulls/${n}/comments/${commentId}/replies`, '--input', '-',
];

/** GraphQL goes through `gh api graphql` with the query and its variables as JSON on stdin. */
export const buildGraphqlArgs = (): string[] => ['api', 'graphql', '--input', '-'];

export const REVIEW_THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}';

export const RESOLVE_THREAD_MUTATION =
  'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}';

export const buildSearchIssuesArgs = (repo: string, marker: string): string[] => [
  'api', '-X', 'GET', 'search/issues',
  '-f', `q=repo:${repo} is:issue in:body "${marker.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  '-f', 'per_page=100',
];

// Read-after-write consistent lookup (the search index is eventually consistent).
// With `-X GET`, gh sends `-f` fields as URL-encoded query parameters, so the label is encoded by gh.
export const buildListIssuesByLabelArgs = (repo: string, label: string, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/issues`,
  '-f', 'state=all', '-f', `labels=${label}`, '-f', 'per_page=100', '-f', `page=${page}`,
];

/** Open issues with a label, oldest first; `-X GET` makes gh send the `-f` fields as query parameters. */
export const buildListOpenIssuesByLabelArgs = (repo: string, label: string, page: number): string[] => [
  'api', '-X', 'GET', `repos/${repo}/issues`,
  '-f', 'state=open', '-f', `labels=${label}`, '-f', 'sort=created', '-f', 'direction=asc',
  '-f', 'per_page=100', '-f', `page=${page}`,
];

export const buildCreateIssueArgs = (repo: string): string[] => [
  'api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-',
];

// `gh pr merge --auto` enables auto-merge: GitHub waits for the required checks of the branch protection
// and merges when they pass. It handles merge-method flags and auto-detects the repo/branch rules.
// --delete-branch removes factory/issue-<n> after the merge, so a later resubmit of the issue does not
// seed from a stale merged branch; --match-head-commit refuses the merge if the head moved.
export const buildMergePrArgs = (
  repo: string,
  n: number,
  method: MergeMethod,
  opts: { deleteBranch?: boolean; matchHeadCommit?: string } = {},
): string[] => [
  'pr', 'merge', String(n), '--repo', repo, `--${method}`, '--auto',
  ...(opts.deleteBranch ? ['--delete-branch'] : []),
  ...(opts.matchHeadCommit !== undefined ? ['--match-head-commit', opts.matchHeadCommit] : []),
];

// ---- Adapter ----

interface RestIssue {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: Array<{ name: string } | string>;
  author_association?: string | null;
  pull_request?: unknown;
}

interface RestPr {
  number: number;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  head?: { sha?: string };
  base?: { ref?: string };
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}

interface RestUser {
  login?: string | null;
}

interface RestReview {
  id: number;
  user?: RestUser | null;
  author_association?: string | null;
  state?: string | null;
  body?: string | null;
  submitted_at?: string | null;
}

interface RestReviewComment {
  id: number;
  user?: RestUser | null;
  author_association?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string | null;
  body?: string | null;
  created_at?: string | null;
  pull_request_review_id?: number | null;
}

interface GraphqlThreads {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{ id: string; isResolved?: boolean; comments?: { nodes?: Array<{ databaseId?: number | null } | null> } } | null>;
        };
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

interface RestIssueComment {
  id: number;
  user?: RestUser | null;
  author_association?: string | null;
  body?: string | null;
  created_at?: string | null;
}

interface RestCheckRun {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  details_url?: string | null;
  html_url?: string | null;
}

interface RestCommitStatus {
  context?: string | null;
  state?: string | null;
  target_url?: string | null;
}

const WORKFLOW_RUN_URL = /\/actions\/runs\/(\d+)/;

/** The workflow run id in a check's details url (`.../actions/runs/<id>/job/<job>`), when it has one. */
export function runIdFromUrl(url: string | undefined): number | undefined {
  const m = url === undefined ? null : WORKFLOW_RUN_URL.exec(url);
  return m ? Number(m[1]) : undefined;
}

/** A check run: GitHub's `queued`, `in_progress` and `completed`; anything else counts as not finished. */
export function checkFromRun(r: RestCheckRun): CheckInfo {
  const status = r.status === 'completed' ? 'completed' : r.status === 'in_progress' ? 'in_progress' : 'queued';
  const detailsUrl = r.details_url ?? r.html_url ?? undefined;
  const runId = runIdFromUrl(detailsUrl);
  return {
    name: r.name ?? '(unnamed)',
    status,
    conclusion: status === 'completed' ? (r.conclusion ?? null) : null,
    ...(detailsUrl ? { detailsUrl } : {}),
    ...(runId === undefined ? {} : { runId }),
  };
}

/** A legacy commit status: `success` passes, `failure` and `error` fail, `pending` is unfinished. */
export function checkFromStatus(s: RestCommitStatus): CheckInfo {
  const state = String(s.state ?? 'pending');
  const detailsUrl = s.target_url ?? undefined;
  const runId = runIdFromUrl(detailsUrl);
  const done = state === 'success' || state === 'failure' || state === 'error';
  return {
    name: s.context ?? '(unnamed)',
    status: done ? 'completed' : 'in_progress',
    conclusion: done ? (state === 'error' ? 'failure' : state) : null,
    ...(detailsUrl ? { detailsUrl } : {}),
    ...(runId === undefined ? {} : { runId }),
  };
}

const REVIEW_STATES: readonly PrReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

export class GhCliHost implements GitHost {
  private readonly exec: ExecFn;
  private readonly mergeMethod: MergeMethod;
  private readonly ghTimeoutMs: number;
  private readonly deleteBranch: boolean;
  private readonly auth: GithubAuth | undefined;

  constructor(
    opts: { exec?: ExecFn; mergeMethod?: MergeMethod; ghTimeoutMs?: number; deleteBranch?: boolean; auth?: GithubAuth } = {},
  ) {
    this.auth = opts.auth;
    this.exec = opts.exec ?? defaultExec;
    this.mergeMethod = opts.mergeMethod ?? 'squash';
    this.ghTimeoutMs = opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
    this.deleteBranch = opts.deleteBranch ?? true;
  }

  private async run(args: string[], input?: unknown): Promise<string> {
    const r = await this.exec('gh', args, {
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
      timeoutMs: this.ghTimeoutMs,
      ...(this.auth === undefined ? {} : { env: ghAuthEnv(this.auth) }),
    });
    // No status: the effects' classification treats it as transient and retries.
    if (r.timedOut) throw new GitHostError(`gh ${args[0]} timed out after ${this.ghTimeoutMs} ms`);
    if (r.exitCode !== 0) {
      const m = /HTTP (\d{3})/.exec(r.stderr);
      throw new GitHostError(r.stderr.trim() || `gh exited with ${r.exitCode}`, m ? Number(m[1]) : undefined);
    }
    return r.stdout;
  }

  private async json<T>(args: string[], input?: unknown): Promise<T> {
    const out = await this.run(args, input);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new GitHostError(`gh returned invalid JSON: ${out.slice(0, 200)}`);
    }
  }

  /** The login the adapter's credentials resolve to (`gh api user`). */
  async currentLogin(): Promise<string> {
    const u = await this.json<RestUser>(buildGetUserArgs());
    return u.login ?? '';
  }

  private mapIssue(i: RestIssue): Issue {
    return {
      number: i.number,
      title: i.title ?? '',
      body: i.body ?? '',
      labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      state: String(i.state).toLowerCase() === 'closed' ? 'closed' : 'open',
      authorAssociation: i.author_association ?? 'NONE',
    };
  }

  async getIssue(repo: string, n: number): Promise<Issue> {
    return this.mapIssue(await this.json<RestIssue>(buildGetIssueArgs(repo, n)));
  }

  async listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
    const items = await this.pages<RestIssue>((p) => buildListOpenIssuesByLabelArgs(repo, label, p));
    return items
      .filter((i) => !i.pull_request)
      .map((i) => this.mapIssue(i))
      .sort((a, b) => a.number - b.number);
  }

  async findPrByHead(repo: string, branch: string): Promise<Pr | null> {
    const list = await this.json<Array<{ number: number; state: string; headRefOid: string; baseRefName: string; mergeable?: string }>>(
      buildFindPrArgs(repo, branch),
    );
    const p = list[0];
    if (!p) return null;
    return {
      number: p.number,
      state: p.state.toLowerCase() as Pr['state'],
      headSha: p.headRefOid,
      baseBranch: p.baseRefName,
      mergeable: mergeableFromCli(p.mergeable),
    };
  }

  private mapPr(p: RestPr): Pr {
    const state: Pr['state'] = p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
    return {
      number: p.number,
      state,
      headSha: p.head?.sha ?? '',
      baseBranch: p.base?.ref ?? '',
      mergeable: mergeableFromRest(p.mergeable, p.mergeable_state),
    };
  }

  async openPr(repo: string, a: { head: string; base: string; title: string; body: string }): Promise<Pr> {
    return this.mapPr(await this.json<RestPr>(buildOpenPrArgs(repo), a));
  }

  async getPr(repo: string, n: number): Promise<Pr> {
    return this.mapPr(await this.json<RestPr>(buildGetPrArgs(repo, n)));
  }

  async setLabels(repo: string, n: number, add: string[], remove: string[]): Promise<void> {
    const toAdd = [...new Set(add)];
    if (toAdd.length > 0) await this.run(buildAddLabelsArgs(repo, n), { labels: toAdd });
    for (const label of new Set(remove)) {
      try {
        await this.run(buildRemoveLabelArgs(repo, n, label));
      } catch (e) {
        if (e instanceof GitHostError && e.status === 404) continue; // label not present
        throw e;
      }
    }
  }

  async findComment(repo: string, n: number, marker: string): Promise<boolean> {
    for (let page = 1; ; page++) {
      const comments = await this.json<Array<{ body?: string | null }>>(buildListCommentsArgs(repo, n, page));
      if (comments.some((c) => (c.body ?? '').includes(marker))) return true;
      if (comments.length < 100) return false;
    }
  }

  async comment(repo: string, n: number, body: string): Promise<void> {
    await this.run(buildCommentArgs(repo, n), { body });
  }

  /** Every page of a REST list (100 per page, a short page is the last). */
  private async pages<T>(build: (page: number) => string[]): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = await this.json<T[]>(build(page));
      all.push(...items);
      if (items.length < 100) return all;
    }
  }

  async getChecks(repo: string, sha: string): Promise<ChecksStatus> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new GitHostError(`not a commit sha: ${sha.slice(0, 80)}`);
    const checks: CheckInfo[] = [];
    // The check-runs endpoint wraps its page in an object; stop on a short page.
    for (let page = 1; ; page++) {
      const body = await this.json<{ check_runs?: RestCheckRun[] }>(buildListCheckRunsArgs(repo, sha, page));
      const runs = body.check_runs ?? [];
      checks.push(...runs.map(checkFromRun));
      if (runs.length < 100) break;
    }
    for (let page = 1; ; page++) {
      const body = await this.json<{ statuses?: RestCommitStatus[] }>(buildListStatusesArgs(repo, sha, page));
      const statuses = body.statuses ?? [];
      checks.push(...statuses.map(checkFromStatus));
      if (statuses.length < 100) break;
    }
    return { state: summarizeChecks(checks), checks };
  }

  async getFailedLogExcerpt(repo: string, runId: number, maxLines: number): Promise<string> {
    const out = await this.run(buildFailedLogArgs(repo, runId));
    const lines = out.replace(/\r/g, '').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-Math.max(0, maxLines)).join('\n');
  }

  async listReviewThreads(repo: string, prNumber: number): Promise<PrReviewThread[]> {
    const [owner, name] = repo.split('/');
    const threads: PrReviewThread[] = [];
    let after: string | null = null;
    for (;;) {
      const r: GraphqlThreads = await this.json<GraphqlThreads>(buildGraphqlArgs(), {
        query: REVIEW_THREADS_QUERY,
        variables: { owner, name, number: prNumber, after },
      });
      // GraphQL reports failures with HTTP 200 and an `errors` list: no status, so they count as transient.
      if (r.errors?.length) throw new GitHostError(`graphql: ${r.errors.map((e) => e.message ?? 'error').join('; ')}`);
      const pr = r.data?.repository?.pullRequest;
      if (!pr) throw new GitHostError('graphql: pull request not found', 404);
      const page = pr.reviewThreads;
      for (const t of page?.nodes ?? []) {
        if (!t) continue;
        threads.push({
          id: t.id,
          resolved: t.isResolved === true,
          commentIds: (t.comments?.nodes ?? []).flatMap((c) => (typeof c?.databaseId === 'number' ? [c.databaseId] : [])),
        });
      }
      if (page?.pageInfo?.hasNextPage !== true || !page.pageInfo.endCursor) return threads;
      after = page.pageInfo.endCursor;
    }
  }

  async replyToReviewComment(repo: string, prNumber: number, commentId: number, body: string): Promise<void> {
    await this.run(buildReplyToReviewCommentArgs(repo, prNumber, commentId), { body });
  }

  async resolveReviewThread(_repo: string, threadId: string): Promise<void> {
    const r = await this.json<{ errors?: Array<{ message?: string }> }>(buildGraphqlArgs(), {
      query: RESOLVE_THREAD_MUTATION,
      variables: { threadId },
    });
    if (r.errors?.length) throw new GitHostError(`graphql: ${r.errors.map((e) => e.message ?? 'error').join('; ')}`);
  }

  async listPrFeedback(repo: string, prNumber: number): Promise<PrFeedback> {
    const reviews = await this.pages<RestReview>((p) => buildListReviewsArgs(repo, prNumber, p));
    const reviewComments = await this.pages<RestReviewComment>((p) => buildListReviewCommentsArgs(repo, prNumber, p));
    const comments = await this.pages<RestIssueComment>((p) => buildListCommentsArgs(repo, prNumber, p));
    const threadOf = new Map<number, PrReviewThread>();
    for (const t of await this.listReviewThreads(repo, prNumber)) for (const id of t.commentIds) threadOf.set(id, t);
    return {
      reviews: reviews.map((r) => {
        const state = String(r.state ?? '').toUpperCase();
        return {
          id: r.id,
          author: r.user?.login ?? '',
          authorAssociation: r.author_association ?? 'NONE',
          // Pending reviews are never listed to others; anything unknown is a plain comment.
          state: (REVIEW_STATES as readonly string[]).includes(state) ? (state as PrReviewState) : 'COMMENTED',
          body: r.body ?? '',
          submittedAt: r.submitted_at ?? '',
        };
      }),
      reviewComments: reviewComments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE',
        path: c.path ?? '',
        line: c.line ?? c.original_line ?? null,
        diffHunk: c.diff_hunk ?? '',
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
        reviewId: c.pull_request_review_id ?? null,
        threadId: threadOf.get(c.id)?.id ?? null,
        threadResolved: threadOf.get(c.id)?.resolved === true,
      })),
      comments: comments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? '',
        authorAssociation: c.author_association ?? 'NONE',
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
      })),
    };
  }

  async findIssueByMarker(repo: string, marker: string, label?: string): Promise<number | null> {
    if (label !== undefined) {
      let best: number | null = null;
      for (let page = 1; ; page++) {
        const items = await this.json<Array<{ number: number; body?: string | null; pull_request?: unknown }>>(
          buildListIssuesByLabelArgs(repo, label, page),
        );
        for (const i of items) {
          if (i.pull_request || !(i.body ?? '').includes(marker)) continue;
          if (best === null || i.number < best) best = i.number;
        }
        if (items.length < 100) return best;
      }
    }
    const r = await this.json<{ items?: Array<{ number: number; pull_request?: unknown }> }>(
      buildSearchIssuesArgs(repo, marker),
    );
    const nums = (r.items ?? []).filter((i) => !i.pull_request).map((i) => i.number);
    return nums.length ? Math.min(...nums) : null;
  }

  async createIssue(repo: string, a: { title: string; body: string; labels: string[] }): Promise<number> {
    const r = await this.json<{ number: number }>(buildCreateIssueArgs(repo), a);
    return r.number;
  }

  async mergePr(repo: string, n: number, opts?: { expectHeadSha?: string }): Promise<void> {
    try {
      await this.run(
        buildMergePrArgs(repo, n, this.mergeMethod, {
          deleteBranch: this.deleteBranch,
          ...(opts?.expectHeadSha !== undefined ? { matchHeadCommit: opts.expectHeadSha } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof GitHostError && AUTO_MERGE_REFUSED.some((re) => re.test(e.message))) {
        throw new AutoMergeRefusedError(e.message, e.status);
      }
      throw e;
    }
  }
}
