# Software Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the factory kernel, the router, and the software engine so that `factory submit <issue-url>` drives a GitHub issue through execute, review and (per profile) merge, with every external dependency replaceable by a fake.

**Architecture:** A SQLite-backed kernel owns the queue, leases, fencing, workers, child processes and the DLQ. Engines plug in through an `Engine` interface (pure `transition`, idempotent `runEffect`, per-delivery workspaces). A label-based router picks the engine. The software engine is the first engine; a trivial echo engine in the tests proves the seam.

**Tech Stack:** TypeScript on Node, `better-sqlite3`, `zod`, `vitest`, `yaml`. External CLIs: `git`, `gh`, `claude`.

**Spec:** `docs/superpowers/specs/2026-10-03-software-factory-design.md`

## Global Constraints

- Language and libraries: TypeScript on Node, `better-sqlite3`, `zod`, `vitest`.
- Timing defaults: lease 5 minutes; heartbeat 30 seconds; `inactivityTimeoutMs` 10 minutes; `maxDeliveries` 3; `maxAttempts` 3; `historyRetentionDays` 30.
- Job statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`. Chain statuses: `active`, `waiting`, `dead_lettered`, `completed`, `cancelled`.
- Dead-letter reasons: `runner_error`, `timeout`, `max_deliveries`, `effect_error`.
- Labels: `factory:in-progress`, `factory:ready-for-merge`, `factory:needs-human`, `factory:dead-letter`, `factory:followup`; profile selector `factory:profile:automatic`; engine selector prefix `factory:engine:`; default engine `software`.
- Software engine: subject key `owner/repo#<issue>`; remote branch `factory/issue-<n>`; per-delivery local branch `factory/issue-<n>-d<delivery>`; phases `executing`, `reviewing`, `awaiting_merge`, `needs_human`, `merged`; job types `execute` and `review`; policy kinds `execute` and `review`.
- Required issue sections (default, configurable): `## Goal` and `## Acceptance criteria`.
- Hidden marker format: `<!-- factory:chain=7 job=42 event=dead-letter -->`.
- `claude-cli` runner uses `claude -p` with `--output-format stream-json`, `--allowedTools` and `--max-budget-usd`.
- Pushes use `--force-with-lease`; the runner environment carries no GitHub credentials; the workspace push URL is disabled.
- All kernel writes after a claim are conditioned on `WHERE id = ? AND delivery = ?`.
- Time is injected as `Clock = () => number` (epoch ms) everywhere a lease or timeout is computed.

## Review Focus

Inputs and conditions the spec implies but does not spell out, most likely first. Each has a test in the task that owns the code.

1. An execute job that changes nothing: no empty PR is opened; the job is dead-lettered as `runner_error` with the message `no changes produced` (Task 17).
2. The issue is closed or deleted, or GitHub returns 404, between submit and a later job: dead-lettered as `effect_error`, no crash (Task 17).
3. `claude` emits a truncated final line, non-JSON noise or no result event: the job fails as `runner_error`, the runner does not throw past its boundary (Task 8).
4. A worker is told to stop (SIGTERM) mid-job: it aborts the run, kills its children and requeues the job immediately instead of waiting out the lease (Task 13).
5. Under `automatic`, the merge is refused (conflicts or failing required checks): dead-lettered as `effect_error`, the PR stays open and the issue gets `factory:dead-letter` (Task 17).

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts
policies/                      default policy files
src/
  kernel/
    types.ts                   shared types (Chain, Job, Engine, Fence, ...)
    db.ts                      open + migrate
    queue.ts                   chains, jobs, claim, lease, fenced writes
    workers.ts                 worker + child_processes registry
    dlq.ts                     dead letters
    reaper.ts                  expired leases, kill-before-reclaim
    process-delivery.ts        one delivery, start to finish
    worker-loop.ts             poll, heartbeat, self-fencing, stop
    kernel.ts                  createKernel wiring + enqueue
    retention.ts               history pruning
  policy/ schema.ts store.ts matcher.ts
  router/router.ts
  runner/ types.ts registry.ts fake.ts claude-cli.ts stream.ts
  engines/software/
    index.ts state.ts schemas.ts profiles.ts transition.ts
    github.ts workspace.ts effects.ts submit.ts followups.ts run-input.ts
  cli/ index.ts
test/
  support/ echo-engine.ts fake-github.ts temp-repo.ts stub-claude.mjs
  (tests mirror src paths; scenarios in test/scenarios/)
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs vitest; `npm run build` runs `tsc`; ESM, `strict: true`.

