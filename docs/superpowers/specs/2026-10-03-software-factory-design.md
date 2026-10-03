# Software Factory: Design

Date: 2026-10-03
Status: Draft for review
Scope: Prototype. The goal is to run the full loop end to end and learn where it falls short, not to be production-grade.

## 1. Purpose

A reusable **kernel** that runs queued work, plus pluggable **engines** that each define a loop. The first engine, the **software engine**, takes a formalized GitHub issue, executes it according to a matched policy, and produces a pull request that is reviewed according to a separately matched policy.

The kernel is the point of the design. Once it exists, new loops are new engines: an experiment engine whose output is a data artifact, an intake engine that ingests GitHub issues and produces issues the software engine can run, and so on. A **router** chooses the engine for each piece of work.

### Success criteria

- `factory submit <issue-url>` produces a PR through execute and review with no further human action (under the `automatic` profile, through merge).
- A reviewer's "request changes" triggers a bounded revise loop.
- Failures are visible on the issue and recoverable, never silent.
- Every external dependency (model, GitHub, queue, artifact store) can be replaced by a fake, so the whole loop is testable offline.
- A second engine can be added without changing the kernel. This is proven in tests by a trivial second engine (section 10).

### Non-goals (prototype)

- Multi-host or distributed workers. Workers run on one machine.
- A webhook server or GitHub-event ingestion. A poller is a later add-on that calls the same `enqueue` function.
- The experiment engine and the intake engine. Each gets its own spec; this spec defines the seam they plug into.
- A declarative multi-step workflow engine. The `Runner` boundary (section 6) leaves room for one.
- Policy precedence rules, automatic job retries beyond redelivery, and cost dashboards.

## 2. Decisions

| Area | Decision |
|---|---|
| Structure | Shared kernel, pluggable engines, router in front |
| Input (software engine) | Formalized GitHub issues, submitted with a CLI |
| Queue | Local SQLite; workers long-poll it and claim jobs atomically |
| Policies | YAML files, label-matched; each engine declares its policy kinds |
| Execution | Pluggable `Runner`; `claude-cli` (headless `claude -p`) first, `fake` for tests |
| Software output | A PR, then a review job; revise loop up to 3 attempts |
| Autonomy | Profiles: `supervised` (human merges) and `automatic` (factory merges) |
| Language | TypeScript on Node, with `better-sqlite3`, `zod`, `vitest` |
| Architecture | Ports-and-adapters; thin entrypoints |

## 3. Architecture

```
 CLI: submit | worker | status | dlq        (future: poller)
                    |
                 +--v---+
                 |Router|   issue labels -> engine id
                 +--+---+
                    | enqueue(engine, input)
   +----------------v--------------------------------------+
   |                       Kernel                           |
   |  queue, claim, lease, heartbeat, fencing, workers,     |
   |  child processes, DLQ, policy loading, runner registry |
   +--------+------------------------+----------------------+
            | dispatch by chain.engine
   +--------v-------+      +---------v------+      +--------------+
   | software engine|      | experiment     |      | intake engine|
   | (this spec)    |      | engine (future)|      | (future)     |
   +--------+-------+      +----------------+      +--------------+
            |
   engine ports: GitHost (gh | fake), WorkspaceProvider (git worktree)
   kernel ports: Queue (SQLite), Runner (claude-cli | fake | workflow*), PolicyStore (YAML)
```

The CLI and any future poller are thin wrappers over `router.route` and `kernel.enqueue`. `submit` and a poller call the same functions.

### What the kernel owns

- The job queue: atomic claim, leases, heartbeat, fencing, redelivery.
- Workers and the child processes they spawn, including kill-before-reclaim.
- The dead-letter queue.
- Policy loading and the label matcher.
- The runner registry and runner invocation with timeouts and inactivity detection.
- Dispatch: given a claimed job, find the chain's engine and call its handlers.

### What an engine owns

- Its job types and result types.
- Its state machine: a pure function from (chain state, job result) to transitions, new jobs and effects.
- Its ports (the software engine uses `GitHost`; an experiment engine would use an `ArtifactStore`).
- Its workspace provider (a git worktree for software work, a scratch directory for an experiment).
- Its policy kinds (the software engine declares `execute` and `review`).
- Its effects, executed idempotently under the kernel's fencing rules.
- How a dead letter is surfaced to people (the software engine labels and comments on the issue).

### Engine interface

