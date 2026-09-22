---
status: work-breakdown
---

# Pre-container work: getting Stageflow into the right shape

Index: [container-ready](container-ready.md) · Evidence: [container-ready-assessment](container-ready-assessment.md)

Everything that must change in the **product and the code** before a Dockerfile is worth writing.
The Dockerfile, compose file, and registry publishing are deliberately out of scope here — they are
the easy part, and they are the part that gets rewritten if any of this lands afterwards.

The organising idea: **stop patching Stageflow to survive a container, and change the model so a
container is the natural shape.** The clearest example is the Checkout. Today a Run points at a
directory that already exists on the machine. That is coherent on a laptop and incoherent in a
container, where nothing exists until something puts it there. The fix is not a bind mount — it is
to make the Host responsible for materialising a workspace from a declared Repository.

Visual walkthrough: [pre-container-work-explainer.html](pre-container-work-explainer.html).

---

## Build order

**This is the section to work from.** Nine shipping slots. The thirteen workstreams below are the
reference detail behind them — several workstreams contribute to more than one slot, and several
items are *riders* on work another slot is already doing, so building workstream-by-workstream would
open the same code repeatedly.

| Slot | Work | Ships as |
|---|---|---|
| **1** | Workstream 1 + **12.1** | Durable root is explicit; the store has a version and refuses a downgrade |
| **2** | Workstream 2 + **10.4, 13.1** | **A Run names a repository and gets its own worktree** — with a git identity, and a way to see what changed |
| **3** | Workstream 3 + **11.3, 11.4** | Worktrees get cleaned up; runs queue, cancel, and delete |
| **4** | Workstream 4 + **10.7, 10.8, 10.9, 12.5** | Restarting the Host is routine; signals reach grandchildren; output is not truncated |
| **5** | Workstream 5 + **10.11 (timeouts, console URL)** | The Host can be bound anywhere, safely |
| **6** | Workstream 6 + **10.1, 10.2, 10.5, 10.6, 11.1** | A stage sees only its declared secrets — and a working proxy, CA bundle, cache, and heap ceiling |
| **7** | Workstreams 7 + 8 + **13.3, 12.6** | Several repos, a seeded catalog, three health surfaces, config from the repo treated as untrusted |
| **8** | Workstream 12 (rest) | Backup, restore, provenance, egress posture documented |
| **9** | Workstreams 9 + 13 (rest) | Parity closed; preflight, run manifest, attribution |

### Three rules that are not negotiable

Everything else can move. These three are each a specific failure, not a preference.

1. **Slots 2 and 3 are one release.** Shipping worktree creation without worktree cleanup is
   shipping a disk leak. On a laptop you `rm -rf` by hand; in a container there is no hand.
2. **12.1 lands before the first published image, not after.** The moment there is an image tag
   someone rolls it back, and today an older binary opens a newer store happily and writes rows the
   newer code will misread. Containerizing is what creates this risk.
3. **5.3 and 5.4 are one commit.** The loopback gate is currently the only authentication `/mcp`
   has, so relaxing it alone publishes an unauthenticated endpoint that runs arbitrary `bash`.

And one efficiency rule: add the `queued` (11.3) and `cancelled` (3.1) run statuses in **one** schema
pass. Both ripple through the store, the types, MCP and REST responses, the console, and the CI exit
codes — doing them separately means paying that cost twice.

### Then the Dockerfile

After all nine slots it is mostly transcription: a base image pinned by digest, `git` and `bash` and
`tini` and `ca-certificates`, a fixed non-root uid, `ENV STAGEFLOW_HOME=/data
STAGEFLOW_BIND=0.0.0.0`, a volume, a `HEALTHCHECK` on `/livez`, and an entrypoint of `sf mcp`. A
Dockerfile written before slot 1 lands has to be rewritten after it.

---

## 1. Durable root contract

Small, unglamorous, and it blocks workstream 2 — worktrees and the bare-clone cache have to live
somewhere defined.

### 1.1 Introduce `STAGEFLOW_HOME`

**Today.** The durable root is `path.join(os.homedir(), ".stageflow")`, hardcoded in
`src/project/globalHome.ts:5`. No override exists.

**Target.** `STAGEFLOW_HOME` env var, defaulting to `~/.stageflow`. Resolved once, validated at
boot (exists or can be created, is a directory, is writable), and surfaced in health output.

**Why it matters beyond containers.** `os.homedir()` reads the passwd entry, falling back to `$HOME`.
Run as a uid with no passwd entry — which is what `--user 1000:1000` does on most images — and the
result is unpredictable. Every durable path silently relocates and the Host looks like it lost its
data.

### 1.2 Flatten the layout and write it down

**Today.** `storeRootFor(globalHome)` produces `~/.stageflow/.stageflow/`. Provider credentials are
split across `~/.stageflow/agent/auth.json` and `~/.pi/agent/auth.json`
(`src/runtime/credentialBinding.ts:40-46`). A2A artifacts sit under the store root
(`src/a2a/store.ts:120`). Nothing documents the whole tree.

**Target.** One documented layout under `$STAGEFLOW_HOME`:

```
$STAGEFLOW_HOME/
  state.db, -wal, -shm      the run store
  runs/<runId>/             run + stage + attempt workspaces
  repos/<host>/<owner>/<repo>.git    bare clone cache        (workstream 2)
  worktrees/<runId>/        per-Run working tree             (workstream 2)
  agent/auth.json           provider credentials
  a2a-artifacts/
  settings.json
```

Plus a migration that moves an existing `~/.stageflow/.stageflow/` into place on first boot, and a
decision on `~/.pi`: either bring Pi's agent dir under `$STAGEFLOW_HOME` via `PI_CODING_AGENT_DIR`,
or document it as a second required volume. One roof is better.

### 1.3 Put the store and credentials out of the agent's reach

**Today.** Artifact reads deny `.pi-agent` segments and `auth.json`
(`src/mcp/readArtifact.ts:73-78`), but Pi's own file tools have no equivalent deny list.

**Target.** A path deny list applied to the agent's read/write tools covering `$STAGEFLOW_HOME`
except the run's own workspace. Cheap, and it makes the "the store is outside the Checkout"
guarantee real rather than incidental.

---

## 2. Repository binding and Worktree-per-Run

The centrepiece. This is the change that makes a container make sense.

### 2.0 The model change

**Today.** `task.checkout` is a path to a directory that must already exist and be readable,
writable, and searchable (`resolveAndValidateCheckout`, `src/runtime/stageRoots.ts:67-94`). It does
not even have to be a git repository. If absent, the Run is "unbound" and the agent works in the run
workspace. One active Run per `realpath(checkout)`, enforced by a lease.

**Target.** A Run has exactly one **workspace binding**, of three kinds:

| Kind | Declared as | Host does | Use case |
|---|---|---|---|
| `repository` | `repository` + required `ref` | fetches into a shared bare cache, creates a `git worktree` for this Run | the container case; also the right answer locally |
| `checkout` | `checkout: <path>` | validates and uses it as-is | laptop, bind mount, non-git directory |
| unbound | neither | agent works in the run workspace | pipelines that touch no repo |

