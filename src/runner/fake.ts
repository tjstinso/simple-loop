import { z } from 'zod';
import type { RunHooks, Runner, RunInput } from './types.js';

type Script = unknown[] | ((input: RunInput) => unknown);

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export class FakeRunner implements Runner {
  readonly name = 'fake';
  readonly configSchema = z.unknown();
  readonly calls: RunInput[] = [];
  private readonly scripts = new Map<string, { script: Script; next: number }>();

  script(jobType: string, results: unknown[] | ((input: RunInput) => unknown)): void {
    this.scripts.set(jobType, { script: results, next: 0 });
  }

  async run(input: RunInput, signal: AbortSignal, _hooks?: RunHooks): Promise<unknown> {
    if (signal.aborted) throw abortError();
    this.calls.push(input);
    const type = input.job.type;
    const entry = this.scripts.get(type);
    if (!entry) throw new Error(`FakeRunner: no script for job type "${type}"`);
    let result: unknown;
    if (typeof entry.script === 'function') {
      result = entry.script(input);
    } else {
      if (entry.next >= entry.script.length) {
        throw new Error(`FakeRunner: script exhausted for job type "${type}" after ${entry.script.length} result(s)`);
      }
      result = entry.script[entry.next++];
    }
    if (result instanceof Error) throw result;
    return result;
  }
}
