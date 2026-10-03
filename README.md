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

Residual risk: this is not a sandbox. The agent runs as your OS user with your `HOME` (the `claude` CLI needs its own login there), and the shipped execute policy allows unrestricted `Bash`. An agent that goes looking can still read any credential stored in plaintext under `HOME` (for example `~/.config/gh/hosts.yml` when `gh` stores its token in a file rather than the system keyring, `~/.git-credentials`, SSH private keys without a passphrase, cloud CLI credentials), and it could leave a background process that rewrites the cache config after the factory sanitized it. Run the factory under a dedicated low-privilege OS user, or in a container or VM, whose only GitHub credential is a fine-grained token (or machine user) limited to the repositories you submit, ideally a sandbox repository.

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
factory --help
```

`--config` and `-h`/`--help` may appear anywhere on the line. Exit codes: 0 success, 1 runtime error (message `error: ...` on stderr), 2 usage error (message and the usage text on stderr).

**submit.** The URL must be `https://github.com/<owner>/<repo>/issues/<n>`. The issue must be open, have a non-empty body, and contain the required sections; a policy of kind `execute` must match its labels. A subject (`owner/repo#n`) can have only one open chain. `--label` values and `--engine <id>` (shorthand for `--label factory:engine:<id>`) feed the router only; they are not written to the issue. `submit` makes no GitHub writes.

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

`retry` re-queues the same job (its delivery counter is kept, so the next claim is delivery + 1), puts the chain back to active, and keeps the recorded result only for `effect_error` (then the agent is not rerun, only the post-processing). Only a review job's effects (labels, merge, comments) dead-letter as `effect_error`. When an execute job's push or pull-request creation fails, the job is dead-lettered as `runner_error`, so one `retry` reruns the agent in a fresh worktree (its earlier, unpublished work is redone); resuming would be impossible because the earlier delivery's worktree is not reused. It also moves the issue label from `factory:dead-letter` back to `factory:in-progress`. `discard` cancels the chain, which frees the subject for a new `submit`; it does not touch labels on GitHub, so remove `factory:dead-letter` from the issue yourself.

## Labels

| Label | On | Meaning |
|---|---|---|
| `factory:in-progress` | issue | Set once the first execute job produced a pull request; removed on approval, on the final changes request, and on dead-lettering. |
| `factory:ready-for-merge` | PR | `supervised` profile: the reviewer approved; a human merges. |
| `factory:needs-human` | PR | The reviewer still requested changes after the last attempt. |
| `factory:dead-letter` | issue | A job failed beyond what the kernel can recover; the factory also comments with the reason, error and job id. |
| `factory:followup` | new issues | Issues the factory filed from `followups` in agent or reviewer output. Nothing queues them automatically. |
| `factory:profile:automatic` | issue (set by you, before submit) | Selects the `automatic` profile. |
| `factory:engine:<id>` | `--label` value | Router label naming the engine. More than one distinct engine label is an error; an unknown id is an error. |

Labels are set and removed explicitly, never toggled. GitHub creates a label on first use if the repository lacks it.

### needs-human versus dead-letter

`needs-human` means the machinery worked: the agent produced a pull request three times and the reviewer kept requesting changes. A PR exists and a person decides what to do with it. `dead-letter` means the machinery failed (the runner errored or timed out, a GitHub or git effect kept failing, the workspace could not be prepared, or the lease expired on every delivery) and no usable result exists. Look at the issue comment and `factory dlq list`, fix the cause, then `factory dlq retry <job-id>`, or `factory dlq discard <job-id>` to give up.

## Policies

A policy is one YAML file in `policiesDir`:

| Field | Meaning |
|---|---|
| `id` | Unique across all files. |
| `kind` | Job kind the policy serves: `execute` or `review` for the software engine. |
| `match.labels` | Labels that must all be present on the job's labels (the issue's labels at submit time). |
| `default` | `true` marks the fallback for its kind. A default must have empty `match.labels`; a non-default must have a non-empty list. At most one default per kind. |
| `runner` | Runner name; `claude-cli` is the only one registered. |
| `config` | Runner-specific settings, validated by the runner when it runs. |

Matching: among the non-default policies of the kind, those whose `match.labels` are all present are candidates. Exactly one wins; more than one is an `ambiguous policy match` error; none falls back to the default of that kind; no default is an error. Files are loaded at startup, so restart the worker after editing them.

Two default policies ship:

- `policies/software-execute.yaml` (`software-execute`): tools `Read, Edit, Write, Bash, Glob, Grep`, budget `maxBudgetUsd: 5`, `timeoutMs: 1800000`, `inactivityTimeoutMs: 600000`, `resultFormat: execution`.
- `policies/software-review.yaml` (`software-review`): tools `Read, Glob, Grep` plus `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git status:*)`, budget `maxBudgetUsd: 2`, `timeoutMs: 900000`, `inactivityTimeoutMs: 600000`, `resultFormat: json`.

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

The review policy is read-only by tool restriction: no `Edit`, `Write` or general `Bash`, only the four read-only git subcommands. The agent must end its final message with one fenced `json` block; the last such block is parsed.

## Concurrency and safety

Each claim of a job increments its `delivery` counter and takes a lease (5 minutes, renewed every 30 seconds by a heartbeat). Every kernel write is fenced by `(job id, delivery)`, so a stale worker's result is rejected, and every external effect re-checks the fence immediately before acting. Each delivery gets its own git worktree, so a zombie cannot corrupt its replacement, and the push uses `--force-with-lease` against the sha the delivery was seeded from. Before a job is reclaimed the reaper kills the claiming worker's agent process groups and the worker pid, then requeues or dead-letters. Effects look before they act (find the PR by branch, find a marker comment, check PR state). The reasoning and the accepted residual risks are in section 5 of [the spec](docs/superpowers/specs/2026-10-03-software-factory-design.md).

## Writing a new engine

1. Implement `Engine<S>` from `src/kernel/types.ts`: `id`, `policyKinds`, `stateSchema`, `resultSchemas` (job type to zod schema), `submit`, `workspace`, `buildRunInput`, a pure `transition`, idempotent `runEffect`, `describe`, `surfaceDeadLetter`, `cleanup`, and optionally `afterRetry` and `sweep`.
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
- An execute job whose result was recorded but whose workspace was lost in a crash goes to the dead-letter queue; a human `factory dlq retry` reruns the agent. Review jobs resume cleanly.
- A dead letter created by the reaper is surfaced on the issue only once; if that surfacing fails it is not retried.
- The worktree sweep only recognizes directories named `j<jobId>-d<delivery>`; older naming is left alone.
- History tables are pruned by `historyRetentionDays`.
- The `claimed_until` column of the `followups` table exists only in the DDL (`CREATE TABLE IF NOT EXISTS`) and there is no migration tooling: delete the database file when upgrading a prototype database.
- The `gh`-based GitHub calls were never run against the real CLI during development, only against fakes.
