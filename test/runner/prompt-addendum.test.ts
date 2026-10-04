import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/runner/claude-cli.js';
import type { RunInput } from '../../src/runner/types.js';

const cfg = { prompt: 'BASE PROMPT' } as Parameters<typeof buildPrompt>[0];
const input = (extra: Partial<RunInput>): RunInput => ({ job: {} as RunInput['job'], config: {}, subject: { a: 1 }, workspace: { path: '/w' }, ...extra });

describe('buildPrompt addendum', () => {
  it('places the engine addendum between the policy prompt and the work item', () => {
    const p = buildPrompt(cfg, input({ promptAddendum: 'EXTRA' }));
    expect(p.indexOf('BASE PROMPT')).toBeLessThan(p.indexOf('EXTRA'));
    expect(p.indexOf('EXTRA')).toBeLessThan(p.indexOf('## Work item'));
  });

  it('is unchanged without one', () => {
    expect(buildPrompt(cfg, input({}))).toBe('BASE PROMPT\n\n## Work item\n\n```json\n{\n  "a": 1\n}\n```');
  });
});
