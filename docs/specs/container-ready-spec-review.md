---
status: review
---

# Container-ready: spec review

Index: [container-ready](container-ready.md) · My assessment: [container-ready-assessment](container-ready-assessment.md)

Reviews [container-ready.md](container-ready.md), [container-ready-analysis.md](container-ready-analysis.md),
[host-owned-worktrees.md](host-owned-worktrees.md), and [run-scoped-skills.md](run-scoped-skills.md)
against an independent read of the code.

---

## Verdict

**The reasoning is good. The facts underneath it are not reliable enough to drive implementation
without a correction pass.**

Split the spec set into two things and judge them separately:

| Part | Grade | Why |
|---|---|---|
| **Risk analysis and recommendations** (§5–§6 of the analysis, both child specs) | Strong | The auth argument is correct and better-argued than the locked decision it contradicts. Worktree-per-Run, GC/TTL, stable checkout path, stage env allowlist, multi-arch, `_FILE` secrets, PID 1, isolation contract — all right, all the things a first attempt usually misses |
| **"Stageflow as it exists"** (§3 of the analysis) | Unreliable | Two of the three load-bearing facts are wrong, and both errors point the work in the wrong direction |

Concretely: the spec says the hardest prerequisite is *moving the run store out of the checkout*
(already done) and that the bind work is *already implemented and just needs committing*
(does not exist, not even as an untracked file). Those are exactly backwards. An agent handed this
spec would skip the single hardest blocker and spend a day re-doing finished work.

Everything in §5 onward is worth keeping. §3 needs to be replaced.

---

## 1. Material factual errors

### 1.1 The bind work does not exist — this is the big one

The analysis states (§3.2, and again in §6 and Phase 0 item 1):

> `--host` / `STAGEFLOW_BIND` / `--no-open` / `STAGEFLOW_NO_OPEN` **exist and are wired** …
> All of this is **uncommitted**.