```ts
interface Engine<State> {
  id: string;                                   // 'software'
  policyKinds: string[];                        // ['execute', 'review']
  stateSchema: ZodType<State>;                  // validates chain.engine_state

  // Result type per job type. The kernel validates runner output against
  // these before calling transition; a failure dead-letters the job.
  resultSchemas: Record<string, ZodType>;       // { execute: ..., review: ... }

  // Fail fast: validate the input, return the initial chain state and first job.
  submit(input: SubmitInput, ports): Promise<{ subjectKey: string; state: State; firstJob: NewJob }>;

  // One private workspace per job delivery (see section 5).
  workspace: WorkspaceProvider;                 // prepare(chain, job) / teardown(chain, job)

  // What the runner is given for this job: subject details, feedback, workspace.
  buildRunInput(chain: ChainView<State>, job: Job, workspace: Workspace): RunInput;

  // Pure. No I/O. Returns what the kernel should write and what effects to run.
  transition(chain: ChainView<State>, job: Job, result: unknown): Transition<State>;

  // Idempotent, check-before-act. Run BEFORE the transition commits (section 5),
  // with the fence token so it can re-check the delivery before acting.
  runEffect(effect: Effect, fence: Fence, ports): Promise<void>;

  describe(chain: ChainView<State>): string;    // one-line status for `factory status`
  surfaceDeadLetter(chain: ChainView<State>, dl: DeadLetter, ports): Promise<void>;
  cleanup(chain: ChainView<State>, job: Job, ports): Promise<void>;
}

// NewJob        = { type, attempt, policyKind, labels, payload }
//                 (policyKind and labels select the policy at enqueue time)
// Transition<S> = { engineState, chainStatus, newJobs: NewJob[], effects: Effect[] }
```

The transition function being pure is what makes engines testable without a database or network. `engine_state` is opaque JSON to the kernel, so engines cannot be queried by their private fields in SQL; the kernel `status` column and `describe` cover the common needs.

### Router

The router runs at submit time. It resolves an engine for an incoming piece of work.

- It uses the same label matcher as policies. For example `factory:engine:experiment` selects the experiment engine.
- If no engine label is present, the configured default engine applies (`software`).
- If more than one engine label is present, `submit` fails with an explicit error.
- The chosen engine id is stored on the chain as `engine`.

### Engines feeding other engines

An engine may create work for another engine, such as an intake engine producing issues for the software engine. The loose-coupling rule: it does this by creating a GitHub issue labeled for the target engine (as the software engine already does with followups), which then enters through the normal submit or poller path. No engine calls another engine directly.

## 4. Data model

SQLite. Every state transition that creates follow-on jobs happens in one transaction.

### Kernel tables

**`chains`**: one per unit of work. The chain is the unit of workspace and engine state.

| Column | Notes |
|---|---|
| `id` | |
| `engine` | Engine id chosen by the router |
| `subject_key` | What the chain is about, such as `owner/repo#12` |
| `status` | `active`, `waiting`, `dead_lettered`, `completed`, `cancelled` |
| `engine_state` | JSON, validated by the engine's `stateSchema` |

`active` means the chain has a queued or running job. `waiting` means the chain is parked on something outside the factory. Unique partial index on `subject_key` where `status NOT IN ('completed','cancelled')`: a second `submit` for an open chain is rejected. A dead-lettered chain is resolved with `dlq retry` or `dlq discard` (which cancels it).

**`jobs`**

| Column | Notes |
|---|---|
| `id`, `chain_id` | |
| `type` | Defined by the engine (the software engine uses `execute` and `review`) |
| `attempt` | Engine-defined; the software engine matches the chain's attempt |
| `status` | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
| `policy_id` | Fixed at enqueue time; later policy edits do not affect queued jobs |
| `payload` | JSON input, such as review feedback for a revise attempt |
| `result` | JSON result, typed by the engine. Once non-null, the job has finished running and only post-processing remains (section 5) |
| `claimed_by`, `lease_expires_at` | Worker id and lease deadline |
| `delivery` | Incremented on every claim; the fencing token |
| `error`, timestamps | |

Unique on `(chain_id, type, attempt)`, with `INSERT OR IGNORE` for follow-on jobs.

**`workers`**: one row per worker process. `id`, `pid`, `pgid`, `process_start_time`, `host`, `started_at`, `last_seen_at`.

