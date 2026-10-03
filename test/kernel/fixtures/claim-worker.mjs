// Worker-thread claimer used by queue-claim.test.ts.
//
// Runs outside vitest's transform pipeline, so it loads src/kernel/*.ts through
// Node's built-in type stripping. A synchronous resolve hook maps the `.js`
// specifiers used in the TypeScript sources to their `.ts` files.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workerData, parentPort } from 'node:worker_threads';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { dbPath, workerId, srcDir, startGate } = workerData;
const { openDb } = await import(new URL('db.ts', srcDir).href);
const { claimNext } = await import(new URL('queue.ts', srcDir).href);

const db = openDb(dbPath);
const gate = new Int32Array(startGate);
// Everyone checks in, then blocks until the parent opens the gate, so all
// workers start hammering the write lock at the same moment.
Atomics.add(gate, 1, 1);
Atomics.wait(gate, 0, 0);

const claimed = [];
for (;;) {
  const job = claimNext(db, workerId, 1000, 60_000);
  if (!job) break;
  claimed.push({ id: job.id, delivery: job.delivery, claimedBy: job.claimedBy, status: job.status });
}
db.close();
parentPort.postMessage(claimed);
