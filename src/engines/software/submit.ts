import type { NewJob } from '../../kernel/types.js';
import type { PolicyStore } from '../../policy/store.js';
import type { GitHost } from './github.js';
import { FOLLOWUP_LABEL } from './followups.js';
import { SoftwareStateSchema, type SoftwareState } from './state.js';

const SEGMENT_RE = /^[\w.-]+$/;
const PROFILE_LABEL_PREFIX = 'factory:profile:';

export type Profile = 'supervised' | 'automatic';

/** Which profiles issue labels may select: the allowed names and the labels that select one by default. */
export interface ProfileSelection {
  allowed: string[];
  byLabel: Record<string, string>;
}

export const DEFAULT_PROFILE_SELECTION: ProfileSelection = {
  allowed: ['automatic', 'supervised'],
  byLabel: { 'factory:supervised': 'supervised' },
};

export interface SubmitDeps {
  host: GitHost;
  policies: PolicyStore;
  config: { defaultProfile: Profile; requiredSections: string[]; profiles?: ProfileSelection };
}

/** The issue itself cannot be taken on (closed, empty, a required section missing); retrying cannot help until it changes. */
export class SubmitRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmitRejectedError';
  }
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
  // GitHub owner and repository names are case-insensitive: one spelling, so one subject key per issue.
  return { repo: `${owner}/${name}`.toLowerCase(), number: Number(num) };
}

function missingSections(body: string, required: string[]): string[] {
  const lines = new Set(body.split(/\r?\n/).map((l) => l.trim().toLowerCase()));
  return required.filter((s) => !lines.has(s.trim().toLowerCase()));
}

/**
 * The profile the labels choose: a `factory:profile:<name>` label, else the first `byLabel` entry whose
 * label is present, else `defaultProfile`. The result must be in `allowed`.
 */
export function chooseProfile(labels: string[], defaultProfile: Profile, selection: ProfileSelection): Profile {
  const explicit = [...new Set(labels.filter((l) => l.startsWith(PROFILE_LABEL_PREFIX)))];
  if (explicit.length > 1) throw new SubmitRejectedError(`multiple profile labels: ${explicit.join(', ')}`);
  let chosen: string = defaultProfile;
  if (explicit.length === 1) {
    chosen = explicit[0]!.slice(PROFILE_LABEL_PREFIX.length);
  } else {
    const have = new Set(labels);
    for (const [label, profile] of Object.entries(selection.byLabel)) {
      if (have.has(label)) {
        chosen = profile;
        break;
      }
    }
  }
  if (!selection.allowed.includes(chosen)) {
    throw new SubmitRejectedError(`profile "${chosen}" is not allowed (allowed: ${selection.allowed.join(', ')})`);
  }
  return chosen as Profile;
}

export async function softwareSubmit(
  input: { issueUrl: string },
  deps: SubmitDeps,
): Promise<{ subjectKey: string; state: SoftwareState; firstJob: NewJob }> {
  const { repo, number } = parseIssueUrl(input.issueUrl);
  const issue = await deps.host.getIssue(repo, number);
  if (issue.state !== 'open') throw new SubmitRejectedError(`issue ${repo}#${number} is closed`);
  if (issue.body.trim() === '') throw new SubmitRejectedError(`issue ${repo}#${number} has an empty body`);
  // A follow-up is a one- or two-sentence note from a reviewer: it has no sections to require.
  const missing = issue.labels.includes(FOLLOWUP_LABEL) ? [] : missingSections(issue.body, deps.config.requiredSections);
  if (missing.length > 0) {
    throw new SubmitRejectedError(`issue ${repo}#${number} is missing required section(s): ${missing.join(', ')}`);
  }
  const profile = chooseProfile(
    issue.labels,
    deps.config.defaultProfile,
    deps.config.profiles ?? DEFAULT_PROFILE_SELECTION,
  );
  deps.policies.match('execute', issue.labels);
  // The review job is matched with the same labels later; an ambiguous or missing review policy must
  // fail here, not after the agent ran.
  deps.policies.match('review', issue.labels);
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