**`child_processes`**: one row per process a runner spawns while executing a job delivery. Separate from `workers` because a worker is long-lived and handles many jobs, while a child lives for one delivery, and a runner may spawn more than one.

| Column | Notes |
|---|---|
| `id` | |
| `worker_id` | The supervising worker |
| `job_id`, `delivery` | The job delivery the child belongs to; kill-before-reclaim looks children up by these |
| `pid`, `pgid`, `process_start_time` | The start time guards against PID reuse |
| `started_at`, `exited_at`, `exit_code` | `exited_at` is null while the child is believed running |

The worker inserts the row immediately after spawning and updates it from the child's `exit` event. Rows are kept after exit as a debugging history and pruned by age. On startup, a worker marks any rows of its own previous incarnation with a null `exited_at` as orphans and kills them.

**`dead_letters`**: `job_id`, `chain_id`, `reason` (`runner_error`, `timeout`, `max_deliveries`, `effect_error`), `error`, `step_log_path`, timestamps, `resolved_at`.

### Software engine tables

**`followups`**: `id`, `job_id`, `title`, `body`, `filed_issue_number` (null until filed), timestamps.

### Retention

History tables (`child_processes`, resolved `dead_letters`, filed `followups`) are pruned by age under `historyRetentionDays` (default 30). Unfiled followups and unresolved dead letters are never pruned.

## 5. Kernel behavior

### Worker loop

Each worker repeats:

1. Long-poll the queue and claim a job. The claim is one atomic `UPDATE ... WHERE status='queued'` that sets the lease and increments `delivery`.
2. If the job already has a recorded `result`, skip to step 5 (a previous delivery finished the run and died during post-processing; the agent is not rerun).
3. Look up the chain's engine and prepare a private workspace for this delivery. The path is derived from the chain id and `delivery`.
4. Resolve the runner from the job's policy, build its input with the engine's `buildRunInput`, and call `run()` with an `AbortSignal`. Validate the output against the engine's `resultSchemas`; a schema failure dead-letters the job with reason `runner_error`. Record the validated `result` on the job, fenced by `delivery`.
5. Post-processing, in this order:
   1. Call the engine's pure `transition` to get the new state, new jobs and effects.
   2. Run the effects through the engine (push, open PR, labels, ...). Each is idempotent and re-checks the fence first, so replaying them after a crash is safe.
   3. Commit the new engine state, chain status, new jobs and the job's `succeeded` status in one transaction, fenced by `delivery`.
6. Run the engine's `cleanup` for this delivery.

Follow-on jobs are only created at step 5.3, after the effects they depend on (for example the PR a review job needs) have completed. A failed effect dead-letters the job with reason `effect_error` and creates no follow-on jobs.

### Liveness and progress

There are two separate signals.

**Liveness (lease heartbeat) belongs to the worker.** The worker is our Node process; the agent is a child it spawned. While supervising the child, the worker renews its lease on a timer. This says the worker is alive and still watching its child. It is independent of the runner, so every runner behaves the same.

**Progress (hang detection) belongs to the runner.** A live worker with a hung child would renew forever, so liveness alone is not enough. The `claude-cli` runner reads the `stream-json` events from stdout. Every event resets an inactivity timer. If nothing arrives for `inactivityTimeoutMs`, the runner aborts, kills the child's process group, and the job fails with reason `timeout`. A hard `timeoutMs` bounds total wall-clock time. The same event stream fills in `steps` and `costUsd`.

A single long tool call (for example a slow test suite) produces no events, so `inactivityTimeoutMs` needs a generous default.

### Child process tracking

The worker holds the child handle and uses its `exit` event to learn immediately when the child dies. Because that handle is lost if the worker crashes, the worker also persists each child in `child_processes`.

### Timing defaults

| Setting | Default |
|---|---|
| Lease | 5 minutes |
| Heartbeat interval | 30 seconds |
| `inactivityTimeoutMs` | 10 minutes |
| `maxDeliveries` | 3 |

These are starting points to tune from prototype runs.

### Dead-letter queue

A job that reaches `failed` goes to the DLQ, and its chain becomes `dead_lettered`. This covers runner errors, timeouts, repeated external-effect failures and jobs whose lease expired repeatedly.

- **Reasons:** `runner_error`, `timeout`, `max_deliveries`, `effect_error`.
- **Redelivery:** when a worker crashes and its lease expires, the job is requeued, up to `maxDeliveries` (3). After that it is dead-lettered instead of looping.
- **Surfacing:** the kernel calls the chain's engine to surface the dead letter. The software engine does this on the issue (section 8).
- **CLI:**
  - `factory dlq list`
  - `factory dlq retry <job-id>`: enqueues a fresh job, keeping the chain and attempt count.
  - `factory dlq discard <job-id>`: cancels the chain.

