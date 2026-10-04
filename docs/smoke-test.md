# Smoke test: manual end-to-end run

## Purpose and warning

The automated suite (`npm test`) uses fakes for GitHub and for the model. This runbook exercises the real thing: the real `gh` CLI, the real `claude` CLI and a real GitHub repository. It confirms the assumptions listed in "What only a real run can confirm" below.

Warning: the run creates real issues, branches, pull requests, labels and comments in the sandbox repository, and it spends model budget (the shipped policies cap one execute run at 5 USD and one review run at 2 USD, so one attempt costs at most 7 USD and a run using all three attempts at most 21 USD; a trivial issue costs far less). Use a throwaway repository you can delete, and keep the small budgets of the shipped policies.

## Prerequisites checklist

- [ ] A dedicated GitHub machine user, or a fine-grained personal access token, whose access is limited to the sandbox repository, and nothing else. The agent runs as your OS user with unrestricted `Bash` (see "Credentials" in the README); bare mode gives it an empty `HOME` and an allow-listed environment, but it can still read any file of that user by absolute path, so treat every credential readable by that user as reachable by the agent. Best: run the whole smoke test under a dedicated OS user or in a container or VM that holds only this credential.
- [ ] `gh auth status` (as that machine user or token) reports a logged-in account with permission to create issues, labels, branches and pull requests, and to merge, in the sandbox repository.
- [ ] `claude` is installed and `claude --help` lists `--bare` (its description names `--append-system-prompt[-file]`, which the runner uses for the worktree's `CLAUDE.md`).
- [ ] `ANTHROPIC_API_KEY` is exported in the shell that runs the worker, preferably a dedicated key with a low spend limit (the agent can read it). The shipped policies run in bare mode, where the runner does not use the `claude` CLI's own login (`claude --help`: OAuth and the keychain are never read), so being logged in to `claude` is no longer enough; without a key every job dead-letters with a message naming `ANTHROPIC_API_KEY`. Bedrock or Vertex: list your provider's variables in the policies' `passEnv` instead. To confirm the key works headless in bare mode, run `claude --bare -p "say hi"` once.
- [ ] A sandbox repository, for example `<you>/factory-sandbox`, with a trivial codebase and a test command, so the agent has something to check. Example: a `greet.js` exporting `greet(name)`, a `test.js` using `node:assert`, and a `package.json` with `"test": "node test.js"`. Its default branch must exist on the remote (push at least one commit).
- [ ] `git fetch` and `git push` over HTTPS work without prompting for the URL the factory will use (`https://github.com/<owner>/<repo>.git` by default). Check with `git ls-remote https://github.com/<owner>/<repo>.git` and a trial push of a scratch branch (delete it afterwards). Use a git credential helper, or `gh auth setup-git`, or a token configured in your git credentials. The factory sets `GIT_TERMINAL_PROMPT=0`, so a missing credential fails instead of prompting.
- [ ] Understand the credential split: the engine's own `git push` runs with the machine's git credential configuration and `gh` calls use your `gh` login, whereas the `claude` runner starts the agent in bare mode (`src/runner/claude-cli.ts`, `bareChildEnv`): `claude --bare`, an allow-listed environment (no `GH_*` or `GITHUB_*` tokens, no SSH agent, askpass, D-Bus or keyring variables), `HOME` and the XDG directories in an empty per-run directory, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` (no credential helper from your git config), and an empty per-run `GH_CONFIG_DIR` (no `gh` login). So the default lookups of git over HTTPS, `gh` and keyring clients find nothing. This is not a sandbox: the agent runs as your OS user and the shipped execute policy gives it unrestricted `Bash`, so it can still read your credential files by absolute path (`/home/<you>/.config/gh/hosts.yml`, `/home/<you>/.git-credentials`), reach your keyring by pointing `DBUS_SESSION_BUS_ADDRESS` at your session bus, and `ssh` still finds passphrase-less keys in your real `~/.ssh` (OpenSSH does not use `HOME`). It can also modify your global git and `gh` configuration, which the factory's cleaning of the cache repository config does not cover (the engine's own push honours your global git config), and it holds the model API key. That is why you should run the factory under a dedicated low-privilege OS user or in a container, with a fine-grained token limited to the sandbox repository. Narrowing or sandboxing the execute policy's `Bash` is a product decision that is still open.

## Setup

From the repository root:

```
npm install
npm run build
mkdir -p /tmp/factory-smoke
```

Create `/tmp/factory-smoke/factory.config.json`. Relative paths resolve against the config file's directory, so absolute policy paths are the clearest:

```json
{
  "dbPath": "/tmp/factory-smoke/factory.db",
  "workspaceRoot": "/tmp/factory-smoke/workspaces",
  "policiesDir": "/absolute/path/to/this/repository/policies"
}
```

All other fields keep their defaults (see the README configuration table). Define a shell alias for the runs below:

```
alias factory='node /absolute/path/to/this/repository/dist/src/cli/main.js --config /tmp/factory-smoke/factory.config.json'
```

Required: create the `factory:profile:automatic` label in the sandbox repository before step (b). `gh issue create --label` fails when the label does not exist, whereas the factory's own label calls (the REST add-labels endpoint) create labels on first use. The command is safe to re-run because of `--force`:

```
gh label create "factory:profile:automatic" --repo <owner>/<repo> --description "Run the factory without a human merge" --force
```

The other `factory:*` labels (`in-progress`, `ready-for-merge`, `needs-human`, `dead-letter`, `followup`) are applied only by the factory through the API and need no pre-creation. This runbook uses `gh issue create --label` only for the profile label.

The `sqlite3` command-line tool is used below to peek into the database; any SQLite client works.

Terminal 1 is for commands, terminal 2 runs the worker: `factory worker --id smoke` (it prints `worker smoke started`). Stop it with Ctrl-C (`worker smoke stopped`).

Issue template used throughout (the lines `## Goal` and `## Acceptance criteria` are required):

```
## Goal
Add a function `shout(name)` to greet.js that returns the name in upper case followed by "!".

## Acceptance criteria
- greet.js exports `shout`
- `shout("ada")` returns `"ADA!"`
- test.js has a test for it and `npm test` passes
```

## (a) Supervised profile

1. Create the issue with the template above, no profile label: `gh issue create --repo <owner>/<repo> --title "Add shout()" --body-file issue.md`. Note its number `<n>` and URL.
2. Submit, in terminal 1:

   ```
   factory submit https://github.com/<owner>/<repo>/issues/<n>
   ```

   Expected: `chain 1 job 1 engine software`. No label, comment or branch exists on GitHub yet (submit only reads the issue). A second identical submit must fail with `error: an open chain already exists for this subject`.
3. `factory status` expected: `1 software active <owner>/<repo>#<n> phase=executing attempt=1 profile=supervised`.
4. Start the worker in terminal 2. The execute job runs `claude` in `/tmp/factory-smoke/workspaces/1/j1-d1`; the bare cache is at `/tmp/factory-smoke/workspaces/.cache/<owner>__<repo>.git`. This takes minutes.
5. When the execute job finishes, expected on GitHub:
   - branch `factory/issue-<n>` on the remote with one commit whose message starts `factory: <issue title> (attempt 1)`, authored by `factory <factory@localhost>`;
   - a pull request from `factory/issue-<n>` to the default branch, titled like the issue, whose body starts with `Closes #<n>`, then the agent's summary, then a hidden marker `<!-- factory:chain=1 job=1 event=open-pr -->`;
   - the issue has the label `factory:in-progress`; the PR has no factory label yet.
   `factory status` now shows `phase=reviewing attempt=1`.
6. When the review finishes with an approval, expected: the PR has `factory:ready-for-merge`; the issue no longer has `factory:in-progress`; `factory status` shows `phase=awaiting_merge` with chain status `waiting`. The worker stays idle and keeps polling.
7. Check the review verdict: the verdict itself is not posted to GitHub; look at the worker's terminal for errors and, if you want the verdict, query the database: `sqlite3 /tmp/factory-smoke/factory.db "select type, attempt, status, result from jobs"` (the review row's `result` holds `verdict`, `feedback`, `costUsd`).
8. Finish by merging by hand: `gh pr merge <pr> --repo <owner>/<repo> --squash`. The issue closes through `Closes #<n>`. Nothing in the factory observes the merge (there is no poller), so `factory status` keeps listing the chain as `waiting`; that is expected for this prototype. End it with `factory cancel <chain-id>`: expected `cancelled chain <chain-id>`, the chain leaves `factory status`, and the issue loses any `factory:*` status label (the PR keeps `factory:ready-for-merge`).
9. Any follow-ups the agent or reviewer reported appear as new issues labeled `factory:followup`; see (e).

