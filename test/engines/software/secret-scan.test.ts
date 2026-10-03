import { describe, expect, it } from 'vitest';
import {
  SECRET_PATTERNS,
  redactSecrets,
  scanPaths,
  scanText,
  secretEnvValues,
} from '../../../src/engines/software/secret-scan.js';

// Fake tokens are assembled at run time so this file never holds a literal that looks like a real one.
const FAKE = {
  'anthropic-key': 'sk-ant-' + 'api03-' + 'A'.repeat(10) + 'b1_c2-d3' + 'e'.repeat(12),
  'github-token': 'gh' + 'p_' + 'Zx9'.repeat(12),
  'github-fine-grained-token': 'github' + '_pat_' + '11ABCDE0Y_' + 'q'.repeat(30),
  'aws-access-key-id': 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
  'private-key': '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  'slack-token': 'xo' + 'xb-' + '1234567890-abcdef',
  'google-api-key': 'AI' + 'za' + 'S'.repeat(20) + 'y_-' + '0'.repeat(12),
} as const;

describe('SECRET_PATTERNS', () => {
  it('names every pattern once', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names.sort()).toEqual(Object.keys(FAKE).sort());
  });
});

describe('scanText', () => {
  for (const [kind, value] of Object.entries(FAKE)) {
    it(`detects ${kind}`, () => {
      expect(scanText(`const x = "${value}";\n`, [])).toEqual([{ kind }]);
    });
  }

  it('detects the RSA and plain private key headers too', () => {
    expect(scanText('-----BEGIN ' + 'RSA PRIVATE KEY-----', [])).toEqual([{ kind: 'private-key' }]);
    expect(scanText('-----BEGIN ' + 'PRIVATE KEY-----', [])).toEqual([{ kind: 'private-key' }]);
  });

  it('passes a normal source file and a lockfile-like blob', () => {
    const source = [
      "import { readFileSync } from 'node:fs';",
      'export const API_KEY_HEADER = "x-api-key";',
      'export function token(n: number): string { return `tok-${n}`; }',
      '// see https://example.com/docs#section-12',
    ].join('\n');
    const lock = [
      '"node_modules/zod": {',
      '  "version": "4.6.5",',
      '  "resolved": "https://registry.npmjs.org/zod/-/zod-4.6.5.tgz",',
      '  "integrity": "sha512-' + 'Qm9vYmFyQmF6'.repeat(7) + '=="',
      '}',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0  some-file.tgz',
    ].join('\n');
    expect(scanText(source, ['not-in-the-text-123456'])).toEqual([]);
    expect(scanText(lock, [])).toEqual([]);
  });

  it('detects an exact known value and ignores short or one-character known values', () => {
    const value = 'correct-horse-battery-staple';
    expect(scanText(`password=${value}\n`, [value])).toEqual([{ kind: 'known-secret-value' }]);
    expect(scanText('id: shortvalue1', ['shortvalue1'])).toEqual([]); // 11 characters
    expect(scanText('x'.repeat(40), ['x'.repeat(20)])).toEqual([]);
    expect(scanText('', [''])).toEqual([]);
  });

  it('returns kinds de-duplicated and sorted, never the matched text', () => {
    const key = FAKE['anthropic-key'];
    const findings = scanText(`${FAKE['github-token']}\n${key}\n${key}\n${FAKE['aws-access-key-id']}`, [key]);
    expect(findings).toEqual([
      { kind: 'anthropic-key' },
      { kind: 'aws-access-key-id' },
      { kind: 'github-token' },
      { kind: 'known-secret-value' },
    ]);
    const json = JSON.stringify(findings);
    for (const v of Object.values(FAKE)) expect(json).not.toContain(v);
  });
});

describe('scanPaths', () => {
  it('flags secret-looking file names', () => {
    for (const p of ['.env', '.env.local', 'config/prod.env', 'id_rsa', 'home/.ssh/id_ed25519', 'server.pem', 'tls/server.key', '.npmrc', '.netrc', 'credentials', 'aws/credentials.json']) {
      expect(scanPaths([p]), p).toEqual([{ kind: 'secret-file' }]);
    }
  });

  it('allows example env files and ordinary names', () => {
    expect(scanPaths(['.env.example', '.env.sample', '.env.template', 'src/env.ts', 'docs/environment.md', 'keys.ts', 'README.md', 'src/.envrc.d/x'])).toEqual([]);
  });

  it('reports one finding however many files match', () => {
    expect(scanPaths(['.env', 'id_rsa', 'a.pem'])).toEqual([{ kind: 'secret-file' }]);
    expect(scanPaths([])).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('replaces every pattern match and known value with [redacted]', () => {
    const known = 'hunter2-but-longer-value';
    const text = `key ${FAKE['anthropic-key']} and ${FAKE['github-token']}; pass ${known} again ${known}.`;
    expect(redactSecrets(text, [known])).toBe('key [redacted] and [redacted]; pass [redacted] again [redacted].');
  });

  it('leaves clean text and short known values alone', () => {
    expect(redactSecrets('nothing to see here', ['short'])).toBe('nothing to see here');
  });

  it('treats known values literally (no regular expression syntax)', () => {
    expect(redactSecrets('a.b*c+d?e(f)[g]{h}|i^j$k', ['a.b*c+d?e(f)[g]{h}|i^j$k'])).toBe('[redacted]');
    expect(redactSecrets('aXbYcZdWeVfU', ['a.b.c.d.e.f.'])).toBe('aXbYcZdWeVfU');
  });
});

describe('secretEnvValues', () => {
  it('takes ANTHROPIC_API_KEY, secret-looking names and the extra names, de-duplicated', () => {
    const env = {
      ANTHROPIC_API_KEY: 'anthropic-value-1',
      GH_TOKEN: 'gh-token-value-2',
      db_password: 'db-password-value-3',
      MY_SECRET_THING: 'gh-token-value-2',
      AWS_CREDENTIALS_FILE: '/path/to/creds-4',
      PROVIDER_PROJECT: 'provider-project-5',
      HOME: '/home/someone/here',
      EMPTY_TOKEN: '',
      UNSET_KEY: undefined,
    };
    expect(secretEnvValues(env, ['PROVIDER_PROJECT', 'NOT_SET']).sort()).toEqual(
      ['anthropic-value-1', 'gh-token-value-2', 'db-password-value-3', '/path/to/creds-4', 'provider-project-5'].sort(),
    );
  });
});