- [ ] **Step 1: Write the failing test** `test/smoke.test.ts`: `it('loads the package entry', ...)` imports `../src/index.js` and asserts `typeof version === 'string'`.
- [ ] **Step 2: Run** `npx vitest run test/smoke.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the scaffold; `src/index.ts` exports `version: string` read from `package.json`. Dependencies: `better-sqlite3`, `zod`, `yaml`; dev: `typescript`, `vitest`, `@types/node`, `@types/better-sqlite3`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `chore: scaffold TypeScript project`.

### Task 2: Kernel types and database schema

**Files:**
- Create: `src/kernel/types.ts`, `src/kernel/db.ts`
- Test: `test/kernel/db.test.ts`

**Interfaces:**
- Produces in `types.ts` (all later tasks import these):
  - `type Clock = () => number`
  - `type ChainStatus`, `type JobStatus`, `type DeadLetterReason` (unions from Global Constraints)
  - `interface Chain { id: number; engine: string; subjectKey: string; status: ChainStatus; engineState: unknown }`
  - `interface Job { id: number; chainId: number; type: string; attempt: number; status: JobStatus; policyId: string; payload: unknown; result: unknown | null; claimedBy: string | null; leaseExpiresAt: number | null; delivery: number; error: string | null }`
  - `interface NewJob { type: string; attempt: number; policyKind: string; labels: string[]; payload?: unknown }`
  - `interface ResolvedNewJob { type: string; attempt: number; policyId: string; payload?: unknown }`
  - `interface Fence { jobId: number; delivery: number }`; `class StaleDeliveryError extends Error`
  - `interface ChainView<S> { id: number; engine: string; subjectKey: string; status: ChainStatus; state: S }`
  - `interface DeadLetter { jobId: number; chainId: number; reason: DeadLetterReason; error: string; stepLogPath: string | null; createdAt: number; resolvedAt: number | null }`
  - `class EffectError extends Error { reason: 'runner_error' | 'effect_error' }` (used by Tasks 12 and 17)
  - `interface Effect { kind: string; [k: string]: unknown }`
  - `interface Transition<S> { engineState: S; chainStatus: ChainStatus; newJobs: NewJob[]; effects: Effect[] }`
- Produces in `db.ts`: `openDb(path: string): Database` (WAL, `busy_timeout` 5000, foreign keys on); `migrate(db: Database, extra?: string[]): void` applying kernel tables `chains`, `jobs`, `workers`, `child_processes`, `dead_letters` plus any `extra` DDL strings (used by engines for their own tables).

- [ ] **Step 1: Write the failing tests:**
  - `it('rejects a second open chain for the same subject_key')` inserts two `active` chains with the same key, expects a UNIQUE error.
  - `it('allows a new chain once the previous is completed or cancelled')`.
  - `it('rejects a duplicate (chain_id, type, attempt) job')`.
  - `it('applies extra DDL passed by an engine')`.
  - `it('is idempotent when migrated twice')`.
- [ ] **Step 2: Run** `npx vitest run test/kernel/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** tables per spec section 4. The unique partial index is on `chains(subject_key) WHERE status NOT IN ('completed','cancelled')`; unique index on `jobs(chain_id, type, attempt)`. `engine_state`, `payload`, `result` are JSON text.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): types and sqlite schema`.

### Task 3: Chains and job creation

**Files:**
- Create: `src/kernel/queue.ts` (first half)
- Test: `test/kernel/queue-create.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `openDb`, `migrate`.
- Produces:
  - `class DuplicateChainError extends Error`
  - `createChain(db, args: { engine: string; subjectKey: string; engineState: unknown; firstJob: ResolvedNewJob }, now: number): { chain: Chain; job: Job }` (one transaction; throws `DuplicateChainError` on the unique index)
  - `getChain(db, id: number): Chain`; `getJob(db, id: number): Job`
  - `listJobsForChain(db, chainId: number): Job[]`

- [ ] **Step 1: Write the failing tests:** `it('creates a chain and a queued job atomically')` asserts job `status === 'queued'`, `delivery === 0`; `it('throws DuplicateChainError for an open subject')`; `it('does not leave a chain behind when job insert fails')` (force a bad job, assert zero chains).
- [ ] **Step 2: Run** `npx vitest run test/kernel/queue-create.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions with `better-sqlite3` transactions; parse JSON columns into the typed shapes.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): chain and job creation`.

### Task 4: Claim, lease, and fenced writes

**Files:**
- Modify: `src/kernel/queue.ts`
- Test: `test/kernel/queue-claim.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `claimNext(db, workerId: string, now: number, leaseMs: number): Job | null` (atomic `UPDATE ... WHERE status='queued'`; sets `running`, lease, `claimed_by`, increments `delivery`; picks oldest first)
  - `renewLease(db, fence: Fence, now: number, leaseMs: number): boolean` (false if the fence is stale)
  - `recordResult(db, fence: Fence, result: unknown): void` (throws `StaleDeliveryError` if stale)
  - `commitTransition(db, fence: Fence, args: { chainId: number; engineState: unknown; chainStatus: ChainStatus; newJobs: ResolvedNewJob[]; attempt?: number }, now: number): void` (one transaction: job `succeeded`, chain updated, new jobs inserted with `INSERT OR IGNORE`)
  - `failJob(db, fence: Fence, error: string): void`
  - `requeueJob(db, jobId: number): void` (status back to `queued`, lease cleared; keeps `result` and `delivery`)

- [ ] **Step 1: Write the failing tests:**
  - `it('claims the oldest queued job and increments delivery')`.
  - `it('returns null when nothing is queued')`.
  - `it('N claimers over M jobs never claim a job twice')` using N=8 separate connections to one file database and M=50; assert every job id claimed exactly once.
  - `it('rejects recordResult and commitTransition from a stale delivery')` claims, requeues, claims again, then uses the first fence; expects `StaleDeliveryError` and unchanged rows.
  - `it('renewLease returns false for a stale fence')`.
  - `it('commitTransition ignores a duplicate follow-on job')`.
- [ ] **Step 2: Run** `npx vitest run test/kernel/queue-claim.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every write uses `WHERE id = ? AND delivery = ? AND status = 'running'`; zero rows changed throws `StaleDeliveryError`. Use `BEGIN IMMEDIATE` for claim.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): claim, lease and fenced writes`.

### Task 5: Policies

**Files:**
- Create: `src/policy/schema.ts`, `src/policy/store.ts`, `src/policy/matcher.ts`
- Test: `test/policy/policy.test.ts`

**Interfaces:**
- Produces:
  - `const PolicySchema` (zod): `{ id: string; kind: string; match: { labels: string[] }; runner: string; config: unknown; default?: boolean }`; type `Policy`.
  - `loadPolicies(dir: string): Policy[]` (reads `*.yaml`; throws with the file name on schema failure; throws on duplicate ids)
  - `class PolicyStore { constructor(policies: Policy[]); byId(id: string): Policy; match(kind: string, labels: string[]): Policy }`
  - `class AmbiguousMatchError`, `class NoPolicyError` (both extend `Error`)

- [ ] **Step 1: Write the failing tests:** `it('matches when all policy labels are present')`; `it('falls back to the default policy of that kind')`; `it('throws AmbiguousMatchError when two non-default policies match')`; `it('throws NoPolicyError when nothing matches and no default exists')`; `it('rejects a policy file that fails the schema and names the file')`; `it('rejects duplicate policy ids')`.
- [ ] **Step 2: Run** `npx vitest run test/policy`. Expected: FAIL.
- [ ] **Step 3: Implement.** A default policy is `default: true` and has empty `match.labels`; it is excluded from the "more than one match" count.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(policy): schema, loader and label matcher`.

