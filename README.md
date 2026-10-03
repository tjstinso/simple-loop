# Software factory

The software factory turns a GitHub issue into a reviewed pull request. A worker picks up the issue, runs the `claude` CLI in a private git worktree to implement it, pushes a branch, opens a pull request, runs a second `claude` pass as reviewer, and repeats until the reviewer approves or three attempts are used. Depending on the autonomy profile, a human then merges the pull request or the factory merges it itself. All state lives in one SQLite file; GitHub is the source of truth for issues, branches, pull requests and labels.

## Core idea

- **Kernel.** A reusable, engine-agnostic job queue on SQLite: chains of jobs, leases and heartbeats, fenced writes, a reaper that kills before it reclaims, a dead-letter queue, history retention. It knows nothing about GitHub or git.
- **Engines.** Pluggable modules that implement the `Engine` interface (`src/kernel/types.ts`): they say how to submit work, prepare a workspace, build the runner input, turn a result into the next jobs (a pure `transition`), and perform external effects.
- **Router.** `src/router/router.ts` picks the engine for a submission from labels of the form `factory:engine:<id>`, falling back to `defaultEngine`.
- **Software engine.** The first and only shipped engine (`src/engines/software`): execute and review jobs, GitHub through the `gh` CLI, git worktrees, follow-up issue filing.
- **Policies.** YAML files in `policies/` choose the runner and its settings (prompt, tools, budget, timeouts) per job kind.

The full design is in [the spec](docs/superpowers/specs/2026-10-03-software-factory-design.md); the implementation plan is [here](docs/superpowers/plans/2026-10-03-software-factory.md).

## How a piece of work flows

```
GitHub issue (## Goal, ## Acceptance criteria)
   |  factory submit <issue-url>      validates the issue, creates a chain and an execute job
   v
queue (SQLite)
   |  factory worker                  claims the job under a lease
   v
EXECUTE  claude edits a private worktree ──> commit, push factory/issue-<n>, open PR ("Closes #<n>")
   v
REVIEW   claude reviews the PR branch (read-only tools)
   |
   +-- approve ------------> supervised: PR labeled factory:ready-for-merge, a human merges
   |                         automatic:  the factory merges the PR (squash)
   +-- request_changes ----> attempt < 3: new EXECUTE job with the feedback, same branch
   |                         attempt = 3: PR labeled factory:needs-human
   +-- machinery failure --> dead-letter queue; issue labeled factory:dead-letter
```

The profile is `supervised` unless the issue carries the label `factory:profile:automatic` at submit time (or `defaultProfile` in the config says otherwise). Both profiles allow 3 attempts. Follow-up items that the agent or reviewer report are filed as new issues labeled `factory:followup`.

## Prerequisites

