import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from this module (src/ or dist/src/) to the nearest package.json.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return (JSON.parse(readFileSync(candidate, 'utf8')) as { version: string }).version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
}

export const version: string = readVersion();
