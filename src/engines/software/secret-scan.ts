/**
 * The secret guard's matching (pure, no I/O). `commit_push` refuses to push a change whose added
 * paths or added lines match. Defense in depth only: pattern and value based, it cannot recognize an
 * obfuscated, encoded or split secret. A finding carries only a kind, never the matched text.
 */

export interface SecretFinding {
  kind: string;
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/** Well-known token shapes. No `g` flag: `redactSecrets` makes its own global copies. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'github-fine-grained-token', pattern: /github_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
];

export const KNOWN_SECRET_KIND = 'known-secret-value';
export const SECRET_FILE_KIND = 'secret-file';
export const SCAN_TRUNCATED_KIND = 'scan-truncated';
export const REDACTED = '[redacted]';

/** Shorter known values, or one character repeated, would match ordinary text too often. */
const MIN_KNOWN_LENGTH = 12;

function usableKnownValues(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_KNOWN_LENGTH) continue;
    if ([...v].every((c) => c === v[0])) continue;
    out.add(v);
  }
  // Longest first, so a value that contains another is redacted whole.
  return [...out].sort((a, b) => b.length - a.length);
}

/** De-duplicated, sorted kinds. */
export function findingsOf(kinds: Iterable<string>): SecretFinding[] {
  return [...new Set(kinds)].sort().map((kind) => ({ kind }));
}

/** The kinds of secret found in `text`: pattern names, plus `known-secret-value` for an exact known value. */
export function scanText(text: string, knownValues: readonly string[]): SecretFinding[] {
  const kinds: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) if (pattern.test(text)) kinds.push(name);
  if (usableKnownValues(knownValues).some((v) => text.includes(v))) kinds.push(KNOWN_SECRET_KIND);
  return findingsOf(kinds);
}

const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const SECRET_NAMES = new Set(['.env', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc', 'credentials', 'credentials.json']);

function isSecretFileName(path: string): boolean {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (ENV_EXAMPLES.has(base)) return false;
  return (
    SECRET_NAMES.has(base) ||
    base.startsWith('.env.') ||
    (base.endsWith('.env') && base.length > '.env'.length) ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  );
}

/** `secret-file` when any path's file name looks like a credential file (by name only). */
export function scanPaths(paths: readonly string[]): SecretFinding[] {
  return paths.some(isSecretFileName) ? [{ kind: SECRET_FILE_KIND }] : [];
}

/** `text` with every pattern match and every (usable) known value replaced by `[redacted]`. */
export function redactSecrets(text: string, knownValues: readonly string[]): string {
  // Every match range in the ORIGINAL text (values literally, patterns by regex), merged when they
  // overlap or touch, then each merged range replaced once: overlapping values leak no tail.
  const ranges: Array<[number, number]> = [];
  for (const v of usableKnownValues(knownValues)) {
    for (let i = text.indexOf(v); i !== -1; i = text.indexOf(v, i + 1)) ranges.push([i, i + v.length]);
  }
  for (const { pattern } of SECRET_PATTERNS) {
    for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) ranges.push([m.index, m.index + m[0].length]);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let out = '';
  let at = 0;
  for (const [s, e] of merged) {
    out += text.slice(at, s) + REDACTED;
    at = e;
  }
  return out + text.slice(at);
}

/** Variable names whose values the guard treats as secrets. */
export const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * The values the guard looks for, from an environment the caller passes in: `ANTHROPIC_API_KEY`,
 * every variable whose name matches SECRET_ENV_NAME, and the `extraNames` (for example the claude-cli
 * policies' `passEnv`). Empty values are skipped; the result is de-duplicated.
 */
export function secretEnvValues(env: Readonly<Record<string, string | undefined>>, extraNames: readonly string[] = []): string[] {
  const extra = new Set(extraNames);
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (name === 'ANTHROPIC_API_KEY' || SECRET_ENV_NAME.test(name) || extra.has(name)) out.add(value);
  }
  return [...out];
}
