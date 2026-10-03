import type { ChainView, Job } from '../../kernel/types.js';
import type { RunInput } from '../../runner/types.js';
import type { Issue } from './github.js';
import type { SoftwareState } from './state.js';
import type { SoftwareWorkspace } from './workspace.js';

/**
 * Pure builder of the runner input (everything except `config`, which the kernel fills from the
 * policy). The subject is a plain object holding only the fields the agent needs; nothing else of
 * the issue (author, URLs) is passed on. Issue text is untrusted data and is only ever placed into
 * this JSON subject, never into a command or the prompt template.
 */
export function buildSoftwareRunInput(
  chain: ChainView<SoftwareState>,
  job: Job,
  workspace: SoftwareWorkspace,
  issue: Issue,
  pr: { number: number; baseBranch: string } | null,
): Omit<RunInput, 'config'> {
  const s = chain.state;
  const base = {
    repo: s.repo,
    issueNumber: s.issueNumber,
    title: issue.title,
    body: issue.body,
    labels: [...issue.labels],
    attempt: s.attempt,
  };
  let subject: Record<string, unknown>;
  if (job.type === 'review') {
    if (!pr) throw new Error(`no PR found for review of ${s.branch}`);
    subject = { kind: 'review', ...base, prNumber: pr.number, baseBranch: pr.baseBranch };
  } else {
    subject = { kind: 'execute', ...base };
  }
  const out: Omit<RunInput, 'config'> = { job, workspace, subject };
  const payload = job.payload as { feedback?: unknown } | null | undefined;
  const feedback = payload?.feedback;
  if (typeof feedback === 'string' && feedback !== '') out.feedback = feedback;
  return out;
}