## (b) Automatic profile

1. Create a second issue (a different small goal, for example `shout` with a trailing "?" variant, so the code does not collide with (a)). Add the label before submitting: `gh issue create ... --label factory:profile:automatic`.
2. `factory submit <url>`; `factory status` shows `profile=automatic`.
3. Worker as before. Stages are the same as (a) up to the review.
4. On approval expected: the factory runs `gh pr merge <pr> --repo <owner>/<repo> --squash --delete-branch --match-head-commit <sha>` (the sha is the PR head the reviewer saw); the PR is merged, the remote branch `factory/issue-<n>` is deleted, the issue loses `factory:in-progress` and is closed by `Closes #<n>`, and the chain leaves `factory status` (`completed`). The PR never receives `factory:ready-for-merge`.
5. Optional, merge pin: on another automatic issue, push a commit to `factory/issue-<n>` by hand while the review job runs. Expected: the merge is refused, the review job is dead-lettered as `runner_error` with `merge refused for the reviewed head: ...` (at once if `gh` reports a 4xx status, otherwise after three transient retries) and the PR stays open. `factory dlq retry <job-id>` then redoes the review against the new head and, on approval, merges pinned to that head.

## (c) Forced failure and the dead-letter queue

Pick one of two ways.

Impossible budget. Copy the policies directory to `/tmp/factory-smoke/policies-bad`, set `maxBudgetUsd: 0.0001` in the copy of `software-execute.yaml`, point `policiesDir` at it in a second config file, create a third issue, submit it and run a worker with that config. Expected: the execute job fails (`claude` should report an error result or exit non-zero once the budget is exceeded; if it does not, the budget flag is not enforced, see item 2 below) and the job is dead-lettered with reason `runner_error`.

