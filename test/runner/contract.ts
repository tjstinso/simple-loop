import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Runner, RunInput } from '../../src/runner/types.js';

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

export function runnerContract(
  makeRunner: () => { runner: Runner; validInput: RunInput; cleanup(): void },
): void {
  describe('runner contract', () => {
    it('resolves with a value for valid input', async () => {
      const { runner, validInput, cleanup } = makeRunner();
      try {
        const result = await runner.run(validInput, new AbortController().signal);
        expect(result).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('rejects with AbortError when the signal is aborted before start', async () => {
      const { runner, validInput, cleanup } = makeRunner();
      try {
        const ac = new AbortController();
        ac.abort();
        await expect(runner.run(validInput, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
      } finally {
        cleanup();
      }
    });

    it('does not mutate files outside workspace.path', async () => {
      const { runner, validInput, cleanup } = makeRunner();
      const sibling = mkdtempSync(join(tmpdir(), 'runner-sibling-'));
      try {
        writeFileSync(join(sibling, 'a.txt'), 'a');
        mkdirSync(join(sibling, 'sub'));
        writeFileSync(join(sibling, 'sub', 'b.txt'), 'b');
        const before = snapshot(sibling);
        await runner.run(validInput, new AbortController().signal);
        expect(snapshot(sibling)).toEqual(before);
      } finally {
        rmSync(sibling, { recursive: true, force: true });
        cleanup();
      }
    });
  });
}
