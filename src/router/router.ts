const ENGINE_PREFIX = 'factory:engine:';

export class UnknownEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownEngineError';
  }
}

export class AmbiguousEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousEngineError';
  }
}

/** Pure: resolve the engine id for a set of labels. */
export function routeEngine(labels: string[], defaultEngine: string, known: string[]): string {
  const engineLabels = [...new Set(labels.filter((l) => l.startsWith(ENGINE_PREFIX)))];
  if (engineLabels.length > 1) {
    throw new AmbiguousEngineError(`multiple engine labels: ${engineLabels.join(', ')}`);
  }
  if (engineLabels.length === 0) {
    if (!known.includes(defaultEngine)) {
      throw new UnknownEngineError(`default engine "${defaultEngine}" is not registered`);
    }
    return defaultEngine;
  }
  const label = engineLabels[0]!;
  const id = label.slice(ENGINE_PREFIX.length);
  if (id === '' || !known.includes(id)) {
    throw new UnknownEngineError(`unknown engine for label "${label}"`);
  }
  return id;
}
