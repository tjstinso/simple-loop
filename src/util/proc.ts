import { readFileSync } from 'node:fs';

/**
 * Extracts field 22 (`starttime`, in clock ticks since boot) from the contents
 * of `/proc/<pid>/stat`. Field 2 is the command name in parentheses and may
 * itself contain spaces and parentheses, so fields are split after the LAST `)`.
 * Returns null for malformed input.
 */
export function parseProcStatStartTime(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // After the comm field come fields 3, 4, ...; field 22 is index 19 here.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const raw = fields[19];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Start time of `pid` in clock ticks since boot (field 22 of `/proc/<pid>/stat`).
 * Together with the pid it identifies a process instance, guarding against pid
 * reuse. Returns null when unavailable (no such process, or no procfs).
 */
export function readProcessStartTime(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  return parseProcStatStartTime(stat);
}