### Task 6: Router

**Files:**
- Create: `src/router/router.ts`
- Test: `test/router/router.test.ts`

**Interfaces:**
- Produces: `routeEngine(labels: string[], defaultEngine: string, known: string[]): string`; `class UnknownEngineError`, `class AmbiguousEngineError`.

- [ ] **Step 1: Write the failing tests:** `it('returns the default engine with no engine label')`; `it('returns the engine named by factory:engine:<id>')`; `it('throws AmbiguousEngineError for two engine labels')`; `it('throws UnknownEngineError for an unregistered engine label')`.
- [ ] **Step 2: Run** `npx vitest run test/router`. Expected: FAIL.
- [ ] **Step 3: Implement** as a pure function using the `factory:engine:` prefix.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(router): label-based engine routing`.

### Task 7: Runner contract, registry and fake runner

**Files:**
- Create: `src/runner/types.ts`, `src/runner/registry.ts`, `src/runner/fake.ts`
- Test: `test/runner/contract.ts` (shared suite, exported), `test/runner/fake.test.ts`

**Interfaces:**
- Produces:
  - `interface Workspace { path: string; [k: string]: unknown }`
  - `interface RunInput { job: Job; config: unknown; subject: unknown; workspace: Workspace; feedback?: string }`
  - `interface Runner { name: string; configSchema: ZodType; run(input: RunInput, signal: AbortSignal, hooks?: RunHooks): Promise<unknown> }`
  - `interface RunHooks { onSpawn?(child: { pid: number; pgid: number; startTime: number }): void; onExit?(pid: number, code: number | null): void }`
  - `class RunnerRegistry { register(r: Runner): void; get(name: string): Runner }`
  - `class FakeRunner implements Runner` with `script(jobType: string, results: unknown[] | ((input: RunInput) => unknown)): void`, `calls: RunInput[]`; name `fake`.
  - `runnerContract(makeRunner: () => { runner: Runner; validInput: RunInput; cleanup(): void }): void` in the contract file.

- [ ] **Step 1: Write the failing tests:** contract suite asserts `it('resolves with a value for valid input')`, `it('rejects with AbortError when the signal is aborted before start')`, `it('does not mutate files outside workspace.path')`. `fake.test.ts` runs the suite on `FakeRunner` plus `it('replays scripted results in order')` and `it('throws when the script is exhausted')`.
- [ ] **Step 2: Run** `npx vitest run test/runner`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, registry and fake.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(runner): contract, registry and fake runner`.

### Task 8: `claude-cli` runner

**Files:**
- Create: `src/runner/claude-cli.ts`, `src/runner/stream.ts`, `test/support/stub-claude.mjs`
- Test: `test/runner/claude-cli.test.ts`

**Interfaces:**
- Consumes: Task 7 types.
- Produces:
  - `parseStreamLine(line: string): StreamEvent | null` (returns null for non-JSON noise); `interface StreamEvent { type: string; [k: string]: unknown }`
  - `class ClaudeCliRunner implements Runner` (name `claude-cli`; constructor takes `{ bin?: string; env?: Record<string,string> }` so tests point it at the stub). Config schema: `{ prompt: string; allowedTools: string[]; maxBudgetUsd: number; timeoutMs: number; inactivityTimeoutMs: number }`. Resolves to `{ status: 'ok' | 'error'; summary: string; costUsd?: number; steps: string[]; followups?: {title:string;body:string}[] }`.
  - Spawns detached (own process group), strips `GH_TOKEN`, `GITHUB_TOKEN` and `GH_*` credentials from the child environment, calls `hooks.onSpawn`/`onExit`.

