import { execFile } from 'node:child_process';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
}

export interface Pr {
  number: number;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  baseBranch: string;
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
  mergePr(repo: string, n: number): Promise<void>;
}

export class GitHostError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHostError';
    if (status !== undefined) this.status = status;
  }
}

/** Default limit for one `gh` call; a hung call is killed (SIGKILL) and fails as a transient error. */
export const GH_TIMEOUT_MS = 60_000;

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: opts?.timeoutMs ?? 0, killSignal: 'SIGKILL' },
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
  '--json', 'number,state,headRefOid,baseRefName', '--limit', '1',
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

// `gh pr merge` handles merge-method flags and auto-detects the repo/branch rules.
export const buildMergePrArgs = (repo: string, n: number, method: MergeMethod): string[] => [
  'pr', 'merge', String(n), '--repo', repo, `--${method}`,
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
}

export class GhCliHost implements GitHost {
  private readonly exec: ExecFn;
  private readonly mergeMethod: MergeMethod;
  private readonly ghTimeoutMs: number;

  constructor(opts: { exec?: ExecFn; mergeMethod?: MergeMethod; ghTimeoutMs?: number } = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.mergeMethod = opts.mergeMethod ?? 'squash';
    this.ghTimeoutMs = opts.ghTimeoutMs ?? GH_TIMEOUT_MS;
  }

  private async run(args: string[], input?: unknown): Promise<string> {
    const r = await this.exec('gh', args, {
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
      timeoutMs: this.ghTimeoutMs,
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
    const list = await this.json<Array<{ number: number; state: string; headRefOid: string; baseRefName: string }>>(
      buildFindPrArgs(repo, branch),
    );
    const p = list[0];
    if (!p) return null;
    return { number: p.number, state: p.state.toLowerCase() as Pr['state'], headSha: p.headRefOid, baseBranch: p.baseRefName };
  }

  private mapPr(p: RestPr): Pr {
    const state: Pr['state'] = p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
    return { number: p.number, state, headSha: p.head?.sha ?? '', baseBranch: p.base?.ref ?? '' };
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

  async mergePr(repo: string, n: number): Promise<void> {
    await this.run(buildMergePrArgs(repo, n, this.mergeMethod));
  }
}