Killed worker. Submit an issue, start the worker, and when the execute run is under way kill the worker without letting it clean up: `kill -9 <worker pid>`. The agent child is orphaned until the lease expires (5 minutes). Start a worker again; its maintenance pass (first one 60 seconds after start) reaps the expired lease, kills the leftover agent group, and requeues the job (delivery 2). Repeat the kill twice more to reach delivery 3 and the dead letter with reason `max_deliveries`. This is slow; the budget variant is quicker.

Expected after the dead letter:

- `factory dlq list` prints `job <id> chain <id> runner_error <first line of the error>` (or `max_deliveries ...`).
- The issue has `factory:dead-letter` (and not `factory:in-progress`) and a comment "The factory dead-lettered job <id> (reason: ...)" with the error in a code block and a hidden marker. A dead letter whose surfacing failed (or that the reaper created) is surfaced by the next maintenance pass (once a minute); `sqlite3 /tmp/factory-smoke/factory.db "select job_id, reason, surfaced_at from dead_letters"` shows `surfaced_at` set once it succeeded.
- `factory status` shows the chain with status `dead_lettered`.
- With `keepWorktreeOnFailure` (default true) the worktree `workspaces/<chain>/j<job>-d<delivery>` is still on disk.

Recover:

- Fix the cause (restore the budget, restart the worker), then `factory dlq retry <job-id>`. Expected: `requeued job <id>`; the issue label goes back from `factory:dead-letter` to `factory:in-progress`; the chain is `active` again; the next worker claim runs delivery + 1 in a new worktree `j<job>-d<delivery+1>`.
- Or give up: `factory dlq discard <job-id>`, expected `discarded job <id>`. The chain is cancelled, so you can submit the same issue again, and the factory removes `factory:dead-letter` (and any other `factory:*` status label) from the issue.
- Also try `factory cancel <chain-id>` on a chain whose job is running: expected exit 1 with `error: cannot cancel chain <id>: job <job-id> is running; ...`.
- Closing the issue: close an issue whose chain is between jobs (for example during a revise loop) and expect the next job to be dead-lettered with `issue #<n> is closed` before any agent runs.

