import type { Engine } from './types.js';

export class EngineRegistry {
  private readonly engines = new Map<string, Engine<any>>();

  register(e: Engine<any>): void {
    if (this.engines.has(e.id)) throw new Error(`engine already registered: ${e.id}`);
    this.engines.set(e.id, e);
  }

  get(id: string): Engine<any> {
    const e = this.engines.get(id);
    if (!e) throw new Error(`unknown engine: ${id}`);
    return e;
  }

  ids(): string[] {
    return [...this.engines.keys()];
  }
}
