import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseProcStatStartTime, readProcessStartTime } from '../../src/util/proc.js';

describe('readProcessStartTime', () => {
  it.runIf(process.platform === 'linux')('returns a positive clock-tick count for a live process', () => {
    const t = readProcessStartTime(process.pid);
    expect(typeof t).toBe('number');
    expect(t).toBeGreaterThan(0);
    expect(readProcessStartTime(process.pid)).toBe(t);
  });

  it.runIf(process.platform === 'linux')('a later child has a start time no earlier than ours', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      const mine = readProcessStartTime(process.pid)!;
      const theirs = readProcessStartTime(child.pid!);
      expect(theirs).not.toBeNull();
      expect(theirs!).toBeGreaterThanOrEqual(mine);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('returns null for a pid that does not exist', () => {
    expect(readProcessStartTime(2 ** 30)).toBeNull();
  });
});

describe('parseProcStatStartTime', () => {
  const rest = (start: number): string => {
    // fields 3..52; field 22 (starttime) is index 19 of this list
    const f = Array.from({ length: 50 }, (_, i) => String(i + 3));
    f[0] = 'S';
    f[19] = String(start);
    return f.join(' ');
  };

  it('reads field 22', () => {
    expect(parseProcStatStartTime(`123 (node) ${rest(98765)}`)).toBe(98765);
  });

  it('handles command names containing spaces and parentheses', () => {
    expect(parseProcStatStartTime(`123 (a b) (c) ) x) ${rest(4242)}`)).toBe(4242);
  });

  it('returns null for malformed input', () => {
    expect(parseProcStatStartTime('')).toBeNull();
    expect(parseProcStatStartTime('123 (node) S 1 2')).toBeNull();
    expect(parseProcStatStartTime(`123 (node) ${rest(1).replace(/ 1( |$)/, ' x$1')}`)).toBeNull();
  });
});
