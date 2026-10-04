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

waiting (awaiting_merge / needs_human), checked by every worker's maintenance pass (60 s):
   +-- PR merged ----------> chain completed, factory labels removed, one comment on the issue
   +-- PR closed unmerged -> chain cancelled, factory labels removed, one comment on the issue
   +-- PR still open ------> nothing
```

**Reconciling waiting chains.** A chain waiting on a person (`awaiting_merge` or `needs_human`) finishes by itself when the pull request is settled. Every maintenance pass (every 60 seconds in every worker, so the latency is up to a minute plus the time of the pass) looks up the pull request of each `waiting` chain once, by its branch `factory/issue-<n>`. A merged pull request completes the chain (phase `merged`); one closed without merging cancels it, which frees the issue for a new `submit`. Either way the factory removes `factory:ready-for-merge`, `factory:needs-human`, `factory:in-progress` and `factory:dead-letter` from the issue and posts one comment (`Pull request #<n> was merged` or `Pull request #<n> was closed without merging; this chain was cancelled`, hidden marker so it is never posted twice). An open pull request, a missing one and a transient GitHub failure (no HTTP status, 429, 5xx) leave the chain as it is; the next pass retries. A failure to label or comment is printed as an error and does not undo the transition. The change only applies to a chain that is still `waiting`, so a concurrent `factory cancel` or a second worker never conflicts. `dead_lettered` and `active` chains are not reconciled. `factory cancel` keeps working for manual use.

The profile is `supervised` unless the issue carries the label `factory:profile:automatic` at submit time (or `defaultProfile` in the config says otherwise). Both profiles allow 3 attempts. Follow-up items that the agent or reviewer report are filed as new issues labeled `factory:followup`.

## Prerequisites

- Linux. Process identity (kill-before-reclaim, orphan reaping, the guard that never signals the worker's own process group) reads `/proc`. On another OS the start-time check that guards against pid reuse degrades to a bare existence check, and the own-process-group guard fails open, so a recycled pid or the worker's own group could be signalled. Run workers on Linux only.
- Node.js 22 or newer (`"engines": { "node": ">=22" }` in `package.json`; the floor comes from `better-sqlite3`). The build was verified here with Node 25.2.1.
- `git` 2.32 or newer (the secret guard uses `GIT_CONFIG_GLOBAL`, 2.32, and `--diff-merges`, 2.31), able to fetch and push over HTTPS to the repositories you submit (see the note on credentials below).
- `gh`, the GitHub CLI, authenticated (`gh auth status`). Every GitHub call the engine makes goes through it.
- `claude`, the Claude Code CLI, with `--bare` support (check `claude --help`), and `ANTHROPIC_API_KEY` set in the worker's environment, preferably a dedicated, spend-limited key. In bare mode (the default, see "Credentials") the runner does not use the CLI's own login; a worker without a key fails every run with a message saying what to set. Bedrock or Vertex users forward their provider's variables with `passEnv` instead.
- Issues in the formalized template: the body must contain a line `## Goal` and a line `## Acceptance criteria` (compared case-insensitively on trimmed lines; configurable with `requiredSections`).

### Credentials

The factory process itself needs GitHub credentials: `gh` calls use your `gh` login (or `GH_TOKEN`), and the engine pushes with the machine's git credential configuration (credential helper, `gh auth setup-git`, and so on) to the explicit URL built from `cloneUrlTemplate`. The agent (the `claude` child process) is NOT meant to have them. The goal is that the agent keeps its tools (Bash, Edit, the project's tests) but starts with no ambient credentials, so the default routes (`git push` over HTTPS, `gh`, the keyring, a credential helper, the SSH agent) find nothing to authenticate with. SSH keys on disk are the exception, see below.

Bare mode (policy config `bare: true`, the default and what both shipped policies set):