Declaring both `repository` and `checkout` is a validation error with a named code. This XOR is the
whole clarity win: today "where does this Run work" has one fuzzy answer, and afterwards it has
three sharp ones.

### 2.1 A real git service module

**Today.** `git` is shelled out to in three unrelated places for three read-only things:
`rev-parse --show-toplevel` (`src/project/findProjectRoot.ts:24`), `status --porcelain`
(`src/config/migrateYaml.ts`), and `ls-files` for checkout fingerprinting
(`src/runtime/gitCheckoutCapability.ts:15`). There is no clone, fetch, worktree, branch, or push
anywhere, and no git dependency in `package.json`.

**Target.** `src/git/` owning every git invocation, with:

- typed operations: `cloneBare`, `fetch`, `resolveRef`, `worktreeAdd`, `worktreeRemove`,
  `worktreePrune`, `deleteBranch`, `revParse`
- a structured error taxonomy rather than raw stderr: `auth_failed`, `ref_not_found`,
  `repo_not_found`, `network`, `disk_full`, `git_missing`, `timeout`. The harness needs to tell
  "your token is wrong" from "that branch doesn't exist"
- per-operation timeouts and cancellation
- stderr captured into the run record, redacted for credentials
- shell out via `execFile` with argument arrays, never `shell: true`

Deliberately *not* adding `simple-git` or `isomorphic-git`. The surface is small, the shell-out is
already the pattern, and a native git binary is going in the image regardless.

### 2.2 The bare clone cache

**Layout.** `$STAGEFLOW_HOME/repos/<host>/<owner>/<repo>.git`. Keep the host segment even though v1
only accepts GitHub — the moment someone wants GitLab or a self-hosted remote, a path that assumed
`github.com` is a migration.

**Design decisions worth making explicitly:**

- **Mirror, not shallow.** `git clone --mirror` and `git remote update --prune`. Shallow clones
  break `git log`, `blame`, and `merge-base`, which agents genuinely use, and the cache is shared
  across every Run of that repo so the cost is paid once. If size becomes a problem, reach for
  `--filter=blob:none` (partial clone) before `--depth`.
- **Serialise fetches per repository.** Two Runs starting at once on the same repo must not both
  hit the network. An async mutex keyed by repo path inside the Host, plus an advisory lock file so
  a stray `sf` process in the same container cannot corrupt the cache.
- **Freshness policy.** Always fetch when `ref` is a branch or tag. Skip the fetch when `ref` is a
  full SHA already present in the object store. This is the difference between a 200 ms start and a
  15 s start on a repeated run, and it is correct rather than just fast.
- **Cache eviction.** A bare mirror of a large monorepo is not free. GC should evict caches with no
  live worktrees and no Run activity inside a TTL. Folds into workstream 3.

### 2.3 Ref resolution and recording

**Resolve before you create.** Turn `ref` into a concrete SHA first, then create the worktree at that
SHA. Record all three on the Run: `repository`, `ref` (as the caller wrote it), `resolved_sha`.

Why all three: without `resolved_sha` the run record is a lie about what actually ran, and
`rerun` is not reproducible. Without the original `ref` string, rerun can only ever replay history.

**Rerun semantics.** Default to replaying the `ref`, so "rerun" means "run it again against the
current branch" — which is what people mean. Offer `pinned: true` to replay `resolved_sha` exactly.
State this in the docs, because the wrong guess here is surprising in both directions.

### 2.4 The worktree itself

**Create.** `git worktree add -b <branch> $STAGEFLOW_HOME/worktrees/<runId> <resolved_sha>`.

**A branch, not a detached HEAD.** Stages commit. Committing on a detached HEAD and then pushing is
a sharp edge for no benefit. Branch name from a template, default
`stageflow/run-<runId>`, overridable per-task and via `STAGEFLOW_RUN_BRANCH_TEMPLATE`.

**Record on the Run:** worktree path, branch name, base SHA. `get_run` should report the binding so
a harness can show "this run is working on `owner/repo` at `main` (`a1b2c3d`) on branch
`stageflow/run-…`".

**Remove.** `git worktree remove --force` then `git worktree prune`. Handle the case where the
directory was deleted underneath git — prune must be able to recover the cache.

**The branch outlives the worktree, deliberately.** Branches created in a worktree live in the bare
repo's refs, so removing the worktree does not lose committed work. That is the right default, and
it means branch cleanup is a separate GC decision (workstream 3), not a side effect.

### 2.5 Credentials, without putting the token in every stage

**Today.** Nothing fetches, so nothing needs credentials. The moment the Host fetches, it needs one.

**Target.** The Host reads `GITHUB_TOKEN` / `GH_TOKEN` (and `_FILE` variants) from its own
environment and uses it through a `GIT_ASKPASS` helper or a credential helper it writes into the
bare repo's config — **not** by interpolating the token into a remote URL, which leaks it into
`git config`, reflog, and error messages.

The harness never sends a token on `start_run`. Cloning is a Host operation.

**Stages are a separate question.** A stage that raises a PR with `gh` needs the token; a stage that
writes code does not. That opt-in belongs to workstream 6 — the point here is that Host fetch
credentials and stage credentials should stop being the same thing by accident.

### 2.6 The stable path contract

**The problem worktrees create.** The Checkout is now `$STAGEFLOW_HOME/worktrees/<runId>/` — a
different absolute path on every Run. Every stage prompt, skill, or `verify` command containing a
literal path breaks.

**Target.** Export to every stage, and document them as the only supported way to refer to the
workspace:

| Variable | Meaning |
|---|---|
| `STAGEFLOW_CHECKOUT` | the working tree, whatever kind of binding produced it |
| `STAGEFLOW_RUN_WORKSPACE` | the run's own scratch/artifact area (exists today) |
| `STAGEFLOW_REPOSITORY` | `owner/repo`, when repository-bound |
| `STAGEFLOW_REF` | the ref as declared |
| `STAGEFLOW_BASE_SHA` | the resolved SHA the worktree started from |
| `STAGEFLOW_RUN_BRANCH` | the branch the worktree is on |

Add a `validate` check that flags absolute paths under `$STAGEFLOW_HOME` in prompts and verify
commands. Cheap lint, saves a confusing failure.

### 2.7 Lease semantics change

**Today.** One active Run per `realpath(checkout)`, so two Runs on the same repo conflict
(`busy_checkout`).

**Target.** The lease applies to **path checkouts only**. Repository-bound Runs each have their own
worktree and are free to run in parallel — that is the main practical reason to want this feature at
all. Worth calling out loudly in the changelog, because it changes observable behaviour.

### 2.8 Failure handling

A failed link fails the start. If clone, fetch, ref resolution, or worktree creation fails,
`start_run` returns a structured error and no Run is created — no half-built Run in the store, no
orphan worktree. Partial state must be cleaned up on the error path, including the case where the
worktree was created but recording it on the Run failed.

### 2.9 Surface it everywhere