- Linux. Process identity (kill-before-reclaim, orphan reaping, the guard that never signals the worker's own process group) reads `/proc`. On another OS the start-time check that guards against pid reuse degrades to a bare existence check, and the own-process-group guard fails open, so a recycled pid or the worker's own group could be signalled. Run workers on Linux only.
- Node.js 22 or newer (`"engines": { "node": ">=22" }` in `package.json`; the floor comes from `better-sqlite3`). The build was verified here with Node 25.2.1.
- `git`, able to fetch and push over HTTPS to the repositories you submit (see the note on credentials below).
- `gh`, the GitHub CLI, authenticated (`gh auth status`). Every GitHub call the engine makes goes through it.
- `claude`, the Claude Code CLI, logged in.
- Issues in the formalized template: the body must contain a line `## Goal` and a line `## Acceptance criteria` (compared case-insensitively on trimmed lines; configurable with `requiredSections`).

### Credentials

The factory process itself needs GitHub credentials: `gh` calls use your `gh` login (or `GH_TOKEN`), and the engine pushes with the machine's git credential configuration (credential helper, `gh auth setup-git`, and so on) to the explicit URL built from `cloneUrlTemplate`. The agent (the `claude` child process) is NOT meant to have them, and the factory takes these measures:

- The agent's environment has every variable starting with `GH_` or `GITHUB_` removed (so no `GH_TOKEN` or `GITHUB_TOKEN`), and `SSH_AUTH_SOCK`, `SSH_ASKPASS`, `GIT_ASKPASS`, `GIT_SSH_COMMAND` and `GIT_SSH` removed (no SSH agent, no askpass helper).
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` are set for the agent, so git inside the agent does not see a credential helper configured in `~/.gitconfig` or the system config.
- `GH_CONFIG_DIR` points at a fresh, empty directory created for each run and removed afterwards, so `gh` inside the agent does not find your `gh` login.
- The worktree's `origin` has its push URL disabled, and only the engine pushes, after the run.
- The worktrees share one bare cache repository per GitHub repository, whose config the agent can write. Before the engine commits and pushes, and at the start of every workspace preparation, the factory removes every key of that config that is not on a short allow-list (so a planted `url.*.insteadOf`, `credential.helper`, `core.sshCommand`, `core.fsmonitor` or `include.path` cannot redirect or hijack the engine's own git), checks that the worktree's `.git` file still points into the cache, and runs its git commands with hooks disabled.
- The review run is started with `--setting-sources user`, so the `.claude/settings.json` on the branch under review (written by the execute agent) cannot add hooks or permission rules.

Residual risk: this is not a sandbox. The measures above only keep credentials out of the agent's default environment; they do not stop an agent that goes looking. The agent runs as your OS user with your `HOME` (the `claude` CLI needs its own login there) and your `DBUS_SESSION_BUS_ADDRESS`, and the shipped execute policy allows unrestricted `Bash`, which can undo the environment changes for its own commands (for example by pointing `GH_CONFIG_DIR` back at `~/.config/gh` or unsetting `GIT_CONFIG_GLOBAL`). Every credential your OS user can use is therefore reachable: credential files under `HOME` (`~/.config/gh/hosts.yml`, `~/.git-credentials`, SSH private keys without a passphrase, cloud CLI credentials), the OS keyring (through `gh auth token` or `git credential fill`), and any configured credential helper. A keyring login is not safer than a plaintext one here. The agent can also modify your global git and `gh` configuration (`~/.gitconfig`, `~/.config/gh`), which the factory's cleaning of the cache repository config does not cover, and the engine's own push honours your global git config; it could also leave a background process that rewrites the cache config after the factory sanitized it. Run the factory under a dedicated low-privilege OS user, or in a container or VM, whose only GitHub credential is a fine-grained token (or machine user) limited to the repositories you submit, ideally a sandbox repository. Narrowing or sandboxing the execute policy's `Bash` is a product decision that is still open.

## Install and build

```
npm install
npm run build
```

The build writes to `dist/`. `package.json` declares the `factory` bin as `dist/src/cli/main.js`. Run it with `node dist/src/cli/main.js ...`, or link it (`npm link`) to get a `factory` command. The examples below use `factory`.

## Configuration

`factory` reads `factory.config.json` from the current directory, or the file given with `--config <path>`. A missing default file means all defaults; an explicit `--config` path that does not exist is an error. Unknown keys are ignored. Relative `dbPath`, `policiesDir` and `workspaceRoot` resolve against the directory of the config file (the current directory when there is no file). A complete example is [factory.config.example.json](factory.config.example.json).

| Field | Default | Meaning |
|---|---|---|
| `dbPath` | `./factory.db` | SQLite database file. |
| `policiesDir` | `./policies` | Directory scanned for `*.yaml` policy files. |
| `workspaceRoot` | `./.factory/workspaces` | Root for the bare repository cache (`.cache/`) and the per-delivery worktrees (`<chainId>/j<jobId>-d<delivery>`). |
| `defaultEngine` | `software` | Engine used when a submission names none. |
| `defaultProfile` | `supervised` | `supervised` or `automatic`; used when the issue has no `factory:profile:automatic` label. |
| `requiredSections` | `["## Goal", "## Acceptance criteria"]` | Lines that must appear in the issue body. |
| `historyRetentionDays` | `30` | Positive number. Age after which exited child-process rows, resolved dead letters and filed follow-up rows are pruned. |
| `keepWorktreeOnFailure` | `true` | Keep the worktree of a dead-lettered job for debugging. |
| `keptWorktreeMaxAgeMs` | `604800000` (7 days) | Non-negative. A kept worktree whose dead letter is older than this, or resolved, is removed by the periodic sweep. |
| `cloneUrlTemplate` | `https://github.com/{repo}.git` | Fetch and push URL; `{repo}` is replaced by `owner/name`. |

Not configurable (set in `src/cli/runtime.ts`): lease 300000 ms, heartbeat 30000 ms, `maxDeliveries` 3 (a job whose lease expires on its third delivery is dead-lettered instead of requeued). `delivery` counts every claim of the job, including claims after a worker's own stop handed the job back (SIGINT/SIGTERM), and `dlq retry` keeps the counter, so a job that was stopped twice, or retried after two deliveries, is dead-lettered the next time its lease expires. The squash merge method is the default of `GhCliHost`.

## Usage

```
factory [--config <path>] submit <issue-url> [--label <l>]... [--engine <id>]
factory [--config <path>] worker [--poll-ms <n>] [--id <name>]
factory [--config <path>] status
factory [--config <path>] dlq list
factory [--config <path>] dlq retry <job-id>
factory [--config <path>] dlq discard <job-id>
factory [--config <path>] cancel <chain-id>
factory --help
```

`--config` and `-h`/`--help` may appear anywhere on the line. Exit codes: 0 success, 1 runtime error (message `error: ...` on stderr), 2 usage error (message and the usage text on stderr). Every command first loads and validates the policies (see Policies) and fails with exit 1, naming the policy, when one is invalid.

**submit.** The URL must be `https://github.com/<owner>/<repo>/issues/<n>`; owner and repository are lower-cased, so `Owner/Repo` and `owner/repo` name the same subject. The issue must be open, have a non-empty body, and contain the required sections; exactly one policy of kind `execute` and one of kind `review` must match its labels (or the defaults apply), so an ambiguous review policy fails here rather than after the agent ran. A subject (`owner/repo#n`) can have only one open chain. `--label` values and `--engine <id>` (shorthand for `--label factory:engine:<id>`) feed the router only; they are not written to the issue. `submit` makes no GitHub writes.

```
$ factory submit https://github.com/acme/sandbox/issues/12
chain 1 job 1 engine software
```

**worker.** Runs until SIGINT or SIGTERM, one job at a time. `--poll-ms` (non-negative integer, default 1000) is the delay between empty polls; `--id` names the worker (default `<host>:<pid>:<random>`). Give each worker a stable `--id` (for example `--id w1` in its service definition): at startup a worker kills the agent processes that a previous incarnation with the same id left behind (after a crash or `kill -9`). With the random default id nothing matches, and leftover agents are only killed when the reaper reclaims their expired lease. Maintenance (reaping expired leases, surfacing dead letters, pruning, follow-up and worktree sweeps) runs every 60 seconds. On a signal the worker aborts the current delivery, kills its agent processes and hands the job back to the queue.

```
$ factory worker --id w1
worker w1 started
...
worker w1 stopped
```

**status.** One line per chain that is not completed or cancelled: `<chain-id> <engine> <chain-status> <engine description>`.

```
$ factory status
1 software active acme/sandbox#12 phase=reviewing attempt=1 profile=supervised
```

With nothing open it prints `no open chains`.

**dlq.** `list` prints unresolved dead letters, newest first: `job <job-id> chain <chain-id> <reason> <first line of the error, at most 120 characters>`. The reason is one of `runner_error`, `timeout`, `max_deliveries`, `effect_error`. Empty output is `no dead letters`.

```
$ factory dlq list
job 1 chain 1 runner_error workspace prepare failed: git fetch origin --prune failed: ...
$ factory dlq retry 1
requeued job 1
$ factory dlq discard 1
discarded job 1
```

`retry` re-queues the same job (its delivery counter is kept, so the next claim is delivery + 1), puts the chain back to active, and keeps the recorded result only for `effect_error` (then the agent is not rerun, only the post-processing). Only a review job's effects (labels, merge, comments) dead-letter as `effect_error`, with one exception: when the `automatic` merge cannot be pinned to the head the reviewer saw (the review's worktree is gone after a crash or an `effect_error` retry) or the pinned merge is refused, the job is dead-lettered as `runner_error`, so `retry` redoes the review against the current head. When an execute job's push or pull-request creation fails, the job is dead-lettered as `runner_error`, so one `retry` reruns the agent in a fresh worktree (its earlier, unpublished work is redone); resuming would be impossible because the earlier delivery's worktree is not reused. `retry` also moves the issue label from `factory:dead-letter` back to `factory:in-progress`. `discard` cancels the chain, which frees the subject for a new `submit`, and removes `factory:in-progress`, `factory:needs-human`, `factory:dead-letter` and `factory:ready-for-merge` from the issue (best effort; a labelling failure is printed as an error, the discard stands).