### Idempotency

Model: at-least-once delivery, with fenced writes to state the kernel owns and check-before-act for effects on external systems.

**State the kernel owns (SQLite): strong guarantees**

- **One open chain per subject**, enforced by the unique partial index on `chains`.
- **No duplicate follow-on jobs**, enforced by the unique `(chain_id, type, attempt)` constraint and `INSERT OR IGNORE`.
- **Fencing.** Every claim increments `delivery`. Every kernel write is conditioned on `WHERE id = ? AND delivery = ?`, so a stale worker's result is rejected.

**External effects: best-effort.** The external system is the source of truth, and each engine's `runEffect` looks before acting and receives the fence token. The software engine's rules are in section 8.

### Zombie workers

A zombie is a worker the queue considers dead while it is still running. Causes: a stalled heartbeat (blocked event loop, `SQLITE_BUSY`), a suspended machine that resumes after the lease expired, or an orphaned agent child that outlives a crashed worker.

Idempotency handles an effect being *repeated*. A zombie is two actors running *concurrently*, which is an isolation problem. The design therefore has three layers.

**Layer 1: isolate each delivery.**

1. **A private workspace per delivery.** Each claim gets its own workspace, seeded from the last *published* state. A zombie keeps working in its own directory and cannot corrupt the replacement's. A redelivered job starts clean; uncommitted partial work from a crashed delivery is discarded and the agent redoes it.
2. **Publishing is only an engine effect.** A runner never publishes. The engine's effect publishes from that delivery's workspace, after the fence check. The runner's environment has no credentials for the external system. A runner with a general shell could still reach an external system through ambient credentials, so the environment is stripped of them and `allowedTools` is kept narrow.

**Layer 2: reduce zombies.**

3. **Kill before reclaim.** Before redelivering a job, the reaper checks the claiming worker's persisted `pid` and start time, and the job's rows in `child_processes` for that delivery. For each process still alive, it kills the process group (agent child included), then requeues.
4. **Self-fencing.** A worker treats losing its lease as cancellation: abort the run, kill the children. After a suspend, it checks the lease before any effect.
5. **Generous lease** relative to the heartbeat, to avoid false positives on long agent runs.

**Layer 3: fence the effects.**

6. **Fence before effects.** Before each external effect, the engine re-reads the job's `delivery` and proceeds only if it still matches.
7. **System-level fencing where the system allows it.** The software engine pushes with `--force-with-lease` (section 8).

**Residual risk.** A worker frozen at exactly the wrong moment could still make one stale external call, because the fence check and the action are not atomic. This is accepted for a single-machine prototype. It would not be acceptable with workers on separate hosts, which could not be killed. If a stricter model is needed, the alternative is an outbox table: effects are recorded as intents and applied by a single dispatcher with a per-effect idempotency key.

## 6. Policies and the Runner contract

### Policy files

YAML in a `policies/` directory, validated with `zod` at load time. Each policy has a `kind` that must be one of the policy kinds some engine declares.

```yaml
id: bugfix-execute
kind: execute            # a policy kind declared by an engine
match:
  labels: [type:bugfix]  # all must be present on the issue
runner: claude-cli
config:                  # opaque to the kernel; validated by the runner
  prompt: |
    ...
  allowedTools: [Read, Edit, Bash]
  maxBudgetUsd: 5
  timeoutMs: 1800000
  inactivityTimeoutMs: 600000
```

### Matching

- The matcher takes the work item's labels and finds policies of the right `kind` whose `match.labels` are all present.
- No match: the default policy for that kind.
- More than one match: `submit` fails with an explicit error. There are no precedence rules.
- The matched `policy_id` is stored on the job at enqueue time.

### Runner contract

```ts
interface Runner<R> {
  name: string;
  configSchema: ZodType;
  run(input: RunInput, signal: AbortSignal): Promise<R>;
}

// RunInput: job, resolved policy config, subject details from the engine,
//           workspace { path, ... } from the engine's WorkspaceProvider
// R is the engine's result type for that job type.
```

The software engine's result types:

```ts
// execute job -> ExecutionResult { status, summary, costUsd?, steps?, followups? }
// review job  -> ReviewVerdict   { verdict: 'approve' | 'request_changes',
//                                  feedback, costUsd?, followups? }
// followups: { title: string; body: string }[]
```

### Boundary rule

A runner only works inside the workspace it is given and returns a typed result. The engine owns everything outside the workspace: creating the workspace, publishing outputs, notifications, retries, attempt counting. The kernel only moves results to the engine, so any conforming runner can be used with any engine that expects its result type.

This keeps the door open for a `WorkflowRunner` that interprets a list of steps (agent steps, deterministic steps such as tests and lint, self-check gates) from the policy `config`, without any change to the kernel or an engine. Workflow steps must not perform engine effects such as opening PRs or merging.

### Runners shipped in the prototype

- **`claude-cli`:** runs `claude -p` with `--output-format stream-json`, `--allowedTools` and `--max-budget-usd` taken from the policy config.
- **`fake`:** returns scripted results. Used by tests to drive whole loops without a model.

## 7. Router

See section 3. The router is configured with a default engine id and the label prefix `factory:engine:`. It returns an engine id, or an error for ambiguous input. It performs no I/O and is unit-tested directly.

## 8. Software engine

The first engine. Policy kinds: `execute` and `review`. Subject key: `owner/repo#<issue>`.

### Chain state (`engine_state`)

`{ repo, issueNumber, labels, profile, branch, attempt, phase }`

- `branch` is the remote branch `factory/issue-<n>`. Workspaces are per delivery and their paths are derived, so none is stored here.
- `attempt` is the current execute attempt, 1 to `maxAttempts` (default 3).
- `phase` is one of `executing`, `reviewing`, `awaiting_merge`, `needs_human`, `merged`. Kernel status maps as: `executing` and `reviewing` are `active`; `awaiting_merge` and `needs_human` are `waiting`; `merged` is `completed`.

### Submit

`factory submit <issue-url>` verifies the issue exists, contains the required sections of the formalized issue template (default: `## Goal` and `## Acceptance criteria`, configurable), and has exactly one matching execute policy (or the default). It rejects an issue that already has an open chain. The first job is an `execute` job at attempt 1.

### State machine

| Event | Result |
|---|---|
| Execute job succeeds | Effects, in order: commit leftover changes, push, open the PR (reusing an existing one for the branch). Only after they succeed, the review job is created (section 5, step 5.3). |
| Review approves | Run the profile's `onApprove` action |
| Review requests changes, `attempt < maxAttempts` | Increment the attempt; enqueue an execute job on the same branch with the feedback in `payload` |
| Review requests changes, attempts exhausted | Phase becomes `needs_human`; PR is labeled `factory:needs-human` |
| Any job fails | Kernel dead-letters it (section 5) |

### Autonomy profiles

A profile is a named bundle `{ onApprove, maxAttempts }`.

| Profile | `onApprove` |
|---|---|
| `supervised` (default) | Label the PR `factory:ready-for-merge`; phase becomes `awaiting_merge`; a human merges |
| `automatic` | Merge the PR; phase becomes `merged` |

The issue label `factory:profile:automatic` selects the profile at submit time. Without it, the repo default applies, and if none is configured, `supervised`.

### Labels

`factory:in-progress`, `factory:ready-for-merge`, `factory:needs-human`, `factory:dead-letter`, `factory:followup`. Labels are set and removed explicitly, never toggled.

- `needs-human` means the machinery worked, but the reviewer kept requesting changes. A PR exists and a person decides what to do with it.
- `dead-letter` means the machinery failed and no usable result exists. The fix is to retry or investigate.

### Surfacing dead letters

The engine adds `factory:dead-letter` to the issue, removes `factory:in-progress`, and comments with the reason and job id. The label is cleared when the issue is retried.

### Effects and idempotency

GitHub is the source of truth, and the engine looks before acting. Before each external effect it re-reads the job's `delivery` through the fence token.

- **Branch:** deterministic name. Pushing is an engine effect only; the runner has no push credentials and the workspace's push URL is disabled. Pushes use `--force-with-lease` against the sha the delivery was seeded from, so a stale push fails once the branch has moved.
- **PR:** look up by head branch before creating one.
- **Labels:** set and remove specific labels, never toggle.
- **Merge:** check the PR state first.
- **Comments and followup issues:** carry a hidden marker such as `<!-- factory:chain=7 job=42 event=dead-letter -->`, searched before posting. The `followups` table records the filed issue number.
- **External failures:** retried with backoff a few times, then the job is dead-lettered with reason `effect_error`.