Not done until all of these accept a repository binding:

- MCP `start_run` — `repository` + `ref` on the inline task
- REST `POST /api/runs`
- CLI `sf run --repository owner/repo --ref main`
- Task YAML schema + `sf validate` with named error codes
- A2A publications
- `get_run` / run detail / operator console display the binding
- `rerun` replays it

---

## 3. Run lifecycle: cancel, delete, GC

Workstream 2 makes this urgent — every Run becomes a full checkout on disk — but the leak already
exists today and is a container-only failure mode either way.

### 3.1 Run-level cancel

**Today.** Only per-stage `abandon_stage`. There is no way to stop a Run.

**Target.** `cancel_run(runId, reason)`: stop scheduling, SIGTERM active workers with a SIGKILL
escalation, mark the Run `cancelled`.

**This needs a new terminal status**, which ripples: run status types, the store schema, MCP and
REST responses, the operator console, `sf run --json` output, and CI exit codes. Worth doing
properly once rather than overloading `failed`.

### 3.2 Run deletion

**Today.** No delete anywhere in the codebase.

**Target.** `delete_run(runId)` that removes the store rows, the run workspace, the worktree, the
run branch, and any A2A artifacts. Refuses on an active Run unless `force`, which cancels first.
Exposed on MCP, REST, and CLI.

### 3.3 Two-stage retention, not one TTL

The design point worth getting right: **a single TTL forces a bad trade.** You usually want to keep
the *record* of a failed run for a long time while reclaiming its *disk* quickly.

| Stage | Reclaims | Keeps | Suggested default |
|---|---|---|---|
| **Slim** | worktree, `.pi-agent` dirs, stream logs, large artifacts | run record, envelopes, events, verification history | 3 days after terminal |
| **Purge** | everything, including the record | nothing | 30 days after terminal |

Per-status overrides (keep failed runs longer than succeeded ones), configurable, with sane
defaults. Bare-clone caches evict when they have no live worktrees and no activity inside the
window.

### 3.4 Make it visible and runnable

- `sf runs gc [--dry-run]`, and an internal periodic sweep in the Host so an unattended container
  self-maintains
- disk usage per run in `list_runs`, and a total in `get_health` — an operator should be able to see
  the leak before the volume fills
- a startup warning when the durable root crosses a configurable threshold

---

## 4. Daemon behaviour

The Host is currently a CLI that happens to serve HTTP. It needs to behave like a service.

### 4.1 Graceful shutdown

**Today.** No `SIGTERM` or `SIGINT` handler exists. `sf ui` and `sf mcp` block on a promise that
never resolves, so Node's default action terminates the process instantly.

**Target.** On signal: stop accepting new starts, stop scheduling new stages, signal active workers,
wait up to a grace period, checkpoint in-flight state, close SQLite cleanly, exit with a defined
code. Second signal escalates immediately.

### 4.2 An `interrupted` state, distinct from `failed`

**Today.** On boot, `reconcileOrphanedStages` marks any stage still `running` as failed with
`process_interrupted` (`src/runtime/runManager.ts:431-441`). A restart therefore looks like a batch
of failures.

**Target.** A distinct `interrupted` stage status that is **not** terminal, produced both by
graceful shutdown and by orphan reconciliation, and resumable via `resume_stage`. Without this,
graceful shutdown has nothing to write and a restart is indistinguishable from a bad night.

This is the single highest-value item in the workstream: it converts "restarting the container
destroys work" into "restarting the container is routine."

### 4.3 Don't fork a rival Host

**Today.** `sf run` and mutating `sf runs` verbs call `ensureGlobalService`, which probes health and
spawns a **detached** `sf mcp` if nothing answers (`src/server/ensureGlobalService.ts:132-160`).

**Target.** `STAGEFLOW_NO_AUTOSTART` (set in the image) so `docker exec … sf run` fails with a clear
"no Host is running" message instead of forking a second one that competes for the same SQLite file.

### 4.4 Structured logs to stdout

**Today.** Ad-hoc `console` output, and the autostart path writes to `~/.stageflow/service.log`.

**Target.** One JSON-lines logger to stdout with level, timestamp, run id, stage id, and event.
`docker logs` is the only observability a container operator has by default, and a file inside the
container is invisible. Keep a human-readable mode for local use.

---

## 5. Access control

Code work, not Docker work — the bind and the lock have to exist before an image can be safe.

### 5.1 Bind resolution

`--host` flag and `STAGEFLOW_BIND` env, precedence flag > env > `127.0.0.1`, wired into both
`sf ui` and `sf mcp`, with malformed values rejected at startup and the *advertised* URL sanitised
so binding `0.0.0.0` does not print an address nobody can use. None of this exists today.

### 5.2 `--no-open` / `STAGEFLOW_NO_OPEN`

`sf ui` unconditionally spawns a browser (`src/cli.ts:398-412`). In a slim image `xdg-open` is not
installed and the spawn fails on every start.

### 5.3 Allowed hosts, and the lock that must ship with it

`/mcp` is gated by `localhostHostValidation()` + `localhostOriginValidation()` with no override
(`src/server/createHttpHost.ts:64-81`); mutating REST has the same shape; **reads have no gate at
all**. Replace with a resolver defaulting to loopback that accepts an explicit allow-list — still
validating `Host`, never skipping the check — and apply it to reads too.

### 5.4 Control token, and refuse-to-start

`STAGEFLOW_CONTROL_TOKEN` / `_FILE`, checked as a bearer on `/mcp` and every `/api/*` except health.
Reuse A2A's existing ≥32-char validation and constant-time compare (`src/a2a/registry.ts:114-118`).
Two scopes, `read` and `drive`.

Then: **refuse to start when the resolved bind is non-loopback and no control token is set.**

> 5.3 and 5.4 are one change set, never two. The loopback gate is currently the only authentication
> `/mcp` has, so shipping the allow-list alone converts the gate into nothing and publishes an
> unauthenticated endpoint that runs arbitrary `bash`.

---

## 6. Stage isolation and secrets

### 6.1 Stop passing `process.env` wholesale

**Today.** `fork(this.cliEntry, args, { env: { ...process.env, ...this.env, SF_STAGE_WORKER: "1" } })`
(`src/runtime/stageProcessLauncher.ts:208-212`). Every stage's `bash` can read every secret the Host
holds — provider keys, the GitHub token, and any control token you add in workstream 5.

**Target.** Build the child environment explicitly: a base allow-list (`PATH`, `HOME`, `LANG`, `TZ`,
locale, proxy vars), the `STAGEFLOW_*` run variables from 2.6, and nothing else by default.

**Migration matters here.** This is a breaking change for anyone whose stages rely on ambient
environment. Ship `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` as an escape hatch, warn when it is used,
and give it a deprecation window.

### 6.2 Declared secrets per stage

Add to stage YAML the ability to declare which secrets a stage needs:

```yaml
- id: raise-pr
  secrets: [GITHUB_TOKEN]
```