- [ ] **Step 1: Write the failing tests** with `stub-claude.mjs`, a Node script whose behavior is selected by an env var:
  - `it('builds the command with -p, --output-format stream-json, --allowedTools and --max-budget-usd')` (stub echoes argv).
  - `it('collects steps and costUsd from the event stream')`.
  - `it('aborts and kills the process group after inactivityTimeoutMs of silence')` (stub sleeps; use a 200 ms timeout; assert the child pid is gone and the error is `timeout`).
  - `it('enforces the hard timeoutMs even when events keep arriving')`.
  - `it('kills the process group on AbortSignal')`.
  - `it('does not pass GH_TOKEN to the child')`.
  - `it('resolves status error for a truncated final line, non-JSON noise, or no result event')` (Review Focus 3); it must resolve, not throw.
  - `it('calls onSpawn and onExit with pid and pgid')`.
  - Runs `runnerContract` against the stub.
- [ ] **Step 2: Run** `npx vitest run test/runner/claude-cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before relying on stream-json, run `claude --help` and confirm whether `--verbose` must accompany `--output-format stream-json` with `-p`; add it if required and note it in a code comment. Inactivity timer resets on every parsed event. Timeouts reject with an error whose `reason` is `timeout`.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(runner): claude-cli runner with inactivity watchdog`.

### Task 9: Worker and child-process registry

**Files:**
- Create: `src/kernel/workers.ts`
- Test: `test/kernel/workers.test.ts`

**Interfaces:**
- Produces:
  - `registerWorker(db, args: { id: string; pid: number; pgid: number; startTime: number; host: string }, now: number): void`
  - `touchWorker(db, id: string, now: number): void`
  - `recordChild(db, args: { workerId: string; jobId: number; delivery: number; pid: number; pgid: number; startTime: number }, now: number): number`
  - `markChildExited(db, childId: number, code: number | null, now: number): void`
  - `liveChildrenFor(db, jobId: number, delivery: number): ChildRow[]`
  - `isProcessAlive(pid: number, startTime: number): boolean` (compares `/proc/<pid>/stat` start time on Linux; false on mismatch, so a reused pid is not killed)
  - `killProcessGroup(pgid: number): void` (SIGTERM, then SIGKILL after 2 s)

- [ ] **Step 1: Write the failing tests:** `it('records a child and lists it as live until exited')`; `it('isProcessAlive is false for a dead pid')`; `it('isProcessAlive is false when the start time does not match (pid reuse)')`; `it('killProcessGroup terminates a spawned process group including grandchildren')`; `it('on startup a worker kills its previous incarnation's unexited children')`.
- [ ] **Step 2: Run** `npx vitest run test/kernel/workers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The orphan sweep is `reapOwnOrphans(db, workerId, now)`; export it too.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): worker and child process registry`.

### Task 10: Dead-letter queue

**Files:**
- Create: `src/kernel/dlq.ts`
- Test: `test/kernel/dlq.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4.
- Produces:
  - `deadLetter(db, args: { jobId: number; reason: DeadLetterReason; error: string; stepLogPath?: string }, now: number): DeadLetter` (job `failed`, chain `dead_lettered`, row inserted, one transaction; callable with or without a fence, the caller decides)
  - `listDeadLetters(db, opts?: { unresolved?: boolean }): DeadLetter[]`
  - `retryDeadLetter(db, jobId: number, now: number): Job` (new queued job in the same chain with the same type, attempt, policy and payload; **keeps `result` when the dead letter was `effect_error`** so processing resumes at post-processing; chain back to `active`; dead letter `resolved_at` set)
  - `discardDeadLetter(db, jobId: number, now: number): void` (chain `cancelled`, resolved)

- [ ] **Step 1: Write the failing tests:** `it('moves the job to failed and the chain to dead_lettered')`; `it('retry creates a fresh job with the same type, attempt and payload')`; `it('retry after effect_error keeps the recorded result')`; `it('retry after runner_error starts without a result')`; `it('discard cancels the chain and frees the subject key')` (a new chain for the key can then be created).
- [ ] **Step 2: Run** `npx vitest run test/kernel/dlq.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The retried job needs a new `attempt`-unique slot: reuse the same `(chain_id, type, attempt)` by updating the failed job back to `queued` instead of inserting.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): dead-letter queue`.

### Task 11: Reaper

**Files:**
- Create: `src/kernel/reaper.ts`
- Test: `test/kernel/reaper.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 9, 10.
- Produces: `reapExpired(db, deps: { now: number; maxDeliveries: number; isAlive?: typeof isProcessAlive; kill?: typeof killProcessGroup }): ReapReport` where `ReapReport = { requeued: number[]; deadLettered: number[]; killed: number[] }`.

- [ ] **Step 1: Write the failing tests:** `it('requeues a running job whose lease expired')`; `it('kills live children of that delivery before requeueing')` (assert `kill` called before the status change); `it('does not touch a job whose lease is still valid')`; `it('dead-letters with max_deliveries once delivery reaches maxDeliveries')`; `it('kills the worker's own pid group when the worker is still alive')`.
- [ ] **Step 2: Run** `npx vitest run test/kernel/reaper.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** using injected `isAlive` and `kill` so no real processes are needed in unit tests.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): reaper with kill-before-reclaim`.

### Task 12: Engine interface, registry, echo engine and `processDelivery`

