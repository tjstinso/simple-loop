import { createHash } from 'node:crypto';
import type { GitHost, Issue } from '../engines/software/github.js';
import { SubmitRejectedError } from '../engines/software/submit.js';
import { AmbiguousMatchError, NoPolicyError } from '../policy/store.js';
import { DuplicateChainError } from '../kernel/queue.js';
import type { Kernel } from '../kernel/kernel.js';
import type { IntakeConfig } from '../cli/config.js';
import { planIntake } from './plan.js';

export const QUEUED_LABEL = 'factory:queued';
export const REJECTED_LABEL = 'factory:rejected';
export const REJECTED_MARKER = '<!-- factory:intake-rejected';

export interface IntakeDeps {
  host: GitHost;
  kernel: Kernel;
  config: IntakeConfig;
  /** The engine every intake issue is enqueued with. */
  engine: string;
  /** Subject keys of the open chains (active, waiting or dead-lettered). */
  openSubjects: () => string[];
  isDraining: () => boolean;
  /** Redacts text before it is posted to GitHub. */
  redact: (text: string) => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The hidden marker of a rejection comment: one comment per distinct issue body. */
export function rejectionMarker(body: string): string {
  return `${REJECTED_MARKER} hash=${createHash('sha256').update(body).digest('hex').slice(0, 8)} -->`;
}

function rejectionComment(reason: string, marker: string, readyLabel: string): string {
  return `${marker}\nThe factory cannot take on this issue: ${reason}\n\nFix the issue and add the \`${readyLabel}\` label again to have it considered once more.`;
}

/** One intake pass over every repository, and the memory that keeps the output quiet between passes. */
export class Intake {
  private readonly lastLine = new Map<string, string>();

  constructor(private readonly deps: IntakeDeps) {}

  /** Prints a decision only when it differs from what was last printed for the issue. */
  private note(key: string, line: string): void {
    if (this.lastLine.get(key) === line) return;
    this.lastLine.set(key, line);
    this.deps.stdout(line);
  }

  /** Runs one pass; returns whether any repository errored. `stop` is checked between issues. */
  async pass(stop: () => boolean = () => false): Promise<boolean> {
    const { host, config, stderr } = this.deps;
    let failed = false;
    for (const repo of config.repos) {
      if (stop()) break;
      try {
        const issues = await host.listIssuesByLabel(repo, config.readyLabel);
        const listed = new Set(issues.map((i) => `${repo}#${i.number}`));
        for (const key of [...this.lastLine.keys()]) if (key.startsWith(`${repo}#`) && !listed.has(key)) this.lastLine.delete(key);
        if (this.deps.isDraining()) {
          this.note(`${repo}#draining`, `${repo} draining: not enqueueing`);
          continue;
        }
        this.lastLine.delete(`${repo}#draining`);
        const decisions = planIntake(issues, this.deps.openSubjects(), { ...config, repo });
        for (const d of decisions) {
          if (stop()) break;
          const issue = issues.find((i) => i.number === d.number)!;
          const key = `${repo}#${d.number}`;
          try {
            if (d.decision === 'enqueue') {
              await this.enqueue(repo, issue);
            } else {
              this.note(key, `${key} ${d.decision} ${d.reason}`);
              // A chain exists but the label swap failed earlier: retry the acknowledgement.
              if (d.reason === 'already queued') await this.acknowledge(repo, issue.number);
            }
          } catch (e) {
            stderr(`error: ${message(e)}`);
            failed = true;
          }
        }
      } catch (e) {
        stderr(`error: ${message(e)}`);
        failed = true;
      }
    }
    return failed;
  }

  private async acknowledge(repo: string, n: number): Promise<void> {
    await this.deps.host.setLabels(repo, n, [QUEUED_LABEL], [this.deps.config.readyLabel]);
  }

  private async enqueue(repo: string, issue: Issue): Promise<void> {
    const { kernel, engine, stdout } = this.deps;
    const key = `${repo}#${issue.number}`;
    try {
      const { chain, job } = await kernel.enqueue(engine, { issueUrl: `https://github.com/${repo}/issues/${issue.number}` });
      this.lastLine.delete(key);
      stdout(`${key} enqueued chain ${chain.id} job ${job.id}`);
    } catch (e) {
      if (e instanceof SubmitRejectedError || e instanceof NoPolicyError || e instanceof AmbiguousMatchError) return this.reject(repo, issue, e);
      if (!(e instanceof DuplicateChainError)) throw e;
    }
    await this.acknowledge(repo, issue.number);
  }

  private async reject(repo: string, issue: Issue, e: Error): Promise<void> {
    const { host, config } = this.deps;
    const key = `${repo}#${issue.number}`;
    const reason = this.deps.redact(e.message);
    const marker = rejectionMarker(issue.body);
    if (!(await host.findComment(repo, issue.number, marker))) {
      await host.comment(repo, issue.number, rejectionComment(reason, marker, config.readyLabel));
    }
    await host.setLabels(repo, issue.number, [REJECTED_LABEL], [config.readyLabel]);
    this.note(key, `${key} rejected ${reason}`);
  }
}

export type IntakeStopSignal = 'SIGINT' | 'SIGTERM';

/** Passes now and then every `pollIntervalMs` until `stopped` resolves (a pass in progress finishes its current issue first). */
export async function runIntakeLoop(
  intake: Intake,
  pollIntervalMs: number,
  stopped: Promise<unknown>,
  isStopped: () => boolean,
  wait: (ms: number, wake: Promise<unknown>) => Promise<void> = (ms, wake) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      void wake.then(() => {
        clearTimeout(t);
        resolve();
      });
    }),
): Promise<void> {
  while (!isStopped()) {
    await intake.pass(isStopped);
    if (isStopped()) break;
    await wait(pollIntervalMs, stopped);
  }
}