Undeclared secrets are absent. A stage that only writes code cannot exfiltrate the token that a PR
stage needs. This is also what makes 2.5 coherent: the Host fetches with a credential the stages
never see, and a stage that pushes asks for one explicitly.

### 6.3 Redaction

Secret values must not appear in stage logs, stream logs, envelopes, or git error output. The git
error taxonomy from 2.1 is the most likely leak path.

---

## 7. Multi-project and the path contract

A container will serve several repositories. The Host currently pins one project at boot.

### 7.1 Make the catalog multi-project consistently

**Today.** MCP `list_pipelines` merges across `store.listProjectRoots()`
(`src/mcp/catalogTools.ts:27-128`); REST `GET /api/pipelines` browses only the boot `cwd`
(`src/server/http.ts:630-638`). The operator console and the harness will disagree about what
exists.

**Target.** One catalog resolution path used by both, with an optional `project_root` filter.
Registered roots come from the manifest and from runs that have been seen.

### 7.2 A stated path contract, enforced

**Today.** Callers pass paths that resolve on the Host's filesystem. A harness on another machine has
no way to know the container's layout, and sending `/Users/you/proj/x.pipeline.yaml` fails with a
bare `ENOENT`.

**Target.** Say it and enforce it:

- inline pipeline + inline task is the mount-free path, and the recommended one for remote harnesses
- file references are **catalog-relative**, never host-absolute
- an absolute path from a remote caller is rejected with an error that explains the contract rather
  than an `ENOENT`

### 7.3 Per-project concurrency

`STAGEFLOW_MAX_CONCURRENT_RUNS` is global (`src/runtime/runManager.ts:250-253`). One busy repo
starves every other one in the container. A per-project cap alongside the global one is worth having
once a single Host serves several projects.

---

## 8. Headless configuration and observability

### 8.1 Fully non-interactive credentials

**Today.** `sf providers login --type api_key --api-key-env VAR` works headlessly, but OAuth is
terminal-driven (`src/cli/terminalAuthInteraction.ts`) and the console path is browser-driven.

**Target.** Boot-time provider configuration from env or file, so a container self-configures with
no exec step for the API-key case. `*_FILE` variants for every secret-bearing variable — compose,
swarm, and Kubernetes all deliver secrets as files, and an env var cannot hold a multi-line
credential. OAuth stays an explicit `docker exec` flow, documented as such.

### 8.2 One config surface

Configuration is currently scattered across env vars, `stageflow.yaml`, `settings.json`, `a2a.yaml`,
and `.mcp.json`, with no single validated resolution.

**Target.** A resolved host config, assembled from env plus an optional file, validated at boot with
**unknown keys as errors rather than silently ignored**, and echoed in redacted form on the health
endpoint. Misconfiguration should fail at startup with a message, not at run time with a mystery.

### 8.3 Three health surfaces, not one **[revised]**

This item originally proposed a single rich `/api/health` and named `sf doctor` as the container
healthcheck. That is the canonical anti-pattern: a healthcheck that fails when the disk is filling
or a credential expired turns a degraded-but-serving Host into a restart loop, and restarting frees
no disk. Split it three ways.

| Surface | Contents | Auth | Used by |
|---|---|---|---|
| `/livez` | in-process only — no disk stat, no DB query, sub-100 ms | open | the container `HEALTHCHECK`, and only this |
| `/readyz` | store openable, `$STAGEFLOW_HOME` writable, migrations complete, git present; result cached a few seconds | open | orchestrators, startup gating |
| `/api/health` | version, build SHA, `STAGEFLOW_HOME`, schema version, git version, toolchain manifest, proxy and CA state, disk usage by category, capacity, A2A state and **its configuration error if any** | control token | bug reports, the console, operators |

The rich payload moves behind the token because it discloses paths, versions, and capacity. Use
`HEALTHCHECK --start-period` to cover boot rather than weakening the interval. Worth documenting for
users: a failing Docker healthcheck does not restart anything by itself — `restart: unless-stopped`
does.

### 8.4 `sf doctor` — a human preflight, not a probe **[revised]**

Checks git presence and version, `bash` presence, Node version, `$STAGEFLOW_HOME` writability and
the uid that owns it, store schema state, credential availability, outbound TLS reachability, free
disk, and every `command` named in the catalog's `.mcp.json` resolved against `PATH`. Non-zero exit
on failure.

**Do not wire it to `HEALTHCHECK.`** It spawns a fresh Node process on every interval inside the
same memory cgroup as the Host, which under 11.1 is a way to OOM the thing you are monitoring. It is
a first-run diagnostic and a bug-report attachment, which is where it is genuinely good.

### 8.5 Error taxonomy on the API

Structured, stable error codes on MCP and REST responses so a remote harness can branch on them.
`{ code: "repository_auth_failed", message: "…" }` rather than prose a harness has to regex.

---

## 9. Harness parity

The stated bar is that a harness gets what a local install gets.

### 9.1 `start_run` parameter parity

MCP `start_run` lacks `checkout` override, `skipGates`, and CI metadata, all of which REST and the
CLI have (`src/server/http.ts:352-422`). Add them, plus the repository binding from 2.9.

### 9.2 Inline pipelines must be rerunnable

`rerun` hard-requires `meta.pipeline_path` (`src/runtime/runManager.ts:688-694`), so a run started
from an inline pipeline — the mount-free path we are recommending to every remote harness — can
never be retried. Either persist the inline pipeline with the run and let `rerun` replay it, or add
opt-in `save_as`. Persisting is better: it makes the run record self-contained, which is also what
makes it portable.

### 9.3 Run-scoped skills

`start_run.skills` as name → file bytes, materialised beside the Run (never inside the worktree,
which would dirty the PR), resolved by stage `skill: <name>`, with documented precedence and the
chosen origin recorded. Plus `list_skills` reporting origin, because otherwise "which `SKILL.md` did
this stage load" is guesswork over MCP.

### 9.4 Close the remaining CLI-only gaps

Decide explicitly, per capability, whether it gets an API or is documented as `docker exec` only:
`sf export-run`, `sf graph`, `sf migrate-yaml`, `sf skills install`, `sf a2a *`, provider login. An
undocumented gap is worse than a documented one.

---

## 10. Runtime environment correctness

The "worked on my laptop" class. Every item here is something macOS gives Stageflow for free that a
Linux container does not. All verified in code.

### 10.1 Outbound proxy support

**Today.** No `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` handling and no `ProxyAgent` anywhere in
`src/`. Node's global `fetch` (undici) deliberately ignores those variables.

**Failure.** Behind any corporate egress proxy every model call fails with a timeout, surfacing as a
stage that hangs and dies with no hint that a proxy was involved.

**Careful:** workstream 6.1 lists proxy variables in the child-env allowlist, which makes this look
solved. Passing a variable to a process that ignores it changes nothing.

**Fix.** `setGlobalDispatcher(new EnvHttpProxyAgent())` at Host and worker boot when a proxy variable
is set. Report resolved proxy state in health. Document that `NO_PROXY` must include the loopback
host, or `ensureGlobalService`'s own `127.0.0.1` health probe gets routed through the proxy.

