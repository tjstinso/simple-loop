import { it, expect } from 'vitest';
import { version } from '../src/index.js';

it('loads the package entry', () => {
  expect(typeof version).toBe('string');
});
