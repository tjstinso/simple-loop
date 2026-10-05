import {
  AutoMergeRefusedError,
  summarizeChecks,
  type CheckInfo,
  type ChecksStatus,
  GitHostError,
  type GitHost,
  type Issue,
  type Pr,
  type PrConversationComment,
  type PrFeedback,
  type PrReview,
  type PrReviewComment,
  type PrReviewThread,
} from '../../src/engines/software/github.js';

interface StoredIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  authorAssociation: string;
}

interface StoredPr extends Pr {
  head: string;
  title: string;
  body: string;
}

export class FakeGitHost implements GitHost {
  readonly issues = new Map<number, StoredIssue>();
  readonly prs = new Map<number, StoredPr>();
  readonly calls: { method: string; args: unknown[] }[] = [];
  private labels = new Map<number, Set<string>>();
  private comments = new Map<number, string[]>();
  private nextNumber = 1;
  private failures = new Map<string, Error>();
  private autoMerge = new Set<number>();
  private feedback = new Map<number, PrFeedback>();
  private nextFeedbackId = 1;
  private resolvedThreads = new Set<string>();
  private checks = new Map<string, CheckInfo[]>();
  private failedLogs = new Map<number, string>();
  /** Clock (epoch ms) for the `createdAt` of replies the factory posts; the harness points it at its own. */
  now: () => number = Date.now;
  /** Like the repository setting "Allow auto-merge": off makes `mergePr` throw AutoMergeRefusedError. */
  autoMergeAllowed = true;
  /** The branch protection's required checks: auto-merge merges only once they pass. */
  requiredChecksPass = false;
  /**
   * When set, a PR's head sha is resolved from its branch on every read (the harness points this at
   * the real temp remote), so pushes after opening are visible, as on GitHub.
   */
  headShaOf: ((branch: string) => string | null) | null = null;

  // ---- seeding / inspection ----
  addIssue(a: { number?: number; title: string; body: string; labels: string[]; state?: 'open' | 'closed'; authorAssociation?: string }): number {
    const number = a.number ?? this.nextNumber;
    this.nextNumber = Math.max(this.nextNumber, number + 1);
    this.issues.set(number, { number, title: a.title, body: a.body, state: a.state ?? 'open', authorAssociation: a.authorAssociation ?? 'NONE' });
    this.labels.set(number, new Set(a.labels));
    return number;
  }

  getLabels(n: number): string[] {
    return [...(this.labels.get(n) ?? [])];
  }

  getComments(n: number): string[] {
    return [...(this.comments.get(n) ?? [])];
  }

  /** Whether auto-merge is enabled on the pull request and it is still waiting for the checks. */
  autoMergeEnabled(n: number): boolean {
    return this.autoMerge.has(n);
  }

  /** The required checks pass: every open pull request with auto-merge enabled merges, like GitHub. */
  passRequiredChecks(): void {
    this.requiredChecksPass = true;
    for (const n of [...this.autoMerge]) {
      const pr = this.prs.get(n);
      if (pr?.state === 'open') pr.state = 'merged';
      this.autoMerge.delete(n);
    }
  }

  /** Marks a pull request merged (a person merged it, or GitHub did). */
  markMerged(n: number): void {
    this.prOrThrow(n).state = 'merged';
    this.autoMerge.delete(n);
  }

  private feedbackOf(n: number): PrFeedback {
    let f = this.feedback.get(n);
    if (!f) {
      f = { reviews: [], reviewComments: [], comments: [] };
      this.feedback.set(n, f);
    }
    return f;
  }

  /** A review by a person (`author_association` defaults to COLLABORATOR); returns its id. */
  addReview(n: number, r: Partial<PrReview> & Pick<PrReview, 'state' | 'submittedAt'>): number {
    const id = r.id ?? this.nextFeedbackId++;
    this.feedbackOf(n).reviews.push({ id, author: 'alice', authorAssociation: 'COLLABORATOR', body: '', ...r });
    return id;
  }

  /** An inline review comment; returns its id. */
  addReviewComment(n: number, c: Partial<PrReviewComment> & Pick<PrReviewComment, 'createdAt'>): number {
    const id = c.id ?? this.nextFeedbackId++;
    this.feedbackOf(n).reviewComments.push({
      id, author: 'alice', authorAssociation: 'COLLABORATOR', path: 'src/a.ts', line: 1, diffHunk: '@@ -1 +1 @@', body: '', reviewId: null,
      threadId: `thread-${id}`, ...c,
    });
    return id;
  }

  /** Marks a review thread resolved, as a person would. */
  resolveThread(threadId: string): void {
    this.resolvedThreads.add(threadId);
  }

  isThreadResolved(threadId: string): boolean {
    return this.resolvedThreads.has(threadId);
  }

