import { describe, expect, it } from 'vitest';
import {
  conflictFeedback,
  conflictingPaths,
  hasConflictMarkers,
  looksBinary,
  MAX_CONFLICT_PATHS,
  parseUnmerged,
  structuralConflicts,
} from '../../../src/engines/software/conflict.js';

const sha = 'a'.repeat(40);
const ls = (...e: Array<[string, number, string]>) => e.map(([mode, stage, path]) => `${mode} ${sha} ${stage}\t${path}\0`).join('');

describe('hasConflictMarkers', () => {
  it('finds each of the three marker lines', () => {
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n')).toBe(true);
    expect(hasConflictMarkers('a\n=======\nb\n')).toBe(true);
    expect(hasConflictMarkers('a\n>>>>>>> origin/main\n')).toBe(true);
    expect(hasConflictMarkers('a\r\n=======\r\nb')).toBe(true);
  });

  it('ignores lines that only resemble a marker', () => {
    expect(hasConflictMarkers('a\nb\n')).toBe(false);
    expect(hasConflictMarkers('x <<<<<<< y\n  =======\n==== ====\n<<<<<<<\n=======x\n')).toBe(false);
    expect(hasConflictMarkers('')).toBe(false);
  });
});

describe('conflicting paths', () => {
  it('lists each unmerged path once, sorted', () => {
    const entries = parseUnmerged(ls(['100644', 1, 'b.txt'], ['100644', 2, 'b.txt'], ['100644', 3, 'b.txt'], ['100644', 2, 'a/c.txt'], ['100644', 3, 'a/c.txt']));
    expect(entries).toHaveLength(5);
    expect(conflictingPaths(entries)).toEqual(['a/c.txt', 'b.txt']);
    expect(parseUnmerged('')).toEqual([]);
  });

  it('keeps paths with spaces and flags deleted/modified, symlink and submodule entries', () => {
    const entries = parseUnmerged(
      ls(['100644', 2, 'my file.txt'], ['100644', 3, 'my file.txt'], ['100644', 1, 'gone.txt'], ['100644', 2, 'gone.txt'], ['120000', 2, 'link'], ['120000', 3, 'link']),
    );
    expect(conflictingPaths(entries)).toEqual(['gone.txt', 'link', 'my file.txt']);
    expect(structuralConflicts(entries)).toEqual(['gone.txt', 'link']);
  });

  it('treats an add/add conflict (no stage 1) as a plain text conflict', () => {
    expect(structuralConflicts(parseUnmerged(ls(['100644', 2, 'n.txt'], ['100644', 3, 'n.txt'])))).toEqual([]);
  });
});

describe('looksBinary', () => {
  it('is true with a NUL byte in the first 8000 bytes', () => {
    expect(looksBinary(Buffer.from([65, 0, 66]))).toBe(true);
    expect(looksBinary(Buffer.from('text\n'))).toBe(false);
  });
});

describe('conflictFeedback', () => {
  it('names the base branch and the paths and states the resolution rules', () => {
    const text = conflictFeedback('main', ['a.txt', 'dir/b.txt']);
    expect(text).toContain('`main`');
    expect(text).toContain('- a.txt\n- dir/b.txt');
    expect(text).toContain('keeping the intent of both sides');
    expect(text).toContain('Leave no conflict markers');
    expect(text).toContain('Do not reformat unrelated code');
    expect(MAX_CONFLICT_PATHS).toBe(50);
  });
});