### 10.2 CA trust must reach the worker

No `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, or `SSL_CERT_DIR` handling in `src/`. Node honours
`NODE_EXTRA_CA_CERTS` natively so the Host is fine today — but they are absent from 6.1's allowlist,
so the moment that lands, a TLS-intercepting proxy's CA stops reaching stages and they fail with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` while the Host's own calls still work. **Rider on 6.1:** add all
three. Add an outbound-TLS check to `sf doctor`.

### 10.3 `verify` commands must run under `bash`, not `/bin/sh`

`spawn(input.command, { shell: true })` (`src/runtime/completionCheckRunner.ts:195-199`) means
`/bin/sh -c`. On macOS that is bash in POSIX mode and tolerates most bashisms. On Debian-slim it is
dash; on Alpine, busybox ash. Every `verify` using `[[ ]]`, `pipefail`, `source`, or brace expansion
starts failing with a terse exit 2 that reads as "my tests broke in the container."

**Fix.** Invoke `bash -c` explicitly, and make `bash` a `sf doctor` hard requirement.

### 10.4 Git identity — the first thing that will break

**Today.** No `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `user.email`, `user.name`, or `safe.directory`
anywhere in `src/`. Stages commit through Pi's `bash` tool, inheriting the developer's
`~/.gitconfig` **by accident**.

**Failure.** A container has no `~/.gitconfig`, so the first `git commit` in any stage fails with
git's "Please tell me who you are." Workstream 6.1 removes even the accidental path. This is the
failure that will make the first container user think the product is broken.

**Fix (rider on 2.6 and 6.1).** The Host sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL`
in the curated stage environment, defaulting to something honest like `Stageflow
<stageflow@localhost>`, overridable per-host and per-task, and recorded on the run. Also set
`safe.directory` for the worktree so a uid mismatch on a bind-mounted repo does not trip git's
ownership check — a second silent container-only failure in the same area.

### 10.5 Shared dependency caches

Worktree-per-run gives every Run a pristine tree, so every Run pays a full `npm install` before
`verify` can run. Locally one checkout stays warm forever. Nothing exports a cache location today.

**Fix (rider on 6.1).** `$STAGEFLOW_HOME/cache`, exported as `npm_config_cache`, `PNPM_STORE_DIR`,
`YARN_CACHE_FOLDER`, `UV_CACHE_DIR`, `GOMODCACHE`, `CARGO_HOME`, plus a `STAGEFLOW_CACHE` variable in
the 2.6 table. Excluded from per-run disk quotas, and it must survive slim GC. About a dozen lines
once 6.1's allowlist exists, and it is the difference users feel on every single run.

### 10.6 File-backed credentials

Locally the agent inherits an authenticated `gh`, a loaded ssh-agent, and `~/.aws`. In a container
none of it exists, so any pipeline copied from `examples/` that shells out to `gh` fails. Workstream
6.2's `secrets:` declaration is the right frame but covers only environment variables.

**Fix.** Extend the same declaration to file-backed credentials, mounted read-only and materialised
per stage. Build **one** credential-materialisation path shared with 2.5's `GIT_ASKPASS` design
rather than two.

### 10.7 Process groups, and the kill escalation that does not work

```137:145:src/runtime/stageProcessLauncher.ts
            child.once("exit", finish);
            child.kill("SIGTERM");
            if (killAfterMs > 0) {
              setTimeout(() => {
                if (!child.killed) {
                  child.kill("SIGKILL");
                }
              }, killAfterMs);
            }
```

`child.killed` is true as soon as a signal has been *sent*, not when the process has died — so the
`SIGKILL` branch is unreachable in every case that matters. Separately the `fork` has no
`detached: true`, so nothing signals the worker's descendants.

**This is load-bearing:** workstreams 3.1 and 4.1 both assume this escalation works. `docker stop`
currently leaves the agent's `bash` grandchildren running until the runtime SIGKILLs them, possibly
mid-`git`. **Fix (rider on 3.1/4.1):** `detached: true`, signal the group with
`process.kill(-child.pid, sig)`, escalate on a lost exit race rather than on `child.killed`. Same
treatment for the verify executor, which today signals the `sh -c` shell and not the pipeline
beneath it.

### 10.8 Stdout is piped and never drained

`stdio: ["pipe", "pipe", "pipe", "ipc"]` (`src/runtime/stageProcessLauncher.ts:208-212`) with a
reader attached to `child.stderr` only. Anything that writes to the worker's stdout fills the 64 KB
pipe buffer and blocks forever; the Host sees no exit and no IPC message, and the stage hangs holding
its concurrency slot. Stageflow's own worker logging correctly goes to stderr today, which is why
this has not bitten — it is one dependency away from doing so. **Fix:** drain it into the 4.4 logger,
or set it to `"ignore"`.

### 10.9 `process.exit` truncates piped stdout

`main(...).then((code) => process.exit(code))` (`src/cli.ts:475`) and `exitForOutcome`
(`src/runtime/stageWorker.ts:229-234`). On a TTY Node's stdout writes are synchronous; when stdout is
a pipe — `docker logs`, `docker exec … sf run --json | jq`, CI capture — they are asynchronous, and
`process.exit` discards what is still queued. So `sf run --json` can emit truncated JSON inside a
container while being perfect on the laptop, against an output contract we treat as public.

**Fix.** Set `process.exitCode` and let the loop drain, or flush explicitly. Cheap, and it protects
the contract workstreams 8 and 9 build on.

### 10.10 Stage MCP servers need a package manager and more than five seconds

Catalog `.mcp.json` entries are typically `npx -y @modelcontextprotocol/server-…`, and the connect
budget is a fixed `5_000` ms (`src/agent/piIsolatedMcp.ts:15`). In a slim image with no `npx` the
spawn fails as a bare "failed to connect" with no mention of a missing binary; with `npx` but a cold
cache the first run of every such stage times out and the retry passes — intermittent, and invisible
on a laptop with a warm cache.

**Fix.** Configurable timeout with a higher default; `sf validate` and `sf doctor` resolve every
catalog `command` against `PATH` and name what is missing; pre-install common servers at image build
time. **Also note for 6.1:** `.mcp.json` interpolation reads the environment
(`src/config/resolveStageMcpServers.ts:321`), so the allowlist will turn every `${SOME_TOKEN}` into a
hard `unresolved_var` error. That is a breaking change 6.1 must call out.

### 10.11 Smaller items

- **UID contract.** Pick and document a fixed non-root uid/gid. When `$STAGEFLOW_HOME` is not
  writable, fail with a named error printing the running uid and the exact `chown` to fix it. Prefer
  named volumes in the documented default. Never recursively chown the data root on boot.
- **Writable-path declaration.** State that the data volume plus an explicitly-set `TMPDIR` are the
  only writable paths, so `read_only: true`, `cap_drop: ALL`, and `no-new-privileges` become a
  supported configuration rather than something users discover by breaking.