**Files:**
- Modify: `src/kernel/types.ts` (add `Engine`, `Workspace`-related types)
- Create: `src/kernel/process-delivery.ts`, `test/support/echo-engine.ts`
- Test: `test/kernel/process-delivery.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 7, 10.
- Produces:
  - `interface Engine<S = unknown>` exactly as in spec section 3 (`id`, `policyKinds`, `stateSchema`, `resultSchemas`, `submit`, `workspace`, `buildRunInput`, `transition`, `runEffect`, `describe`, `surfaceDeadLetter`, `cleanup`).
  - `class EngineRegistry { register(e: Engine): void; get(id: string): Engine; ids(): string[] }`
  - `interface KernelDeps { db; engines: EngineRegistry; runners: RunnerRegistry; policies: PolicyStore; clock: Clock; config: { leaseMs: number; heartbeatMs: number; maxDeliveries: number } }`
  - `processDelivery(deps: KernelDeps, job: Job, workerId: string, signal: AbortSignal): Promise<'succeeded' | 'dead_lettered' | 'stale'>`
  - `interface EffectFence extends Fence { assertCurrent(): void }` (re-reads `delivery` from the database; throws `StaleDeliveryError`). `Engine.runEffect` takes an `EffectFence`.
- Consumed by Task 13: `processDelivery` performs spec section 5 steps 2 to 6 in this order: (resume if `job.result` is set) → prepare workspace → `buildRunInput` → run → validate against `resultSchemas[job.type]` → `recordResult` → `transition` → `runEffect` for each effect (each with an `EffectFence`) → `commitTransition` (new jobs resolved through `policies.match(policyKind, labels)`) → `cleanup`. An `EffectError` thrown by an effect dead-letters with its `reason`.

- [ ] **Step 1: Write the failing tests** using the echo engine (job types `echo`; effect kind `note` appended to an in-memory list):
  - `it('runs a delivery end to end and enqueues the follow-on job only after effects ran')` (effect log shows the effect before the new job exists).
  - `it('dead-letters with runner_error when the result fails its schema')`.
  - `it('dead-letters with effect_error when an effect throws and creates no follow-on jobs')`.
  - `it('skips the runner and resumes post-processing when job.result is already recorded')` (runner call count 0).
  - `it('discards the outcome of a stale delivery and returns stale')`.
  - `it('dead-letters with timeout when the runner rejects with reason timeout')`.
  - `it('calls cleanup on success and on failure')`.
  - `it('two engines register and each job is dispatched to its chain's engine')` (echo engine and a second stub engine).
- [ ] **Step 2: Run** `npx vitest run test/kernel/process-delivery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `Fence` passed to effects exposes `assertCurrent(): void` that re-reads `delivery` from the database and throws `StaleDeliveryError`. A `StaleDeliveryError` anywhere ends in `'stale'` with no database writes. Call `engine.surfaceDeadLetter` after every `deadLetter`.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): engine interface and delivery processing`.

### Task 13: Worker loop

**Files:**
- Create: `src/kernel/worker-loop.ts`, `src/kernel/kernel.ts`
- Test: `test/kernel/worker-loop.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 9, 11, 12.
- Produces:
  - `createKernel(deps: Omit<KernelDeps, 'db'> & { dbPath: string }): Kernel`
  - `interface Kernel { deps: KernelDeps; enqueue(engineId: string, input: unknown): Promise<{ chain: Chain; job: Job }>; startWorker(opts?: { pollMs?: number; id?: string }): Worker }`
  - `interface Worker { id: string; done: Promise<void>; stop(): Promise<void> }`

- [ ] **Step 1: Write the failing tests** (fake clock, fake timers):
  - `it('claims queued jobs and processes them until stopped')`.
  - `it('renews the lease every heartbeatMs while a job runs')`.
  - `it('aborts the run and kills children when a lease renewal fails')` (self-fencing).
  - `it('stop() aborts the current run, kills its children and requeues the job immediately')` (Review Focus 4; assert the job is `queued` with the lease cleared, not waiting for expiry).
  - `it('runs the reaper on an interval')`.
  - `it('registers itself and records children through RunHooks')`.
- [ ] **Step 2: Run** `npx vitest run test/kernel/worker-loop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the loop with `setInterval` heartbeats on the main event loop and one `AbortController` per delivery. `enqueue` calls `engine.submit`, resolves the first job's policy and calls `createChain`.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): worker loop with heartbeat and self-fencing`.

### Task 14: Software engine state, schemas, profiles and transition

**Files:**
- Create: `src/engines/software/state.ts`, `schemas.ts`, `profiles.ts`, `transition.ts`
- Test: `test/engines/software/transition.test.ts`

**Interfaces:**
- Produces:
  - `interface SoftwareState { repo: string; issueNumber: number; profile: 'supervised' | 'automatic'; branch: string; attempt: number; phase: Phase }`; `SoftwareStateSchema`
  - `ExecutionResultSchema`: `{ status: 'ok'|'error'; summary: string; costUsd?: number; steps?: string[]; followups?: Followup[] }`; `ReviewVerdictSchema`: `{ verdict: 'approve'|'request_changes'; feedback: string; costUsd?: number; followups?: Followup[] }`
  - `PROFILES: Record<'supervised'|'automatic', { onApprove: 'label' | 'merge'; maxAttempts: number }>`
  - `softwareTransition(chain: ChainView<SoftwareState>, job: Job, result: unknown): Transition<SoftwareState>` (pure)
  - Effect kinds: `commit_push`, `open_pr`, `set_labels`, `merge_pr`, `comment`, `file_followups`.

- [ ] **Step 1: Write the failing tests** (table-driven, no I/O), one per row of the spec's state machine:
  - execute `ok` → phase `reviewing`, effects in order `commit_push`, `open_pr`, `set_labels` (in-progress), one new `review` job.
  - review `approve` under `supervised` → phase `awaiting_merge`, chain `waiting`, effects set `factory:ready-for-merge`, no new jobs.
  - review `approve` under `automatic` → phase `merged`, chain `completed`, effect `merge_pr`.
  - review `request_changes` at attempt 1 and 2 → attempt incremented, new `execute` job whose payload carries the feedback, phase `executing`.
  - review `request_changes` at attempt 3 → phase `needs_human`, chain `waiting`, label `factory:needs-human`, no new jobs.
  - `followups` in any result add a `file_followups` effect.
  - execute result `status: 'error'` → the transition is not called (kernel dead-letters); assert `softwareTransition` throws for it as a guard.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/transition.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as pure functions; `maxAttempts` comes from the profile.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): state, schemas, profiles and transition`.

### Task 15: `GitHost` port, fake and `gh` adapter

**Files:**
- Create: `src/engines/software/github.ts`, `test/support/fake-github.ts`
- Test: `test/engines/software/github.test.ts`

**Interfaces:**
- Produces:
  - `interface GitHost { getIssue(repo: string, n: number): Promise<Issue>; findPrByHead(repo: string, branch: string): Promise<Pr | null>; openPr(repo: string, args: { head: string; base: string; title: string; body: string }): Promise<Pr>; getPr(repo: string, n: number): Promise<Pr>; setLabels(repo: string, n: number, add: string[], remove: string[]): Promise<void>; findComment(repo: string, n: number, marker: string): Promise<boolean>; comment(repo: string, n: number, body: string): Promise<void>; findIssueByMarker(repo: string, marker: string): Promise<number | null>; createIssue(repo: string, args: { title: string; body: string; labels: string[] }): Promise<number>; mergePr(repo: string, n: number): Promise<void> }`
  - `interface Issue { number: number; title: string; body: string; labels: string[]; state: 'open'|'closed' }`; `interface Pr { number: number; state: 'open'|'closed'|'merged'; headSha: string; baseBranch: string }`
  - `class GitHostError extends Error { status?: number }`
  - `class GhCliHost implements GitHost` (shells out to `gh` via an injectable `exec`)
  - `class FakeGitHost implements GitHost` with in-memory issues, PRs, labels, comments and `failNext(method, error)` for injecting failures.

- [ ] **Step 1: Write the failing tests:** against `FakeGitHost`: `it('findPrByHead returns the existing PR')`; `it('setLabels adds and removes without duplicates')`; `it('findComment sees a marker already posted')`; `it('failNext makes the next call throw GitHostError')`. For `GhCliHost` with a stub `exec`: `it('maps gh JSON output to Issue')` and `it('maps a 404 to GitHostError with status 404')`.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/github.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `gh issue view --json`, `gh pr list --head`, `gh pr create`, `gh issue edit --add-label/--remove-label`, `gh api` for comment search. Inspect `gh --help` for exact flags as you go.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): GitHost port, fake and gh adapter`.