If labelling the issue fails when a job is dead-lettered (for example GitHub answers 502), the dead letter is recorded as not yet surfaced, and every maintenance pass (once a minute, in any running worker) retries the label and comment until they succeed.

**cancel.** Ends a chain by hand, typically a `waiting` one: a supervised PR you merged or closed yourself, a `needs-human` PR you dealt with, or an issue you want to resubmit. It cancels the chain and its queued jobs, resolves its dead letters, frees the subject for a new `submit`, and removes `factory:in-progress`, `factory:needs-human`, `factory:dead-letter` and `factory:ready-for-merge` from the issue (labels on the PR are left alone). It refuses (exit 1) a chain whose job is running (stop that worker, or wait for the delivery to finish) and a chain that is already completed or cancelled; a missing or non-numeric id is a usage error (exit 2).

```
$ factory cancel 1
cancelled chain 1
```

## Labels

| Label | On | Meaning |
|---|---|---|
| `factory:in-progress` | issue | Set once the first execute job produced a pull request (the same step removes a leftover `factory:dead-letter`); removed on approval, on the final changes request, on dead-lettering, and by `cancel` and `dlq discard`. |
| `factory:ready-for-merge` | PR | `supervised` profile: the reviewer approved; a human merges. |
| `factory:needs-human` | PR | The reviewer still requested changes after the last attempt. |
| `factory:dead-letter` | issue | A job failed beyond what the kernel can recover; the factory also comments with the reason, error and job id. Removed by `dlq retry`, `dlq discard`, `cancel`, and the next execute job of a resubmitted issue. |
| `factory:followup` | new issues | Issues the factory filed from `followups` in agent or reviewer output. Nothing queues them automatically. |
| `factory:profile:automatic` | issue (set by you, before submit) | Selects the `automatic` profile. |
| `factory:engine:<id>` | `--label` value | Router label naming the engine. More than one distinct engine label is an error; an unknown id is an error. |

