import type { Runner } from './types.js';

export class RunnerRegistry {
  private readonly runners = new Map<string, Runner>();

  register(r: Runner): void {
    if (this.runners.has(r.name)) throw new Error(`runner already registered: ${r.name}`);
    this.runners.set(r.name, r);
  }

  has(name: string): boolean {
    return this.runners.has(name);
  }

  get(name: string): Runner {
    const r = this.runners.get(name);
    if (!r) throw new Error(`unknown runner: ${name}`);
    return r;
  }
}