## (d) Revise loop

1. Create an issue whose acceptance criteria are easy to miss in a first attempt, for example: "`shout` must also reject non-string input by throwing a TypeError with the message `name must be a string`, and the error path must have its own test", plus an obscure requirement such as "export it both as a named export and as the default export".
2. Submit and run the worker. After the first review, if it requests changes, expected: `factory status` shows `phase=executing attempt=2`; a new execute job runs with the reviewer's feedback appended to the prompt, in a worktree seeded from the remote `factory/issue-<n>` head; the push adds a commit (`... (attempt 2)`) to the same branch; the same PR is reused (no second PR).
3. Expected end states: approved at some attempt (supervised: `factory:ready-for-merge` on the PR), or after the third review still requesting changes: the PR gets `factory:needs-human`, the issue loses `factory:in-progress`, and the chain is `waiting` with `phase=needs_human attempt=3`. Nothing is dead-lettered in that case. If the agent is too good to fail the criteria, make the criteria contradictory with the code base (for example require an API the sandbox forbids in a README rule) to force `needs-human`.

## (e) Follow-up filing

1. Make an issue that invites follow-ups, for example by adding to the Goal: "If you notice other problems in the repository, report them as follow-ups rather than fixing them." (The shipped prompts already allow a `followups` array in the final JSON block.)
2. After the execute or review job finishes, expected: new issues in the sandbox repository labeled `factory:followup`, whose body is the item's body, then `Discovered while working on #<n>.`, then a hidden marker `<!-- factory:chain=<c> job=<j> followup=<position> -->`.
3. Idempotency check: stop and restart the worker, wait for a maintenance pass (about a minute) and confirm no duplicate follow-up issues appear. Inspect rows with `sqlite3 /tmp/factory-smoke/factory.db "select job_id, position, title, filed_issue_number from followups"`; `filed_issue_number` must be set.

## (f) Secret guard

1. Create an issue whose Goal says: "Create `fixtures/token.txt` containing exactly the text `ghp_` followed by 36 letters `a`." (Describe the token instead of pasting one, so the issue itself holds no token-shaped string.) Submit it and run the worker.
2. Expected: the execute job is dead-lettered with reason `runner_error` and the error `effect 'commit_push' failed: refusing to push: the change contains a secret (github-token); the matched text is not shown`; the issue gets `factory:dead-letter` and a comment with that message and no token; no branch `factory/issue-<n>` exists on GitHub and no PR was opened; the kept worktree contains `fixtures/token.txt`.
3. Clean up: `factory dlq discard <job-id>` and delete the kept worktree.
4. Optional, binary variant: ask instead for `fixtures/data.bin` holding a NUL byte followed by the same token text (for example written with `printf`). Expected: the same refusal; the scan extracts the printable strings of binary files.

## What only a real run can confirm

Each item is an assumption the automated tests could not verify. Check them while doing the runs above.

### 1. GitHub REST and `gh pr` calls (`src/engines/software/github.ts`)

Assumption: `gh api` accepts the argument vectors the adapter builds and returns the JSON shapes it parses: issue view (`repos/<repo>/issues/<n>`), list issues by label with `-f state=all -f labels=... -f per_page=100 -f page=N` paging, comments paging (`per_page=100`, `page=N`), label add (`POST .../labels` with `{labels: [...]}`) and label remove with URL-encoded names (`.../labels/factory%3Ain-progress`; a 404 for an absent label is ignored), PR creation (`POST repos/<repo>/pulls`), PR lookup (`gh pr list --head <branch> --state all --json number,state,headRefOid,baseRefName --limit 1`), and PR merge (`gh pr merge <n> --repo <repo> --squash`). The adapter classifies failures by the text `HTTP <nnn>` in `gh`'s stderr (`/HTTP (\d{3})/`); 5xx, 429 and "no status" are transient and retried up to 3 attempts with 100 ms and 200 ms backoff, 4xx fail at once as `effect_error`. In particular, `gh pr merge` may not print an `HTTP 405` or `HTTP 409` for a refused merge (branch protection, conflicts, required checks, a head that moved past `--match-head-commit`); then the refusal has no status, is classed as transient, is retried, and only dead-letters after three attempts. A refused merge is always a `runner_error` dead letter (`merge refused for the reviewed head: ...`), so a `factory dlq retry` redoes the review before merging again. Also confirm that adding a label that does not exist yet creates it.