- **Claude backend cannot run as root.** `permissionMode: "bypassPermissions"`
  (`src/agent/claudeAdapter.ts:303-304`) is refused when euid is 0, and the Docker default user *is*
  root. Make it a validated precondition in `sf doctor` with a named error, not a Dockerfile
  convention.
- **HTTP server has no request timeout.** `server.requestTimeout = 0`
  (`src/server/createHttpHost.ts:106`), no `maxConnections`, and no persistent runtime `error`
  handler. Fine for loopback-only; poor once workstream 5 makes the port reachable. Set a finite
  timeout with an exemption for the long-lived MCP route.
- **The console hands out the wrong MCP URL.** `ui/src/mcpConnect.ts` returns a hardcoded
  `http://127.0.0.1:3847/mcp` for any non-loopback origin — so reaching the console at
  `http://build-box:3847` and opening Settings → MCP gives you an address pointing at your own
  laptop. Derive from `window.location`, and have the server inject its advertised origin.
- **A2A config errors are swallowed.** `catch { status.state = "configuration_error"; }`
  (`src/a2a/server.ts:251-259`) discards exactly the container-relevant reasons: a token under 32
  chars, a non-HTTPS `public_url`, a path that fails to `realpath`. Keep the message, log it, expose
  it on `/api/a2a/status`.
- **Runtime TypeScript loading.** The jiti fallback (`src/agent/piIsolatedMcp.ts:125-147`) needs
  `node_modules` sources present, a writable cache, and a Node new enough to strip types — while
  `engines` still says `>=20`. Point jiti's cache under `$STAGEFLOW_HOME`, prefer built entries, fail
  with a named error rather than a raw `SyntaxError`.
- **Case sensitivity.** The code is correct (all containment goes through `realpath`), but a `skill:`
  name or artifact path with wrong case resolves on APFS and `ENOENT`s on Linux. Add a case-mismatch
  check to `sf validate`.
- **`service.log` lives in the data volume.** Unbounded, invisible to `docker logs`, competing for
  space with the store (`src/server/ensureGlobalService.ts:134-152`). When 4.3 lands, make this path
  unreachable in the container profile rather than merely unused.

---

## 11. Limits, budgets and backpressure

A laptop with swap degrades. A container with `--memory` gets OOM-killed, and the kernel gives you
exit 137 with no stack and no log line.

### 11.1 Cgroup-aware heap sizing and a finite stage-process cap

**Today.** `DEFAULT_MAX_ACTIVE_STAGES_PER_RUN` and `DEFAULT_MAX_ACTIVE_STAGE_PROCESSES` are both
`Number.POSITIVE_INFINITY` (`src/runtime/stageConcurrency.ts:3-11`), and `waitForCapacity`
short-circuits entirely when the cap is not finite. Runs are capped at 3; each run's stage fan-out is
not. No `--max-old-space-size` anywhere.

**Why it bites only in a container.** Node sizes its default heap at roughly half the cgroup limit
*per process*. Fork one worker per stage and four processes each independently believe they may grow
to ~1 GB inside a 2 GB container. The OOM killer takes one — possibly the Host — the run sits in
`running` forever, and nothing recovers it until a restart.

**Fix.** Finite defaults derived from `/sys/fs/cgroup/memory.max` (explicitly *not* `os.totalmem()`,
which reports host values). Pass `--max-old-space-size` per worker via `execArgv`. Log the computed
figures once at boot and report them in health. Classify a child exiting via SIGKILL with no envelope
as `worker_oom_killed` so the failure is legible.

### 11.2 Wall-clock, disk and cost budgets

There is a per-stage `timeout_ms` and a per-check `timeout_ms`, but no run-level wall clock, no disk
quota, and no token budget. A stage that loops forever holds a worktree, a slot, and a provider bill
until someone notices — which on a remotely-driven container may be a long time.

**Fix.** Per-attempt timeout, total budget across retries, captured-output byte cap, run-level
`deadline`, per-run disk quota, and a token/cost budget that cancels rather than warns. Every limit
hit gets its own terminal reason code, distinct from `failed` — the same argument 4.2 makes for
`interrupted`.

**Ownership line.** Stageflow owns **time, disk, and tokens**, because those map to run semantics it
already tracks. The operator owns **CPU and memory** via `docker run --cpus --memory`. Enforcing CPU
and memory inside Stageflow means cgroups or nested containers, which needs privileges the docs will
tell users never to grant.

### 11.3 Admission control instead of rejection

**Today.** Over capacity, `start_run` returns a hard `busy_capacity` failure
(`src/runtime/runManager.ts:1695-1716`). Nothing queues. Workstream 7.3's per-project cap makes the
rejection fairer, not rarer.

**Why it matters more here.** 2.7 removes the checkout lease specifically so parallelism becomes the
point. Then the only backpressure left is "no" — and a CI system firing five PR pipelines gets five
failed MCP calls and a retry race.

**Fix.** A `queued` run status. `start_run` returns a run id immediately with a queue position;
`get_run` reports it; `cancel_run` works on a queued run. `STAGEFLOW_MAX_QUEUED` bounds the queue and
that is where `busy_capacity` moves to. Dequeue round-robin across project roots, which subsumes
7.3 more cleanly than a second static cap.

**Do the `queued` and `cancelled` status ripples in one pass**, not two — both touch the same
schema, types, MCP and REST responses, console, and CI exit codes.

### 11.4 Disk admission

3.4's startup warning does not prevent the failure. Refuse to start a run when free disk is below a
configurable floor, with its own error code so a harness can back off. That turns "the volume filled
and twelve runs corrupted" into `insufficient_disk`.

### 11.5 Log volume

4.4 sets the format but not the budget. Agent transcripts are the highest-volume output, and Docker's
default `json-file` driver has no rotation — an agent in a retry loop can fill a VPS through
`docker logs` alone, which is a failure mode workstream 3.4 does not watch because it only watches
`$STAGEFLOW_HOME`.

**Fix.** stdout carries lifecycle events with a per-line size cap; full transcripts stay in the run
store where 3.3's retention governs them. Ship the compose example with `logging: driver: local`.
Apply 6.3's redaction at the log sink, not per call site, so a new log line cannot leak by omission.

---

## 12. Data safety and release integrity

The largest genuinely-new workstream, and the one that loses user data if skipped.

### 12.1 Schema versioning and a downgrade guard

**Today.** There is no `PRAGMA user_version` and no migrations table anywhere in `src/`. The schema
evolves by probing `PRAGMA table_info(...)` and adding columns when absent — nine such probes plus
ALTER TABLEs plus a full-table backfill, **on every connection open**, outside any transaction
(`src/runstore/sqlite/SqliteRunStore.ts:493-510`). Every forked stage worker opens its own store.

Three distinct failures, none of which appear on a laptop:

- **Downgrade is silently wrong.** Roll the image back and the older binary opens a newer database
  happily, finds the columns it knows, ignores the rest, and writes rows the newer code will
  misread. Container operators roll back image tags routinely; a single local install never does.
- **Startup contention.** N workers launching at once each try to take the exclusive lock DDL needs,
  against a 5000 ms `busy_timeout`. On a slow volume a worker dies with `SQLITE_BUSY` before doing
  any work.
