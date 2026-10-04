import { execFile } from 'node:child_process';
import { ghAuthEnv, type GithubAuth } from './identity.js';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
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

export interface GitHost {
  getIssue(repo: string, n: number): Promise<Issue>;
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
  /** The reviews, inline review comments and conversation comments of a pull request, all pages. */
  listPrFeedback(repo: string, prNumber: number): Promise<PrFeedback>;
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

export const buildCommentArgs = (repo: string, n: number): string[] => [
  'api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-',
];

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

interface RestIssueComment {
  id: number;
  user?: RestUser | null;
  author_association?: string | null;
  body?: string | null;
  created_at?: string | null;
}

const REVIEW_STATES: readonly PrReviewState[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

export class GhCliHost implements GitHost {
  private readonly exec: ExecFn;
  private readonly mergeMethod: MergeMethod;
  private readonly ghTimeoutMs: number;
  private readonly deleteBranch: boolean;
  private readonly env: Record<string, string> | undefined;

  constructor(
    opts: { exec?: ExecFn; mergeMethod?: MergeMethod; ghTimeoutMs?: number; deleteBranch?: boolean; auth?: GithubAuth } = {},
  ) {
    this.env = opts.auth === undefined ? undefined : ghAuthEnv(opts.auth);
    this.exec = opts.exec ?? defaultExec;
    this.mergeMethod = opts.mergeMethod ?? 'squash';
    this.ghTimeoutMs = opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
    this.deleteBranch = opts.deleteBranch ?? true;
  }

  private async run(args: string[], input?: unknown): Promise<string> {
    const r = await this.exec('gh', args, {
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
      timeoutMs: this.ghTimeoutMs,
      ...(this.env === undefined ? {} : { env: this.env }),
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

  async getIssue(repo: string, n: number): Promise<Issue> {
    const i = await this.json<RestIssue>(buildGetIssueArgs(repo, n));
    return {
      number: i.number,
      title: i.title ?? '',
      body: i.body ?? '',
      labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      state: String(i.state).toLowerCase() === 'closed' ? 'closed' : 'open',
    };
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

  async listPrFeedback(repo: string, prNumber: number): Promise<PrFeedback> {
    const reviews = await this.pages<RestReview>((p) => buildListReviewsArgs(repo, prNumber, p));
    const reviewComments = await this.pages<RestReviewComment>((p) => buildListReviewCommentsArgs(repo, prNumber, p));
    const comments = await this.pages<RestIssueComment>((p) => buildListCommentsArgs(repo, prNumber, p));
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