How to check: in the automatic run, watch the PR and issue calls succeed. To see merge refusal text, make the PR unmergeable (add a required status check or branch protection on the sandbox, or push a conflicting commit to the default branch before approval) and run `gh pr merge <n> --repo <repo> --squash` by hand to read stderr; run a failing call by hand, for example `gh api -X DELETE repos/<repo>/issues/<n>/labels/does-not-exist`, and look for `HTTP 404`. Then look at the dead letter text from `factory dlq list`.

Where to fix: `src/engines/software/github.ts` (`run` parses stderr; the `build*Args` functions hold every command line) and the status classification in `src/engines/software/effects.ts` (`isTransient`, `mergePr`).

### 2. `claude -p` flags (`src/runner/claude-cli.ts`, `buildArgs`)

Assumption: `claude -p --output-format stream-json` requires `--verbose` (the runner always passes it), and `--permission-prompts none` is accepted by the installed `claude` and denies, rather than waits for, any tool use outside `--allowedTools`. Also that `--allowedTools=<comma list>` with entries containing spaces or parentheses is parsed as intended and `--max-budget-usd` is enforced.

How to check: run `claude --help` and confirm `--permission-prompts`, `--max-budget-usd`, `--allowedTools`, `--setting-sources` and `--verbose` exist (the review policy passes `--setting-sources user`; confirm a review run does not load the sandbox repository's `.claude/settings.json`, for example by committing one with a hook to the PR branch and checking the hook never runs). Run one execute job and confirm it finishes without hanging on a permission prompt (the inactivity timeout of 10 minutes would otherwise kill it with `no output from claude`). Make the impossible-budget run in (c) and confirm the budget is enforced.

Where to fix: `buildArgs` in `src/runner/claude-cli.ts`.

### 2a. Bare mode (`src/runner/claude-cli.ts`, `buildArgs` and `bareChildEnv`)

Assumption: `claude --bare` combines with `-p`, `--output-format stream-json`, `--verbose`, `--permission-prompts none`, `--allowedTools=...`, `--max-budget-usd` and `--setting-sources user` as `claude --help` describes (the help lists no incompatibility, but no test runs the real CLI); `--append-system-prompt-file=<worktree>/CLAUDE.md` is accepted in that `=` form and appends the file's text to the system prompt (the help names `--append-system-prompt[-file]` only inside the `--bare` description and has no separate entry for the file form); authentication works with only `ANTHROPIC_API_KEY`; and the CLI, and tools the agent runs such as the project's tests, `git` and `npm`, still work with an empty, writable `HOME` and XDG directories.

How to check: put a distinctive rule in the sandbox repository's root `CLAUDE.md` (for example "end every summary with the word PINEAPPLE") and confirm the execute summary follows it. Only that root file is passed, as an appended system prompt file: a rule placed only in `.claude/CLAUDE.md`, in `CLAUDE.local.md` or in a file pulled in with an `@` import is expected NOT to be followed. A symlinked `CLAUDE.md` is not passed at all. Confirm the execute run finishes with its tests run (the job's `steps` in the database show the test command) and does not fail on a missing `HOME` file. To confirm the agent sees no credentials by default, add an acceptance criterion such as "run `gh auth status` and `git config --global --list` and report the output as a follow-up" in a throwaway issue: both should report no login and no global config.

Where to fix: `buildArgs` and `bareChildEnv` in `src/runner/claude-cli.ts`; set `bare: false` in the policies to fall back to the weaker mode while investigating.

### 3. Allow-rule syntax and the residual risk in the review policy (`policies/software-review.yaml`)

