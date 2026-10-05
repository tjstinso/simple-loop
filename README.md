# Software factory

The software factory turns a GitHub issue into a reviewed pull request. A worker picks up the issue, runs the `claude` CLI in a private git worktree to implement it, pushes a branch, opens a pull request, runs a second `claude` pass as reviewer, and repeats until the reviewer approves or three attempts are used. Depending on the autonomy profile, a human then merges the pull request or GitHub merges it by itself once the repository's required checks pass (the factory only enables auto-merge). All state lives in one SQLite file; GitHub is the source of truth for issues, branches, pull requests and labels.

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
EXECUTE  claude edits and commits in a private worktree ──> engine validates, verifies, pushes factory/issue-<n>, opens PR ("Closes #<n>")
   v
REVIEW   claude reviews the PR branch (read-only tools)
   |
   +-- approve ------------> supervised: PR labeled factory:ready-for-merge, a human merges
   |                         automatic:  the factory enables GitHub auto-merge (squash); GitHub merges when the required checks pass
   +-- request_changes ----> attempt < 3: new EXECUTE job with the feedback, same branch
   |                         attempt = 3: PR labeled factory:needs-human
   +-- machinery failure --> dead-letter queue; issue labeled factory:dead-letter

waiting (awaiting_merge / needs_human), checked by every worker's maintenance pass (60 s):
   +-- PR merged ----------> chain completed, factory labels removed, one comment on the issue
   +-- PR closed unmerged -> chain cancelled, factory labels removed, one comment on the issue
   +-- PR still open ------> nothing, or a revision when a person left feedback (see below)
```

**Reconciling waiting chains.** A chain waiting on a person (`awaiting_merge` or `needs_human`) finishes by itself when the pull request is settled. Every maintenance pass (every 60 seconds in every worker, so the latency is up to a minute plus the time of the pass) looks up the pull request of each `waiting` chain once, by its branch `factory/issue-<n>`. A merged pull request completes the chain (phase `merged`); one closed without merging cancels it, which frees the issue for a new `submit`. Either way the factory removes `factory:ready-for-merge`, `factory:needs-human`, `factory:in-progress` and `factory:dead-letter` from the issue and posts one comment (`Pull request #<n> was merged` or `Pull request #<n> was closed without merging; this chain was cancelled`, hidden marker so it is never posted twice). An open pull request, a missing one and a transient GitHub failure (no HTTP status, 429, 5xx) leave the chain as it is; the next pass retries. A failure to label or comment is printed as an error and does not undo the transition. The change only applies to a chain that is still `waiting`, so a concurrent `factory cancel` or a second worker never conflicts. `dead_lettered` and `active` chains are not reconciled. `factory cancel` keeps working for manual use.

**Is the factory looking?** Every maintenance pass records what it found for each `waiting` chain in two nullable columns of the `chains` table (not in `events`, which is a log of lifecycle changes and would grow by 1,440 rows per chain per day): `last_checked_at` (epoch milliseconds) and `last_check_result` (a short text, at most 200 characters, redacted like event details). The result is `none` (looked, nothing to do), `unknown` (GitHub had not computed mergeability yet), `error: <message>` (the lookup threw, or GitHub failed transiently), or the outcome name when the pass acted: `completed`, `cancelled`, `update` or `new_work`. The write is one small `UPDATE` that leaves `status` and `updated_at` alone, is skipped when somebody else moved the chain meanwhile, and when it fails the error goes to the worker's error output and the other chains are still checked. Old databases get the columns when the factory next opens them, with null values. Read them with `factory show <chain>` (`last checked: 20s ago (none)`, or `never checked`), on the chain's line in `factory status`, and in the dashboard, which shows `checked 20s ago (none)` and marks a waiting chain that has not been checked for more than three maintenance intervals (3 minutes) with `⚠ not checked recently`: no worker is running maintenance, so nobody is watching that pull request. Only `waiting` chains are recorded, and only the latest check is kept.

