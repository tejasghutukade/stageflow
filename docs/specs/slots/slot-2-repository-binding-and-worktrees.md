---
status: implementation-brief
slot: 2
---

# Slot 2 — A Run names a repository and gets its own worktree

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage AI agent workflows. Users
author pipeline-owned YAML (`*.pipeline.yaml`, `*.task.yaml`, an optional `stageflow.yaml`
manifest). Each stage runs in a fresh agent session; stages hand off through typed envelopes and
artifacts; HITL gates pause a run for operator input.

The pieces you will be touching:

| Piece | What it is |
|---|---|
| `sf` CLI | `src/cli.ts` — `sf run`, `sf runs`, `sf validate`, `sf ui`, `sf mcp`, `sf providers` |
| The Host | One Node process serving HTTP: REST (`src/server/http.ts`), MCP (`src/mcp/`), A2A (`src/a2a/`) |
| Run store | SQLite (`better-sqlite3`, WAL) under `~/.stageflow/.stageflow/state.db` (`src/runstore/`) |
| Run manager | `src/runtime/runManager.ts` — admission, leases, tracking, `startRun`, `rerun` |
| Stage worker | A **forked Node child** (`src/runtime/stageProcessLauncher.ts`) running `internal run-stage`, which hosts a **Pi** coding agent with `bash` / read / write / edit tools |

The project is being prepared for **containerization**: one published image that a user runs
anywhere and drives from their own harness (a coding agent or IDE) over MCP or A2A. That work is
split into nine shipping slots. **This is slot 2, and it is the centrepiece** — the one change that
makes a container make sense at all, because today a Run points at a directory that must already
exist on the machine, and in a container nothing exists until something puts it there.

- Whole-programme work breakdown: [`../pre-container-work.md`](../pre-container-work.md) (this slot
  is workstream 2, plus riders 10.4 and 13.1)
- Locked product decisions for this feature:
  [`../host-owned-worktrees.md`](../host-owned-worktrees.md)
- Verified current-state evidence: [`../container-ready-assessment.md`](../container-ready-assessment.md)

Repo conventions live in [`AGENTS.md`](../../../AGENTS.md); YAML schema conventions in
[`docs/yaml-catalog.md`](../../yaml-catalog.md).

## Mission

Make the Host responsible for materialising a workspace from a declared repository:

> `start_run` with `repository: owner/repo` + `ref: main` fetches into a shared bare clone cache on
> the Host, creates a `git worktree` for that Run on a fresh branch, records the repository, the ref
> and the resolved SHA on the Run, exports a stable set of `STAGEFLOW_*` variables to every stage,
> and gives the agent a checkout that already exists — with no bind mount, no token from the caller,
> and no `git clone` inside a stage.

Plus the two riders that make it usable: a git **identity** so the first `git commit` in a stage
does not fail, and three read-only **visibility tools** so a remote operator can see what the run
changed without `docker exec`.

## Why this matters

1. **Without it, a mountless container can only run pipelines that touch no repository.** That is a
   real product but a narrow one.
2. **The checkout lease is currently a parallelism ceiling.** One active Run per
   `realpath(checkout)` (`src/runtime/runManager.ts:1718-1731`) means two Runs on the same repo
   conflict with `busy_checkout`. Worktree-per-Run removes that for repository-bound runs.
3. **It is the clarity win.** "Where does this Run work?" has one fuzzy answer today and three
   sharp ones afterwards.
4. **Everything downstream assumes it.** Worktree GC (slot 3), per-run disk accounting, the run
   manifest (slot 9), and `get_run_diff` all need a recorded `resolved_sha` and a known worktree
   path.

## Dependencies

**Assumes shipped (slot 1):**

- `STAGEFLOW_HOME` exists as a resolved, validated durable root, replacing the hardcoded
  `path.join(os.homedir(), ".stageflow")` in `src/project/globalHome.ts:5-7`. Everything this slot
  writes to disk (`repos/`, `worktrees/`) lives under it. **Do not invent your own root**; consume
  slot 1's resolver.
- The run store has a schema version (`PRAGMA user_version` + a `schema_migrations` ledger) and
  migrations are applied by the Host only. This slot adds columns to `runs`, so it must add them as
  a numbered forward migration, **not** as another `PRAGMA table_info` probe of the kind at
  `src/runstore/sqlite/SqliteRunStore.ts:188-189`.

**Must ship in the same release as slot 3.** Worktree creation without worktree cleanup is a disk
leak. On a laptop you `rm -rf` by hand; in a container there is no hand. Slot 3 owns
`cancel_run` / `delete_run` / retention / `sf runs gc`. Do not ship slot 2 to a published image
without it.

**Blocks:** slot 9 (harness parity — `rerun` of inline pipelines, run-scoped skills, the run
manifest, preflight) all read the binding this slot records.

## The model change

This is the conceptual core. Read it before the task list.

### Before

`task.checkout` is a path to a directory that must already exist and be readable, writable and
searchable. It does not even have to be a git repository (`resolveAndValidateCheckout`,
`src/runtime/stageRoots.ts:67-95`). If absent, the Run is *unbound* and the agent's `cwd` is the run
workspace (`buildStageRoots`, `src/runtime/stageRoots.ts:97-123`).

```yaml
# today: the only binding that exists
id: fix-flaky-test
goal: Make the retry test deterministic
checkout: /Users/me/work/acme-api    # must already be on this machine
```

### After

A Run has exactly **one workspace binding**, of three kinds:

| Kind | Declared as | What the Host does | `STAGEFLOW_CHECKOUT` points at | Lease |
|---|---|---|---|---|
| `repository` | `repository` + **required** `ref` | fetch (or first clone) into a shared bare cache, then `git worktree add -b <branch>` for this Run | `$STAGEFLOW_HOME/worktrees/<runId>` | none — parallel runs are the point |
| `checkout` | `checkout: <path>` | validate the path as-is (unchanged behaviour) | the declared path | one active Run per `realpath(path)` |
| unbound | neither | nothing | *(unset)* — agent `cwd` is the run workspace | none |

```yaml
# after: the container case, and the right answer locally too
id: fix-flaky-test
goal: Make the retry test deterministic
repository: acme/api
ref: main
```

Declaring **both** `repository` and `checkout` is a validation error with a named code
(`task.binding_conflict`). Declaring `repository` without `ref` is
`task.repository_ref_required`. `ref` without `repository` is `task.ref_without_repository`.

Locked (see [`../host-owned-worktrees.md`](../host-owned-worktrees.md)) — do not relitigate:

- One working tree per Run. Two Runs never share a dirty checkout.
- That worktree **is** the Checkout. Stages edit, commit, and (if the pipeline says so) push there.
- Worktrees and bare clones live under Host state, not in the catalog, so a stage's `bash` in a
  checkout cannot treat the SQLite store as project files.
- Stability comes from **env vars, not mount namespaces**. No `SYS_ADMIN`, no remount over
  `/workspace`.
- **No Host "land"** — no apply-delta-onto-a-shared-tree API. The Run's branch is the git record;
  opening a PR is a pipeline stage.
- The repository is frozen at start: one repo, one required ref per Run.
- Clone credentials stay on the Host. The harness never sends a token on `start_run`.

## Verified current state

Read in this worktree before writing anything. Where the work-breakdown doc is wrong, it is flagged.

