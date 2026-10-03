import { describe, it, expect } from 'vitest';
import { routeEngine, UnknownEngineError, AmbiguousEngineError } from '../../src/router/router.js';

const known = ['software', 'docs'];

describe('routeEngine', () => {
  it('returns the default engine with no engine label', () => {
    expect(routeEngine(['bug'], 'software', known)).toBe('software');
  });
  it('returns the engine named by factory:engine:<id>', () => {
    expect(routeEngine(['factory:engine:docs'], 'software', known)).toBe('docs');
  });
  it('throws AmbiguousEngineError for two engine labels', () => {
    expect(() => routeEngine(['factory:engine:docs', 'factory:engine:software'], 'software', known)).toThrow(AmbiguousEngineError);
  });
  it('throws UnknownEngineError for an unregistered engine label', () => {
    expect(() => routeEngine(['factory:engine:nope'], 'software', known)).toThrow(UnknownEngineError);
    expect(() => routeEngine(['factory:engine:nope'], 'software', known)).toThrow(/factory:engine:nope/);
  });
  it('throws UnknownEngineError for an empty engine id', () => {
    expect(() => routeEngine(['factory:engine:'], 'software', known)).toThrow(UnknownEngineError);
  });
  it('does not treat a repeated identical engine label as ambiguous', () => {
    expect(routeEngine(['factory:engine:docs', 'factory:engine:docs'], 'software', known)).toBe('docs');
  });
  it('throws UnknownEngineError when the default engine is not registered', () => {
    expect(() => routeEngine([], 'ghost', known)).toThrow(UnknownEngineError);
    expect(() => routeEngine([], 'ghost', known)).toThrow(/ghost/);
  });
  it('ignores unrelated labels', () => {
    expect(routeEngine(['factory:engine', 'x:factory:engine:docs', 'priority'], 'software', known)).toBe('software');
  });
});