**Revising for a person's feedback.** While a chain is `waiting` with an open pull request, the same maintenance pass also reads what people said on it (reviews, inline review comments and conversation comments) and starts a revision when there is something new. The latency is therefore the same 60-second maintenance interval, plus the time of the pass. Feedback counts when it is newer than `feedbackHandledAt` (kept in the chain state, initially the time the pull request was opened), written by an author whose `authorAssociation` is in `allowedAuthorAssociations` (default `OWNER`, `MEMBER`, `COLLABORATOR`), not a factory comment (any comment with the hidden marker `<!-- factory:`) and not an empty approval: a review that requests changes, a review comment with text, any inline comment and any conversation comment start a round, an approval alone does not (the person merges). Feedback from other authors is ignored and never sent to the agent. The feedback becomes the next `execute` job's `payload.feedback`, listed oldest first with each item's author, the file and line of inline comments with their diff hunk, and the text, capped at 20,000 characters (the oldest are kept and the text says when it was truncated); like all pull request text it is untrusted data in the agent's prompt, not instructions. One transaction, conditional on the chain still being `waiting`, creates the job, sets the chain `active` and stores the new state (phase `executing`, `humanActive` set, `feedbackHandledAt` set to the newest item), so two workers never start the same round twice. While the round is worked the issue carries `factory:in-progress` and the pull request loses `factory:ready-for-merge`. The workspace is seeded from the current branch head, so commits a person pushed to the branch are built upon and never overwritten; if the branch moves while the agent works the push is rejected as before (`runner_error`, "remote branch moved by someone else") and a retry starts from the new head. After the factory's own review approves the revision the chain returns to `awaiting_merge`, `factory:ready-for-merge` is restored and the factory posts one comment with the new commit and the counts of the answers (hidden marker with the round number). If the agent changes nothing, the answers are posted as described below (or, without any response, one comment says so with the agent's redacted summary), the review is skipped and the chain goes back to `awaiting_merge`; the same feedback is not retried. A person's feedback is never a failure and the number of rounds is not limited; only the factory's own failed rounds count (see "Circuit breakers and asks"). **Answering each comment.** The feedback text lists every item with a stable id in parentheses (`comment <id>` for an inline or conversation comment, `review <id>` for a review body with text) and the execute prompt asks the agent to return one entry per id in `feedbackResponses`: `{ "id": "comment 12", "action": "changed" | "explained" | "declined", "reply": "..." }` (reply 1 to 2,000 characters). `changed` means the agent modified code (the reply says what and where), `explained` means no change is needed because the comment asks a question or wants an explanation (the reply is the explanation), `declined` means the agent will not make the change (the reply says why). The feedback and the replies are untrusted data: replies go through the secret redaction, `@` mentions and closing keywords are neutralized, and the prompt tells the agent never to put a secret in one. After the revision is pushed (or, for a round without a code change, once the agent's run succeeds) the engine validates the responses against the round, as the factory identity: responses for ids that are not in the round are dropped, a repeated id keeps the first, and a malformed `feedbackResponses` is treated as no responses and never fails the run. It then posts one reply per response: a threaded reply (`POST .../pulls/{n}/comments/{id}/replies`) for an inline comment, and for a conversation comment or a review body one conversation comment that quotes the first line of the original. A `changed` reply ends with the short sha of the commit that was pushed. Every reply carries a hidden marker with the original id (`<!-- factory:reply comment=<id> -->`, `review=<id>` for a review), so a retry or a second maintenance pass never posts it twice. For `changed` and `explained` replies to an inline comment the engine then resolves the comment's review thread through GraphQL (`reviewThreads`, paged, matched by the comment; `resolveReviewThread`; an already resolved thread is left alone). **A `declined` thread is left open on purpose: the person decides whether the explanation is enough.** Conversation comments and review bodies have no thread and are only replied to. An item the agent gave no response for gets no reply, stays unresolved and is named in one comment per round ("no answer was produced for: ..."), so nothing is skipped silently. A round in which the agent changed nothing is answered the same way (a question gets its explanation and a resolved thread, no code change, no review) and the chain returns to `awaiting_merge`; the round summary comment, still posted once per round, is shortened to the commit link and the counts (`N changed, M explained, K declined`). A reply or a resolution that fails is reported through the engine's `onError` and a `feedback.reply_failed` event, never fails the run and never undoes the push; what is left is kept in the chain state and retried on the next maintenance pass (items with no reply marker yet get their reply, replied ones only the missing resolution). Transient GraphQL errors (no status, 429, 5xx) are retried with the same classification as other GitHub calls. `factory show` lists `feedback.replied` (id, action) and `feedback.resolved` (thread). The planner also stops feeding resolved threads back to the agent: an inline comment in a resolved thread is ignored unless a person added it after the factory's latest reply in that thread (`listPrFeedback` returns each inline comment's thread id and resolved flag; GitHub does not report when a thread was resolved, so a thread a person resolved without a factory reply stays ignored). Replies are only posted for comments of allowed authors that started a round; the factory never resolves or dismisses a person's whole review, requests a new review, or reopens a thread a person resolved. Webhooks are not used, and feedback on pull requests that are not the factory's own is not read.

**Resolving merge conflicts.** Every agent branches from the base branch as it is when its job starts, so with several chains open the first pull request to merge can make the others conflict. The same maintenance pass (so the latency is the 60-second interval, plus the pass) reads GitHub's `mergeable` state of a `waiting` chain's open pull request (`mergeable`, `conflicting`, or `unknown` while GitHub is still computing it). A pull request that is only *behind* the base branch but still `mergeable` is left alone: the repository does not require up-to-date branches, so it can merge as it is. When it is `conflicting` the engine starts a conflict round, before any pending human feedback (which is handled afterwards, in sequence): a new `execute` job (phase `executing`, `conflictActive` set). Before the agent starts, the workspace merges `origin/<base branch>` into the pull request branch (a merge, not a rebase, so people's commits are kept and the push stays a fast-forward) and the agent gets the base branch and the conflicting paths (at most 50) as its task: resolve every conflict keeping the intent of both sides, leave no conflict markers, do not reformat unrelated code. The agent only edits files; the engine completes the merge commit, with the factory identity, through the usual secret scan and push. If a conflict marker line (`<<<<<<< `, `=======`, `>>>>>>> `) remains in a conflicted file the push is refused as a `runner_error` naming the files. A conflict in a binary file, a file deleted on one side and modified on the other, or in more than 50 paths is not given to the agent: the factory raises an ask (phase `needs_input`, the issue gets `factory:needs-human`, one comment explains it) and resumes when a person answers or pushes. If nothing conflicts any more when the round starts (the base was reverted, or a person resolved it), no agent runs and the chain goes back to `awaiting_merge`. The resolution goes through the factory's own review like any revision; after approval `factory:ready-for-merge` is restored and one comment ("Resolved conflicts with `<base>` in <short sha>", hidden marker with the round number) is posted, and CI runs again because of the push. If a person pushes while the round runs, the push is rejected ("remote branch moved by someone else") and a retry starts from the new head. `unknown` leaves the chain as it is and is looked at again on the next pass, at most 5 passes in a row, after which the engine logs `conflict.gave_up` once and moves on. Conflict rounds are not limited in number: a base branch that keeps moving is not a failure. Only failed rounds count, through the `conflict` circuit breaker. `factory show` lists `conflict.detected` (base branch, round, number of conflicting paths), `conflict.resolved` (short sha) and `conflict.gave_up` (reason). Pull requests the factory did not open are not looked at, and the factory never rebases or force-pushes.

**Setup and verification per repository.** A fresh workspace has no dependencies, so the optional `repos` object of the configuration says what a repository needs, keyed by `owner/name`: `setup` (commands run in the workspace before the agent starts, after the base merge of a conflict or feedback round; also for the review job's workspace), `verify` (commands the engine runs after the agent finished and before `commit_push` pushes), `setupTimeoutMs` (default 300000), `verifyTimeoutMs` (default 600000) and `maxVerifyRounds` (default 3, minimum 1) and `verifyBaseline` (default `true`, see below). A command is an argument array, never a shell string; unknown keys, empty commands and empty arguments are configuration errors. A repository without an entry behaves as before. Example for this repository:

```json
{
  "repos": {
    "tjstinso/simple-loop": {
      "setup": [["npm", "ci", "--ignore-scripts"]],
      "verify": [["npx", "tsc", "--noEmit"], ["npm", "run", "build"], ["npm", "test"]]
    }
  }
}
```

If `verify` fails, nothing is pushed: the engine starts another agent run in the same workspace and attempt whose feedback names the failing command, its exit code and the last 200 lines of its output (redacted, at most 20,000 characters, labelled untrusted, with the instruction to fix the cause without weakening or deleting tests), then verifies again. At most `maxVerifyRounds` such rounds run per execute attempt. The count is of reruns, so the default 3 means up to 4 agent executions and 4 verifications; the verify feedback is appended to the feedback the attempt already had (human feedback, a CI failure or a conflict instruction). The number of reruns is stored as `verifyRounds` in the job's result; if the last one still fails the attempt fails as `runner_error` naming the command, so the usual retry rules apply, and the failure is never pushed. A failing `setup` is a `runner_error` that names the command; its output is not given to the agent. Events: `workspace.setup` (command names, duration), `verify.started`, `verify.passed` and `verify.failed` (command, exit code, round); the cost of the verify rounds is added to the job's `costUsd` and their time is stored as `verifyDurationMs` in its result. The verification output is never written to GitHub. The repository should ignore `node_modules` (the push stages the whole workspace and scans it).

**The agent commits, the engine validates and pushes.** "Done" means "committed": the execute prompt tells the agent to commit its finished work with `git add` and `git commit` (a subject of at most 72 characters in the imperative and, when not obvious, a body saying what changed and why; several logical commits are fine; no amend, rebase, reset, branch, tag, remote or config changes; no push). The workspace's local git configuration carries the factory identity (`github.commitName` and `github.commitEmail`, default `factory <factory@localhost>`), so a plain `git commit` is attributed correctly. After a successful agent run the engine runs a validation round before anything is pushed, in this order: (1) **state checks** on the workspace: HEAD is on the expected local branch (not detached, not another branch), the seed commit is an ancestor of HEAD (history was not rewritten), there is no merge commit outside a conflict round, at most 50 commits since the seed, no gitlink (submodule) entry added or changed, and the author and committer email of every commit equals the factory identity. A violation fails the delivery as `runner_error` naming the check and the commit (`commit validation failed (<check>) at <sha>: ...`), is not retried within the attempt, records `commit.rejected` (check, short reason) and pushes nothing. (2) **Uncommitted changes**: a dirty tree (tracked changes, or untracked files that are not ignored) is committed by the engine as `factory: <title> (attempt n)` and recorded as `commit.fallback` (number of files), so forgotten work is never lost; the state checks run again on the result. If the agent made no commit and the tree is clean the existing "no change" outcome applies (also for human feedback and CI rounds). (3) **Verification** of the repository's `verify` commands (see above) on the clean checkout of exactly that commit; a verification that leaves tracked files modified (a generated file the run rewrote) fails as `verify_dirty` and the feedback names the files, so they get committed or the generator fixed. (4) **Pinned push**: `commit_push` runs the secret scan over `seed..HEAD` (paths, added lines, binary strings, commit headers and messages) and pushes the verified sha, and only when HEAD is still that sha. A failure in (3) starts a fix round in the same attempt, as described for `verify`: the agent receives the feedback, makes new commits on top (never an amend) and the whole validation runs again, up to `maxVerifyRounds` rounds; after the last one the attempt fails as `runner_error` and nothing is pushed. A secret found by the scan fails the attempt (`runner_error`): the agent cannot remove it from commits it must not amend. Conflict rounds are the exception to the contract: the agent only edits files and must not commit (the prompt and the conflict feedback say so); the engine completes the merge commit, and an agent commit during a conflict round is refused (`conflict_commit`). The engine never rewrites or squashes the agent's commits (GitHub's squash merge collapses them, keeping their messages in the squashed commit body), never signs them and never gives the agent a credential. The pull request body lists the commits (short sha and subject, at most 20, redacted) under "Commits"; the title stays the issue title. Events: `commit.validated` (commit count, head sha), `commit.rejected`, `commit.fallback` and the `verify.*` events.

**Priming a workspace.** Everything deterministic happens before the agent starts, so its tokens go to judgment.

- *Dependency cache.* When a repository's `setup` is the standard install (a single `npm ci`, flags allowed), the engine keys the installed `node_modules` by the SHA-256 of `package-lock.json` plus the Node major version and keeps it in `<workspaceRoot>/.cache/deps/<key>/`, outside every worktree and outside the agent's writable area. A workspace whose key is cached gets `node_modules` by a copy-on-write copy (`cp -a --reflink=auto`, never a hard link or a symlink, so a change an agent or a test makes in `node_modules` cannot reach the cache) instead of running the install; a missing key runs `setup` and then stores the result. The cache is written only right after the engine's own `setup`, from a workspace it prepared before the agent started, never from a tree the agent touched. The maintenance sweep removes entries not used for 30 days and all but the 5 most recently used. A corrupt entry (no `.package-lock.json`, a failed copy) is deleted and the normal install runs. Other setups and other package managers get no cache.
- *Baseline verification.* For an execute job of a repository with `verify`, after setup and before the agent starts, the engine runs every `verify` command once on the unmodified tree (same environment rules as the verification before the push) and records `pass` or `fail` with the last 50 lines of output (redacted) for each command. `verifyBaseline: false` turns this off; the default is `true`. A failing baseline never starts the agent: the delivery is retried like a transient infrastructure failure (the existing backoff and `maxTransientRetries`; when they run out the job dead-letters as `runner_error` with `baseline_failing` and the command), it does not count as a failure of the agent's work, and one marker-guarded comment on the pull request (the issue for a first attempt) says the base branch or environment is red and names the command. The output is not posted. A passing baseline is kept in the run input (`baseline`); when a command later fails the verification, its feedback says whether the command was green on the baseline, that is, a regression caused by the change. A conflict round skips the baseline (the tree holds conflict markers). The gate before the push is unchanged.
- *Prompt.* For a repository with `verify`, the execute prompt also says that the dependencies are installed, to run only targeted tests while working (the single test file for the code being changed), not to run the full type-check, build or test suite because the factory runs them after the agent finishes and returns failures, and to finish as soon as the change is complete. A repository without `verify` gets none of this.
- *Events.* `workspace.primed` records the cache result (`hit`, `miss`, `corrupt` or `none`), the key prefix, the setup duration and the baseline result and duration, so the time cost of priming shows in `factory show` and the dashboard; compare the job's recorded `costUsd` before and after to see the effect on tokens.

Limits: this is not a sandbox. The workspace is the engine's own checkout and setup and verify commands run with the worker's privileges (only the environment is restricted). The cache is trusted only because it is written from a tree the engine prepared before the agent started; anyone who can write to `<workspaceRoot>/.cache/deps` can plant code that later workspaces run, so keep that directory private to the worker. The cache is per host.

Commands run without a shell, in their own process group (killed on timeout and when the delivery is aborted), with the last 1 MB of output kept for the failure text. Their environment is an allow-list: `PATH`, `LANG`, `TERM`, `TZ`, `TMPDIR`, the proxy and certificate variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`), `CI=true` and a `HOME` (and `XDG_*`) pointing at an empty per-run directory. Never any `GH_*`, `GITHUB_*`, `GIT_*`, `SSH_*`, `ANTHROPIC_*`, the `github.tokenEnv` variable or other secrets. **This is not a sandbox**: an installed package or a test still runs as the operator's user, with network access and able to read any file that user can; only the secrets are kept out of its environment. Use `--ignore-scripts` where the project allows it.

**Fixing failing checks.** The same maintenance pass (latency: the 60-second interval, plus the pass) reads the CI checks of a `waiting` chain's open pull request when the chain is `awaiting_merge` and the pull request head is the commit the chain last pushed (`lastPushedSha` in the chain state; a commit a person pushed is not looked at). It asks GitHub for the check runs and legacy statuses of exactly that sha (never an older commit), all pages. The state is `failing` when any completed check concluded `failure`, `timed_out`, `cancelled` or `action_required`, `pending` when any check is not completed, `passing` when all completed with `success`, `neutral` or `skipped`, and `none` without checks. Only `failing` does anything: the engine starts a CI round, after the conflict check and before the feedback check (conflict first, then CI, then human feedback; each later one is looked at on a later pass): a new `execute` job (phase `executing`, `ciActive` set) whose feedback names each failing check (name, conclusion, details url) and, for up to 3 failing checks, the last 200 lines of the failing log (`gh run view <id> --log-failed`), redacted like other agent-bound text and capped at 20,000 characters in total (the text says when it was truncated). The text says it is untrusted CI output and tells the agent to make the failing tests and build pass, not to weaken or delete tests, and to run the full test suite. A failure that is gone when the pass looks (a re-run passed), or a transient GitHub error, starts nothing; the next pass looks again. After the revision is pushed the usual path applies: the factory's review, `awaiting_merge` again, `factory:ready-for-merge` restored, CI on the new head, and one comment ("Fixed failing checks in <short sha>", hidden marker with the round number). Under the `automatic` profile the auto-merge already enabled on the pull request merges it when CI passes. Only CI rounds that fail count, through the `ci` circuit breaker: a round fails when the pushed head still fails its checks. A flaky test looks like a failure and uses a round. `factory show` lists `ci.failed` (check names, round), `ci.fixed` (short sha, round) and `ci.gave_up` (reason; legacy). Merging stays enforced by the repository's branch protection (required checks), not by factory code: the factory never blocks or performs a merge because of a check, it only reacts to a failure.

**Circuit breakers and asks.** The factory does not give up after a fixed number of rounds per chain: a base branch that moves ten times or a person who asks for ten changes is not a failure. Every failure class (`conflict`, `ci`, `human`, `review`) has a circuit breaker (`src/engines/software/breaker.ts`, pure functions `onSuccess`, `onFailure`, `canAttempt`) kept in the chain state as `breakers: { conflict?, ci?, human?, review? }`, each `{ consecutiveFailures, opens, openUntil? }`. *Closed*: attempts are allowed. After `failureThreshold` consecutive failures (default 3) the breaker *opens*: the chain keeps waiting, posts nothing and starts no round of that class until `openUntil`. After the cool-down (`cooldownMs`, default 10 minutes, doubled on every re-open, capped at 2 hours) the breaker is *half-open* and exactly one trial round runs: a success closes it and resets everything, a failure re-opens it with the doubled cool-down. After `maxOpens` opens (default 3) the breaker raises an ask. Configure them with the `breakers` object (`failureThreshold`, `cooldownMs`, `maxOpens` per class). `maxConflictRounds`, `maxCiRounds` and `maxHumanRounds` are deprecated for one release: they act as `failureThreshold` of their class, and a warning at startup names the replacement; an explicit `breakers` value wins.

*What counts as a failure:* a round whose job ended in `runner_error` (including an agent result with status `error`, an invalid result such as a malformed `ask`, a push refused for leftover conflict markers, a stale remote head or a secret, a refused commit), a round the factory's reviewer rejects (`request_changes`; the agent is retried at once until the breaker opens, then the rejected round waits as a pending fix and one trial runs after the cool-down), and a CI round whose pushed head still fails its checks. A round that fails this way does not dead-letter the chain: the failure is counted (`round.failed`) and the chain goes back to waiting. *What does not count:* a successful round (the reviewer approved it, and for CI the checks of the pushed head pass: it resets the class to closed), a new conflict created by another change merging (a new base head is a new problem and starts a round without counting), an infrastructure error classified as transient (retried separately by the kernel), a `timeout`, and anything a person caused. A person's feedback rounds are never failures; only the factory's own failed rounds in them count towards the `human` breaker. The first attempt of a chain and review jobs keep their dead-letter behavior.

*Asks.* When automation cannot go on the factory raises an ask instead of giving up silently: one marker-guarded comment on the pull request (`<!-- factory:chain=<id> event=ask id=<ask id> -->`, on the issue when there is no pull request yet) that states the question, what was tried (the failure classes and their counts) and the expected answer, the label `factory:needs-human` on the issue, the phase `needs_input` and no automatic rounds. An ask is raised when a breaker opened `maxOpens` times, when the chain's recorded cost exceeds `chainBudgetUsd` (default 25, minimum 1; the cost counts from the last answer) and when the agent asks. A comment, review or push by an allowed author after the ask resumes the chain automatically as a human feedback round whose feedback contains the question and the answer; every breaker is reset, `factory:needs-human` is removed and `ask.answered` is recorded. (An ask raised before a pull request exists is only answered once the first push has created one; see the follow-ups.) The agent asks through the optional `ask: { question, options? }` in its result (question 1 to 1,000 characters, at most 5 options of at most 200 characters); the execute prompt tells it to use it only when it cannot continue without a decision that is not in the issue, the feedback or the code, and never for something it can find out itself. A run that returns an `ask` is a successful run: nothing is pushed, the engine raises the ask and no breaker is touched. The dashboard's `waitingOn` shows `cool-down (<class>, until <time>)` while a breaker is open and `an answer to a question` while an ask is open; `factory show` lists `breaker.opened`, `breaker.half_open`, `breaker.closed`, `ask.raised` and `ask.answered`.

**Automatic profile and CI.** The factory has no CI gate of its own: GitHub enforces it. On approval the `automatic` profile runs `gh pr merge <n> --squash --auto --delete-branch --match-head-commit <reviewed sha>`, records the event `merge.enabled` and posts one comment on the pull request, and the chain goes to `waiting` with phase `awaiting_merge`, exactly as in the supervised profile. GitHub merges the pull request when the required checks of the branch protection pass, and the reconcile hook then completes the chain (a pull request closed without merging cancels it). A pull request whose required checks fail simply never merges and the chain stays `waiting`; revising automatically after a CI failure is a separate, later change. If GitHub refuses to enable auto-merge (the repository setting is off, the branch protection forbids it, or the head moved after the review), the factory hands over like the supervised profile: it labels the issue `factory:needs-human`, posts one comment on the pull request saying why a person has to merge, records `merge.needs_human` and leaves the chain `waiting` with phase `needs_human`. It never dead-letters for that reason and never merges without the check protection.

**GitHub settings the factory expects.** In the repository's settings, an operator enables "Allow auto-merge" and protects `main` with a branch protection rule that requires the status checks `check (node 22)` and `check (node 24)` (the jobs of `.github/workflows/ci.yml`), also for administrators. Without both, the `automatic` profile cannot merge by itself: auto-merge is refused and the chain waits for a person. The factory does not configure either setting.

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

### Running as its own GitHub identity

By default the factory acts as you: `gh` uses your login and git your credentials, so every pull request is authored by you, and GitHub does not let an author approve their own pull request. Requiring one approving review on `main` would then block every factory pull request. Giving the factory its own identity (a bot account, a machine user, or a GitHub App installation token) fixes that: your approval counts, and a person's review of a factory pull request becomes a real gate.

Operator setup:

1. Create the bot account (or a GitHub App) in GitHub. The factory does not do this.
2. Grant it write access to the repositories you submit, and nothing else.
3. Create a token for it with only the scopes the factory needs: repository **Contents** (read and write: fetch and push `factory/issue-<n>` branches), **Pull requests** (read and write: open, read reviews and comments, enable auto-merge), **Issues** (read and write: read issues, labels, comments, follow-up issues). A fine-grained token limited to those repositories is best; for a classic token that is the `repo` scope. Add **Metadata** (read), which GitHub grants by default.
4. Set the token in the worker's environment, for example `FACTORY_GH_TOKEN`.
5. Configure the worker:

```json
{
  "github": {
    "tokenEnv": "FACTORY_GH_TOKEN",
    "expectLogin": "my-factory-bot",
    "commitName": "My Factory Bot",
    "commitEmail": "my-factory-bot@users.noreply.github.com"
  },
  "cloneUrlTemplate": "https://github.com/{repo}.git"
}
```

What the factory then does:

- Every `gh` call runs with `GH_TOKEN` set to the token, `GH_HOST=github.com` and `GH_CONFIG_DIR` pointing at an empty per-worker directory, so your own `gh` login is never used.
- Every git command that talks to the remote (clone, fetch, ls-remote, push) uses the HTTPS URL from `cloneUrlTemplate` and a `GIT_ASKPASS` helper script that prints the token from the git process's environment. The credential helper list is reset for those commands, so your helper is not asked first. The token is never written to disk, passed in an argument list, put in a remote URL or `.git/config`, logged or stored in an event. (The helper script, in a per-worker directory under the temp directory, contains no token.)
- Commits are authored and committed as `commitName <commitEmail>` (the factory's default is `factory <factory@localhost>`). The hardened git environment of the secret scan is unchanged.
- At worker start the token's login (`gh api user`) must equal `expectLogin` (case-insensitive), otherwise the worker refuses to start and the error names both logins. A missing or empty `tokenEnv` variable is a startup error that names the variable and never its value.
- Only commands that call GitHub need the token: `worker` and `submit` read it (and fail before doing any work without it), and `dlq retry`, `dlq discard` and `cancel` need it when the engine hook they run calls GitHub (the label changes after a retry or cancel). `status`, `show`, `events`, `workers`, `dlq list`, `policies` and `--help` never read the variable, create no directory and never call GitHub, so they work in a shell without the token.
- The per-process temporary directory (`factory-github-*` under the temp directory) is created only when a command first needs the token, and removed when the process exits normally, on SIGINT and SIGTERM, and when the worker shuts down. A crash (for example SIGKILL) may leave it behind; it holds no secret (an empty `gh` config directory and the askpass script, which contains no token), so it is safe to delete.
- The agent never sees the token: the claude-cli runner removes the `tokenEnv` variable, `GH_TOKEN`, `GITHUB_TOKEN` and `GIT_ASKPASS` from the agent's environment in bare and non-bare mode, even if a policy lists them in `passEnv`. The token's value is also registered with the secret guard, so it is redacted from pull request bodies, comments, follow-ups and events, and a push containing it is refused.

With a distinct identity, `main` can require one approving review (administrators included) and your approval counts. Auto-merge, which the automatic profile enables, then waits for that approval as well as the checks; the chain stays `waiting` and completes through the existing reconcile step once GitHub merges the pull request.

The identity must have the minimum rights: write access only to the repositories you submit, no administration, no organization-wide scopes. A token is a secret: keep it only in the worker's environment (or your secret manager), never in `factory.config.json` or a repository, and rotate it if it may have leaked. Rotation, GitHub App JWT exchange and installation-token refresh are not handled: a long-lived token is used as is. Posting the factory reviewer's verdict as a pull request review under the bot identity is not done yet.

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
| `policiesDir` | `./policies` next to the config file, used only if that directory exists | Directory scanned for `*.yaml` policy files, applied on top of the shipped policies. Required (it must be set explicitly or `./policies` must exist) when `shippedPolicies` is `false`. |
| `shippedPolicies` | `true` | Load the policies that ship with the package (found from the installed package location, not the current directory) before `policiesDir`. |
| `policyOverrides` | `{}` (no overrides) | Object keyed by policy name; see "Overriding policy settings". |
| `workspaceRoot` | `./.factory/workspaces` | Root for the bare repository cache (`.cache/`) and the per-delivery worktrees (`<chainId>/j<jobId>-d<delivery>`). |
| `defaultEngine` | `software` | Engine used when a submission names none. |
| `defaultProfile` | `supervised` | `supervised` or `automatic`; used when the issue has no `factory:profile:automatic` label. |
| `requiredSections` | `["## Goal", "## Acceptance criteria"]` | Lines that must appear in the issue body. |
| `historyRetentionDays` | `30` | Positive number. Age after which exited child-process rows, resolved dead letters and filed follow-up rows are pruned. |
| `keepWorktreeOnFailure` | `true` | Keep the worktree of a dead-lettered job for debugging. |
| `allowedAuthorAssociations` | `["OWNER", "MEMBER", "COLLABORATOR"]` | Pull request feedback counts only from authors with one of these GitHub `authorAssociation` values. |
| `maxHumanRounds` | none | **Deprecated** alias for `breakers.human.failureThreshold` (a warning at startup names the replacement); removed after one release. |
| `maxConflictRounds` | none | **Deprecated** alias for `breakers.conflict.failureThreshold`. It no longer limits the rounds of a chain: only consecutive failures count (see "Circuit breakers and asks"). |
| `breakers` | defaults below | Object with `conflict`, `ci`, `human` and `review`, each with optional `failureThreshold` (default 3), `cooldownMs` (default 600000, 10 minutes) and `maxOpens` (default 3). |
| `chainBudgetUsd` | `25` | Number, at least 1. Recorded cost (USD) above which a chain gets no more automatic rounds and raises an ask. |
| `repos` | none | Object keyed by `owner/name` with `setup`, `verify`, `setupTimeoutMs`, `verifyTimeoutMs`, `maxVerifyRounds`, `verifyBaseline` (see "Setup and verification per repository"). |
| `maxCiRounds` | none | **Deprecated** alias for `breakers.ci.failureThreshold`. |
| `keptWorktreeMaxAgeMs` | `604800000` (7 days) | Non-negative. A kept worktree whose dead letter is older than this, or resolved, is removed by the periodic sweep. |
| `maxConcurrentJobs` | no limit | Integer, at least 1. At most this many jobs run at once across the whole database, that is across all workers together, not per worker. A worker that cannot claim because of it keeps polling and records at most one `job.throttled` event per minute (running count and limit). A running job whose lease has expired counts until the reaper reclaims it. `factory status` and the dashboard show `slots: <running> of <max>` (or `slots: <running> (no limit)`). |
| `leaseMs` | `300000` | At least 10000. How long a claim lasts without a heartbeat. |
| `heartbeatMs` | `30000` | At least 1000, and smaller than half of `leaseMs` (otherwise startup fails). How often a running job's lease is renewed. |
| `maintenanceMs` | `60000` | At least 5000. Interval of a worker's maintenance (reaper, dead-letter surfacing, reconcile, pruning, sweeps). |
| `maxDeliveries` | `3` | Integer, at least 1. A job whose lease expires on this delivery is dead-lettered instead of requeued. Deliveries that were retried after a transient failure (see `maxTransientRetries`) are not counted. |
| `maxTransientRetries` | `8` | Integer, at least 1. How often a job whose delivery failed only because of a transient network problem is requeued with a delay before it is dead-lettered (see [Suspended machine and transient failures](#suspended-machine-and-transient-failures)). Separate from `maxDeliveries`. |
| `cloneUrlTemplate` | `https://github.com/{repo}.git` | Fetch and push URL; `{repo}` is replaced by `owner/name`. With `github.tokenEnv` it must be an `https://` URL without credentials. |
| `github` | absent | Optional object: the factory's own GitHub identity, see "Running as its own GitHub identity". `tokenEnv` (variable holding the token), `expectLogin` (the login it must resolve to; required with `tokenEnv`), `commitName` and `commitEmail` (author and committer of factory commits). Without it nothing changes. |

`delivery` counts every claim of the job, but claims after a worker's own stop handed the job back (SIGINT/SIGTERM) are not counted against `maxDeliveries` (they are added to `transient_retries`), and `dlq retry` keeps the counter, so with the default `maxDeliveries` a job retried after two deliveries is dead-lettered the next time its lease expires. The squash merge method is the default of `GhCliHost`.

## Usage

```
factory [--config <path>] submit <issue-url> [--label <l>]... [--engine <id>]
factory [--config <path>] worker [--poll-ms <n>] [--id <name>]
factory [--config <path>] status [--json]
factory [--config <path>] show <chain-id> [--json]
factory [--config <path>] events [--since <duration>] [--chain <id>] [--limit <n>] [--json]
factory [--config <path>] workers [--json]
factory [--config <path>] dlq list
factory [--config <path>] dlq retry <job-id>
factory [--config <path>] dlq discard <job-id>
factory [--config <path>] cancel <chain-id>
factory [--config <path>] policies
factory [--config <path>] dashboard [--port <n>] [--host <addr>]
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

**status.** One line per chain that is not completed or cancelled: `<chain-id> <engine> <chain-status> <engine description>`, followed by one indented line per job of the chain: job id, type, attempt, status, delivery number, the worker holding it (running jobs), the time since the job's last event and, for a running job, the lease expiry. `--json` prints the same data as one JSON array.

```
$ factory status
1 software active acme/sandbox#12 phase=reviewing attempt=1 profile=supervised
  job 1 execute attempt=1 succeeded delivery=1 last-event=4m ago
  job 2 review attempt=1 running delivery=1 worker=w1 last-event=12s ago lease-expires=2026-10-03T21:09:40.000Z
```

With nothing open it prints `no open chains`.

**show.** `factory show <chain-id>` prints the chain's events oldest first (timestamp, kind, `job=`/`delivery=`, detail), so the path to the current state, the dead-letter reason and the review verdicts are readable without SQL, then the cost of each job that reported one and the chain total (`cost total $0.8750`). `--json` prints `{chain, events, cost}`. An unknown chain exits 1.

**events.** `factory events` prints the newest events across chains, oldest first. `--since <duration>` (`30s`, `15m`, `2h`, `7d`), `--chain <id>` and `--limit <n>` (default 50) narrow it; `--json` prints the rows.

**workers.** `factory workers` prints each registered worker: id, pid, host, whether it is alive (see the liveness rule under Dashboard), the job and delivery it is on (or `idle`) and the age of its last heartbeat.

**dlq.** `list` prints unresolved dead letters, newest first: `job <job-id> chain <chain-id> <reason> <first line of the error, at most 120 characters>`. The reason is one of `runner_error`, `timeout`, `max_deliveries`, `effect_error`. Empty output is `no dead letters`.

```
$ factory dlq list
job 1 chain 1 runner_error workspace prepare failed: git fetch origin --prune failed: ...
$ factory dlq retry 1
requeued job 1
$ factory dlq discard 1
discarded job 1
```

`retry` re-queues the same job (its delivery counter is kept, so the next claim is delivery + 1), puts the chain back to active, and keeps the recorded result only for `effect_error` (then the agent is not rerun, only the post-processing). Only a review job's effects (labels, merge, comments) dead-letter as `effect_error`, with one exception: when the `automatic` merge cannot be pinned to the head the reviewer saw (the review's worktree is gone after a crash or an `effect_error` retry) or the merge call fails for another reason than a typed auto-merge refusal (which hands over to a person, see above), the job is dead-lettered as `runner_error`, so `retry` redoes the review against the current head. When an execute job's push or pull-request creation fails, the job is dead-lettered as `runner_error`, so one `retry` reruns the agent in a fresh worktree (its earlier, unpublished work is redone); resuming would be impossible because the earlier delivery's worktree is not reused. `retry` also moves the issue label from `factory:dead-letter` back to `factory:in-progress`. `discard` cancels the chain, which frees the subject for a new `submit`, and removes `factory:in-progress`, `factory:needs-human`, `factory:dead-letter` and `factory:ready-for-merge` from the issue (best effort; a labelling failure is printed as an error, the discard stands).

If labelling the issue fails when a job is dead-lettered (for example GitHub answers 502), the dead letter is recorded as not yet surfaced, and every maintenance pass (once a minute, in any running worker) retries the label and comment until they succeed.

**cancel.** Ends a chain by hand, typically a `waiting` one you do not want to wait a maintenance pass for, or an issue you want to resubmit while its PR is still open. It cancels the chain and its queued jobs, resolves its dead letters, frees the subject for a new `submit`, and removes `factory:in-progress`, `factory:needs-human`, `factory:dead-letter` and `factory:ready-for-merge` from the issue (labels on the PR are left alone). It refuses (exit 1) a chain whose job is running (stop that worker, or wait for the delivery to finish) and a chain that is already completed or cancelled; a missing or non-numeric id is a usage error (exit 2).

```
$ factory cancel 1
cancelled chain 1
```

**drain and resume.** Quiesce the factory for maintenance without losing in-flight work. `factory drain` sets a flag (the `drain` row of the `control` table) that stops every worker from claiming new jobs; jobs already running finish normally, and maintenance (reaper, reconcile, dead-letter surfacing, pruning) and heartbeats keep running. Queued, retried, requeued and reaper-reclaimed jobs stay `queued` until `factory resume`. It prints `draining: <n> job(s) running` and records `drain.started` the first time (a second call changes nothing). `factory drain --wait` sets the flag, then polls the database every 2 seconds until no job is running, prints `drained` and exits 0; `--timeout <seconds>` gives up with exit 1 and `still draining: <n> job(s) running`, leaving the flag set. SIGINT and SIGTERM exit 130 and 143, also leaving the flag set. `factory resume` clears the flag, prints `resumed` and records `drain.resumed` only if it was set. Neither command needs the GitHub token. While the flag is set, `factory status` ends with `DRAINING (<n> job(s) still running)` and the dashboard header shows the same text.

```
$ factory drain --wait --timeout 3600
drained
$ factory resume
resumed
```

## Intake

The optional `intake` block of `factory.config.json` lets the factory find the issues a person marked ready with a label. In this first phase it only reads: it enqueues, comments and labels nothing.

| Field | Default | Meaning |
|---|---|---|
| `repos` | required, at least one | `owner/name` of each repository to watch. |
| `readyLabel` | `factory:ready` | Label that marks an open issue as ready. |
| `pollIntervalMs` | `60000` | At least 5000. For the polling loop of a later phase. |
| `maxOpenChains` | `2` | At least 1. Open chains (active, waiting or dead-lettered) allowed per repository. |
| `allowedAuthorAssociations` | `["OWNER", "MEMBER", "COLLABORATOR"]` | Only issues by authors with one of these GitHub `author_association` values may cause work. |

Unknown keys in the block are an error. Without the block `factory intake` exits 1 with `intake is not configured`.

```
factory intake --once --dry-run
```

prints one line per ready issue, oldest first, as `<owner/repo>#<n> <decision> <reason>`, and exits 0. The decision is `enqueue ready`, or `skip` with the reason `author not allowed`, `already queued` or `at capacity`. If `gh` fails for a repository, `error: <message>` goes to stderr, the other repositories are still processed and the exit code is 1. The command reads the GitHub token and calls GitHub, but writes nothing to GitHub or the database. Both flags are required until the loop exists.

## Dashboard

`factory dashboard [--port <n>] [--host <addr>]` serves a page in the browser that shows where every chain is and who has to act next, so you do not have to combine `status`, `show` and `workers`. It listens on `127.0.0.1:4173` by default and runs until SIGINT or SIGTERM, then shuts down cleanly.

**Local and unauthenticated.** The dashboard has no authentication. The default host is loopback, so only this machine can reach it. Binding to another address needs an explicit `--host` (for example `--host 0.0.0.0`) and prints a warning; anyone who can reach the port can then read your factory data (issue numbers, branch names, event details, costs).

**Read-only.** The server opens the database with a read-only connection, answers only `GET` (every other method gets `405`), never calls GitHub and never starts, stops or retries a job. It needs the database to exist already (`factory submit` or `factory worker` creates it). It uses only Node built-ins; the page is one self-contained HTML document with inline CSS and JavaScript (no external scripts, fonts or images), so it works offline, and follows the system light or dark preference. It polls `/api/overview` every 5 seconds (paused while the tab is hidden), shows the time of the last successful refresh, and shows a "Disconnected" banner above the last data when the server cannot be reached. Expanded chains stay expanded across refreshes. All text from GitHub or an agent is rendered as text, never as HTML.

**Sections.** The header counts live workers, running jobs and chains waiting on a person. "Needs you" lists chains waiting on a person or a dead-letter decision, with links; "In progress" lists chains with a running job (its worker, how long it has run, the latest events); "Queued" lists the rest of the open chains; "Recently finished" shows the last 20 completed or cancelled chains. Expanding a chain shows its jobs with cost and its full event timeline (the same events as `factory show`).

**API.** `GET /api/overview` returns, in one response: `openChains` (status `active`, `waiting` or `dead_lettered`) and the 20 most recent `finishedChains`, each with subject, engine, status, phase, attempt, links, jobs, its 10 latest events, total cost and `waitingOn`; plus `workers` (the alive ones first, then at most the 5 most recently seen dead ones, and the job each is on), `summary` (`workers` counts alive workers only; `aliveWorkers` is an alias for it, kept for one release; `stoppedWorkers` is the number of dead workers in total), `totalCostUsd` and `generatedAt`. `GET /api/chains/<id>` returns the same data as `factory show --json`. The pull request link is `https://github.com/<repo>/pull/<number>` when the chain recorded the number (the `pr.opened` event and the chain state carry it); chains from before that fall back to a GitHub search for the chain's branch.

**Worker liveness.** `factory workers` and the dashboard use one rule. A worker on this host is alive while its process id exists (`kill(pid, 0)`; a permission error also counts as alive), however long it has been idle, because an idle worker does not stamp its heartbeat. A worker on another host cannot be probed, so it is alive while its heartbeat is younger than twice the 30 s heartbeat interval. A reused process id is not detected.

**Worker grouping.** The page lists alive workers in a table and puts the dead ones in a collapsed "Stopped workers (N)" group, where N is the total number of dead workers; the API and the page carry only the 5 most recently seen of them.

**Host check.** Every request, including the `404` and `405` cases, must carry a `Host` header whose hostname is `localhost`, `127.0.0.1` or `[::1]` (or exactly the value given with `--host`) and whose port is the port the server listens on. Anything else, including a missing `Host`, gets `421 Misdirected Request` with a one-line plain-text body and no data. This stops DNS-rebinding pages from reading the dashboard through the browser. A reverse proxy in front of the dashboard must keep the original `Host` header (and so use a matching name and port) or rewrite it to `127.0.0.1:<port>`, otherwise every request is refused.

**waitingOn.** Derived for each open chain:

| `waitingOn` | When |
| --- | --- |
| `a worker` | a job is queued (the detail says when no worker is alive, and when it is a retry) |
| `running` | a job is claimed by a live worker with an unexpired lease (shows how long it has run and when the lease expires) |
| `a reviewer agent` | a review job is queued or running |
| `a person: review and merge` | phase `awaiting_merge`; names the pull request's branch and how long it has waited |
| `a person: needs attention` | phase `needs_human`; shows how long it has waited |
| `an answer to a question` | phase `needs_input`: the factory asked a question and waits for a comment, review or push |
| `cool-down (<class>, until <time>)` | a circuit breaker is open; the chain tries again after the cool-down |
| `a decision on the dead letter` | chain status `dead_lettered`; shows the reason (see `factory dlq`) |
| `a stuck job` | a running job whose worker is dead or whose lease has expired (shown prominently) |

**What it does not show.** What the agent is doing inside a running job (tool calls, files touched): the runner does not record its steps, so the dashboard shows only the recorded job and chain state and events. There are no controls (cancel, retry, submit) in the dashboard; use the commands above.

## Events

The kernel table `events` is an append-only log of lifecycle transitions: `id`, `at` (epoch milliseconds), `chain_id`, `job_id` (nullable), `delivery` (nullable), `kind`, `engine` (`kernel` or the recording engine's id) and `detail` (small JSON). The helper `recordEvent(db, event)` in `src/kernel/events.ts` is its only writer; the kernel's events are written in the same transaction as the state change they describe. Every string in `detail` is cut to 200 characters, and only structured values (reasons, verdicts, label names, secret-guard kinds) are recorded: never issue bodies, agent output or matched secret text.

| Recorded by | Kinds |
| --- | --- |
| kernel | `chain.created`, `job.queued`, `job.claimed`, `job.lease_lost`, `job.succeeded` (with `costUsd` when the result has one), `job.requeued`, `job.retry_scheduled` (reason, delay in ms, retry count), `worker.resumed` (gap length; recorded after a detected suspend or stall), `job.dead_lettered` (with the reason), `dead_letter.retried`, `dead_letter.discarded`, `chain.cancelled`, `chain.completed`, `chain.waiting` |
| software engine | `pr.opened`, `labels.changed`, `review.verdict` (verdict and attempt), `merge.requested`, `merge.enabled`, `merge.needs_human`, `followup.filed`, `secret_guard.refused` (kinds only), `round.failed` (class, error), `breaker.opened` (class, failures, cool-down in ms), `breaker.half_open` (class), `breaker.closed` (class), `ask.raised` (reason, class), `ask.answered` |

Lease renewals are deliberately not recorded (too noisy).

Costs: the model's cost is stored as `costUsd` on the job result for execute and review jobs, and `factory show` sums it per chain. The unused `dead_letters.step_log_path` column was removed from the schema (existing databases keep the column; nothing reads or writes it).

### Issue comments

When a chain is queued the software engine posts one short comment on the issue, and another when the chain's first execute job starts; each carries a hidden marker (`<!-- factory:chain=<id> event=queued -->`, `event=started`) and is never posted twice. `factory:in-progress` is set when a job is claimed, not only after the first pull request opens.

## Labels

| Label | On | Meaning |
|---|---|---|
| `factory:in-progress` | issue | Set once the first execute job produced a pull request (the same step removes a leftover `factory:dead-letter`); removed on approval, on the final changes request, on dead-lettering, and by `cancel` and `dlq discard`. |
| `factory:ready-for-merge` | PR | `supervised` profile: the reviewer approved; a human merges. |
| `factory:needs-human` | issue | The factory raised an ask and waits for a person's answer (a legacy `needs_human` chain also carries it on the PR). |
| `factory:dead-letter` | issue | A job failed beyond what the kernel can recover; the factory also comments with the reason, error and job id. Removed by `dlq retry`, `dlq discard`, `cancel`, and the next execute job of a resubmitted issue. |
| `factory:followup` | new issues | Issues the factory filed from `followups` in agent or reviewer output. Nothing queues them automatically. |
| `factory:profile:automatic` | issue (set by you, before submit) | Selects the `automatic` profile. |
| `factory:engine:<id>` | `--label` value | Router label naming the engine. More than one distinct engine label is an error; an unknown id is an error. |

Labels are set and removed explicitly, never toggled. GitHub creates a label on first use if the repository lacks it.

### needs-human versus dead-letter

`needs-human` means the machinery worked: the agent produced a pull request three times and the reviewer kept requesting changes. A PR exists and a person decides what to do with it. `dead-letter` means the machinery failed (the runner errored or timed out, a GitHub or git effect kept failing, the workspace could not be prepared, or the lease expired on every delivery) and no usable result exists. Look at the issue comment and `factory dlq list`, fix the cause, then `factory dlq retry <job-id>`, or `factory dlq discard <job-id>` to give up. Once you merge or close the PR of a `needs-human` or `ready-for-merge` chain, the maintenance pass completes or cancels the chain within about a minute (see the lifecycle above); `factory cancel <chain-id>` ends it immediately, and is the way out when the PR is neither merged nor closed.

Closing the issue stops the chain: the next job is dead-lettered (`runner_error`, `issue #<n> is closed`) before the agent runs, and opening a pull request or merging for a closed issue fails as `effect_error`. Discard it or cancel the chain.

## Policies

A policy is one YAML file (shipped in the package's `policies/`, or in `policiesDir`). The policy name is the file name without `.yaml`:

| Field | Meaning |
|---|---|
| `id` | Unique across all files. |
| `kind` | Job kind the policy serves: `execute` or `review` for the software engine. |
| `match.labels` | Labels that must all be present on the job's labels (the issue's labels at submit time). |
| `default` | `true` marks the fallback for its kind. A default must have empty `match.labels`; a non-default must have a non-empty list. At most one default per kind. |
| `runner` | Runner name; `claude-cli` is the only one registered. |
| `config` | Runner-specific settings, validated against the runner's schema at startup. |

Matching: among the non-default policies of the kind, those whose `match.labels` are all present are candidates. Exactly one wins; more than one is an `ambiguous policy match` error; none falls back to the default of that kind; no default is an error. Files are loaded and validated at startup: each policy's `kind` must be declared by a registered engine, its `runner` must be registered, and its `config` must pass that runner's schema; otherwise every command fails with an error naming the policy. Restart the worker after editing them.

### Overriding policy settings

Policies load in this order: the shipped ones (unless `shippedPolicies` is `false`), then the `*.yaml` files in `policiesDir`: a file with the same name as a shipped policy replaces it whole, other files are added. Then `policyOverrides` is applied. Each value is a partial policy deep-merged over the loaded one: objects merge key by key, scalars and arrays replace. Only `runner` and `config` may be overridden; `kind`, `match` or any other key is a configuration error naming it. An override for a policy name that does not exist is an error. The merged result is validated like any policy at startup, before a worker claims work; errors name the policy and key.

Example for an operator with a subscription and no API key (the whole run directory is this one file):

```json
{
  "policyOverrides": {
    "software-execute": { "config": { "bare": false } },
    "software-review": { "config": { "bare": false } }
  }
}
```

`factory policies` prints each effective policy: name, source (`shipped`, `directory` or `overridden`), the labels it matches, and the effective `runner` and `config` with secret-looking values redacted.

Two default policies ship:

- `policies/software-execute.yaml` (`software-execute`): tools `Read, Edit, Write, Bash, Glob, Grep`, budget `maxBudgetUsd: 5`, `timeoutMs: 1800000`, `inactivityTimeoutMs: 600000`, `resultFormat: execution`, `model: sonnet`, `bare: true`.
- `policies/software-review.yaml` (`software-review`): tools `Read, Glob, Grep` plus `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git status:*)`, budget `maxBudgetUsd: 2`, `timeoutMs: 900000`, `inactivityTimeoutMs: 600000`, `resultFormat: json`, `model: haiku`, `bare: true`, `settingSources: user`.

The `model` key of the `claude-cli` config (optional, 1 to 100 characters matching `^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]*$`, so it cannot be read as an option) is passed as `--model=<value>`: an alias such as `sonnet`, `haiku` or `opus`, or a full model id. When it is unset the claude CLI's default (or `ANTHROPIC_MODEL`) applies. The shipped defaults are `sonnet` for execute and `haiku` for review; change either without editing a policy file, for example `"policyOverrides": { "software-review": { "config": { "model": "sonnet" } } }`. Rule: every shipped policy must declare a `model` (a test enforces it).

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
| `pluginDirs` | Optional list of plugin directories (default `[]`), each passed as one `--plugin-dir=<absolute path>` in both bare and non-bare mode. A relative entry is resolved against the worktree and, after following symlinks, must be a directory inside it. An absolute entry is operator configuration and is taken as given. A missing, non-directory or refused entry fails the run, naming the entry. `tools/ts-lsp/` is a plugin that gives the agent a TypeScript language server (see its README). |

Example: a policy that gives the agent the TypeScript language server from `tools/ts-lsp/` (needs `npm install` in the worktree; whether it works with `bare: true` is unconfirmed, see `docs/smoke-test.md`). The shipped policies leave `pluginDirs` empty.

A relative plugin directory must match the base branch; changes to plugins need a human merge first. A plugin's `command` (for example a language server) is started by the CLI as a separate process, outside the agent's tool permissions, so a directory the execute agent could edit would let it run code later, including in the review run. Before the agent is spawned the runner compares the directory with `refs/remotes/origin/<baseBranch>` in the shared cache (`git ls-tree`, hardened like the other scan commands): every file must be present with the same content and executable bit, and no other file may exist under it (untracked, ignored or generated, such as an installed `node_modules/`), and a symlink anywhere inside it is refused. A failing check fails the run before spawning, with an error that names the entry and says plugin changes take effect only after a person merges them (it contains no file contents). So a plugin that needs installed dependencies belongs in an absolute `pluginDirs` entry. Absolute entries are operator configuration and are not checked. This does not cover the branch's own `CLAUDE.md` and `.claude/settings.json`, which the agent can also write and the next run reads: that is a known, documented limit.

```yaml
config:
  # ...the other fields of software-execute.yaml...
  pluginDirs:
    - tools/ts-lsp
```

The review policy is read-only by tool restriction: no `Edit`, `Write` or general `Bash`, only the four read-only git subcommands. Its prompt tells the reviewer to pass `--no-ext-diff --no-textconv` to `git diff`, `git show` and `git log -p` and never to use `--output` (a prompt rule, not enforced: the `Bash(git diff:*)` rules cannot express it). The agent must end its final message with one fenced `json` block; the last such block is parsed.

## Suspended machine and transient failures

A suspended machine pauses everything: every process is frozen, including the heartbeat timers, and the wall clock keeps running. The factory does not keep the machine awake or look at the network interface; it makes the resume harmless.

- **Gap detection.** Each worker compares the time between two of its timer ticks on the wall clock and on a monotonic clock (which does not advance while some systems are suspended). When more than three intervals (3 x `heartbeatMs`) passed on either, it first renews the lease of its own running job, even though the lease expired on the wall clock, and records `worker.resumed` with the gap length, once per gap. The renewal is fenced, so a job a peer already reclaimed is lost as before.
- **Reaper grace.** After a detected gap the worker's maintenance pass skips the reaper for `2 * heartbeatMs` (at least 30 seconds), so owners of leases that expired only because everything was frozen can renew them before a peer requeues the job or kills the worker. Every worker applies this rule to itself. A lease that is still expired after the grace is reaped as before (kill before reclaim, requeue or dead-letter).
- **Transient failures.** A failure that is clearly a network problem at workspace preparation or in `onJobStart` is not dead-lettered: git output with `Could not resolve host`, `unable to access`, `Connection timed out`, `Connection reset`, `early EOF`, `Failed to connect`, `Network is unreachable` or `Temporary failure in name resolution`, a `gh` error without an HTTP status (`error connecting to api.github.com`), and HTTP 429 and 5xx. The job is requeued with `available_at` set in the future: 15 seconds, doubled each time, at most 5 minutes. `claimNext` skips it until then. The attempt is cleaned up like any failed delivery and its fence rejects late writes. Each retry records `job.retry_scheduled` (reason, delay, count), `factory show` lists these events, and `factory status` and the dashboard show the job as `retrying (attempt n, in <time>)` instead of `queued`.
- **Budget.** Retries are counted in `transient_retries`, not against `maxDeliveries`; the reaper compares `delivery - transient_retries` with `maxDeliveries`. After `maxTransientRetries` retries the job is dead-lettered (`runner_error`) with `transient_retries_exhausted` and the last error in its message. A dead letter whose surfacing fails because GitHub is unreachable stays unsurfaced and maintenance surfaces it later, as before.

Failures of the agent itself (the model run) are not retried this way, and permanent failures (a bad ref, an invalid result) are dead-lettered immediately. Single machine only.

## Concurrency and safety

Each claim of a job increments its `delivery` counter and takes a lease (5 minutes by default, renewed every 30 seconds by a heartbeat; see `leaseMs` and `heartbeatMs`). Every kernel write is fenced by `(job id, delivery)`, so a stale worker's result is rejected, and every external effect re-checks the fence immediately before acting. Each delivery gets its own git worktree, so a zombie cannot corrupt its replacement, and the push uses `--force-with-lease` against the sha the delivery was seeded from. Before a job is reclaimed the reaper kills the delivery's agent process groups and, only if that worker's row still names this job delivery as its current one, the worker pid (a worker that moved on to another job is never killed), then requeues or dead-letters. A worker that loses its lease waits at most 10 seconds for the run to stop before it moves on. Effects look before they act (find the PR by branch, find a marker comment, check PR state). When the push's lease is rejected while the delivery is still current, someone else moved `factory/issue-<n>` (a person pushed to it, for example) and the job is dead-lettered (`runner_error`, `remote branch moved by someone else`). In the `automatic` profile the merge enables auto-merge with `gh pr merge --auto --match-head-commit`, pinned to the head the reviewer saw (the commit the review's worktree was seeded from), and `--delete-branch` removes the branch afterwards. If that head cannot be verified (the review's worktree is gone after a crash or a retry) the review job is dead-lettered as `runner_error` and `factory dlq retry` redoes the review against the current head; the factory never merges an unpinned head. If GitHub refuses to enable auto-merge (including because someone pushed after the review), a person takes over (`needs_human`). The agent's summary is capped at 2000 characters and neutralized before it goes into the PR body (no `@` mentions, no `Fixes #n` closing references). Every `gh` call is killed after 60 seconds (a transient failure, retried), every git network command (fetch, push, ls-remote) after 5 minutes and every local git command after 60 seconds; git's ssh runs with `BatchMode=yes`, so it fails instead of prompting. The reasoning and the accepted residual risks are in section 5 of [the spec](docs/superpowers/specs/2026-10-03-software-factory-design.md).

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
- The `gh`-based GitHub calls were never run against the real CLI during development, only against fakes. In particular, the error text `gh pr merge --auto` prints when GitHub refuses to enable auto-merge is matched by message (see `AutoMergeRefusedError` in `src/engines/software/github.ts`) and was not checked against the real CLI; an unrecognized refusal without an HTTP status is retried as transient, then dead-lettered as `runner_error`, so `dlq retry` redoes the review.