**There is no git provisioning code anywhere, and no git library dependency.** `git` is shelled out
to in exactly three read-only places:

| Call | Site |
|---|---|
| `rev-parse --show-toplevel` | `src/project/findProjectRoot.ts:24` (`execFileSync`) |
| `rev-parse --show-toplevel`, `status --porcelain -- <path>` | `src/config/migrateYaml.ts:144`, `:158` (`execFileSync`) |
| `ls-files -z`, `ls-files --others --exclude-standard -z` | `src/runtime/gitCheckoutCapability.ts:55-57` via `runGit` at `:13-31` |

No `clone`, `fetch`, `worktree`, `branch`, `push`, or `diff` anywhere. No `simple-git`,
`isomorphic-git`, `nodegit`, or `dugite` in `package.json` or `package-lock.json`. **Everything in
this slot is greenfield.**

**Checkout resolution and the bound/unbound split.**

- `resolveAndValidateCheckout(task, override, factoryCwd)`
  (`src/runtime/stageRoots.ts:67-95`) takes `override ?? task.checkout`, rejects empty/whitespace,
  resolves against `factoryCwd`, `stat`s it, requires a directory, and requires `R_OK | W_OK |
  X_OK`. It returns `string | undefined`. It never touches git.
- `buildStageRoots` (`src/runtime/stageRoots.ts:97-123`) returns
  `mode: "bound"` with `cwd = checkoutRoot` when a checkout exists, otherwise `mode: "unbound"`
  with `cwd = runWorkspaceDir`. `StageRoots` is declared at `:10-19`.
- Called from two places: `src/runtime/pipelineRunner.ts:141-145` (the real start path, whose result
  flows into `store.createRun({ checkoutRoot, ... })` at `:158-171`) and
  `src/runtime/runManager.ts:1630-1634` (pre-flight, purely to compute the lease key).

**The checkout lease.**

- `BusyCode = "busy_capacity" | "busy_checkout"` (`src/runtime/runManager.ts:82`).
- `private readonly checkoutLeases = new Map<string, string>()` (`:188`), keyed by
  `toCheckoutLeaseKey(absPath)` which is `realpath` with a `path.resolve` fallback and an invariant
  log (`:169-183`).
- `reserveAndStartPipeline` (`:1611-1684`) loads the task, resolves the checkout, computes
  `checkoutKey`, calls `tryReserve(checkoutKey)` (`:1710-1744`), then `startPipeline(...)`, then
  `this.track(...)`. On throw it calls `clearReservation`.
- `tryReserve` checks `active.size >= maxConcurrent` first (`busy_capacity`), then the lease
  (`busy_checkout` with `conflictingRunId` / `conflictingCheckout`, `busyFailure` at `:1686-1708`),
  then inserts a `provisionalId` and claims the lease under it. `track` (`:1750-1768`) re-keys the
  lease from the provisional id to the real run id.
- The lease is also re-acquired on attach (`:351-385`) and on restart resume (`trackResume`,
  `:1834-1880`), both reading durable `meta.checkout_root`. **Both paths need the same
  path-checkout-only condition** as `tryReserve`, or a restart will re-lease worktrees.

**`startRun` and `rerun`.**

- `startRun` (`:613-678`) accepts `{ pipeline, task?, checkoutOverride?, skipGates?, gitSha?,
  ciPrUrl?, ciJobUrl? }` and forwards to `reserveAndStartPipeline`.
- `rerun(runId)` (`:680-718`) **hard-requires `meta.pipeline_path`** (`:689-695`) and returns a 400
  `"missing pipeline_path; re-run requires stored catalog locators"` otherwise. It reads
  `meta.project_root` and `store.readTaskYaml(runId)`, then calls `reserveAndStartPipeline` with
  `checkoutOverride: undefined`. Because it replays the stored task YAML, a `repository` + `ref`
  task will replay its binding for free once the task schema carries it — but an **inline-pipeline**
  run still cannot be rerun at all. That gap is slot 9's (workstream 9.2); do not fix it here, but
  do not build anything that depends on `rerun` working for inline pipelines.

**What is recorded today.** `RunMeta` (`src/runstore/port.ts:56-72`) is exactly:

```ts
run_id, pipeline_id, created_at, status?, task_id?, updated_at?,
checkout_root?, git_sha?, ci_pr_url?, ci_job_url?,
pipeline_dag?, pipeline_path?, task_path?, project_root?
```

`CreateRunInput` (`:375-389`) mirrors it. `checkout_root` is a nullable `TEXT` column
(`src/runstore/sqlite/schema.ts:10`), written at `SqliteRunStore.ts:567` and read back at `:1615`.
`git_sha` is **CI provenance from the caller**, not a resolved ref — do not reuse it for
`resolved_sha`.

> **Correction to the work breakdown.** 2.4 says `get_run` "should report the binding"; note that
> `get_run` reports *nothing* about the checkout today. `checkout_root` is on `RunMeta` only.
> `RunSummary` / `RunDetail` (`src/runstore/port.ts`) and `RunProjection`
> (`src/projection/projectRun.ts:32-56`, exported as `projectRunForMcp` at `:140`) have no checkout
> field at all, and `store.readRun` never surfaces one. Exposing the binding is a new field on the
> projection, not a rename.

**The fingerprinting machinery that `list_checkout_changes` can reuse.**
`createGitCheckoutCapability(root)` (`src/runtime/gitCheckoutCapability.ts:88-115`) captures a
snapshot of tracked + untracked files with content hashes (`filesAt` at `:54-66`, `fingerprintFile`
at `:37-52`) and diffs two snapshots into `{ path, status }` with
`added | untracked | modified | deleted` (`changesSince` at `:91-113`). Its single caller is
`src/runtime/verifiedStageExecution.ts:105`, gated on `roots.checkoutRoot`. Its `runGit` helper
(`:13-31`) already does the right thing — `execFile("git", ["-C", root, ...args])`, `maxBuffer`
16 MB, stderr-first error message — but has **no timeout** and no error classification.

**Env vars.** The constant `STAGEFLOW_RUN_WORKSPACE` exists (`src/runtime/stageRoots.ts:21`) but
`bindRunWorkspaceEnv` is a **deliberate no-op** (`:125-127`), asserted as such by
`tests/agent.piAdapter.session.test.ts:92-98`.

> **Correction to the work breakdown.** 2.6's table marks `STAGEFLOW_RUN_WORKSPACE` as "(exists
> today)". The *name* exists; the export does not. Nothing in `src/` sets it in a stage's
> environment. Stage children today get `{ ...process.env, ...this.env, SF_STAGE_WORKER: "1" }`
> (`src/runtime/stageProcessLauncher.ts:210`), so the whole path contract in 2.6 — including
> `STAGEFLOW_RUN_WORKSPACE` — is new work in this slot.
>
> For comparison, `STAGEFLOW_STAGE_ARTIFACTS_DIR` (`src/config/resolveStageMcpServers.ts:29-38`) is
> a **prompt/`.mcp.json` interpolation token**, not an exported variable. Do not copy that
> mechanism for the 2.6 variables; they must be real environment entries on the forked child.

