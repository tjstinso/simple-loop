import { describe, expect, it } from 'vitest';
import { AutoMergeRefusedError, GitHostError } from '../../src/engines/software/github.js';
import { isTransientError } from '../../src/kernel/transient.js';

const url = 'https://github.com/o/r.git';

describe('isTransientError', () => {
  const table: [string, unknown, boolean][] = [
    ['could not resolve host', new Error(`fatal: unable to access '${url}': Could not resolve host: github.com`), true],
    ['unable to access', new Error(`fatal: unable to access '${url}': The requested URL returned error: 503`), true],
    ['connection timed out', new Error('ssh: connect to host github.com port 22: Connection timed out'), true],
    ['connection reset', new Error('error: RPC failed; Connection reset by peer'), true],
    ['early EOF', new Error('fatal: early EOF'), true],
    ['failed to connect', new Error('Failed to connect to github.com port 443 after 10 ms'), true],
    ['network unreachable', new Error('connect: Network is unreachable'), true],
    ['name resolution', new Error('Temporary failure in name resolution'), true],
    ['gh without status', new Error('error connecting to api.github.com'), true],
    ['host error without status', new GitHostError('gh failed'), true],
    ['host 429', new GitHostError('rate limited', 429), true],
    ['host 500', new GitHostError('server error', 500), true],
    ['host 503', new GitHostError('unavailable', 503), true],
    ['host 404', new GitHostError('not found', 404), false],
    ['host 422', new GitHostError('unprocessable', 422), false],
    ['host 403', new GitHostError('forbidden', 403), false],
    ['auto-merge refused', new AutoMergeRefusedError('refused'), false],
    ['bad ref', new Error("fatal: couldn't find remote ref refs/heads/nope"), false],
    ['invalid result', new Error("result for job type 'execute' failed its schema: summary: Required"), false],
    ['plain string without network text', 'something broke', false],
    ['string with network text', 'Could not resolve host: github.com', true],
    ['undefined', undefined, false],
  ];
  it.each(table)('%s', (_name, err, expected) => {
    expect(isTransientError(err)).toBe(expected);
  });
});
