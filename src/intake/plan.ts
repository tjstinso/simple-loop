import type { Issue } from '../engines/software/github.js';

export interface IntakePlanConfig {
  /** The repository the issues belong to (`owner/name`). */
  repo: string;
  maxOpenChains: number;
  allowedAuthorAssociations: readonly string[];
}

export type IntakeDecisionKind = 'enqueue' | 'skip';

export interface IntakeDecision {
  number: number;
  decision: IntakeDecisionKind;
  reason: string;
}

/**
 * Decides, per issue and oldest first, what the intake would do. Pure: `openSubjects` are the subject
 * keys (`owner/repo#N`) of the open chains, and capacity counts those of this repository plus the
 * issues already planned for enqueueing.
 */
export function planIntake(issues: readonly Issue[], openSubjects: readonly string[], config: IntakePlanConfig): IntakeDecision[] {
  const open = new Set(openSubjects);
  const prefix = `${config.repo}#`;
  let load = openSubjects.filter((s) => s.startsWith(prefix)).length;
  return [...issues]
    .sort((a, b) => a.number - b.number)
    .map((issue): IntakeDecision => {
      const skip = (reason: string): IntakeDecision => ({ number: issue.number, decision: 'skip', reason });
      if (!config.allowedAuthorAssociations.includes(issue.authorAssociation)) return skip('author not allowed');
      if (open.has(`${prefix}${issue.number}`)) return skip('already queued');
      if (load >= config.maxOpenChains) return skip('at capacity');
      load++;
      return { number: issue.number, decision: 'enqueue', reason: 'ready' };
    });
}