**Task schema.** `TaskFile` is `{ id, goal, context?, constraints?, checkout?, input? }`
(`src/types/task.ts`). `parseTaskFile` (`src/config/loadTask.ts:10-40`) requires `id` and `goal` as
strings, validates `input` is a plain object, and **silently drops every unknown key** — so adding
`repository` / `ref` to the YAML without touching this function makes them vanish with no error.
Failure code in use: `task.invalid_shape` (`:15`, `:25`).

**Surfaces.**

| Surface | State |
|---|---|
| MCP `start_run` | `startRunSchema` is `{ pipeline, task_path?, task }` only (`src/mcp/catalogTools.ts:64-76`); `taskFileSchema` at `:38-45` mirrors `TaskFile` including `checkout`. The handler (`:183-216`) forwards only `{ pipeline, task: taskInput }` — no `checkoutOverride`, `skipGates`, or CI metadata |
| REST `POST /api/runs` | `src/server/http.ts:352-423`. Accepts `task` (string or `TaskFile`), `pipeline` (**string only** — no inline pipeline), `checkoutOverride`, `skipGates`, `gitSha`, `ciPrUrl`, `ciJobUrl`, each type-checked inline. Returns `202 { runId }` |
| CLI `sf run` | `--checkout <path>` at `src/cli/runCommand.ts:93-98`, passed as `checkoutOverride` at `:278`; usage string at `:22` and `src/cli.ts:39`; a second parser at `src/cli.ts:161-166` |
| A2A | `src/a2a/service.ts:159-161` calls `startRunOnce` with an inline task built from the publication: `{ id: taskId, goal: publication.goal, input }`. No checkout, no repository |
| `get_run` | `src/mcp/catalogTools.ts:218-238` → `projectRunForMcp` (no binding fields, see above) |
| `read_artifact` | `src/mcp/catalogTools.ts:241-...` → `readRunArtifactBytes` (`src/mcp/readArtifact.ts:99-115`) |

**Containment pattern to reuse for `read_checkout_file`** (`src/mcp/readArtifact.ts`):
`assertSafeRunId` rejects `..`, separators and absolute run ids (`:7-19`);
`resolveRunArtifactFile` (`:57-97`) rejects absolute paths, rejects any `..` segment, **denies any
`.pi-agent` path segment and any basename `auth.json`** (`:73-78`), then `realpath`s both the root
and the candidate and asserts `isInsideDir(fileReal, workspaceReal)` (`:92-93`). Copy this shape
exactly, rooted at the worktree instead of the run workspace.

**Git identity.** No `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `user.name`, `user.email`, or
`safe.directory` anywhere in `src/`. Stages commit through Pi's `bash` tool, inheriting the
developer's `~/.gitconfig` **by accident**. A container has no `~/.gitconfig`.

**Also verified, for context:** `verify` commands run via `spawn(input.command, { shell: true })`
(`src/runtime/completionCheckRunner.ts:195-197`), i.e. `/bin/sh -c`. That is slot 4's rider (10.3),
not yours — but it is why the 2.6 lint on hardcoded paths matters: a `verify` command with a literal
worktree path fails with a terse non-zero exit and no explanation.

## The work

### 2.0 — One binding per Run, XOR enforced

**Today.** `task.checkout` or nothing. Enforced nowhere beyond "does this directory exist".

**Target.** `TaskFile` grows `repository?: string` and `ref?: string`. A resolver returns a
discriminated binding, and the XOR is a load-time validation error, not a runtime surprise.

```ts
// src/runtime/workspaceBinding.ts (new)
export type WorkspaceBinding =
  | { kind: "repository"; repository: string; ref: string }
  | { kind: "checkout"; path: string }
  | { kind: "unbound" };
```

Named error codes, in the existing `task.*` namespace (`src/config/loadTask.ts`):

| Code | When |
|---|---|
| `task.binding_conflict` | both `repository` and `checkout` present (also when `--checkout` / `checkoutOverride` is supplied for a `repository` task) |
| `task.repository_ref_required` | `repository` present, `ref` absent or blank |
| `task.ref_without_repository` | `ref` present, `repository` absent |
| `task.repository_invalid` | `repository` is not `owner/repo` (v1 accepts GitHub `owner/repo` only) |

**Design decisions already made — do not relitigate.**

- **Three kinds, not two.** Unbound stays, because pipelines that touch no repo are a real use case
  and already work.
- **`ref` is required when `repository` is set.** An implicit default branch means the run record
  cannot say what the caller asked for, and "rerun against the ref" becomes ambiguous.
- **GitHub `owner/repo` only in v1.** Arbitrary git URLs are explicitly *not locked*
  ([`../host-owned-worktrees.md`](../host-owned-worktrees.md), "Not locked"). Keep the host segment
  in the cache layout anyway so adding GitLab later is not a migration.
- **`checkoutOverride` never upgrades to a repository.** It stays a path-checkout-only override, and
  supplying it against a `repository` task is `task.binding_conflict` rather than a silent win for
  one of them.

**Files likely to touch.** `src/types/task.ts`, `src/config/loadTask.ts` (parse + validate the new
keys; remember unknown keys are dropped today), `src/runtime/workspaceBinding.ts` (new),
`src/runtime/stageRoots.ts`, `src/mcp/catalogTools.ts` (`taskFileSchema`).

### 2.1 — A real `src/git/` module

**Today.** Three ad-hoc `execFile` / `execFileSync` call sites, no timeouts, no classification, raw
stderr as the error message.

**Target.** `src/git/` owns every git invocation.

```
src/git/
  exec.ts        runGit(): execFile with an arg array, timeout, abort signal, redaction
  errors.ts      GitError + the code taxonomy
  operations.ts  cloneBare, fetch, resolveRef, worktreeAdd, worktreeRemove,
                 worktreePrune, deleteBranch, revParse, diff
  version.ts     gitVersion() for health / doctor
```

Error taxonomy — the harness must be able to tell "your token is wrong" from "that branch doesn't
exist":

```ts
export type GitErrorCode =
  | "auth_failed" | "ref_not_found" | "repo_not_found"
  | "network" | "disk_full" | "git_missing" | "timeout" | "unknown";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly argv: string[];      // never includes a credential
  readonly stderr: string;      // redacted
  readonly exitCode: number | null;
}
```

Classify from exit code plus stderr matching (`Authentication failed`, `could not read Username`,
`Repository not found`, `couldn't find remote ref`, `unknown revision`, `Could not resolve host`,
`No space left on device`, `ENOENT` on the binary itself). Default to `unknown` rather than
guessing.

**Design decisions already made — do not relitigate.**

- **No `simple-git`, no `isomorphic-git`.** The surface is small, shelling out is already the
  pattern, and a native `git` binary is going into the image regardless.
- **`execFile` with argument arrays. Never `shell: true`.** Repository names and refs are
  caller-supplied; a shell would make them injectable. (`gitCheckoutCapability.ts:13-31` already
  gets this right — match it.)
- **Per-operation timeouts, defaulted and configurable.** Suggested: `resolveRef` / `revParse` 30 s,
  `worktreeAdd` / `worktreeRemove` 120 s, `fetch` 300 s, `cloneBare` 900 s. A fetch that hangs
  against an unreachable remote must not hold a start request open forever.
- **Redact before the string exists.** Run every stderr buffer through one redaction function on the
  way out of `runGit`, not at each log site, so a new call site cannot leak by omission. This is the
  most likely credential leak path in the codebase.