### Task 16: Workspace provider (per-delivery git worktrees)

**Files:**
- Create: `src/engines/software/workspace.ts`, `test/support/temp-repo.ts`
- Test: `test/engines/software/workspace.test.ts`

**Interfaces:**
- Produces:
  - `interface SoftwareWorkspace extends Workspace { path: string; localBranch: string; seedSha: string; baseBranch: string }`
  - `class GitWorkspaceProvider { constructor(opts: { cloneUrlFor(repo: string): string; root: string; keepOnFailure: boolean }); prepare(chain: ChainView<SoftwareState>, job: Job): Promise<SoftwareWorkspace>; teardown(chain, job, outcome: 'ok' | 'failed'): Promise<void>; sweep(liveDeliveries: Set<string>): Promise<string[]> }`
  - Path is derived: `<root>/<chainId>/d<delivery>`.
- `temp-repo.ts`: `makeRemote(): { url: string; path: string; cleanup(): void }` creating a bare repo with a `main` commit.

- [ ] **Step 1: Write the failing tests** with real `git` on temp repos:
  - `it('seeds an execute delivery from the base branch when the remote branch is absent')`.
  - `it('seeds a revise delivery from the pushed remote branch head')`.
  - `it('seeds a review delivery from the PR head')`.
  - `it('gives each delivery its own path and local branch factory/issue-<n>-d<delivery>')`.
  - `it('disables the push URL on the workspace remote')` (a plain `git push` from the workspace fails).
  - `it('teardown removes the worktree and local branch on success')`.
  - `it('teardown keeps the worktree on failure when keepOnFailure is true')`.
  - `it('sweep removes worktrees that belong to no live delivery')`.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/workspace.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `git clone --bare`-style cache under `root` plus `git worktree add`; shell out through `child_process.execFile`.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): per-delivery git workspaces`.

### Task 17: Software effects

**Files:**
- Create: `src/engines/software/effects.ts`
- Test: `test/engines/software/effects.test.ts`

**Interfaces:**
- Consumes: Tasks 14, 15, 16.
- Produces: `runSoftwareEffect(effect: Effect, ctx: EffectContext, fence: EffectFence): Promise<void>` where `EffectContext = { chain: ChainView<SoftwareState>; job: Job; workspace: SoftwareWorkspace; host: GitHost; git: GitPorts }` and `GitPorts` exposes `commitAll(ws, message): Promise<boolean>` (false when nothing to commit) and `push(ws, args: { remoteBranch: string; expectSha: string | null }): Promise<void>` using `--force-with-lease`.
- Each effect calls `fence.assertCurrent()` immediately before acting.

- [ ] **Step 1: Write the failing tests:**
  - `it('commit_push commits leftover changes and pushes with force-with-lease against the seed sha')`.
  - `it('commit_push with no changes at all throws "no changes produced"')` (Review Focus 1; the kernel turns this into `runner_error` via an `EffectError` carrying `reason: 'runner_error'`; assert no PR was opened).
  - `it('open_pr reuses an existing PR for the branch')`.
  - `it('set_labels sets specific labels and is repeatable')`.
  - `it('merge_pr checks PR state first and is a no-op when already merged')`.
  - `it('merge refused (GitHostError 405/409) becomes effect_error and leaves the PR open')` (Review Focus 5).
  - `it('a GitHostError 404 on the issue becomes effect_error')` (Review Focus 2).
  - `it('transient GitHostError is retried with backoff three times, then effect_error')`.
  - `it('a stale fence stops the effect before it acts')`.
  - `it('comment and file_followups skip when the marker already exists')`.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/effects.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Throw `EffectError` (defined in Task 2, honored by Task 12's `processDelivery`) with `reason: 'runner_error'` for the empty-diff case and `'effect_error'` for host failures. Backoff delays are injectable.
- [ ] **Step 4: Run** same plus `npx vitest run test/kernel/process-delivery.test.ts` (which must include `it('dead-letters with the EffectError reason')`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): idempotent fenced effects`.