Labels are set and removed explicitly, never toggled. GitHub creates a label on first use if the repository lacks it.

### needs-human versus dead-letter

`needs-human` means the machinery worked: the agent produced a pull request three times and the reviewer kept requesting changes. A PR exists and a person decides what to do with it. `dead-letter` means the machinery failed (the runner errored or timed out, a GitHub or git effect kept failing, the workspace could not be prepared, or the lease expired on every delivery) and no usable result exists. Look at the issue comment and `factory dlq list`, fix the cause, then `factory dlq retry <job-id>`, or `factory dlq discard <job-id>` to give up. Nothing in the factory watches the PR after `needs-human` or `ready-for-merge`: once you have merged, closed or otherwise handled it, end the chain with `factory cancel <chain-id>`.

Closing the issue stops the chain: the next job is dead-lettered (`runner_error`, `issue #<n> is closed`) before the agent runs, and opening a pull request or merging for a closed issue fails as `effect_error`. Discard it or cancel the chain.

## Policies

A policy is one YAML file in `policiesDir`:

| Field | Meaning |
|---|---|
| `id` | Unique across all files. |
| `kind` | Job kind the policy serves: `execute` or `review` for the software engine. |
| `match.labels` | Labels that must all be present on the job's labels (the issue's labels at submit time). |
| `default` | `true` marks the fallback for its kind. A default must have empty `match.labels`; a non-default must have a non-empty list. At most one default per kind. |
| `runner` | Runner name; `claude-cli` is the only one registered. |
| `config` | Runner-specific settings, validated against the runner's schema at startup. |

