import type { NewJob } from '../../kernel/types.js';
import type { PolicyStore } from '../../policy/store.js';
import type { GitHost } from './github.js';
import { SoftwareStateSchema, type SoftwareState } from './state.js';

const SEGMENT_RE = /^[\w.-]+$/;
const PROFILE_AUTOMATIC_LABEL = 'factory:profile:automatic';

export interface SubmitDeps {
  host: GitHost;
  policies: PolicyStore;
  config: { defaultProfile: 'supervised' | 'automatic'; requiredSections: string[] };
}

export function parseIssueUrl(url: string): { repo: string; number: number } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a valid issue URL: ${JSON.stringify(url)}`);
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) {
    throw new Error(`not a github.com issue URL: ${JSON.stringify(url)}`);
  }
  if (u.search || u.hash || u.username || u.password || u.port) {
    throw new Error(`issue URL must not carry a query, fragment, credentials or port: ${JSON.stringify(url)}`);
  }
  const parts = u.pathname.replace(/\/$/, '').split('/');
  // ['', owner, repo, 'issues', n]
  if (parts.length !== 5 || parts[0] !== '' || parts[3] !== 'issues') {
    throw new Error(`expected https://github.com/<owner>/<repo>/issues/<n>: ${JSON.stringify(url)}`);
  }
  const [, owner, name, , num] = parts as [string, string, string, string, string];
  for (const seg of [owner, name]) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..') {
      throw new Error(`invalid owner or repository name in issue URL: ${JSON.stringify(url)}`);
    }
  }
  if (!/^\d+$/.test(num) || Number(num) < 1 || !Number.isSafeInteger(Number(num))) {
    throw new Error(`invalid issue number in issue URL: ${JSON.stringify(url)}`);
  }
  return { repo: `${owner}/${name}`, number: Number(num) };
}

function missingSections(body: string, required: string[]): string[] {
  const lines = new Set(body.split(/\r?\n/).map((l) => l.trim().toLowerCase()));
  return required.filter((s) => !lines.has(s.trim().toLowerCase()));
}

export async function softwareSubmit(
  input: { issueUrl: string },
  deps: SubmitDeps,
): Promise<{ subjectKey: string; state: SoftwareState; firstJob: NewJob }> {
  const { repo, number } = parseIssueUrl(input.issueUrl);
  const issue = await deps.host.getIssue(repo, number);
  if (issue.state !== 'open') throw new Error(`issue ${repo}#${number} is closed`);
  if (issue.body.trim() === '') throw new Error(`issue ${repo}#${number} has an empty body`);
  const missing = missingSections(issue.body, deps.config.requiredSections);
  if (missing.length > 0) {
    throw new Error(`issue ${repo}#${number} is missing required section(s): ${missing.join(', ')}`);
  }
  const profile = issue.labels.includes(PROFILE_AUTOMATIC_LABEL) ? 'automatic' : deps.config.defaultProfile;
  deps.policies.match('execute', issue.labels);
  const state = SoftwareStateSchema.parse({
    repo,
    issueNumber: number,
    labels: issue.labels,
    profile,
    branch: `factory/issue-${number}`,
    attempt: 1,
    phase: 'executing',
  });
  return {
    subjectKey: `${repo}#${number}`,
    state,
    firstJob: { type: 'execute', attempt: 1, policyKind: 'execute', labels: issue.labels },
  };
}