- **`stderr` goes into the run record**, redacted, so a failed link is diagnosable without shell
  access.

Migrate `src/project/findProjectRoot.ts:24`, `src/config/migrateYaml.ts:144`/`:158`, and
`src/runtime/gitCheckoutCapability.ts:13-31` onto `src/git/exec.ts` **as part of this slot** — three
mechanical changes, and leaving them behind guarantees a fourth ad-hoc git call site next quarter.
`findProjectRoot` and `migrateYaml` are synchronous; keep a `runGitSync` in `exec.ts` rather than
making them async.

**Files likely to touch.** `src/git/*` (new), the three existing call sites above.

### 2.2 — The bare clone cache

**Layout** (under slot 1's resolved root):

```
$STAGEFLOW_HOME/repos/<host>/<owner>/<repo>.git
# e.g. $STAGEFLOW_HOME/repos/github.com/acme/api.git
```

Concrete commands:

```bash
# first time
git clone --mirror https://github.com/acme/api.git \
  "$STAGEFLOW_HOME/repos/github.com/acme/api.git"

# subsequently
git -C "$STAGEFLOW_HOME/repos/github.com/acme/api.git" remote update --prune
```

**Design decisions already made — do not relitigate.**

- **Keep the `<host>` segment even though v1 is GitHub-only.** A path that assumed `github.com` is a
  migration the first time someone wants a self-hosted remote.
- **Mirror, not shallow.** Shallow clones break `git log`, `blame` and `merge-base`, which agents
  genuinely use; the cache is shared across every Run of that repo, so the cost is paid once. If
  size becomes a problem, reach for `--filter=blob:none` (partial clone) before `--depth`.
- **Serialise fetches per repository.** Two Runs starting at once on the same repo must not both hit
  the network, and concurrent `remote update` on one object store is how you corrupt a cache. Use an
  in-process async mutex keyed by the absolute cache path, **plus** an advisory lock file
  (`<repo>.git/.stageflow-fetch.lock`, written with `O_EXCL`, holding pid + timestamp, with a stale
  takeover after a timeout) so a stray `sf` process in the same container cannot race the Host.
- **Freshness policy.** Fetch when `ref` is a branch or tag. **Skip the fetch entirely when `ref` is
  a full 40-hex SHA already present in the object store** (`git cat-file -e <sha>^{commit}`). This
  is the difference between a 200 ms start and a 15 s start on a repeated run, and it is correct
  rather than merely fast.
- **Never write the token into the cache's `git config`.** See 2.5.

**Eviction** is specified here and **implemented in slot 3**: a cache is evictable when it has no
live worktrees and no Run activity inside a TTL. What slot 2 owes slot 3 is the ability to answer
both questions — `git worktree list --porcelain` on the cache, and `repository` on the run records.

**Files likely to touch.** `src/git/cache.ts` (new: path derivation, mutex, lock file, freshness),
`src/git/operations.ts`.

### 2.3 — Ref resolution and recording

**Today.** Nothing resolves refs. `RunMeta.git_sha` is caller-supplied CI provenance.

**Target.** Resolve the ref to a concrete SHA **before** creating the worktree, then create the
worktree at that SHA.

```bash
# after the fetch, against the bare cache
git -C "$CACHE" rev-parse --verify --end-of-options "refs/remotes/origin/main^{commit}"
# a mirror clone maps refs directly, so origin/main is also reachable as refs/heads/main;
# resolve explicitly rather than relying on DWIM, and fail with ref_not_found when absent
```

Record **all three** on the Run:

| Field | Value |
|---|---|
| `repository` | `acme/api` — normalised |
| `ref` | `main` — exactly as the caller wrote it |
| `resolved_sha` | `a1b2c3d…` — full 40-hex |

Why all three: without `resolved_sha` the run record is a lie about what actually ran; without the
original `ref` string, rerun can only ever replay history.

**Rerun semantics — already decided.** **Default: replay the `ref`**, so "rerun" means "run it again
against the current branch", which is what people mean. `rerun(runId, { pinned: true })` replays
`resolved_sha` exactly. State this in `docs/cli-reference.md` and `docs/mcp.md`, because the wrong
guess here is surprising in both directions. Note `rerun` currently takes only `runId`
(`src/runtime/runManager.ts:680`) and replays the stored task YAML, so `pinned` is a new optional
parameter that must be threaded through MCP `rerun`, `POST /api/runs/:id/rerun`
(`src/server/http.ts:425-428`), and the CLI.

**Files likely to touch.** `src/git/operations.ts`, `src/runstore/port.ts` (`RunMeta`,
`CreateRunInput`), `src/runstore/sqlite/schema.ts` + a numbered migration,
`src/runstore/sqlite/SqliteRunStore.ts` (insert/select column lists at `:555-567`, `:1076`,
`:1615`, `:1629`), `src/runtime/pipelineRunner.ts`, `src/runtime/runManager.ts`.

### 2.4 — The worktree

```bash
git -C "$CACHE" worktree add -b "stageflow/run-$RUN_ID" \
  "$STAGEFLOW_HOME/worktrees/$RUN_ID" "$RESOLVED_SHA"
```

**Design decisions already made — do not relitigate.**

- **A branch, not a detached HEAD.** Stages commit. Committing on a detached HEAD and then pushing
  is a sharp edge for no benefit.
- **Branch name from a template.** Default `stageflow/run-<runId>`. Overridable per-task
  (`run_branch_template`) and host-wide via `STAGEFLOW_RUN_BRANCH_TEMPLATE`. Supported
  placeholders: `<runId>`, `<taskId>`. Validate the rendered name with `git check-ref-format
  --branch` and fail with a named error rather than letting git reject it mid-sequence. Run ids are
  already ref-safe (`newRunId()`, `src/runstore/paths.ts:6-9`, is an ISO stamp plus hex), but a
  templated `<taskId>` is not.
- **The branch outlives the worktree, deliberately.** Branches created in a worktree live in the
  bare repo's refs, so `git worktree remove` does not lose committed work. That is the right
  default, and it makes branch cleanup a separate GC decision (slot 3), not a side effect.
- **Path is `$STAGEFLOW_HOME/worktrees/<runId>`**, flat, one level — so slot 3's GC can enumerate by
  `readdir` and cross-check against run ids.

**Record on the Run:** `checkout_root` (the worktree path — reuse the existing column, so
`buildStageRoots`, `stageWorker.ts:59` and the verify capability keep working unchanged),
`repository`, `ref`, `resolved_sha`, `run_branch`.

**Remove** (slot 3 calls this; slot 2 provides it and uses it on the error path):

```bash
git -C "$CACHE" worktree remove --force "$STAGEFLOW_HOME/worktrees/$RUN_ID"
git -C "$CACHE" worktree prune
```

Handle the case where the directory was deleted underneath git: `worktree remove` fails, and
`worktree prune` must be able to recover the cache's administrative state. So treat prune as the
recovery path, not an optional tidy — call it unconditionally after a failed remove.

**Surface the binding on `get_run`** so a harness can show *"this run is working on `acme/api` at
`main` (`a1b2c3d`) on branch `stageflow/run-…`"*. As established above, this means new fields on
`RunSummary` / `RunDetail` and `RunProjection` — they carry no checkout information today.

**Files likely to touch.** `src/git/operations.ts`, `src/runtime/workspaceBinding.ts`,
`src/runtime/pipelineRunner.ts`, `src/runstore/port.ts`, `src/projection/projectRun.ts`,
`ui/src/` run detail (see [`ui/AGENTS.md`](../../../ui/AGENTS.md) before touching the console).

### 2.5 — Credentials stay Host-side

**Today.** Nothing fetches, so nothing needs credentials.

**Target.** The Host reads `GITHUB_TOKEN` / `GH_TOKEN` (and `GITHUB_TOKEN_FILE` / `GH_TOKEN_FILE`)
from **its own** environment and supplies them to git through a helper:

```bash
# GIT_ASKPASS points at a tiny executable the Host writes under $STAGEFLOW_HOME (mode 0700)
GIT_ASKPASS=$STAGEFLOW_HOME/git-askpass
GIT_TERMINAL_PROMPT=0     # never block on a tty that does not exist
```

The helper receives git's prompt on `argv[1]`, prints the username (`x-access-token`) or the token
on stdout, and reads the secret from **its own** environment or a file — so the value never appears
in an argument list visible to `ps`.

**Design decisions already made — do not relitigate.**

- **Never interpolate the token into a remote URL.** `https://x-access-token:TOKEN@github.com/...`
  leaks it into `git config`, the reflog, and every error message. This is the single rule to get
  right.
- **The harness never sends a token on `start_run`.** Cloning is a Host operation
  ([`../host-owned-worktrees.md`](../host-owned-worktrees.md), locked decision 8). Reject a
  token-shaped field on the start payload rather than ignoring it.
- **`GIT_TERMINAL_PROMPT=0` on every invocation.** Otherwise an unauthenticated fetch in a container
  hangs instead of failing, and the timeout from 2.1 is the only thing that saves you.
- **Host fetch credentials and stage credentials are different things.** A stage that raises a PR
  with `gh` needs a token; a stage that writes code does not. That opt-in is slot 6's `secrets:`
  declaration. All this slot owes slot 6 is *not* putting the token in the stage environment by
  accident. Note `src/runtime/stageProcessLauncher.ts:210` currently spreads the whole
  `process.env` into every stage child, so **today the token you add for fetching is visible to
  every stage's `bash`** until slot 6 lands. Say so in the changelog.
- **One credential-materialisation path.** Slot 6's file-backed credentials (rider 10.6) must reuse
  this helper rather than growing a second mechanism.

**Files likely to touch.** `src/git/credentials.ts` (new), `src/git/exec.ts`, slot 1's home
resolver.

### 2.6 — The stable path contract

**The problem worktrees create.** The Checkout is now `$STAGEFLOW_HOME/worktrees/<runId>/` — a
different absolute path on every Run. Any stage prompt, skill, or `verify` command containing a
literal path breaks.

**Target.** Export these to every stage, and document them as the **only** supported way to refer to
the workspace:

| Variable | Meaning | Present when |
|---|---|---|
| `STAGEFLOW_CHECKOUT` | the working tree, whatever kind of binding produced it | binding is `repository` or `checkout` |
| `STAGEFLOW_RUN_WORKSPACE` | the run's own scratch / artifact area | always |
| `STAGEFLOW_REPOSITORY` | `owner/repo` | binding is `repository` |
| `STAGEFLOW_REF` | the ref as declared | binding is `repository` |
| `STAGEFLOW_BASE_SHA` | the resolved SHA the worktree started from | binding is `repository` |
| `STAGEFLOW_RUN_BRANCH` | the branch the worktree is on | binding is `repository` |

**Design decisions already made — do not relitigate.**

- **Env is the v1 contract. No mount namespaces.** Do not take `SYS_ADMIN` to remount the worktree
  over a fixed `/workspace`. A stable symlink is allowed later; env is what ships
  ([`../host-owned-worktrees.md`](../host-owned-worktrees.md), locked decision 4).
- **Absent, not empty, when not applicable.** An empty `STAGEFLOW_REPOSITORY` reads as a bug in
  every consuming script; unset is checkable with `${VAR:?}`.
- **Set them on the forked child explicitly**, in `StageProcessLauncher`, not via
  `process.env` mutation on the Host. `bindRunWorkspaceEnv` is a no-op precisely because mutating
  the Host's `process.env` is unsafe with concurrent stages
  (`tests/agent.piAdapter.session.test.ts:110`, "allows overlapping … for concurrent bound
  stages"). Thread the values through `StageProcessLauncherOptions.env` / the stage worker protocol
  (`src/runtime/stageWorkerProtocol.ts`) instead, and **keep `bindRunWorkspaceEnv` a no-op**.
- **`STAGEFLOW_RUN_WORKSPACE` ships in this slot**, despite the work breakdown calling it existing.

**The lint.** Add a `sf validate` check that flags absolute paths under `$STAGEFLOW_HOME` (and any
literal `worktrees/` path segment) in stage prompts and `verify` commands:

```
catalog.hardcoded_host_path — "verify command in stage `test` contains an absolute path under
  the Stageflow home; use $STAGEFLOW_CHECKOUT"
```

Severity: warning, so existing catalogs still validate, promoted by `--strict`. Cheap lint, saves a
confusing failure. `docs/yaml-catalog.md:853` documents the validation scope — update it.

**Files likely to touch.** `src/runtime/stageProcessLauncher.ts`,
`src/runtime/stageWorkerProtocol.ts`, `src/runtime/stageWorker.ts`, `src/runtime/stageRoots.ts`,
`src/config/` validation, `docs/yaml-catalog.md`, `docs/envelopes.md` if prompts are documented
there.

### 2.7 — The lease becomes path-checkout-only

**Today.** One active Run per `realpath(checkout)`, so two Runs on the same repo conflict with
`busy_checkout` (`src/runtime/runManager.ts:1718-1731`).

**Target.** The lease applies to **path checkouts only**. Repository-bound Runs each have their own
worktree and run in parallel — that is the main practical reason to want this feature at all.

Mechanically: `reserveAndStartPipeline` computes `checkoutKey` only when the resolved binding is
`kind: "checkout"`. `busy_capacity` is unaffected. The same condition must be applied to the two
other lease-acquiring paths — attach (`:351-385`) and `trackResume` (`:1834-1880`) — both of which
read durable `meta.checkout_root` and would otherwise re-lease a worktree after a Host restart.
Distinguishing them requires the new `repository` column on the run record, so **do not key this off
"does the path live under `$STAGEFLOW_HOME/worktrees`"** — key it off the recorded binding kind.

**This is an observable behaviour change and must be in the changelog.** Callers that today treat
`busy_checkout` as "wait and retry" will simply stop seeing it for repository-bound runs.
`busy_checkout` stays in `BusyCode` and keeps its meaning for path checkouts.

**Files likely to touch.** `src/runtime/runManager.ts`, `tests/runtime.parallel-runs.test.ts`,
`CHANGELOG`/release notes, `docs/cli-reference.md` (the `busy_*` documentation).

### 2.8 — Failure handling: no half-built Run

**Target.** A failed link fails the start. If clone, fetch, ref resolution, or worktree creation
fails, the start returns a structured error and **no Run is created** — no half-built row in the
store, no orphan worktree.

Order of operations, and this order is deliberate:

1. Parse + validate the task; resolve the binding (2.0). Failures here are `400`.
2. `tryReserve` for capacity (and the path-checkout lease, if applicable).
3. Ensure the bare cache; fetch under the per-repo mutex (2.2).
4. Resolve the ref to a SHA (2.3).
5. `worktree add` (2.4).
6. `store.createRun({ ..., checkoutRoot, repository, ref, resolvedSha, runBranch })`.
7. Start the pipeline.

Steps 3–5 happen **before** `createRun`, so a failure in any of them leaves nothing in the store.
The compensating action on the error path is: remove the worktree if step 5 succeeded, delete the
branch if it was created, `worktree prune` regardless, then `clearReservation`. Wrap it so that a
cleanup failure is logged and does not mask the original `GitError`.

**The case the work breakdown calls out explicitly:** the worktree was created but `createRun`
threw. That must remove the worktree. Structure this as one `try`/`catch` with a rollback list of
thunks rather than nested `try`s, so a new step cannot be added without a rollback.

Error codes returned to the caller — stable, so a harness can branch on them (this is slot 7's error
taxonomy, 8.5, but these codes are born here):

| Code | HTTP | Meaning |
|---|---|---|
| `repository_auth_failed` | 401 | the Host's git credential was rejected |
| `repository_not_found` | 404 | no such repository, or the credential cannot see it |
| `ref_not_found` | 404 | the ref does not exist on the remote |
| `repository_fetch_failed` | 502 | network / transport, including timeout |
| `worktree_create_failed` | 500 | git refused to create the worktree |
| `git_missing` | 500 | no `git` on `PATH` |
| `insufficient_disk` | 507 | out of space (slot 3's 11.4 generalises this) |

Every one carries the redacted `stderr`. Do **not** return raw git stderr as the top-level message.

**Files likely to touch.** `src/runtime/runManager.ts`, `src/runtime/pipelineRunner.ts`,
`src/git/*`, `src/mcp/toolResults.ts`, `src/server/http.ts` (`mapStartFailure`).

### 2.9 — Surface it everywhere

Not done until **all** of these accept, record, or display a repository binding.

**Task YAML** (`docs/yaml-catalog.md` "Tasks" table at `:799-810` gains two rows):

```yaml
# tasks/fix-flaky.task.yaml
id: fix-flaky-test
goal: Make tests/retry.test.ts deterministic and open a PR
context: The retry helper races on a shared timer.
repository: acme/api
ref: main
# run_branch_template: stageflow/flaky-<runId>   # optional
input:
  failing_test: tests/retry.test.ts
```

```yaml
# rejected: task.binding_conflict
id: bad
goal: ...
repository: acme/api
ref: main
checkout: /Users/me/work/acme-api
```

```yaml
# rejected: task.repository_ref_required
id: bad
goal: ...
repository: acme/api
```

**`sf validate`** must report all four 2.0 codes for a task file, and the new
`catalog.hardcoded_host_path` warning for pipelines. It must **not** attempt a network fetch —
`docs/yaml-catalog.md:853` states validation does not check credentials or checkout paths, and
resolving a ref would break that promise and make `sf validate` slow and offline-hostile.

**MCP `start_run`** (`src/mcp/catalogTools.ts:38-76`, `:183-216`). Add `repository` / `ref` /
optional `run_branch_template` to `taskFileSchema`. While you are in there, close the parity gaps
the same schema has (slot 9's 9.1 — cheap to do now, and the handler already drops them):
`checkout_override`, `skip_gates`, `git_sha`, `ci_pr_url`, `ci_job_url`. Update the tool description:
it currently documents `busy_checkout` as "same checkout leased", which 2.7 narrows.

**REST `POST /api/runs`** (`src/server/http.ts:352-423`). The binding arrives inside `task` when
`task` is a `TaskFile` object, so the main work is making `isTaskFile` accept and preserve the new
keys, plus the `mapStartFailure` codes from 2.8. Body-level `repository` / `ref` are **not** added —
one place to declare a binding, and it is the task.

**CLI `sf run --repository owner/repo --ref main`** (`src/cli/runCommand.ts:22`, `:66-98`, `:278`;
plus the second parser at `src/cli.ts:154-177` and the usage block at `src/cli.ts:39`). These are an
*override on the task*, so `--repository` with a task declaring `checkout` is
`task.binding_conflict`, and `--repository` without `--ref` is `task.repository_ref_required`.
`--checkout` keeps working for path bindings.

**A2A** (`src/a2a/service.ts:159-161`). The publication builds the task inline, so a publication
needs optional `repository` / `ref` fields that flow into that object. Config is read once at boot
with no reload — that is deliberate; do not add reload here.

**`get_run` / run detail / operator console.** New fields on `RunSummary` / `RunDetail` /
`RunProjection` (see Verified current state — there is nothing to rename). Suggested shape, so the
three kinds stay legible:

```jsonc
{
  "run_id": "2026-09-21T…-a1b2c3",
  "binding": {
    "kind": "repository",
    "repository": "acme/api",
    "ref": "main",
    "resolved_sha": "a1b2c3d4e5f6…",
    "run_branch": "stageflow/run-2026-09-21T…-a1b2c3",
    "checkout_root": "/data/worktrees/2026-09-21T…-a1b2c3"
  }
}
```

For a path checkout, `{ "kind": "checkout", "checkout_root": "/Users/me/work/acme-api" }`. For
unbound, `{ "kind": "unbound" }`. `sf runs show --json` and `sf export-run` pick this up through the
same projection.

**`rerun`** replays the binding from the stored task YAML for free once the schema carries it. Add
the `pinned` option from 2.3.

**Files likely to touch.** `src/types/task.ts`, `src/config/loadTask.ts`, `src/mcp/catalogTools.ts`,
`src/server/http.ts`, `src/cli/runCommand.ts`, `src/cli.ts`, `src/a2a/service.ts`,
`src/a2a/config*.ts`, `src/projection/projectRun.ts`, `src/runstore/port.ts`, `ui/src/`,
`docs/yaml-catalog.md`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/ci.md`.

### 10.4 (rider) — Git identity and `safe.directory`

**Today.** Nothing. Stages inherit the developer's `~/.gitconfig` by accident
(`src/runtime/stageProcessLauncher.ts:210` spreads `process.env`, and git reads `$HOME/.gitconfig`).

**Failure.** A container has no `~/.gitconfig`, so the **first `git commit` in any stage fails** with
git's *"Please tell me who you are."* Slot 6 removes even the accidental path. This is the failure
that will make the first container user think the product is broken.

**Target.** The Host sets, in the curated stage environment from 2.6:

```
GIT_AUTHOR_NAME     default "Stageflow"
GIT_AUTHOR_EMAIL    default "stageflow@localhost"
GIT_COMMITTER_NAME  same default
GIT_COMMITTER_EMAIL same default
```

**Design decisions already made — do not relitigate.**

- **Env vars, not a written `~/.gitconfig`.** `GIT_*_NAME`/`GIT_*_EMAIL` beat config file precedence,
  work with a read-only home, and cannot be mutated by a stage editing a tracked file.
- **An honest default, not a plausible human.** `Stageflow <stageflow@localhost>` — a commit made by
  an agent should not be attributable to a person who did not make it.
- **Overridable per-host** (`STAGEFLOW_GIT_AUTHOR_NAME` / `_EMAIL`, and the committer pair) **and
  per-task** (`git_identity: { name, email }` on the task). Record the effective values on the run,
  so "who committed this" is answerable from the record.
- **Also set `safe.directory` for the worktree.** A uid mismatch on a bind-mounted repo otherwise
  trips git's ownership check — a second silent container-only failure in the same area. Prefer
  `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0=safe.directory` / `GIT_CONFIG_VALUE_0=<checkout>` in the
  stage environment over writing global config, so it is scoped to the run and needs no writable
  home:

  ```
  GIT_CONFIG_COUNT=1
  GIT_CONFIG_KEY_0=safe.directory
  GIT_CONFIG_VALUE_0=/data/worktrees/<runId>
  ```

  If a later slot needs more `GIT_CONFIG_*` entries, they must agree on the counter — leave a note
  where the env is assembled.

**Files likely to touch.** `src/runtime/stageProcessLauncher.ts`, `src/runtime/stageRoots.ts`,
`src/types/task.ts`, `src/runstore/port.ts`, `docs/yaml-catalog.md`.

### 13.1 (rider) — Three read-only visibility tools

**Today, this is the biggest regression the container introduces.** Locally, mid-run, you open the
checkout in your editor and run `git diff`. Remotely there is no equivalent: `read_artifact` is
strictly confined to the run workspace (`src/mcp/readArtifact.ts:82-93`) and nothing reads from the
checkout or returns a diff. Worktree-per-Run makes it worse, because the tree moves somewhere the
user cannot reach without `docker exec`.

All three are **read-only**, scoped to the Run's binding, and return a named error when the run is
unbound (`run_not_bound`) or its worktree has already been reclaimed by slot 3's GC
(`checkout_reclaimed`).

**`list_checkout_changes(runId)`** — nearly free. `createGitCheckoutCapability`
(`src/runtime/gitCheckoutCapability.ts:88-115`) already fingerprints tracked and untracked files and
already separates them. Either reuse it against the recorded `checkout_root`, or — better for a
repository binding, where a base SHA exists — go straight at git:

```bash
git -C "$CHECKOUT" status --porcelain=v1 -z --untracked-files=all
```

Return `[{ path, status }]` with the same vocabulary the capability already uses
(`added | untracked | modified | deleted`) so the console and the verify checks agree. Cap the
number of entries and report truncation.

**`get_run_diff(runId, { mode: "stat" | "patch", path?, maxBytes? })`** — belongs in `src/git/`.

```bash
# stat
git -C "$CHECKOUT" diff --stat "$STAGEFLOW_BASE_SHA" -- [path]
# patch
git -C "$CHECKOUT" diff --patch --no-color "$STAGEFLOW_BASE_SHA" -- [path]
# plus, so new files are not invisible:
git -C "$CHECKOUT" ls-files --others --exclude-standard -z
```

`--` before `path` is mandatory: a caller-supplied path must never be parsed as a revision. Default
`mode: "stat"`, because an unbounded patch of a large change is a context-window hazard; enforce
`maxBytes` with an explicit `truncated: true` in the response rather than silently cutting. For a
path checkout with no base SHA, diff against `HEAD` and say so in the response.

**`read_checkout_file(runId, relativePath)`** — same containment and deny-list logic as
`readArtifact`, rooted at the worktree. Reuse the pattern at `src/mcp/readArtifact.ts` literally:
`assertSafeRunId` (`:7-19`), reject absolute paths and `..` segments, deny `.pi-agent` segments and
`auth.json` basenames (`:73-78`), `realpath` both sides and assert `isInsideDir` (`:92-93`). Reuse
`classifyArtifactContent` (`:43-55`) so images and non-UTF-8 bytes behave the way `read_artifact`
already does. **Factor the containment check into one shared function** used by both tools rather
than copying it — a divergent copy is how a traversal bug gets introduced later.

Deliberately **not** included: writing to the checkout, running arbitrary git, or a shell. A remote
shell over MCP is explicitly rejected (see Out of scope).

Expose all three on MCP; the equivalent REST reads are `GET /api/runs/:id/changes`,
`/api/runs/:id/diff`, `/api/runs/:id/file?path=` — useful for the console and cheap once the
functions exist.

**Files likely to touch.** `src/mcp/checkoutTools.ts` (new), `src/mcp/tools.ts` (registration),
`src/mcp/readArtifact.ts` (extract shared containment), `src/git/operations.ts`,
`src/server/http.ts`, `docs/mcp.md`.

## Out of scope

- **Worktree GC, TTL, run delete, run cancel — slot 3.** Slot 2 provides `worktreeRemove` /
  `worktreePrune` / `deleteBranch` and uses them on its own error path; slot 3 owns the sweep, the
  retention policy, and `sf runs gc`. Ship them together.
- **Run-scoped skills (`start_run.skills`) — slot 9.** Note the constraint it imposes on you:
  skills are materialised *beside* the Run, never inside the worktree, which would dirty the PR.
- **Curated stage environment / `secrets:` declarations — slot 6.** This slot must not depend on the
  allowlist existing, and must not be *broken* by it: every variable 2.6 and 10.4 introduce has to
  be on slot 6's allowlist by construction.
- **The Dockerfile, compose file, and registry publishing — after all nine slots.** A Dockerfile
  written now gets rewritten.
- **Do not add a `land` / apply-delta API.** Explicitly rejected
  ([`../host-owned-worktrees.md`](../host-owned-worktrees.md)). The Run's branch in its worktree is
  the git record; opening a PR is a pipeline stage, not a Host feature.
- **Do not do a full `git clone` per Run.** Rejected — that is what the shared bare cache exists to
  avoid.
- **Do not use Linux mount namespaces / a `/work` overlay.** Rejected. Env vars are the v1 stable
  path contract; taking `SYS_ADMIN` is not on the table.
- **Do not add one shared working copy per repo**, do not have a first stage `git clone`, and do not
  accept a token on `start_run`. All three are rejected.
- **No `simple-git` / `isomorphic-git` dependency.**
- **No `exec` tool or web terminal over MCP** (rejected in 13.7). The three visibility tools are
  read-only by design.
- **`sf validate` must not hit the network.** Ref resolution is a start-time operation.

## Acceptance criteria

1. A task with `repository: acme/api` + `ref: main` and no `checkout` starts a run; the agent's
   `cwd` is `$STAGEFLOW_HOME/worktrees/<runId>`; that directory is a git worktree on branch
   `stageflow/run-<runId>` whose `HEAD` is the recorded `resolved_sha`.
2. A task with both `repository` and `checkout` fails `sf validate` and fails `start_run` with
   `task.binding_conflict`. `repository` without `ref` fails with `task.repository_ref_required`.
3. `$STAGEFLOW_HOME/repos/github.com/acme/api.git` exists as a mirror after the first run and is
   **not** re-cloned on the second. A second run with a full-SHA `ref` already present performs no
   network fetch.
4. Two runs against the same `repository` + `ref` start concurrently and neither returns
   `busy_checkout`. Two runs against the same path `checkout` still produce `busy_checkout`, and a
   Host restart does not re-lease a worktree.
5. `get_run` reports the binding: kind, `repository`, `ref`, `resolved_sha`, `run_branch`,
   `checkout_root`. Path-checkout and unbound runs report their own kinds.
6. Every stage sees `STAGEFLOW_CHECKOUT`, `STAGEFLOW_RUN_WORKSPACE`, `STAGEFLOW_REPOSITORY`,
   `STAGEFLOW_REF`, `STAGEFLOW_BASE_SHA`, `STAGEFLOW_RUN_BRANCH` with correct values; the
   repository-only variables are **unset** for path and unbound bindings.
7. A stage running `git commit` succeeds with **no `~/.gitconfig` present**, and the commit's author
   and committer match the recorded identity.
8. A bad credential fails the start with `repository_auth_failed`; a bad ref with `ref_not_found`; an
   unreachable remote with `repository_fetch_failed`. In every case **no run row exists**, **no
   worktree remains**, and the reserved capacity slot is released.
9. No token appears in `git config`, the reflog, any error message, any log line, or any stage's
   environment-derived output. Grep the redaction.
10. `rerun` of a repository-bound run resolves the ref again by default and produces a **new**
    `resolved_sha` when the branch has moved; `rerun` with `pinned` reproduces the original SHA.
11. `list_checkout_changes`, `get_run_diff` (both modes), and `read_checkout_file` work mid-run
    against a repository-bound run; all three refuse an unbound run with `run_not_bound`;
    `read_checkout_file` refuses `../…`, absolute paths, `.pi-agent/**`, and `auth.json`.
12. `sf validate` emits `catalog.hardcoded_host_path` for a `verify` command containing an absolute
    path under the Stageflow home, and validation still performs no network access.
13. `npm test`, `npm run ui:test`, and `npm run typecheck` pass.
14. The lease change (2.7) and the "token is currently visible to every stage until slot 6" caveat
    (2.5) are both in the release notes.

## Testing

Follow the repo's existing patterns: tests in `tests/*.test.ts`, fixtures in
`tests/fixtures/{pipelines,stages,tasks}/`, and **extend fixtures rather than inlining YAML** when
behaviour is catalog-driven (`AGENTS.md`).

- **`src/git/` against real local repositories.** Create a source repo in a temp dir with
  `git init`, a commit or two, and a branch; mirror-clone it over a `file://` remote. That exercises
  `cloneBare`, `fetch`, `resolveRef`, `worktreeAdd`, `worktreeRemove`, `worktreePrune` and `diff`
  for real, with no network. Skip the suite when `git` is absent rather than mocking it.
- **Error taxonomy.** `ref_not_found` from a nonexistent branch; `repo_not_found` from a
  `file:///nonexistent` remote; `timeout` from a deliberately tiny timeout; `git_missing` by pointing
  the resolved binary at a path that does not exist. Assert the code, and assert the redaction on a
  stderr string containing a fake token.
- **Binding XOR.** Fixture task files for each of the four 2.0 codes, asserted through both
  `sf validate` and `startRun`.
- **Lease.** Extend `tests/runtime.parallel-runs.test.ts`: two repository-bound runs start
  concurrently; two path-checkout runs still conflict; the attach and `trackResume` paths do not
  lease a repository-bound run.
- **Rollback.** Inject a `createRun` failure after a successful `worktreeAdd` and assert the
  worktree directory is gone, `git worktree list` is clean, and no run row exists.
- **Env contract.** A stage-level assertion that the six variables arrive in the child with correct
  values, and that the repository-only four are absent for a path checkout. Keep
  `tests/agent.piAdapter.session.test.ts`'s no-op assertions for `bindRunWorkspaceEnv` passing.
- **Containment.** Mirror the existing `readArtifact` traversal tests for `read_checkout_file`,
  including symlink escape (the check is `realpath`-based, so add a symlink pointing outside the
  worktree).
- **JSON output and exit codes are part of the public contract** (`docs/ci.md`, `tests/cli.*.test.ts`)
  — cover the new `sf run --repository` flags and the new start-failure codes there.

Manual check worth doing once by hand, because it is the thing a first user hits: run a
repository-bound pipeline whose stage commits, with `HOME` pointed at an empty directory, and
confirm the commit succeeds and `git log` shows the configured identity.

## Repo conventions

- `npm run build`, `npm test`, `npm run ui:test`, `npm run typecheck` before finishing.
- Minimal, focused diffs that match the surrounding code. **No comments unless the logic is
  non-obvious. No refactors that do not serve a logic change.**
- Author new catalog contracts as `io` / `verify` / `on_verify_fail` and map them in
  `compileTargetContract` (`src/config/yamlDialect.ts`); runtime types keep the older IR key names.
  Read [`docs/yaml-catalog.md`](../../yaml-catalog.md) before touching schema or validation.
- `tests/fixtures/` is canonical YAML; keep `examples/` in sync when behaviour changes.
- Stage worker protocol lives in `src/runtime/stageWorkerProtocol.ts` — new stage-visible values go
  through it.
- Console changes: read [`ui/AGENTS.md`](../../../ui/AGENTS.md) first.
- Public docs to update: `docs/yaml-catalog.md` (task fields, validation scope),
  `docs/cli-reference.md` (`sf run` flags, `busy_*`), `docs/mcp.md` (`start_run` schema, the three
  new tools), `docs/ci.md` (error codes and exit codes) — and note `docs/mcp.md` currently
  understates what `sf mcp` serves (it serves the full REST API, not just health).
- Do not commit secrets or `.env` files.
- Positioning: stages are domain-agnostic. Do not write user-facing copy that frames this as an
  SDLC-only feature.

## Open questions for the human

1. **Cache path host segment for GitHub.** `repos/github.com/<owner>/<repo>.git` assumes the
   `owner/repo` shorthand always means `github.com`. Confirm that, or decide now whether
   `repository: gitlab.com/acme/api` should parse in v1 (the locked spec leaves
   "GitHub-only vs any git URL" open).
2. **Default branch name template.** `stageflow/run-<runId>` embeds an ISO timestamp, so branch
   names are ~40 characters. Is a shorter default (`sf/<short-run-id>`) preferable given these
   branches may end up on PRs that humans read?
3. **Branch lifetime.** The branch deliberately outlives the worktree. Should slot 2 record an
   intent flag (e.g. "this run pushed"), so slot 3's GC can delete unpushed branches and keep pushed
   ones — or is branch deletion always an explicit operator action?
4. **`safe.directory` via `GIT_CONFIG_COUNT`.** This reserves index `0` for the whole stage
   environment. Confirm that slot 6 will treat `GIT_CONFIG_*` as Host-owned and never let a task
   contribute entries, or we need a different mechanism.
5. **Fetch on a `pinned` rerun.** If the pinned SHA is no longer in the cache (evicted, or the
   branch was force-pushed and the object garbage-collected upstream), should the rerun fail with
   `ref_not_found`, or attempt a direct `git fetch origin <sha>` (which many servers refuse)?
6. **Path-checkout diffs.** `get_run_diff` against a path checkout has no `STAGEFLOW_BASE_SHA`.
   Diffing `HEAD` is proposed. Should Stageflow instead record the path checkout's `HEAD` SHA at
   start so the diff means "changed during this run" rather than "uncommitted right now"?
7. **Non-git path checkouts.** `resolveAndValidateCheckout` does not require a git repository today,
   and that is load-bearing for some users. Confirm the three visibility tools should degrade
   (`list_checkout_changes` works via the file-fingerprinting capability; `get_run_diff` returns
   `not_a_git_repository`) rather than the binding rejecting a non-git path.