  /** The thread an inline comment belongs to. */
  threadOf(n: number, commentId: number): string | null {
    return this.feedbackOf(n).reviewComments.find((c) => c.id === commentId)?.threadId ?? null;
  }

  /** A conversation comment on the pull request (not an inline one); returns its id. */
  addConversationComment(n: number, c: Partial<PrConversationComment> & Pick<PrConversationComment, 'createdAt'>): number {
    const id = c.id ?? this.nextFeedbackId++;
    this.feedbackOf(n).comments.push({ id, author: 'alice', authorAssociation: 'COLLABORATOR', body: '', ...c });
    return id;
  }

  /** What GitHub reports for the pull request's mergeability (default `mergeable`). */
  setMergeable(n: number, mergeable: Pr['mergeable']): void {
    this.prOrThrow(n).mergeable = mergeable;
  }

  setPrHead(n: number, sha: string): void {
    this.prOrThrow(n).headSha = sha;
  }

  /** Sets the checks GitHub reports for a commit (replacing earlier ones); the state is derived like the real adapter's. */
  setChecks(sha: string, checks: CheckInfo[]): void {
    this.checks.set(sha, checks.map((c) => ({ ...c })));
  }

  /** Sets what the failing log of a workflow run contains. */
  setFailedLog(runId: number, log: string): void {
    this.failedLogs.set(runId, log);
  }

  failNext(method: keyof GitHost, error: Error): void {
    this.failures.set(method, error);
  }

  // ---- internals ----
  private enter(method: keyof GitHost, args: unknown[]): void {
    this.calls.push({ method, args });
    const err = this.failures.get(method);
    if (err) {
      this.failures.delete(method);
      throw err;
    }
  }

  private exists(n: number): boolean {
    return this.issues.has(n) || this.prs.has(n);
  }

  private existsOrThrow(n: number): void {
    if (!this.exists(n)) throw new GitHostError('Not Found', 404);
  }

  private prOrThrow(n: number): StoredPr {
    const pr = this.prs.get(n);
    if (!pr) throw new GitHostError('Not Found', 404);
    return pr;
  }

  private headOf(pr: StoredPr): string {
    return this.headShaOf?.(pr.head) ?? pr.headSha;
  }

  private view(pr: StoredPr): Pr {
    return { number: pr.number, state: pr.state, headSha: this.headOf(pr), baseBranch: pr.baseBranch, mergeable: pr.mergeable };
  }

  // ---- GitHost ----
  async getIssue(repo: string, n: number): Promise<Issue> {
    this.enter('getIssue', [repo, n]);
    const i = this.issues.get(n);
    if (i) return { ...i, labels: this.getLabels(n) };
    const pr = this.prs.get(n); // PRs are issues on GitHub
    if (pr) return { number: n, title: pr.title, body: pr.body, labels: this.getLabels(n), state: pr.state === 'open' ? 'open' : 'closed', authorAssociation: 'NONE' };
    throw new GitHostError('Not Found', 404);
  }