- **Cost per process.** A full-table UPDATE and a legacy-tree `readdir` run in every worker.

**Note:** workstreams 8.3 and 8.4 both want to *report* a schema version. This is the mechanism they
assume exists.

**Fix.** `PRAGMA user_version` plus a `schema_migrations` ledger; forward-only migrations in a single
transaction, applied **by the Host only**; workers assert the version and refuse with a named error
rather than mutating schema. Refuse to start when the on-disk version exceeds what the binary knows,
with an error naming the minimum image version. Publish the support policy the way mature self-hosted
projects do — patch versions interchangeable, minor versions upgrade-only. Enable `PRAGMA
foreign_keys` while you are there; the FKs declared in the schema are currently decoration.

### 12.2 Backup and restore as a shipped feature

Nothing backs anything up. Users will `cp state.db`, which corrupts instantly in WAL mode because the
`-wal` and `-shm` files keep moving during the copy.

**Fix.** `sf backup --out <file>` using `VACUUM INTO` (or better-sqlite3's `.backup()`), followed by
an integrity check before declaring success. `sf restore <file>` that refuses while a Host is live
and clears stale `-wal`/`-shm`. Expose both over the API, since the CLI is behind `docker exec`.

Publish a "what is in `$STAGEFLOW_HOME` and what you must keep" table marking `repos/` (rebuildable)
and `worktrees/` (reconstructable from `resolved_sha`) as disposable, and `state.db` +
`agent/auth.json` + `settings.json` as irreplaceable. That distinction turns a 40 GB backup into a
40 MB one, and it falls straight out of the layout 1.2 already writes down.

### 12.3 SQLite operational decisions

WAL and `busy_timeout` are set. Three decisions are unmade: `synchronous` (better-sqlite3 defaults to
NORMAL under WAL, so recent commits can be lost on power loss — `FULL` is probably right for a run
store), WAL size management (add a `wal_checkpoint(TRUNCATE)` to 4.1's clean close so a restart does
not inherit a huge WAL), and integrity checking (`quick_check` at boot, full `integrity_check` only
in `sf doctor` — it holds a read lock for the whole scan and will stall writers).

**State one supported-configuration boundary loudly: the data volume must be local.** SQLite in WAL
mode needs shared memory between processes and is documented as unsafe on NFS/SMB. VPS users with
network storage will otherwise discover this as corruption.

### 12.4 Release provenance

The Dockerfile is deferred, correctly, but the *release process* is product work. For a tool that
runs an agent with shell access against your repository, "how do I know this image is the one you
built" is a fair question.

Build with `--provenance=true --sbom=true`, sign by digest with cosign, pin the base image by digest,
publish one verification snippet in the docs, and set the standard
`org.opencontainers.image.{source,revision,version,created,licenses,base.name,base.digest}` labels.
**Tie-in:** the `revision` label and 8.3's build SHA must be the same value, so an operator looking at
a running container can get back to a commit. Labels are hints anyone with push access can type; only
signed attestations are evidence.

### 12.5 Exit codes and restart-loop protection

4.1 says "exit with a defined code" without defining them, and says nothing about the interaction
between the drain grace period and `docker stop`'s 10-second default. There is also no guard on the
resume path: 4.2's `interrupted` state is resumable, which is right, but a stage that crashes the
Host on resume will crash it again on every restart under `restart: unless-stopped`.

**Fix.** Publish the exit-code table as part of the CI contract we already treat as public. Set the
forced-exit timer below the stop timeout. Cap automatic resumption — after N interrupted→resume
cycles, leave it `interrupted` and require an explicit `resume_stage`.

### 12.6 Repository-provided configuration is untrusted input

After workstream 2, the Host clones a remote on a caller's instruction, and stage `mcp` / `.mcp.json`
and skills resolve relative to that tree. So a pull request can add an MCP server definition and a
stage will start it. This is the documented failure mode across disclosed agent-sandbox escapes:
agents treat project-local config as trusted infrastructure rather than as workspace content.

**Fix.** A trust boundary on config origin. Pipelines, tasks, and MCP server definitions come from the
catalog or the inline request — never from the cloned worktree — unless a project explicitly opts in.
Record the origin of every resolved MCP server, skill, and verify command on the run, reusing the
mechanism 9.3 already specifies for skills. Mostly a resolution-order decision, and 7.2's
catalog-relative path contract is already half of it.

### 12.7 Egress posture, stated as a product decision

Workstream 5 secures inbound and 6 secures the inherited environment. Nothing addresses where the
agent can *reach* — and a stage holding the `GITHUB_TOKEN` that 6.2 grants it, with unrestricted
network, is the blast radius of one prompt injection in a README.

We are not building a proxy. What we owe users is a documented threat model that says plainly what a
stage can do, a reference compose putting the Host on an `internal: true` network behind a
domain-allowlisting proxy sidecar, and a health field reporting whether proxy variables are set. Say
explicitly that the Docker socket is never mounted — and say honestly that a domain allowlist does
not stop exfiltration through a broad allowed host like GitHub. Stating the limit is what stops users
over-trusting the configuration.

### 12.8 Whole-instance export

`sf export-run` exists and 9.4 files it under "decide whether it gets an API." For a container
product that is the wrong framing — the export *is* the portability promise, and behind `docker exec`
it is not a promise a remote harness can keep. Add `sf export --all` and an API equivalent. Pleasant
coupling: 9.2 (persist inline pipelines so `rerun` works) is the same change that makes a run record
self-contained enough to export, so ship them together.

---

## 13. Better than local

The stated bar is *better*, not equal. These are capabilities the container form factor unlocks, plus
the two places it would otherwise be visibly worse.

### 13.1 No window into the working tree — the biggest regression

Locally, mid-run, you open the checkout in your editor and run `git diff`. Remotely there is no
equivalent: `read_artifact` is strictly confined to the run workspace
(`src/mcp/readArtifact.ts:82-93`) and nothing reads from the checkout or returns a diff. Worktree-
per-Run makes it worse — the tree moves somewhere the user cannot reach without `docker exec`.

**Fix.** Three read-only tools scoped to the Run's binding:

- `list_checkout_changes(runId)` — the fingerprinting machinery already exists and already separates
  tracked from untracked (`src/runtime/gitCheckoutCapability.ts:88-115`). Nearly free.
- `get_run_diff(runId, { stat | patch, path?, maxBytes })` — a diff against `STAGEFLOW_BASE_SHA`,
  which 2.4 already records. Belongs in the `src/git/` module 2.1 creates.
- `read_checkout_file(runId, relativePath)` — the same containment and deny-list logic as
  `readArtifact`, rooted at the worktree.

This is the highest-priority worse-than-local item and it is absent from workstreams 1–9. Without it
the container is visibly worse at the thing users do most.

### 13.2 Declared toolchain requirements and a preflight

Locally a `requires:` block is bureaucracy — you install the tool and move on. In an image the
toolchain is a fixed, inspectable fact, so a declaration can actually be *checked*. This is the
clearest case where the container is strictly better.

`requires: [{ tool: pnpm, version: ">=9" }]` at pipeline and stage level; a toolchain manifest
written at image build time and reported on health (generalising the `git version` field 8.3 already
wants); `sf doctor --pipeline <path>` and an MCP `preflight` tool that diffs a pipeline's needs
against the manifest and returns `missing_tool` / `tool_version_mismatch` **before** a run starts;
resolved versions recorded on the run. Document the derived-image pattern —
`FROM stageflow:x.y.z` plus `apt-get install` — and let `requires` be what tells a user they need one.

### 13.3 A seeded example catalog and a `get_started` tool

Twenty-one runnable examples exist under `examples/` and are **not shipped** (`package.json` `files`
is `dist`, `skills`, README, LICENSE). Locally, first-run is npm install, provider login, then
authoring YAML against docs in a browser.

Ship `examples/` into the image as a read-only registered catalog root via the multi-project
resolution path 7.1 is already building. Then the first thing a user's coding agent can do after
`get_health` is `list_pipelines` and get twenty-one working pipelines it can `describe_pipeline` and
run — no authoring, no mount, no file paths. Add one `get_started` MCP tool composing the resolved
config, provider auth state, toolchain manifest, seeded catalog, and the three-call happy path.

Best impact-to-cost ratio in this document. Do it in the same pass as 7.1.

### 13.4 A run manifest: what actually ran

`RunMeta` already carries a DAG snapshot, which is genuinely good provenance. Missing for "reproducible
from its record": image digest and Stageflow build SHA, the *resolved* model per stage (authored
values are in YAML but the resolution is not recorded), skill identities and digests, toolchain
versions, and the resolved `.mcp.json` server set — which matters because those entries are
interpolated from the environment, so the same YAML resolves differently on two hosts.

