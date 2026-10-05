import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSoftwareRunInput } from '../../../src/engines/software/run-input.js';
import type { Issue } from '../../../src/engines/software/github.js';
import type { SoftwareState } from '../../../src/engines/software/state.js';
import type { SoftwareWorkspace } from '../../../src/engines/software/workspace.js';
import type { ChainView, Job } from '../../../src/kernel/types.js';
import { loadPolicies, PolicyStore } from '../../../src/policy/store.js';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli.js';

const state: SoftwareState = {
  repo: 'acme/widgets', issueNumber: 7, labels: ['bug'], profile: 'supervised',
  branch: 'factory/issue-7', attempt: 2, phase: 'executing',
};
const chain: ChainView<SoftwareState> = { id: 3, engine: 'software', subjectKey: 'acme/widgets#7', status: 'active', state };
const job = (type: string, payload: unknown = {}): Job => ({
  id: 42, chainId: 3, type, attempt: 2, status: 'running', policyId: 'p', payload, result: null,
  claimedBy: 'w', leaseExpiresAt: null, delivery: 1, error: null,
});
const ws: SoftwareWorkspace = {
  repo: 'acme/widgets', path: '/ws', localBranch: 'l', remoteBranch: 'factory/issue-7', remoteUrl: '/r.git',
  remoteHeadSha: null, seedSha: 'seed', baseBranch: 'main', cacheDir: '/cache/o__r.git',
};
const issue = { number: 7, title: 'Add thing', body: '## Goal\nx', labels: ['bug'], state: 'open', authorAssociation: 'NONE', author: 'eve', url: 'http://x' } as Issue;
const pr = { number: 12, baseBranch: 'main' };

const policiesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../policies');
const cfgSchema = new ClaudeCliRunner().configSchema;

describe('buildSoftwareRunInput', () => {
  it('includes issue title, body, labels and attempt in the execute subject', () => {
    const out = buildSoftwareRunInput(chain, job('execute'), ws, issue, null);
    expect(out.subject).toEqual({
      kind: 'execute', repo: 'acme/widgets', issueNumber: 7, title: 'Add thing', body: '## Goal\nx', labels: ['bug'], attempt: 2,
    });
    expect(out.workspace).toBe(ws);
    expect(out.job.id).toBe(42);
  });

  it('supplies the cache and base branch for the plugin directory check, on execute and review', () => {
    for (const out of [buildSoftwareRunInput(chain, job('execute'), ws, issue, null), buildSoftwareRunInput(chain, job('review'), ws, issue, pr)]) {
      expect(out.pluginBase).toEqual({ cacheDir: ws.cacheDir, baseBranch: 'main' });
    }
  });

  it('passes review feedback from the job payload on a revise attempt', () => {
    const out = buildSoftwareRunInput(chain, job('execute', { feedback: 'fix the tests' }), ws, issue, null);
    expect(out.feedback).toBe('fix the tests');
  });

  it('omits feedback when the payload has none or an empty one', () => {
    for (const p of [{}, { feedback: '' }, { feedback: 5 }, null, undefined]) {
      const out = buildSoftwareRunInput(chain, job('execute', p), ws, issue, null);
      expect('feedback' in out).toBe(false);
    }
  });

  it('a review subject carries the PR number and base branch', () => {
    const out = buildSoftwareRunInput(chain, job('review'), ws, issue, pr);
    expect(out.subject).toMatchObject({ kind: 'review', prNumber: 12, baseBranch: 'main', issueNumber: 7, attempt: 2 });
  });

  it('a review job without a PR throws', () => {
    expect(() => buildSoftwareRunInput(chain, job('review'), ws, issue, null)).toThrow(/PR/);
  });

  it('does not leak extra issue fields into the subject', () => {
    const out = buildSoftwareRunInput(chain, job('review'), ws, issue, pr);
    const json = JSON.stringify(out.subject);
    expect(json).not.toContain('eve');
    expect(json).not.toContain('http://x');
    expect(Object.keys(out.subject as object).sort()).toEqual(
      ['attempt', 'baseBranch', 'body', 'issueNumber', 'kind', 'labels', 'prNumber', 'repo', 'title'],
    );
  });
});

describe('default policies', () => {
  it('the default policy files load, form a valid PolicyStore and match execute and review jobs with no labels', () => {
    const store = new PolicyStore(loadPolicies(policiesDir));
    expect(store.match('execute', []).id).toBe('software-execute');
    expect(store.match('review', []).id).toBe('software-review');
  });

  it('each default policy config validates against the claude-cli config schema', () => {
    const byId = new Map(loadPolicies(policiesDir).map((p) => [p.id, p]));
    for (const p of byId.values()) {
      expect(p.runner).toBe('claude-cli');
      expect(cfgSchema.safeParse(p.config).success).toBe(true);
    }
    expect((byId.get('software-execute')!.config as { resultFormat: string }).resultFormat).toBe('execution');
    expect((byId.get('software-review')!.config as { resultFormat: string }).resultFormat).toBe('json');
  });

  it('the review policy tool allowlist contains no unrestricted Bash and no write tools', () => {
    const p = loadPolicies(policiesDir).find((x) => x.id === 'software-review')!;
    const tools = (p.config as { allowedTools: string[] }).allowedTools;
    for (const t of tools) {
      expect(['Bash', 'Edit', 'Write', 'NotebookEdit']).not.toContain(t);
      if (t.startsWith('Bash')) expect(t).toMatch(/^Bash\(git (diff|log|show|status):\*\)$/);
    }
  });

  it('both prompts instruct a final fenced json block with the keys the engine schemas expect', () => {
    const prompts = Object.fromEntries(
      loadPolicies(policiesDir).map((p) => [p.id, (p.config as { prompt: string }).prompt]),
    );
    for (const id of ['software-execute', 'software-review']) {
      expect(prompts[id]).toContain('```json');
      expect(prompts[id]).toContain('followups');
    }
    expect(prompts['software-execute']).toContain('"summary"');
    expect(prompts['software-review']).toContain('"verdict"');
    expect(prompts['software-review']).toContain('"feedback"');
    expect(prompts['software-review']).toContain('request_changes');
  });
});