Matching: among the non-default policies of the kind, those whose `match.labels` are all present are candidates. Exactly one wins; more than one is an `ambiguous policy match` error; none falls back to the default of that kind; no default is an error. Files are loaded and validated at startup: each policy's `kind` must be declared by a registered engine, its `runner` must be registered, and its `config` must pass that runner's schema; otherwise every command fails with an error naming the policy. Restart the worker after editing them.

Two default policies ship:

- `policies/software-execute.yaml` (`software-execute`): tools `Read, Edit, Write, Bash, Glob, Grep`, budget `maxBudgetUsd: 5`, `timeoutMs: 1800000`, `inactivityTimeoutMs: 600000`, `resultFormat: execution`.
- `policies/software-review.yaml` (`software-review`): tools `Read, Glob, Grep` plus `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git status:*)`, budget `maxBudgetUsd: 2`, `timeoutMs: 900000`, `inactivityTimeoutMs: 600000`, `resultFormat: json`, `settingSources: user`.

`claude-cli` config fields (`src/runner/claude-cli.ts`):

| Field | Meaning |
|---|---|
| `prompt` | Prompt text. The work item (issue data as JSON) and, on a revise attempt, the reviewer feedback are appended. |
| `allowedTools` | Tool allow-list passed as `--allowedTools=...`. |
| `maxBudgetUsd` | Positive number, passed as `--max-budget-usd`. |
| `timeoutMs` | Hard wall-clock limit (positive integer, at most 2147483647). |
| `inactivityTimeoutMs` | Kill the run after this long without a stream event (same bounds). |
| `resultFormat` | `execution` (summary and optional followups from the final JSON block; steps and cost from the stream) or `json` (the final JSON block is the result, used for review verdicts). |
| `permissionMode` | Optional; passed as `--permission-mode`. |
| `settingSources` | Optional; passed as `--setting-sources` (comma-separated `user`, `project`, `local`). The review policy uses `user`, so the branch under review cannot bring its own `.claude/settings.json`. |

The review policy is read-only by tool restriction: no `Edit`, `Write` or general `Bash`, only the four read-only git subcommands. Its prompt tells the reviewer to pass `--no-ext-diff --no-textconv` to `git diff`, `git show` and `git log -p` and never to use `--output` (a prompt rule, not enforced: the `Bash(git diff:*)` rules cannot express it). The agent must end its final message with one fenced `json` block; the last such block is parsed.

## Concurrency and safety

Each claim of a job increments its `delivery` counter and takes a lease (5 minutes, renewed every 30 seconds by a heartbeat). Every kernel write is fenced by `(job id, delivery)`, so a stale worker's result is rejected, and every external effect re-checks the fence immediately before acting. Each delivery gets its own git worktree, so a zombie cannot corrupt its replacement, and the push uses `--force-with-lease` against the sha the delivery was seeded from. Before a job is reclaimed the reaper kills the delivery's agent process groups and, only if that worker's row still names this job delivery as its current one, the worker pid (a worker that moved on to another job is never killed), then requeues or dead-letters. A worker that loses its lease waits at most 10 seconds for the run to stop before it moves on. Effects look before they act (find the PR by branch, find a marker comment, check PR state). When the push's lease is rejected while the delivery is still current, someone else moved `factory/issue-<n>` (a person pushed to it, for example) and the job is dead-lettered (`runner_error`, `remote branch moved by someone else`). In the `automatic` profile the merge is pinned with `gh pr merge --match-head-commit` to the head the reviewer saw (the commit the review's worktree was seeded from), and `--delete-branch` removes the branch afterwards. If that head cannot be verified (the review's worktree is gone after a crash or a retry) or the pinned merge is refused (someone pushed after the review), the review job is dead-lettered as `runner_error` and `factory dlq retry` redoes the review against the current head; the factory never merges an unpinned head. The agent's summary is capped at 2000 characters and neutralized before it goes into the PR body (no `@` mentions, no `Fixes #n` closing references). Every `gh` call is killed after 60 seconds (a transient failure, retried), every git network command (fetch, push, ls-remote) after 5 minutes and every local git command after 60 seconds; git's ssh runs with `BatchMode=yes`, so it fails instead of prompting. The reasoning and the accepted residual risks are in section 5 of [the spec](docs/superpowers/specs/2026-10-03-software-factory-design.md).