One `run_manifest` blob written at start and finalised at terminal, exposed on `get_run` and used as
the payload of `sf export-run`. Lift `export-run`'s terminal-status requirement while you are there —
it is the first thing anyone attaches to a bug report, and a hung run is exactly when you want it.

**Record what ran; do not build a replay engine.** Byte-identical replay additionally requires pinning
model non-determinism, network responses, and third-party MCP behaviour, none of which the image
controls.

### 13.5 Per-caller attribution and quotas

`RunMeta` has no caller field. A2A already has the right shape one layer over — `caller_id` is an
indexed column with hashed bearer tokens and constant-time compare (`src/a2a/store.ts:11-29`,
`src/a2a/registry.ts:114-118`) — but none of it reaches the run record. Workstream 5.4's *single*
shared token quietly forecloses team use: every run looks identical in `list_runs`, quotas are
impossible, and rotating locks out everyone at once.

**Minimal fix.** Named tokens rather than one token, reusing A2A's validation verbatim. `caller_id` on
`RunMeta`, a `list_runs` filter, and a per-caller concurrency quota on top of the global and
per-project caps (falls out of 11.3's queue). Append-only audit lines for mutating calls into 4.4's
logger. **Attribution and quotas only** — no accounts, no RBAC, no SSO.

### 13.6 Post-mortem debugging

Live feedback is fine already: `tail_stage_log` handles byte offsets and truncation,
`get_stage_verification` returns captured stdout and stderr. The gap is *after* the run. Locally the
disk is still there. Remotely, 3.3's slim GC reclaims the worktree three days after terminal.

Use 3.3's per-status overrides to keep failed runs' worktrees longer by default; add `sf debug-run
<id>` producing one attachable bundle (13.4's manifest + stage events + verification evidence +
13.1's diff); and document `docker exec` into the worktree as the supported escape hatch rather than
leaving it undiscoverable.

### 13.7 Explicitly rejected

Kept here so they do not get relitigated: a replay engine (13.4 covers the value); per-stage CPU and
memory limits inside Stageflow (operator's job via `--cpus`/`--memory`); per-stage container
sandboxing or docker-in-docker (needs privileges the docs forbid); user accounts, RBAC, or SSO (13.5
gets most of the value for a fraction of the surface); Stageflow building derived images from
`requires:` (declare and check, document the pattern, do not become a build tool); a web terminal or
`exec` tool over MCP (a remote shell behind one bearer token, on an endpoint already one mistake away
from unauthenticated RCE — `docker exec` is the right tool); mounting the user's dotfiles or
ssh-agent (reproducibility is what the container buys; importing ambient laptop state trades it
away); hot reload of A2A publications; OpenTelemetry tracing and a collector dependency; gVisor,
microVMs, or userns-remap; `UV_THREADPOOL_SIZE` tuning (nothing hot is on that pool).

At most, one opt-in Prometheus text endpoint behind the control token with a deliberately small
metric set — runs by status, stage duration, active workers, disk by category, tokens by model, with
labels bounded to project and stage id and never run id. Roughly one file, and it is the only way a
VPS operator sees a growing backlog before users complain.

---

## Workstream index

Reference only — build from [Build order](#build-order) above. Workstreams 10–13 were added after an
audit pass; most of their items are riders on work already scheduled in 1–9 and are marked as such
in place.

| # | Workstream | Why it is pre-container | Size | Slot |
|---|---|---|---|---|
| **1** | [Durable root contract](#1-durable-root-contract) | Everything else writes into it | S | 1 |
| **2** | [Repository binding and Worktree-per-Run](#2-repository-binding-and-worktree-per-run) | The Checkout model itself is wrong for a container | **L** | 2 |
| **3** | [Run lifecycle: cancel, delete, GC](#3-run-lifecycle-cancel-delete-gc) | Worktrees make the existing leak fatal | M | 3 |
| **4** | [Daemon behaviour](#4-daemon-behaviour) | The Host is currently a CLI that happens to serve HTTP | M | 4 |
| **5** | [Access control](#5-access-control) | Reaching it from off-box is the whole point | M | 5 |
| **6** | [Stage isolation and secrets](#6-stage-isolation-and-secrets) | Stages currently inherit every secret the Host holds | M | 6 |
| **7** | [Multi-project and the path contract](#7-multi-project-and-the-path-contract) | One container will serve several repos | M | 7 |
| **8** | [Headless configuration and observability](#8-headless-configuration-and-observability) | No TTY, no console, logs are the only window | M | 7 |
| **9** | [Harness parity](#9-harness-parity) | "Full feature support" is the stated bar | M | 9 |
| **10** | [Runtime environment correctness](#10-runtime-environment-correctness) | Things that silently work on macOS and break on Linux | M | riders → 2, 4, 5, 6 |
| **11** | [Limits, budgets and backpressure](#11-limits-budgets-and-backpressure) | A laptop swaps; a container gets OOM-killed | M | riders → 3, 6 |
| **12** | [Data safety and release integrity](#12-data-safety-and-release-integrity) | An image tag makes rollback routine, and rollback loses data today | **L** | 1 (12.1), 4, 7, 8 |
| **13** | [Better than local](#13-better-than-local) | The bar is *better*, not merely equal | M | riders → 2, 7; rest in 9 |