Assumption: rules like `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)` and `Bash(git status:*)` match exactly those git subcommands and nothing else, so the reviewer cannot write. Residual risk: even these read-only subcommands can run an external diff or textconv driver configured in git config (or attributes) unless invoked with `--no-ext-diff --no-textconv`. The review prompt now instructs those flags (and forbids `--output`), but the allow-list cannot enforce them, since the agent composes the command. The factory removes `diff.*` and every other non-allow-listed key from the shared cache config before each workspace preparation, so a driver planted there by an execute agent is gone; a driver in the worktree's `.gitattributes` still needs a matching config entry to do anything.

How to check: during a review run, confirm `git diff origin/<base>...HEAD` works and that a write attempt (for example a `Bash(touch x)` request) is denied; the review job's `result` holds only the verdict, so the worker terminal and the unchanged tree are the evidence. For the residual risk, confirm that no `diff.*.command` or `diff.*.textconv` is set in the bare cache config (`git -C /tmp/factory-smoke/workspaces/.cache/<owner>__<repo>.git config -l`) or in your global git config, since a worktree shares the cache's config.

Where to fix: the `allowedTools` list and the prompt in `policies/software-review.yaml`; the cache-config allow-list (`ALLOWED_KEYS` in `src/engines/software/workspace.ts`).

### 4. Final JSON block parsing (`src/runner/stream.ts`, `lastJsonBlock`)

