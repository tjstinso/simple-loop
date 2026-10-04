import { isTransient } from '../engines/software/effects.js';
import { BaselineFailingError } from '../engines/software/tool-run.js';
import { AutoMergeRefusedError, GitHostError } from '../engines/software/github.js';

/** Fragments of git (libcurl) and `gh` output that mean the network, not the repository, failed. */
const NETWORK_PATTERNS: RegExp[] = [
  /Could not resolve host/i,
  /unable to access/i,
  /Connection timed out/i,
  /Connection reset/i,
  /early EOF/i,
  /Failed to connect/i,
  /Network is unreachable/i,
  /Temporary failure in name resolution/i,
  /error connecting to/i,
];

/**
 * True when `e` is clearly a network problem that a later attempt may not hit: a host error without
 * an HTTP status, with 429 or with 5xx (the host classification the effects already use), or an
 * error whose message carries one of the network fragments above. Anything else (a bad ref, an
 * invalid result, a 4xx) is permanent.
 */
export function isTransientError(e: unknown): boolean {
  if (e instanceof AutoMergeRefusedError) return false;
  // A red starting point is the base branch's or the environment's problem, not the agent's: retry later.
  if (e instanceof BaselineFailingError) return true;
  if (e instanceof GitHostError) return isTransient(e);
  const text = e instanceof Error ? e.message : String(e);
  return NETWORK_PATTERNS.some((p) => p.test(text));
}
