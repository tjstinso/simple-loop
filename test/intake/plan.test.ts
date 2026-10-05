import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/engines/software/github.js';
import { planIntake, type IntakePlanConfig } from '../../src/intake/plan.js';

const issue = (number: number, authorAssociation = 'MEMBER'): Issue => ({
  number, title: `t${number}`, body: '', labels: ['factory:ready'], state: 'open', authorAssociation,
});
const config = (over: Partial<IntakePlanConfig> = {}): IntakePlanConfig => ({
  repo: 'o/r', maxOpenChains: 2, allowedAuthorAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'], ...over,
});

describe('planIntake', () => {
  it('returns nothing for no issues', () => {
    expect(planIntake([], ['o/r#1'], config())).toEqual([]);
  });

  it('enqueues a ready issue', () => {
    expect(planIntake([issue(1)], [], config())).toEqual([{ number: 1, decision: 'enqueue', reason: 'ready' }]);
  });

  it('skips an author that is not allowed', () => {
    expect(planIntake([issue(1, 'NONE')], [], config())).toEqual([{ number: 1, decision: 'skip', reason: 'author not allowed' }]);
  });

  it('skips an issue that already has an open chain', () => {
    expect(planIntake([issue(1)], ['o/r#1'], config())).toEqual([{ number: 1, decision: 'skip', reason: 'already queued' }]);
  });

  it('checks the author before the other reasons', () => {
    expect(planIntake([issue(1, 'FIRST_TIME_CONTRIBUTOR')], ['o/r#1', 'o/r#2'], config({ maxOpenChains: 1 }))).toEqual([
      { number: 1, decision: 'skip', reason: 'author not allowed' },
    ]);
  });

  it('checks already queued before capacity', () => {
    expect(planIntake([issue(1)], ['o/r#1', 'o/r#2'], config())).toEqual([{ number: 1, decision: 'skip', reason: 'already queued' }]);
  });

  it('counts the open chains of the repository and the issues planned so far', () => {
    const plan = planIntake([issue(1), issue(2), issue(3)], ['o/r#9'], config());
    expect(plan.map((d) => [d.number, d.decision, d.reason])).toEqual([
      [1, 'enqueue', 'ready'],
      [2, 'skip', 'at capacity'],
      [3, 'skip', 'at capacity'],
    ]);
  });

  it('ignores open chains of other repositories for capacity', () => {
    const plan = planIntake([issue(1)], ['x/y#1', 'x/y#2', 'x/y#3'], config());
    expect(plan[0]).toEqual({ number: 1, decision: 'enqueue', reason: 'ready' });
  });

  it('does not let skipped issues use capacity', () => {
    const plan = planIntake([issue(1, 'NONE'), issue(2), issue(3)], [], config({ maxOpenChains: 1 }));
    expect(plan.map((d) => d.decision)).toEqual(['skip', 'enqueue', 'skip']);
  });

  it('answers oldest first whatever the input order', () => {
    const plan = planIntake([issue(7), issue(3), issue(5)], [], config({ maxOpenChains: 5 }));
    expect(plan.map((d) => d.number)).toEqual([3, 5, 7]);
  });
});