- The agent runs as `claude --bare`. Per `claude --help`, bare mode skips hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads and CLAUDE.md auto-discovery, and authenticates to Anthropic strictly with `ANTHROPIC_API_KEY` (or an `apiKeyHelper` passed with `--settings`, which the runner does not use); OAuth and the keychain are never read. When the worktree has a `CLAUDE.md` at its root that is a regular file (not a symlink) inside the worktree, the runner passes it as `--append-system-prompt-file=<worktree>/CLAUDE.md`, one of the options the help lists for supplying context in bare mode, so it is appended to the agent's system prompt. Nothing else is passed: no `.claude/CLAUDE.md`, no `CLAUDE.local.md`, no CLAUDE.md of a subdirectory, and `@` imports inside the file are not resolved. The runner does not pass `--add-dir` (the worktree is already the agent's working directory).
- The agent's environment is built from an allow-list: `PATH`, `LANG`, `LANGUAGE`, the locale categories `LC_ALL`, `LC_CTYPE`, `LC_NUMERIC`, `LC_TIME`, `LC_COLLATE`, `LC_MONETARY`, `LC_MESSAGES`, `LC_PAPER`, `LC_NAME`, `LC_ADDRESS`, `LC_TELEPHONE`, `LC_MEASUREMENT` and `LC_IDENTIFICATION` (no other `LC_` names), `TERM`, `TZ`, `TMPDIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and their lower-case forms), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, plus the names in the policy's `passEnv`. Nothing else from the worker's environment reaches it: no `GH_*` or `GITHUB_*` tokens, no `SSH_*` (SSH agent), no `GIT_*` (askpass, ssh command), no `DBUS_*`, `XDG_RUNTIME_DIR` or `GNOME_KEYRING_*` (so a keyring client is not told where the session bus is), no `KRB5*`, `AWS_*`, `GOOGLE_*` or `AZURE_*` unless named in `passEnv`. `passEnv` refuses `GH_*`, `GITHUB_*`, `SSH_*`, `GIT_*`, `DBUS_*` and `XDG_RUNTIME_DIR`.
- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` point at an empty directory (`factory-run-*` in the temp directory) created for each run. When the run ends (normal exit, abort, timeout, error or spawn failure) the runner first kills the agent's process group, then removes the directory best-effort: it retries, makes read-only directories inside it writable (never following symlinks out of it), and never throws. Tools that find their configuration through `HOME` (git's `~/.gitconfig` and `~/.git-credentials`, `gh`, cloud CLIs, npm's `~/.npmrc`) see nothing. The project's own tests run with that empty HOME too.
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` are set, so git inside the agent does not use a credential helper from your global or system git config.
- `GH_CONFIG_DIR` points at another empty per-run directory, so `gh` inside the agent does not find your `gh` login.
- If neither `ANTHROPIC_API_KEY` (from the worker's environment or the runner's constructor) nor any `passEnv` variable is set, the run fails before anything starts, with a message naming what to set; the kernel dead-letters the job as `runner_error`.

Measures in both modes:

- The worktree's `origin` has its push URL disabled, and only the engine pushes, after the run.
- The worktrees share one bare cache repository per GitHub repository, whose config the agent can write. Before the engine commits and pushes, and at the start of every workspace preparation, the factory removes every key of that config that is not on a short allow-list (so a planted `url.*.insteadOf`, `credential.helper`, `core.sshCommand`, `core.fsmonitor` or `include.path` cannot redirect or hijack the engine's own git), checks that the worktree's `.git` file still points into the cache, and runs its git commands with hooks disabled.
- The review run is started with `--setting-sources user`, so the `.claude/settings.json` on the branch under review (written by the execute agent) cannot add hooks or permission rules. In bare mode the user settings live in the empty per-run HOME, so none are loaded either; `claude --help` documents no conflict between `--bare` and `--setting-sources`.

What bare mode does NOT do. It is not a sandbox, and the agent still runs as your OS user:

- A shell-capable agent that goes looking can still read, and write, any file your OS user can by its absolute path: `/home/<you>/.config/gh/hosts.yml`, `/home/<you>/.git-credentials`, `/home/<you>/.gitconfig`, `/home/<you>/.ssh/*`, cloud credential files. It can also undo the environment for its own commands (set `HOME` or `GH_CONFIG_DIR` back, unset `GIT_CONFIG_GLOBAL`, or point `DBUS_SESSION_BUS_ADDRESS` at your session bus at `/run/user/<uid>/bus` to reach the keyring). It can modify your global git and `gh` configuration, which the engine's own push honours and which the factory's cleaning of the cache repository config does not cover, or leave a background process that rewrites the cache config after the factory sanitized it.
- OpenSSH resolves `~` from the user database, not from `HOME`, so `ssh` (and git over SSH) inside the agent can still find passphrase-less private keys and `~/.ssh/config` in your real home directory, even without an SSH agent. (This is OpenSSH's documented behavior, not something the factory's tests check.)
- The model API key is in the agent's environment by design, so the agent can read it. Use a dedicated, spend-limited key.
- The network is not restricted.
- `PATH` is passed through unchanged, so it may contain entries under your real home (for example `~/.local/bin`, `~/go/bin`, a version manager's shims), and those programs run as the agent's commands.
- The shipped execute policy still allows unrestricted `Bash`. Narrowing or sandboxing it is a product decision that is still open.

Operational effects of bare mode:

- Every run starts with empty per-run caches (npm, Go modules, pip, cargo, and so on live under the scratch `HOME`), so runs are slower, download more over the network and, when the temp directory is a tmpfs, use more RAM.
- A `factory-run-*` scratch directory can be left in the temp directory after a worker crash or `SIGKILL`, or when the OS refused part of the removal. Nothing cleans these up automatically; remove old ones by hand (`chmod -R u+w` first if a removal fails).

A real boundary needs deployment, not code: run the worker under a dedicated low-privilege OS user, or in a container or VM with a filesystem and network sandbox, whose home holds no credentials of yours; limit its egress to the model API (and GitHub for the engine's own git and `gh` calls); and give the engine's own git and `gh` use a fine-grained token (or machine user) limited to the repositories you submit, ideally a sandbox repository.

`bare: false` is the weaker opt-out: the agent gets your whole environment minus the `GH_*` and `GITHUB_*` variables and `SSH_AUTH_SOCK`, `SSH_ASKPASS`, `GIT_ASKPASS`, `GIT_SSH_COMMAND` and `GIT_SSH`, with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and an empty per-run `GH_CONFIG_DIR`, and no `--bare`. It keeps your `HOME` (the `claude` CLI uses its own login there), `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (so `gh auth token` or `git credential fill` can reach the OS keyring) and any cloud credentials in the environment, so the credential files under your `HOME` and the OS keyring stay reachable with ordinary commands (for example `GH_CONFIG_DIR=~/.config/gh gh auth token`). A keyring login is not safer than a plaintext one there.

#### Secret guard

The model API key is in the agent's environment, and a shell-capable agent could write it (or another secret it can reach) into a file in its worktree, by mistake or because an issue told it to. Since the engine commits with `git add -A` and pushes, `commit_push` checks the change before pushing. This is defense in depth, not a guarantee.

- What is scanned: exactly what the push publishes beyond the commit the delivery was seeded from. `commit_push` reads the HEAD sha once, scans `seed..<sha>` and pushes `<sha>`, so a process that moves HEAD after the scan (for example one the agent left running) cannot get an unscanned commit pushed. Every commit in the range is scanned, including commits the agent made itself and a file added in one commit and deleted in a later one, each compared with its first parent:
  - the paths it adds, modifies or changes the type of;
  - for text files, its added lines; the added text is also scanned with NUL bytes removed, so UTF-16 text matches;
  - for files git considers binary (real binary content, or a file marked binary by an attribute, including one in the shared repository's `info/attributes`), the printable strings of the whole new file, like `strings`: runs of at least 8 printable ASCII characters, and runs of at least 8 printable characters interleaved with NUL bytes (UTF-16LE and UTF-16BE), so a key hidden in a binary or a UTF-16 file is still found;
  - the real commit object as stored (every header, including extra headers of a hand-built commit) and its message. Replace refs (`refs/replace/*`, which the agent can write in the shared cache) and a graft file are ignored by the scan, so it reads the same objects `git push` sends. A `shallow` file can still cut the history the scan walks; it cuts what the push sends the same way, so a commit it hides is not sent and a push that needs it is rejected by the remote (fails closed).
- The scan's git commands ignore the worker's global and system git configuration and attributes file (and config passed through the environment), and pin `log.showRoot=true` and `core.bigFileThreshold=1g`, so that configuration cannot hide a root commit or make content unreadable. The push itself keeps your git configuration (it needs your credential helper or ssh setup) but runs with `push.followTags=false`, so no tags go along.
- Two caps apply, each counted in raw bytes: at most 5 MiB of text (added lines and commit objects) and at most 5 MiB of strings extracted from binary files. A change that exceeds either is refused as `scan-truncated`. A binary file's size does not count, only the strings found in it, so random-like assets (compressed images, archives, wasm) of several MiB pass. A scan that fails (a git error or timeout) also refuses the push, as `runner_error` (`refusing to push: the secret scan failed: ...`).
- What is matched: the named patterns `anthropic-key` (`sk-ant-...`), `github-token` (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), `github-fine-grained-token` (`github_pat_...`), `aws-access-key-id` (`AKIA...`), `private-key` (a `-----BEGIN ... PRIVATE KEY-----` line), `slack-token` (`xoxb-` and similar) and `google-api-key` (`AIza...`); `known-secret-value`, the exact value of `ANTHROPIC_API_KEY`, of every variable in the worker's environment whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` (any case), and of the variables the claude-cli policies list in `passEnv` (values shorter than 12 characters, or one repeated character, are ignored); and `secret-file`, an added file named `.env`, `.env.*` (except `.env.example`, `.env.sample` and `.env.template`), `*.env`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `credentials` or `credentials.json`.
- What happens on a match: nothing is pushed and no PR is opened. The execute job is dead-lettered as `runner_error` with `effect 'commit_push' failed: refusing to push: the change contains a secret (<kinds>); the matched text is not shown`, and that message is what the issue comment shows. The matched text is never shown in the error, the dead letter, the issue comment or the logs. With `keepWorktreeOnFailure` the worktree, secret included, is kept for inspection; delete it once you have looked (the sweep removes it after `keptWorktreeMaxAgeMs`). `factory dlq retry` reruns the agent in a fresh worktree; `factory dlq discard` gives up.
- Redaction: agent-controlled text that the factory publishes to GitHub through other channels has every named-pattern match and known value replaced with `[redacted]`: the commit message (built from the issue title), the PR title, the agent's summary in the PR body, the dead-letter issue comment (including an execute job's error summary, which is also redacted in the stored dead letter), and the titles and bodies of follow-up issues.

Limits:

- It matches patterns and exact values only. A split, base64, hex, otherwise encoded, encrypted or compressed secret, or a secret that is neither in the worker's environment nor shaped like one of the patterns, is not recognized. Redaction has the same limits: other text the factory publishes is redacted only for the known values and the named patterns.
- The shared cache repository's `info/attributes`, which the agent can write, no longer hides content from the scan (a file it marks binary has its strings extracted; no textconv or external diff is used). It can still influence how the engine's own `git add` stores files (for example end-of-line conversion); the scan reads the stored objects, which are what is pushed.
- It does not cover what the agent prints to its own output beyond the error summary, which the factory stores locally (the job result in the database, the step log).
- It does not stop the agent from using a secret in other ways (sending it over the network, for example); the key is in its environment by design.
- It does not replace rotating a key. When the guard fires, the leaked file is still on the worker's disk in the kept worktree; treat the key as exposed and rotate it, and rotate any key that was pushed or leaked otherwise.
- It can refuse legitimate changes: a test fixture that looks like a token, a `*.key` or `*.pem` file, a change with more than 5 MiB of added text, or a value of a secret-named variable that also appears in the code. Such a change has to be pushed by hand, or the variable removed from the worker's environment. Tests and docs that need a fake token can build it by string concatenation (see `CLAUDE.md`).

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

**submit.** The URL must be `https://github.com/<owner>/<repo>/issues/<n>`; owner and repository are lower-cased, so `Owner/Repo` and `owner/repo` name the same subject. The issue must be open, have a non-empty body, and contain the required sections (see [docs/issue-format.md](docs/issue-format.md) for the format); exactly one policy of kind `execute` and one of kind `review` must match its labels (or the defaults apply), so an ambiguous review policy fails here rather than after the agent ran. A subject (`owner/repo#n`) can have only one open chain. `--label` values and `--engine <id>` (shorthand for `--label factory:engine:<id>`) feed the router only; they are not written to the issue. `submit` makes no GitHub writes.

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

**cancel.** Ends a chain by hand, typically a `waiting` one you do not want to wait a maintenance pass for, or an issue you want to resubmit while its PR is still open. It cancels the chain and its queued jobs, resolves its dead letters, frees the subject for a new `submit`, and removes `factory:in-progress`, `factory:needs-human`, `factory:dead-letter` and `factory:ready-for-merge` from the issue (labels on the PR are left alone). It refuses (exit 1) a chain whose job is running (stop that worker, or wait for the delivery to finish) and a chain that is already completed or cancelled; a missing or non-numeric id is a usage error (exit 2).

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

`needs-human` means the machinery worked: the agent produced a pull request three times and the reviewer kept requesting changes. A PR exists and a person decides what to do with it. `dead-letter` means the machinery failed (the runner errored or timed out, a GitHub or git effect kept failing, the workspace could not be prepared, or the lease expired on every delivery) and no usable result exists. Look at the issue comment and `factory dlq list`, fix the cause, then `factory dlq retry <job-id>`, or `factory dlq discard <job-id>` to give up. Once you merge or close the PR of a `needs-human` or `ready-for-merge` chain, the maintenance pass completes or cancels the chain within about a minute (see the lifecycle above); `factory cancel <chain-id>` ends it immediately, and is the way out when the PR is neither merged nor closed.

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

- `policies/software-execute.yaml` (`software-execute`): tools `Read, Edit, Write, Bash, Glob, Grep`, budget `maxBudgetUsd: 5`, `timeoutMs: 1800000`, `inactivityTimeoutMs: 600000`, `resultFormat: execution`, `bare: true`.
- `policies/software-review.yaml` (`software-review`): tools `Read, Glob, Grep` plus `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git status:*)`, budget `maxBudgetUsd: 2`, `timeoutMs: 900000`, `inactivityTimeoutMs: 600000`, `resultFormat: json`, `bare: true`, `settingSources: user`.

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
| `bare` | Optional, default `true`. Bare mode: `claude --bare` (the worktree's root `CLAUDE.md` passed with `--append-system-prompt-file`), an allow-listed environment and an empty per-run `HOME`; requires `ANTHROPIC_API_KEY` in the worker's environment or a `passEnv` provider credential (see "Credentials"). `false` is the weaker opt-out: your environment minus a deny-list, with your `HOME`. |
| `passEnv` | Optional list of extra variable names forwarded from the worker's environment in bare mode, for example a Bedrock or Vertex provider's credentials. Each must match `^[A-Z][A-Z0-9_]*$`; `GH_*`, `GITHUB_*`, `SSH_*`, `GIT_*`, `DBUS_*` and `XDG_RUNTIME_DIR` are refused. A listed variable that is set also counts as the provider credential for the start-up check. Ignored when `bare` is `false`. |

The review policy is read-only by tool restriction: no `Edit`, `Write` or general `Bash`, only the four read-only git subcommands. Its prompt tells the reviewer to pass `--no-ext-diff --no-textconv` to `git diff`, `git show` and `git log -p` and never to use `--output` (a prompt rule, not enforced: the `Bash(git diff:*)` rules cannot express it). The agent must end its final message with one fenced `json` block; the last such block is parsed.

## Concurrency and safety

Each claim of a job increments its `delivery` counter and takes a lease (5 minutes, renewed every 30 seconds by a heartbeat). Every kernel write is fenced by `(job id, delivery)`, so a stale worker's result is rejected, and every external effect re-checks the fence immediately before acting. Each delivery gets its own git worktree, so a zombie cannot corrupt its replacement, and the push uses `--force-with-lease` against the sha the delivery was seeded from. Before a job is reclaimed the reaper kills the delivery's agent process groups and, only if that worker's row still names this job delivery as its current one, the worker pid (a worker that moved on to another job is never killed), then requeues or dead-letters. A worker that loses its lease waits at most 10 seconds for the run to stop before it moves on. Effects look before they act (find the PR by branch, find a marker comment, check PR state). When the push's lease is rejected while the delivery is still current, someone else moved `factory/issue-<n>` (a person pushed to it, for example) and the job is dead-lettered (`runner_error`, `remote branch moved by someone else`). In the `automatic` profile the merge is pinned with `gh pr merge --match-head-commit` to the head the reviewer saw (the commit the review's worktree was seeded from), and `--delete-branch` removes the branch afterwards. If that head cannot be verified (the review's worktree is gone after a crash or a retry) or the pinned merge is refused (someone pushed after the review), the review job is dead-lettered as `runner_error` and `factory dlq retry` redoes the review against the current head; the factory never merges an unpinned head. The agent's summary is capped at 2000 characters and neutralized before it goes into the PR body (no `@` mentions, no `Fixes #n` closing references). Every `gh` call is killed after 60 seconds (a transient failure, retried), every git network command (fetch, push, ls-remote) after 5 minutes and every local git command after 60 seconds; git's ssh runs with `BatchMode=yes`, so it fails instead of prompting. The reasoning and the accepted residual risks are in section 5 of [the spec](docs/superpowers/specs/2026-10-03-software-factory-design.md).

## Writing a new engine

1. Implement `Engine<S>` from `src/kernel/types.ts`: `id`, `policyKinds`, `stateSchema`, `resultSchemas` (job type to zod schema), `submit`, `workspace`, `buildRunInput`, a pure `transition`, idempotent `runEffect`, `describe`, `surfaceDeadLetter`, `cleanup`, and optionally `afterRetry`, `afterCancel`, `reconcile` (with `finalState` and `afterReconcile`; called for `waiting` chains on every maintenance pass) and `sweep`.
2. The smallest working example is the echo engine in `test/support/echo-engine.ts`; `src/engines/software/` is the full-size one.
3. Register it in `buildRuntime` (`src/cli/runtime.ts`) next to the software engine, and add policies for its kinds.
4. Route to it with `factory submit <input> --engine <id>` (the label `factory:engine:<id>`). `factory submit` currently passes `{ issueUrl }` as the engine's submit input, so a new engine reading something else needs a CLI change.

## Development

```
npm test          # vitest run
npm run build     # tsc
```

Tests use fakes for GitHub (`test/support/fake-github.ts`) and the model (a stub `claude` script, `test/support/stub-claude.mjs`, and `src/runner/fake.ts`), plus real temporary git repositories. `test/support/harness.ts` wires a software engine, kernel and fake host together for the end-to-end scenario tests in `test/scenarios` (`software-engine.test.ts`, `zombie.test.ts`). Nothing in the automated suite talks to GitHub or a real model; see [docs/smoke-test.md](docs/smoke-test.md) for the manual run that does.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, on Node 22 and 24. After checking that `git` is 2.32 or newer, it runs `npm ci`, `npx tsc --noEmit`, `npm run build` and `npm test` as separate steps. Wait for it to pass before merging, including pull requests the factory opens.

## Known limitations

- Single machine only: the queue is a SQLite file and the kernel kills worker and agent PIDs locally. Workers on separate hosts are not supported.
- No poller: work enters only through `factory submit`. Routing uses the explicit `--label` and `--engine` values, not the issue's own labels. (The profile label `factory:profile:automatic` and policy matching do read the issue's labels.)
- One engine ships (software). The experiment and intake engines are future work.
- Linux only (see Prerequisites).
- Not a sandbox: the agent runs as your OS user (in bare mode with an empty per-run `HOME`, but able to read your files by absolute path), and the shipped execute policy allows unrestricted `Bash`. See "Credentials" for what is isolated and what is not.
- An execute job whose result was recorded but whose workspace was lost in a crash goes to the dead-letter queue; a human `factory dlq retry` reruns the agent. Review jobs resume cleanly, except one whose `merge_pr` (automatic profile) is still pending when it resumes after a crash or an `effect_error` retry: without the review's workspace the reviewed head cannot be verified, so it dead-letters as `runner_error` (the factory never merges an unpinned head) and `factory dlq retry` redoes the review against the current head. The same holds when the execute job's third effect (adding `factory:in-progress` to the issue) keeps failing: that dead letter is an `effect_error`, its first retry resumes into the missing workspace and dead-letters again as `runner_error`, and the second retry reruns the agent.
- The worktree sweep only recognizes directories named `j<jobId>-d<delivery>`; older naming is left alone. It never removes a delivery that is running or recently dead-lettered (checked again under the cache lock right before removal), nor a delivery directory modified in the last 10 minutes.
- History tables are pruned by `historyRetentionDays`. The `workers` table is never pruned.
- There is no migration tooling: tables are created with `CREATE TABLE IF NOT EXISTS`, so columns added since a database was created (`followups.claimed_until`, `dead_letters.surfaced_at`, `workers.current_job_id` and `workers.current_delivery`) are missing from it. Delete the database file when upgrading a prototype database.
- Timeouts are fixed in code: 60 seconds per `gh` call and per local git command, 5 minutes per git fetch or push. A first fetch of a very large repository that needs longer fails the delivery (`workspace prepare failed: ... timed out`).
- The `gh`-based GitHub calls were never run against the real CLI during development, only against fakes. In particular, whether `gh pr merge --match-head-commit` reports an HTTP status when it refuses is unverified (if not, the refusal is retried as transient, then dead-lettered as `runner_error` like any refused pinned merge, so `dlq retry` redoes the review).