> Default bind `127.0.0.1`; `--host` / `STAGEFLOW_BIND`; image `0.0.0.0` | agree (#3) — **already implemented, uncommitted**
> `--no-open` / `STAGEFLOW_NO_OPEN`; no browser in the image | agree (#12) — **already implemented**

**None of this is true.** A repo-wide search for `listenHost`, `STAGEFLOW_BIND`, `STAGEFLOW_NO_OPEN`,
`--no-open`, and `resolveListenHost` outside the planning docs returns nothing. `git log --all --
src/server/listenHost.ts` is empty — the file has never existed on any branch. `src/cli.ts` parses
`--port` only (`src/cli.ts:57-58`), and `sf ui` unconditionally calls `openBrowser(url)`
(`src/cli.ts:398-412`). The bind address is hardcoded `options.host ?? "127.0.0.1"` in both
`startUiServer` (`src/server/http.ts:840`) and `startMcpServer` (`src/server/mcpHost.ts:35`); `host`
is a programmatic option with no CLI or env path to it.

**Impact.** This is the number one hard blocker for the entire project. Without it, `-p 3847:3847`
publishes a port nothing is listening on from outside the container's loopback namespace — the
container appears to start and is simply unreachable. The spec lists it as done in two places and as
"land the in-flight work, add tests" in a third. It needs to be written from scratch, and it should
be the first thing anyone touches.

### 1.2 The run store already lives outside the checkout

The analysis makes this its #1 executive item:

> **Moving the run store out of the Checkout.** Today the SQLite store lives at `<git-root>/.stageflow/`
> (`storeRootFor(rootDir)`) … a stage's `bash` can `rm -rf .stageflow` and destroy the run's own
> recovery record. … in a container that is not a fast-follow, it is a prerequisite.

`storeRootFor(rootDir)` does append `.stageflow` to whatever it is given, but **the Host does not
give it the project root.** `bootstrapStageflowHost` passes `ctx.globalHome`
(`src/server/bootstrap.ts:69`), which is `~/.stageflow` (`src/project/globalHome.ts:5`). The store
is therefore at `~/.stageflow/.stageflow/state.db`. Stage workers open the same global store
(`src/runtime/stageWorker.ts:33-37`). Project-local `.stageflow/` now holds only `settings.json`.

The `rm -rf .stageflow` self-destruction scenario cannot happen as described. The genuine residual
problems are smaller and different, and the spec does not mention any of them:

- The path is hardcoded off `os.homedir()` with **no `STAGEFLOW_HOME`**. Run the container with
  `--user` and no matching passwd entry and every durable path silently relocates.
- The `.stageflow/.stageflow/` double nesting will confuse every `VOLUME` line written against it.
- Provider credentials are split across `~/.stageflow/agent/auth.json` and `~/.pi/agent/auth.json`
  (`src/runtime/credentialBinding.ts:40-46`) — two homes, one volume needed.
- A2A artifacts also live under the store root (`src/a2a/store.ts:120-121`).

**Impact.** A whole executive item and a Phase 0 task point at finished work. Worse, the *actual*
state prerequisite (`STAGEFLOW_HOME`) is absent from the spec entirely.

### 1.3 Broken reference: `global-stageflow-service.md`

The analysis cites `docs/specs/global-stageflow-service.md` four times as an unimplemented spec whose
store relocation is a container prerequisite. **That file is not in this tree** — it was removed in
`0bbf060` ("drop planning spec from the PR"). Reading its content from the parent commit: it is
substantially *implemented*. Store at global home, `sf run` as an HTTP client, `ensureGlobalService`
autostart, `project_root` recorded on runs, per-call project derivation from the pipeline path — all
shipped. What is not shipped from it is remote access, which is this project.

### 1.4 Smaller inaccuracies

| Claim | Correction |
|---|---|
| "Health: `GET /api/health` … **no version/build field**" | True for REST (`src/server/http.ts:745`), but MCP `get_health` already returns `version`. The fix is to unify, not to build from nothing |
| Parity matrix: "Rerun / durability — MCP **not met**" | `rerun` exists and works for path-based runs; it fails only for inline ones, because it hard-requires `meta.pipeline_path` (`src/runtime/runManager.ts:688-694`). The conclusion is right, the row overstates it |
| "`sf run` is a client that may auto-start `sf mcp`" | Correct, and understated — mutating `sf runs` verbs do it too, and the spawned child is **detached** (`src/server/ensureGlobalService.ts:132-160`). Inside a container this can produce a second rival Host |
| "Mutating `sf runs …` verbs refuse while a Host answers health" | This is what `docs/cli-reference.md` says, but the code does the opposite: mutating verbs **require** the Host and send over HTTP (`src/cli/runsCommand.ts:384-394`). The spec inherited a stale doc |

---

## 2. Real gaps the spec misses

Each of these is in [my assessment](container-ready-assessment.md) with a fix and a severity.

| Missing | Why it matters |
|---|---|
| **No SIGTERM/SIGINT handler exists at all** | The spec lists signals as "absent" in a polish table, which undersells it. `sf ui`/`sf mcp` block on a never-resolving promise; `docker stop` hard-kills the Host and orphans every in-flight stage worker. This is P0, not Phase 5 |
| **`sf ui` always spawns a browser** | Follows directly from 1.1. In a slim image `xdg-open` does not exist, so the spawn fails noisily on every start |
| **No run delete, no run-level cancel, no GC of run workspaces** | The spec discusses GC only for worktrees, a feature that does not exist yet. The leak is present *today*: every attempt writes logs, a stream log, a `.pi-agent` dir, a session file and artifacts (`src/runstore/workspaceLayout.ts:22-95`), and nothing ever removes them. A container with a data volume and a nightly pipeline fills up |
| **`ensureGlobalService` autostart inside the container** | `docker exec … sf run` against a container whose Host died will silently fork a second detached Host |
| **`sf mcp` serves the full operator REST API** | `docs/mcp.md` claims health-only (`src/server/mcpHost.ts:41-49` says otherwise). Anyone sizing the container's exposure from the docs under-counts it — including this spec |
| **REST catalog is single-project; MCP catalog is multi-project** | `GET /api/pipelines` browses boot `cwd` only (`src/server/http.ts:630-638`); MCP merges `listProjectRoots()` (`src/mcp/catalogTools.ts:27-128`). In a multi-repo container the console and the harness disagree about what exists |
| **`verify` / completion `command` spawns arbitrary shell with `shell: true`** | `src/runtime/completionCheckRunner.ts:195-198`. A second RCE path that does not even need an agent. Raises the cost of getting auth wrong |
| **MCP `start_run` lacks `checkout`, `skipGates`, and CI metadata** | REST and CLI have all three (`src/server/http.ts:352-422`). A harness that can only use MCP cannot pin a checkout or run unattended-fail |
| **Provider OAuth is interactive-only** | `src/cli/terminalAuthInteraction.ts`. The headless story is `--api-key-env` or a pre-seeded `auth.json`; OAuth providers effectively need `docker exec`. The spec's Phase 0 item 5 assumes this is easier than it is |
| **No `STAGEFLOW_HOME`** | See 1.2 |
| **`server.requestTimeout = 0`** | Worth a look before publishing the port |
| **Checkout does not have to be a git repo** | `resolveAndValidateCheckout` requires only an R/W/X directory (`src/runtime/stageRoots.ts:67-94`). Relevant to the XOR design in host-owned-worktrees |

---

## 3. Where the spec is right, and should be defended

Do not water these down. They are the best part of the document.

- **Auth is the biggest gap, and locked decision 2 is wrong.** The argument is correct: an
  unauthenticated `start_run` with an inline pipeline and stage `bash` is remote code execution, and
  the only thing preventing it today is a loopback gate that decision 3 also wants to relax. The
  proposed fix — one shared bearer token plus *refuse to start when bound off-loopback without one* —
  is about 40 lines and closes the whole class. I would go one step further: **the allowed-hosts
  escape hatch and the control token must land in the same commit**, because allowed-hosts alone is
  the vulnerability.
- **Reads are ungated.** Correct and under-appreciated: run detail embeds full stage transcripts.
- **Allowed-hosts must keep validating `Host`, not drop the check.** Correct — the DNS-rebinding
  point is real.
- **Stage env allowlist.** Correct. `fork` passes the whole `process.env`
  (`src/runtime/stageProcessLauncher.ts:208-212`); a prompt-injected stage reads every secret.
- **Worktree per Run on a shared bare-clone cache**, with a **TTL and GC**, and a **stable
  `STAGEFLOW_CHECKOUT` env var** instead of a mount namespace. All correct, and the
  "don't hardcode `~/.stageflow/worktrees/<runId>` in prompts" rule is the kind of thing that only
  gets written down after someone has been bitten.
- **Multi-arch buildx.** Non-negotiable, for exactly the stated reason.
- **`engines.node` is stale at `>=20`.** Confirmed: Pi needs `>=22.19`, `better-sqlite3@13` needs
  `>=22`, and `install.sh` also says 20.
- **`_FILE` variants for every secret env var.** Right, and cheap.
- **The isolation contract** — no added caps, no `--privileged`, never mount the host Docker socket —
  stated explicitly in the docs. This is Stageflow's entire safety story once an image exists.
- **A2A is mountless-dead and needs a restart to change publications; do not add hot reload.**
  Correct on all three counts.
- **Inline-no-rerun is a real ergonomic cliff**, and opt-in `save_as` is the right minimal fix.
- **Don't let the Docker docs turn Stageflow into a coding-agent product.** The non-goals table is
  genuinely good, especially this one.

---

## 4. Where I'd change the plan, not just the facts

| Spec position | My position |
|---|---|
| Phase 0 opens allowed-hosts (item 2); auth arrives in Phase 1 (items 9–10) | **Never ship those separately.** Allowed-hosts without a control token *is* the remote code execution. One change set |
| Repository + worktree (Phase 2) comes before the Dockerfile (Phase 4) | **Ship a bind-mount image first.** Worktrees are entirely greenfield — no clone, fetch, or worktree code exists anywhere (`git` is used only for `rev-parse`, `status`, and `ls-files`). Putting them before the image delays the deliverable by weeks for a capability most first users won't need on day one |
| GC appears as a worktree concern | **GC is a run-workspace concern that exists today** and is independent of worktrees. Promote it into the core phases |
| Store relocation is Phase 0 item 3 | Replace with **`STAGEFLOW_HOME` + flatten the double nesting**. The relocation itself is done |
| Phase 0 item 1: "land the in-flight bind work, add tests" | Rewrite as **"implement bind resolution from scratch"** — and move it to the top, because nothing else is testable in a container until it exists |
| Default entrypoint implied to be `sf ui` (browser suppression is a prerequisite) | **Make it `sf mcp`.** Already browser-free, serves the same REST API, and drops browser suppression off the critical path |
| Definition of container-ready bundles headless + harness parity + repository/worktree + image + ops into one bar | **Two tiers.** Tier 1 = containerized Host with a mounted checkout. Tier 2 = repository-bound, mountless. Tier 1 is shippable in roughly two weeks; the combined bar is five-plus |
| No acceptance test | Add one a stranger can execute end to end — see §3 of the assessment |
| ~60% of the analysis is Intentic description | Useful as a benchmark, but it buries the Stageflow-specific findings. Split the Intentic material into its own reference and leave the spec as findings plus decisions |

---

## 5. The two child specs

Both are in better shape than the analysis, because they are decisions rather than claims about
current state.

**[host-owned-worktrees.md](host-owned-worktrees.md)** — I agree with all ten locked points. Three
notes:

1. Point 3 says worktrees live under Host home "so agent `bash` in a Checkout cannot treat the SQLite
   store as project files." That protection already exists for the store today (see §1.2) — the
   rationale still holds for the worktrees themselves, but don't cite it as a new fix.
2. "Not locked: GC/TTL for finished worktrees." Lock it. Without a default TTL the feature is a disk
   leak by construction, and the same mechanism should also clean up run workspaces (which leak
   today, worktrees or not).
3. Point 6's XOR is sound, but note that a path `checkout` is not required to be a git repo at all
   (`src/runtime/stageRoots.ts:67-94`), so "Repository vs Checkout" is not "git vs git."

**[run-scoped-skills.md](run-scoped-skills.md)** — agree throughout. Point 6's precedence rule
(run payload > Checkout `.pi/skills` > operator skills, with the chosen origin recorded) is the part
that will save the most debugging time, and the "Host writes beside the Run, not into the Worktree"
rule correctly avoids dirtying a PR. The one thing I would promote out of "not locked": a
`list_skills` that reports origin. Without it, "which `SKILL.md` did this stage actually load" is
guesswork over MCP, and there is no `sf skills list` available to a remote caller.

---

## 6. Recommended edits to the spec set

1. **Replace §3 of the analysis** with §2 of [the assessment](container-ready-assessment.md).
2. **Rewrite §1 (executive take).** Item 1 (store relocation) is done; the new item 1 is the bind
   work. Add lifecycle (no SIGTERM handler) and cleanup (no delete/GC) as first-order items.
3. **Merge Phase 0 item 2 into Phase 1.** Allowed-hosts and the control token are one change.
4. **Re-order the phases** per §5 of the assessment: containerizable → open+lock → survivable →
   image → parity → repository/worktree.
5. **Fix the four dead links** to `global-stageflow-service.md`, and note that the spec it referenced
   is substantially implemented.
6. **Add the acceptance test** so "ready" is falsifiable.
7. **Split out the Intentic material** into its own reference document.
8. **Lock worktree TTL/GC** in host-owned-worktrees, and scope it to run workspaces too.