### Task 18: Software submit, describe and dead-letter surfacing

**Files:**
- Create: `src/engines/software/submit.ts`
- Modify: `src/engines/software/index.ts` (create; exports `createSoftwareEngine(deps): Engine<SoftwareState>`)
- Test: `test/engines/software/submit.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 14, 15.
- Produces:
  - `parseIssueUrl(url: string): { repo: string; number: number }`
  - `softwareSubmit(input: { issueUrl: string }, deps): Promise<{ subjectKey: string; state: SoftwareState; firstJob: NewJob }>`
  - `engine.describe(chain)` returns e.g. `owner/repo#12 phase=reviewing attempt=2 profile=supervised`
  - `engine.surfaceDeadLetter` adds `factory:dead-letter`, removes `factory:in-progress`, comments once with the marker `<!-- factory:chain=<id> job=<id> event=dead-letter -->` including reason and job id.

- [ ] **Step 1: Write the failing tests:**
  - `it('rejects a malformed issue URL')`.
  - `it('rejects an issue missing a required section and names the missing section')`; `it('rejects an empty body')`.
  - `it('rejects a closed issue')`.
  - `it('selects the automatic profile from factory:profile:automatic, else the default')`.
  - `it('builds the first job as execute attempt 1 with the issue labels')`.
  - `it('surfaceDeadLetter labels and comments once even if called twice')`.
  - `it('describe renders phase, attempt and profile')`.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/submit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The engine's `policyKinds` are `['execute','review']`; `resultSchemas` map `execute` and `review` to Task 14 schemas; `stateSchema` is `SoftwareStateSchema`.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): submit, describe and dead-letter surfacing`.

### Task 19: Software cleanup and followups

**Files:**
- Create: `src/engines/software/followups.ts`
- Modify: `src/engines/software/index.ts`
- Test: `test/engines/software/followups.test.ts`

**Interfaces:**
- Produces:
  - Engine DDL: `FOLLOWUPS_DDL` passed through `migrate(db, [FOLLOWUPS_DDL])` (table `followups`: `id`, `job_id`, `title`, `body`, `filed_issue_number`, `created_at`).
  - `storeFollowups(db, jobId: number, items: Followup[], now: number): number[]` (skips blank titles)
  - `fileFollowups(db, host: GitHost, ctx, now: number): Promise<void>` (files each unfiled row as an issue labeled `factory:followup` referencing the PR, with a marker; sets `filed_issue_number`)
  - `sweepUnfiledFollowups(db, host, now): Promise<number>` (retries unfiled rows)
  - `engine.cleanup(chain, job, ports)`: tears down the delivery's workspace (outcome from job status) and prunes its local branch.

- [ ] **Step 1: Write the failing tests:** `it('stores followups from a result and skips blank titles')`; `it('files each followup once with the followup label and PR reference')`; `it('does not file again when the marker issue already exists')` (crash between create and record); `it('a GitHostError while filing leaves filed_issue_number null and does not throw')`; `it('the sweep files previously unfiled rows')`; `it('cleanup tears down the workspace')`.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/followups.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Followup filing is the `file_followups` effect, but it catches `GitHostError` itself so it never fails the job.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): followups and cleanup`.

### Task 20: Software run input and default policies

**Files:**
- Create: `src/engines/software/run-input.ts`, `policies/software-execute.yaml`, `policies/software-review.yaml`
- Test: `test/engines/software/run-input.test.ts`

**Interfaces:**
- Produces: `buildSoftwareRunInput(chain, job, workspace, issue: Issue, policy: Policy): RunInput` (`subject` carries issue title, body and labels; `feedback` is `job.payload.feedback` for revise attempts; review input carries the PR number and base branch).
- Default policies: `default: true`, `runner: claude-cli`; execute config uses `allowedTools: [Read, Edit, Write, Bash, Glob, Grep]`, `maxBudgetUsd: 5`, `timeoutMs: 1800000`, `inactivityTimeoutMs: 600000`; review config is read-only (`allowedTools: [Read, Glob, Grep, Bash]`) with `maxBudgetUsd: 2`.

- [ ] **Step 1: Write the failing tests:** `it('includes issue title and body in subject')`; `it('passes review feedback on a revise attempt')`; `it('default policy files load and validate against Task 5 and the claude-cli config schema')`.
- [ ] **Step 2: Run** `npx vitest run test/engines/software/run-input.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildRunInput` on the engine using this function; the prompt text lives in the YAML files.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(software): run input and default policies`.