  async listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
    this.enter('listIssuesByLabel', [repo, label]);
    return [...this.issues.values()]
      .filter((i) => i.state === 'open' && this.labels.get(i.number)?.has(label))
      .sort((a, b) => a.number - b.number)
      .map((i) => ({ ...i, labels: this.getLabels(i.number) }));
  }

  async findPrByHead(repo: string, branch: string): Promise<Pr | null> {
    this.enter('findPrByHead', [repo, branch]);
    const matches = [...this.prs.values()].filter((p) => p.head === branch);
    const pr = matches.sort((a, b) => b.number - a.number)[0];
    return pr ? this.view(pr) : null;
  }

  async openPr(repo: string, a: { head: string; base: string; title: string; body: string }): Promise<Pr> {
    this.enter('openPr', [repo, a]);
    const number = this.nextNumber++;
    const pr: StoredPr = {
      number, state: 'open', headSha: `fakesha-${number}`, baseBranch: a.base, mergeable: 'mergeable',
      head: a.head, title: a.title, body: a.body,
    };
    this.prs.set(number, pr);
    this.labels.set(number, new Set());
    return this.view(pr);
  }

  async getPr(repo: string, n: number): Promise<Pr> {
    this.enter('getPr', [repo, n]);
    return this.view(this.prOrThrow(n));
  }

  async setLabels(repo: string, n: number, add: string[], remove: string[]): Promise<void> {
    this.enter('setLabels', [repo, n, add, remove]);
    this.existsOrThrow(n);
    const set = this.labels.get(n) ?? new Set<string>();
    for (const l of add) set.add(l);
    for (const l of remove) set.delete(l);
    this.labels.set(n, set);
  }

  async findComment(repo: string, n: number, marker: string): Promise<boolean> {
    this.enter('findComment', [repo, n, marker]);
    this.existsOrThrow(n);
    return (this.comments.get(n) ?? []).some((c) => c.includes(marker));
  }

  async comment(repo: string, n: number, body: string): Promise<void> {
    this.enter('comment', [repo, n, body]);
    this.existsOrThrow(n);
    this.comments.set(n, [...(this.comments.get(n) ?? []), body]);
  }

  async closeIssue(repo: string, n: number, comment: string): Promise<void> {
    this.enter('closeIssue', [repo, n, comment]);
    this.existsOrThrow(n);
    this.comments.set(n, [...(this.comments.get(n) ?? []), comment]);
  }

  async findIssueByMarker(repo: string, marker: string, label?: string): Promise<number | null> {
    this.enter('findIssueByMarker', [repo, marker, label]);
    const nums = [...this.issues.values()]
      .filter((i) => i.body.includes(marker) && (label === undefined || this.labels.get(i.number)?.has(label)))
      .map((i) => i.number);
    return nums.length ? Math.min(...nums) : null;
  }

  async createIssue(repo: string, a: { title: string; body: string; labels: string[] }): Promise<number> {
    this.enter('createIssue', [repo, a]);
    return this.addIssue({ title: a.title, body: a.body, labels: a.labels });
  }

  async mergePr(repo: string, n: number, opts?: { expectHeadSha?: string }): Promise<void> {
    this.enter('mergePr', [repo, n, opts]);
    const pr = this.prOrThrow(n);
    if (pr.state === 'merged') return;
    if (pr.state === 'closed') throw new GitHostError('not mergeable', 405);
    if (!this.autoMergeAllowed) throw new AutoMergeRefusedError('Auto merge is not allowed for this repository');
    // Like `gh pr merge --match-head-commit`: refuse when the head moved.
    if (opts?.expectHeadSha !== undefined && opts.expectHeadSha !== this.headOf(pr)) {
      throw new AutoMergeRefusedError('head commit changed', 409);
    }
    // Like `gh pr merge --auto`: merges now when the required checks already pass, else when they do.
    if (this.requiredChecksPass) pr.state = 'merged';
    else this.autoMerge.add(n);
  }

  async getChecks(repo: string, sha: string): Promise<ChecksStatus> {
    this.enter('getChecks', [repo, sha]);
    const checks = (this.checks.get(sha) ?? []).map((c) => ({ ...c }));
    return { state: summarizeChecks(checks), checks };
  }

  async getFailedLogExcerpt(repo: string, runId: number, maxLines: number): Promise<string> {
    this.enter('getFailedLogExcerpt', [repo, runId, maxLines]);
    const log = this.failedLogs.get(runId);
    if (log === undefined) throw new GitHostError('Not Found', 404);
    return log.split('\n').slice(-maxLines).join('\n');
  }

  async listPrFeedback(repo: string, prNumber: number): Promise<PrFeedback> {
    this.enter('listPrFeedback', [repo, prNumber]);
    this.prOrThrow(prNumber);
    const f = this.feedbackOf(prNumber);
    // Factory comments are conversation comments too, as on GitHub.
    const factory = (this.comments.get(prNumber) ?? []).map((body, i) => ({
      id: -1 - i, author: 'factory', authorAssociation: 'OWNER', body, createdAt: new Date(0).toISOString(),
    }));
    const reviewComments = f.reviewComments.map((c) => ({ ...c, threadResolved: c.threadId != null && this.resolvedThreads.has(c.threadId) }));
    return structuredClone({ reviews: f.reviews, reviewComments, comments: [...factory, ...f.comments] });
  }

  async listReviewThreads(repo: string, prNumber: number): Promise<PrReviewThread[]> {
    this.enter('listReviewThreads', [repo, prNumber]);
    this.prOrThrow(prNumber);
    const byThread = new Map<string, number[]>();
    for (const c of this.feedbackOf(prNumber).reviewComments) {
      if (c.threadId != null) byThread.set(c.threadId, [...(byThread.get(c.threadId) ?? []), c.id]);
    }
    return [...byThread].map(([id, commentIds]) => ({ id, resolved: this.resolvedThreads.has(id), commentIds }));
  }

  async replyToReviewComment(repo: string, prNumber: number, commentId: number, body: string): Promise<void> {
    this.enter('replyToReviewComment', [repo, prNumber, commentId, body]);
    this.prOrThrow(prNumber);
    const original = this.feedbackOf(prNumber).reviewComments.find((c) => c.id === commentId);
    if (!original) throw new GitHostError('Not Found', 404);
    this.addReviewComment(prNumber, {
      author: 'factory', authorAssociation: 'OWNER', path: original.path, line: original.line, diffHunk: original.diffHunk, body,
      threadId: original.threadId ?? null, reviewId: original.reviewId, createdAt: new Date(this.now()).toISOString(),
    });
  }

  async resolveReviewThread(repo: string, threadId: string): Promise<void> {
    this.enter('resolveReviewThread', [repo, threadId]);
    this.resolvedThreads.add(threadId);
  }
}