## Writing a new engine

1. Implement `Engine<S>` from `src/kernel/types.ts`: `id`, `policyKinds`, `stateSchema`, `resultSchemas` (job type to zod schema), `submit`, `workspace`, `buildRunInput`, a pure `transition`, idempotent `runEffect`, `describe`, `surfaceDeadLetter`, `cleanup`, and optionally `afterRetry`, `afterCancel` and `sweep`.
2. The smallest working example is the echo engine in `test/support/echo-engine.ts`; `src/engines/software/` is the full-size one.
3. Register it in `buildRuntime` (`src/cli/runtime.ts`) next to the software engine, and add policies for its kinds.
4. Route to it with `factory submit <input> --engine <id>` (the label `factory:engine:<id>`). `factory submit` currently passes `{ issueUrl }` as the engine's submit input, so a new engine reading something else needs a CLI change.

## Development

```
npm test          # vitest run
npm run build     # tsc
```

Tests use fakes for GitHub (`test/support/fake-github.ts`) and the model (a stub `claude` script, `test/support/stub-claude.mjs`, and `src/runner/fake.ts`), plus real temporary git repositories. `test/support/harness.ts` wires a software engine, kernel and fake host together for the end-to-end scenario tests in `test/scenarios` (`software-engine.test.ts`, `zombie.test.ts`). Nothing in the automated suite talks to GitHub or a real model; see [docs/smoke-test.md](docs/smoke-test.md) for the manual run that does.

## Known limitations

- Single machine only: the queue is a SQLite file and the kernel kills worker and agent PIDs locally. Workers on separate hosts are not supported.
- No poller: work enters only through `factory submit`. Routing uses the explicit `--label` and `--engine` values, not the issue's own labels. (The profile label `factory:profile:automatic` and policy matching do read the issue's labels.)
- One engine ships (software). The experiment and intake engines are future work.
- Linux only (see Prerequisites).
- Not a sandbox: the agent runs as your OS user with your `HOME`, and the shipped execute policy allows unrestricted `Bash`. See "Credentials" for what is isolated and what is not.
- An execute job whose result was recorded but whose workspace was lost in a crash goes to the dead-letter queue; a human `factory dlq retry` reruns the agent. Review jobs resume cleanly. The same holds when the execute job's third effect (adding `factory:in-progress` to the issue) keeps failing: that dead letter is an `effect_error`, its first retry resumes into the missing workspace and dead-letters again as `runner_error`, and the second retry reruns the agent.
- Nothing observes the PR after the factory is done with it (no poller, no webhook): a `waiting` chain stays open until `factory cancel <chain-id>`.
- The worktree sweep only recognizes directories named `j<jobId>-d<delivery>`; older naming is left alone. It never removes a delivery that is running or recently dead-lettered (checked again under the cache lock right before removal), nor a delivery directory modified in the last 10 minutes.
- History tables are pruned by `historyRetentionDays`. The `workers` table is never pruned.
- There is no migration tooling: tables are created with `CREATE TABLE IF NOT EXISTS`, so columns added since a database was created (`followups.claimed_until`, `dead_letters.surfaced_at`, `workers.current_job_id` and `workers.current_delivery`) are missing from it. Delete the database file when upgrading a prototype database.
- Timeouts are fixed in code: 60 seconds per `gh` call and per local git command, 5 minutes per git fetch or push. A first fetch of a very large repository that needs longer fails the delivery (`workspace prepare failed: ... timed out`).
- The `gh`-based GitHub calls were never run against the real CLI during development, only against fakes. In particular, whether `gh pr merge --match-head-commit` reports an HTTP status when it refuses is unverified (if not, the refusal is retried as transient, then dead-lettered as `runner_error` like any refused pinned merge, so `dlq retry` redoes the review).