### Workspace

Each job delivery gets its own private git worktree, with a local branch named `factory/issue-<n>-c<chainId>-d<delivery>`. This isolates a zombie worker from its replacement (section 5).

- An execute delivery is seeded from the remote `factory/issue-<n>` head if the branch exists (a revise attempt starts from the previously published commits), otherwise from the base branch.
- A review delivery is seeded from the PR head and is read-only by policy.
- Nothing is shared between deliveries except what has been pushed.
- A delivery's worktree is torn down in its cleanup, once the job has succeeded and its effects have run. When a job is dead-lettered, its worktree is kept if `keepWorktreeOnFailure` is on (the default in the prototype), and the reaper removes it after a configurable age.

### Cleanup

Run after every job outcome, including failures and timeouts, in a `finally`-style path:

- **Record followups.** Each item a runner returns in `followups` is stored in `followups`, then filed as a GitHub issue labeled `factory:followup` and referencing the originating PR. Followups are not auto-queued; a human or later policy labels them ready.
  - A failure to file a followup never fails the job or chain. The row keeps a null `filed_issue_number`, and the periodic sweep retries it.
  - Followup rows are not torn down when the chain ends. The row is the idempotency record for the filed issue and the audit link back to the originating job.
- **Tear down the delivery's worktree** per the rules above, and prune its local branch. The remote branch is left to GitHub's branch deletion.
- **Reap orphans.** A periodic sweep removes worktrees that belong to no live job delivery.

## 9. Error handling

- **Fail fast at submit.** The router rejects ambiguous engine labels; the engine's `submit` rejects invalid input and duplicate open chains.
- **Atomic transitions.** A job's status change and its follow-on jobs are written in one transaction.
- **External failures.** Retried with backoff a few times, then the job is dead-lettered with reason `effect_error`.
- **Timeouts.** `AbortSignal` ends the run; `claude-cli` kills the whole process group.
- **Cost.** Each result records `costUsd`; the policy's budget cap is enforced by the runner.

## 10. Testing

- **Unit:** the router, the label matcher, policy loading and validation, and each engine's `transition` function (pure, so no database or network).
- **Kernel tests with an echo engine.** A trivial second engine registered only in tests. It proves the router and kernel handle two engines side by side, that the engine interface is sufficient, and shows where the boundary leaks.
- **Software engine scenario tests** on a temporary SQLite database with the fake `Runner` and a fake `GitHost`:
  - supervised happy path;
  - automatic happy path with merge;
  - revise loop reaching the cap and ending in `needs_human`;
  - runner error ending in the DLQ;
  - repeated lease expiry ending in the DLQ after 3 deliveries;
  - stale-worker result rejected by the fence;
  - a zombie delivery working in its own workspace cannot publish and cannot affect its replacement's workspace;
  - a runner result that fails its schema dead-letters the job;
  - a crash during post-processing resumes without rerunning the runner;
  - the review job is not claimable until the PR exists, and a failed effect creates no follow-on jobs;
  - followups filed, and a failed filing retried without failing the chain;
  - worktree teardown.
- **Concurrency:** N workers race for M jobs; no job is claimed twice.
- **Runner contract suite:** shared tests every `Runner` must pass, run against the fake and against `claude-cli` with a stubbed binary.
- **Workspace tests:** real `git` on temporary repositories for worktree creation and teardown.
- **Smoke test:** one manual end-to-end run against a sandbox GitHub repository with the real `claude` CLI. Not part of CI.

## 11. Open questions

None blocking. Values in the timing defaults and `historyRetentionDays` are starting points to tune from prototype runs.

## 12. Future work

- **Experiment engine.** Its own spec. Outputs are artifacts stored through an `ArtifactStore` port (local directory first); review is optional per policy; the issue is closed out with a summary and artifact link. To be brainstormed separately, which will also test whether the engine interface above is drawn in the right place.
- **Intake engine.** Ingests GitHub issues and produces issues labeled `factory:engine:software` that the software engine can run.
- Poller that enqueues issues labeled `factory:ready`.
- `WorkflowRunner` for multi-step policies, plus a skill that helps authors write them.
- Claude Agent SDK runner.
- Outbox for stricter idempotency if workers move off one machine.
- Policy precedence rules, automatic retries beyond redelivery, and cost reporting.