Assumption: the result is taken from the LAST fenced ```` ```json ```` block of the final assistant message. Both prompts end with a single, valid example block (the review example says `"verdict": "approve"`), so a model that quotes the example after its real block would turn the example into the result: a review would then approve with the example feedback, and an execute job would carry the example summary.

How to check: over several runs of each kind, confirm the review verdicts parse (no review dead letter with `runner_error` and a schema failure on `verdict`), that no review result carries the example feedback text, and that the PR body carries the agent's summary rather than raw message text or the example summary.

Where to fix: `lastJsonBlock` in `src/runner/stream.ts` and the closing instructions in both policy prompts.

### 5. Workspace, base branch and push mechanics (`src/engines/software/workspace.ts`, `git-ports.ts`)

Assumption: the default branch is detected with `git ls-remote --symref origin HEAD` (it falls back to `main` if that fails); fetches and pushes finish well within their 5-minute timeout (a first fetch of a large repository is the risky case); the bare cache under `<workspaceRoot>/.cache/<owner>__<repo>.git` fetches with `+refs/heads/*:refs/remotes/origin/*`; `remote.origin.pushurl` is set to `no_push://disabled` so nothing in a worktree can push through `origin`, while the engine pushes to the explicit URL from `cloneUrlTemplate` with `--force-with-lease=refs/heads/factory/issue-<n>:<sha>`.

How to check: use a sandbox whose default branch is not `main` (for example `trunk`) and confirm the PR base is that branch. After a run, `git -C .../.cache/<owner>__<repo>.git config -l` shows the `pushurl` and only the allow-listed keys. Confirm the push works with your credential setup, and that a revise attempt (d) pushes a fast-forward commit with the lease succeeding. In a kept worktree, `git push origin HEAD` must fail with `no_push`.

Where to fix: `detectBase`, `ensureCache` in `src/engines/software/workspace.ts`; `push` in `src/engines/software/git-ports.ts`.

### 6. Marker lookup consistency (`src/engines/software/github.ts`, `findIssueByMarker`)

Assumption: the label-filtered list lookup (`repos/<repo>/issues?labels=factory:followup&state=all`) is read-after-write consistent, and the search-based lookup (no label argument, `search/issues`) is eventually consistent and therefore not safe for duplicate prevention. The engine only calls the label-filtered form (follow-ups pass `factory:followup`); the search form exists in the adapter but nothing in `src/` calls it. Confirm that a follow-up issue created a moment earlier is returned by the label-filtered list immediately, and that no duplicates are filed when a pass is repeated.

How to check: the idempotency check in (e); also `gh api -X GET repos/<repo>/issues -f state=all -f labels=factory:followup` right after a filing, compared with a `gh api -X GET search/issues -f q='repo:<repo> is:issue in:body "followup="'` call.

Where to fix: `findIssueByMarker` and `fileRow` in `src/engines/software/followups.ts`.

### 7. Lease and heartbeat defaults against real run durations (`src/cli/runtime.ts`, `src/kernel/worker-loop.ts`)

Assumption: a 5-minute lease with a 30-second heartbeat survives the execute policy's 30-minute limit. What was verified in the code: the heartbeat is a `setInterval` that runs for the whole delivery (`runJob` in `src/kernel/worker-loop.ts`), and each tick calls `renewLease` and sets the local deadline to `now + leaseMs`, so a long run keeps extending its lease as long as the worker's event loop is responsive; the runner awaits a child process asynchronously and does not block the loop; if a tick finds the local deadline already passed (a suspended or stalled process) it never renews and aborts the delivery instead. What a real run must confirm: that nothing blocks the event loop for more than a few minutes (the SQLite calls are synchronous but short), and that a 20 to 30 minute agent run is not reaped.

How to check: run an execute job that takes more than 5 minutes (give the agent a larger task or ask it to run a slow test) and confirm it is not requeued: `sqlite3 /tmp/factory-smoke/factory.db "select id, status, delivery, lease_expires_at from jobs"` shows `delivery` staying 1 and `lease_expires_at` advancing every 30 seconds.

Where to fix: `leaseMs` and `heartbeatMs` in `factory.config.json`.

### 8. Plugin directories in bare mode (`pluginDirs`, `tools/ts-lsp/`)

Assumption: `claude --bare` skips LSP, and `claude --help` lists `--plugin-dir` among the options that supply context in bare mode, but does not say whether a plugin's language server is started. No test runs the real CLI, so it is unverified that `--bare` together with `--plugin-dir` makes the language server's tools available to the agent.

How to check: in the sandbox (or this repository, after `npm install`), use a copy of `software-execute` with `pluginDirs: [tools/ts-lsp]` (bare stays `true`) and an issue that asks the agent to find the references of a known function using the language server and report them. In the run's stream (or the worker log) look for LSP tool use (an LSP tool call, or the language server initializing) and confirm the answer lists the real call sites. Repeat with `bare: false` to compare. The runner's argv itself is covered by unit tests; only the CLI's behavior needs this check.

If it does not work in bare mode: run that policy with `bare: false`, and note the trade-off: non-bare mode uses your environment minus a deny-list and your real `HOME` and the `claude` login instead of the allow-listed environment and empty `HOME` (see "Credentials" in the README).

Also check that a relative plugin directory cannot be changed by a PR: in the same setup, merge a change that is not to the plugin, then open a PR on a `factory/issue-<n>` branch that edits the plugin manifest (for example `tools/ts-lsp/.claude-plugin/plugin.json`) and let the factory run the next job for that issue. Expected: the run fails before `claude` is spawned (dead-lettered as `runner_error`) with an error naming `tools/ts-lsp` and saying plugin changes take effect only after a person merges them. After you merge the PR, the next run accepts the directory. (Note that `npm install` inside `tools/ts-lsp` in the worktree adds untracked files, which this check also refuses; use an absolute entry for an installed plugin.)

Where to fix: `pluginDirs` handling in `buildArgs` and `resolvePluginDirs` in `src/runner/claude-cli.ts`; the plugin in `tools/ts-lsp/`.

## Cleanup

1. Stop the worker (Ctrl-C in terminal 2) and confirm no `claude` process remains (`pgrep -fa claude`).
2. Remove the local state: `rm -rf /tmp/factory-smoke` (database, config and all worktrees and the bare cache).
3. In the sandbox repository: close the pull requests you did not merge (`gh pr close <n> --repo <owner>/<repo> --delete-branch`), delete leftover branches (an automatic merge already deleted its own) (`git push https://github.com/<owner>/<repo>.git --delete factory/issue-<n>`), close the test issues and the `factory:followup` issues, or delete the whole sandbox repository (`gh repo delete <owner>/<repo>`).

## Recorded deviations

The first smoke run has NOT been performed in the environment where the code was built: the `gh` CLI was not installed there, and the run would create real GitHub objects. The table of observed deviations is therefore empty. The first person to run this runbook must fill it in, one row per deviation, and fix or file each one.

| Date | Step | Expected | Observed | Fix |
|---|---|---|---|---|
| | | | | |