### Task 21: End-to-end scenarios

**Files:**
- Test: `test/scenarios/software-engine.test.ts`, `test/scenarios/zombie.test.ts`

**Interfaces:**
- Consumes: everything. A helper `makeHarness(opts)` in `test/support/harness.ts` builds a kernel on a temp database with the software engine, `FakeRunner`, `FakeGitHost`, a temp bare remote, and a fake clock; it exposes `submit(issueNumber, labels?)`, `runUntilIdle()`, and accessors for chain, jobs and fake GitHub state.

- [ ] **Step 1: Write the failing scenarios:**
  - `it('supervised happy path ends awaiting_merge with factory:ready-for-merge')`.
  - `it('automatic happy path merges the PR and completes the chain')`.
  - `it('revise loop: two request_changes then approve')` asserts attempt 3 and that revise deliveries are seeded from the pushed head.
  - `it('revise loop exhausts at 3 attempts and ends needs_human with the PR open')`.
  - `it('runner error lands in the DLQ, labels the issue and keeps the worktree')`; `it('dlq retry resumes and completes')`.
  - `it('three lease expiries dead-letter with max_deliveries')`.
  - `it('followups are filed as issues and not queued')`.
  - `it('a second submit for an open chain is rejected')`.
  - `it('review job is not claimable until the PR exists')`.
  - Zombie file: `it('a zombie delivery works in its own workspace and cannot publish')` (lease expires, delivery 2 starts, delivery 1 resumes and attempts to finish; assert delivery 1's result and effects are rejected, the remote branch holds only delivery 2's commit, and the two workspaces never share a path); `it('a crash after the result is recorded resumes without rerunning the runner')`.
- [ ] **Step 2: Run** `npx vitest run test/scenarios`. Expected: FAIL for missing wiring, not for missing code under test.
- [ ] **Step 3: Implement** `harness.ts` and fix whatever the scenarios expose in earlier tasks' code (each fix keeps that task's tests green).
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `test: end-to-end scenarios for the software engine`.

### Task 22: Retention pruning

**Files:**
- Create: `src/kernel/retention.ts`
- Test: `test/kernel/retention.test.ts`

**Interfaces:**
- Produces: `pruneHistory(db, now: number, retentionDays: number): { childProcesses: number; deadLetters: number; followups: number }`.

- [ ] **Step 1: Write the failing tests:** `it('prunes exited child_processes older than retention')`; `it('prunes resolved dead letters only')`; `it('never prunes unresolved dead letters')`; `it('prunes filed followups but never unfiled ones')`.
- [ ] **Step 2: Run** `npx vitest run test/kernel/retention.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as three `DELETE` statements; run it from the worker loop's maintenance interval alongside the reaper and the followups sweep.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): history retention`.

### Task 23: CLI

**Files:**
- Create: `src/cli/index.ts`; `package.json` gets a `bin` entry `factory`
- Test: `test/cli/cli.test.ts`

**Interfaces:**
- Produces commands: `factory submit <issue-url> [--label <l>...]`, `factory worker [--poll-ms N]`, `factory status`, `factory dlq list`, `factory dlq retry <job-id>`, `factory dlq discard <job-id>`. Config via `factory.config.json` (`dbPath`, `policiesDir`, `workspaceRoot`, `defaultEngine`, `defaultProfile`, `requiredSections`, `historyRetentionDays`, `keepWorktreeOnFailure`). Exports `run(argv: string[], deps): Promise<number>` returning the exit code, so tests do not spawn processes.

- [ ] **Step 1: Write the failing tests** with the harness from Task 21: `it('submit prints the chain and job ids and exits 0')`; `it('submit exits 1 with the validation message for an issue missing sections')`; `it('submit exits 1 for ambiguous engine labels')`; `it('status prints one engine-described line per open chain')`; `it('dlq list prints unresolved dead letters')`; `it('dlq retry requeues and exits 0')`; `it('dlq discard cancels the chain')`.
- [ ] **Step 2: Run** `npx vitest run test/cli`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:util.parseArgs`; the `worker` command installs SIGINT/SIGTERM handlers that call `worker.stop()`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): submit, worker, status and dlq commands`.

### Task 24: README and smoke runbook

**Files:**
- Create: `README.md`, `docs/smoke-test.md`

- [ ] **Step 1:** Write `README.md`: what the factory is, how to configure and run `factory worker` and `factory submit`, how policies and engines are added (point at the spec).
- [ ] **Step 2:** Write `docs/smoke-test.md`: the manual end-to-end run against a sandbox GitHub repository with the real `claude` CLI (create a sandbox repo with the issue template sections, submit a trivial issue under each profile, expected labels at each stage, how to inspect the DLQ).
- [ ] **Step 3: Run** the smoke test once by hand and record any deviation as an issue in the notes section of the runbook.
- [ ] **Step 4: Commit** `docs: readme and smoke-test runbook`.
