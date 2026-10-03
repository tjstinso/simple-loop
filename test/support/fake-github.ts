import { GitHostError, type GitHost, type Issue, type Pr } from '../../src/engines/software/github.js';

interface StoredIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
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

  // ---- seeding / inspection ----
  addIssue(a: { number?: number; title: string; body: string; labels: string[]; state?: 'open' | 'closed' }): number {
    const number = a.number ?? this.nextNumber;
    this.nextNumber = Math.max(this.nextNumber, number + 1);
    this.issues.set(number, { number, title: a.title, body: a.body, state: a.state ?? 'open' });
    this.labels.set(number, new Set(a.labels));
    return number;
  }

  getLabels(n: number): string[] {
    return [...(this.labels.get(n) ?? [])];
  }

  getComments(n: number): string[] {
    return [...(this.comments.get(n) ?? [])];
  }

  setPrHead(n: number, sha: string): void {
    this.prOrThrow(n).headSha = sha;
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

  private view(pr: StoredPr): Pr {
    return { number: pr.number, state: pr.state, headSha: pr.headSha, baseBranch: pr.baseBranch };
  }

  // ---- GitHost ----
  async getIssue(repo: string, n: number): Promise<Issue> {
    this.enter('getIssue', [repo, n]);
    const i = this.issues.get(n);
    if (i) return { ...i, labels: this.getLabels(n) };
    const pr = this.prs.get(n); // PRs are issues on GitHub
    if (pr) return { number: n, title: pr.title, body: pr.body, labels: this.getLabels(n), state: pr.state === 'open' ? 'open' : 'closed' };
    throw new GitHostError('Not Found', 404);
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
      number, state: 'open', headSha: `fakesha-${number}`, baseBranch: a.base,
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

  async mergePr(repo: string, n: number): Promise<void> {
    this.enter('mergePr', [repo, n]);
    const pr = this.prOrThrow(n);
    if (pr.state === 'merged') return;
    if (pr.state === 'closed') throw new GitHostError('not mergeable', 405);
    pr.state = 'merged';
  }
}
