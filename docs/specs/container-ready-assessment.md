---
status: assessment
---

# Container-ready: independent assessment

Index: [container-ready](container-ready.md) · Review of the existing spec: [container-ready-spec-review](container-ready-spec-review.md)

Written from a fresh read of the code at `3a25568` in worktree `68d4`, without assuming any claim in
[container-ready-analysis.md](container-ready-analysis.md) is true. Where this document and that one
disagree, the disagreement is listed in the [spec review](container-ready-spec-review.md).

No code was changed to produce this.

---

## 0. The goal, restated

> Ship one image. A user runs it anywhere, does some config, points their existing harness
> (coding agent / IDE) at it over MCP or A2A, and gets everything they would get from
> `npm i -g stageflow` on their laptop.

Three separate promises hide in that sentence, and they have very different costs:

| Promise | What it actually demands |
|---|---|
| **Runs in a container** | Process hygiene: bind, no browser, signals, PID 1, volumes, image contents |
| **Reachable from their harness** | Network reachability *and* an authorization story, because the harness is off-box |
| **Full feature parity** | Every capability that is CLI-only or UI-only today must get an API, or be declared out of scope |

The third one is where most of the hidden work is, and it is the one the current spec set covers
least. The second one is where the current spec set makes a decision I think is wrong.

---

## 1. Headline findings

1. **The single hardest blocker is not auth, worktrees, or the Dockerfile — it is that Stageflow
   literally cannot listen on a container-reachable address.** `sf ui` and `sf mcp` parse only
   `--port`. There is no `--host` flag, no `STAGEFLOW_BIND`, no `listenHost.ts`, and no git history
   for any of it. The server hardcodes `options.host ?? "127.0.0.1"`
   (`src/server/http.ts:840`, `src/server/mcpHost.ts:35`). `docker run -p 3847:3847` against
   today's build publishes a port that nothing is listening on from outside the container's
   loopback namespace. Everything else in this document is downstream of fixing that.

2. **The store already left the checkout.** `bootstrapStageflowHost` opens the run store at
   `ctx.globalHome`, i.e. `~/.stageflow/.stageflow/state.db`
   (`src/server/bootstrap.ts:69`, `src/project/globalHome.ts:5`). A stage's `bash` in a checkout
   cannot reach it. The real residual problems are different and smaller: there is no
   `STAGEFLOW_HOME`, the path is hardcoded off `os.homedir()`, and the directory nests
   `.stageflow` inside `.stageflow`.

3. **You cannot have both "connect from anywhere" and "no auth."** `/mcp` is gated by
   `localhostHostValidation()` + `localhostOriginValidation()` with no override
   (`src/server/createHttpHost.ts:64-81`). That gate is the *only* thing standing between the
   public internet and an unauthenticated `start_run` that executes arbitrary `bash`. The moment we
   add the allowed-hosts escape hatch that remote access requires, we have shipped a remote code
   execution endpoint. These two changes must land in the same commit, never separately.

4. **Every `GET /api/*` is already unauthenticated and not loopback-gated** — run list, run detail
   (which embeds full stage event transcripts), artifact bytes, provider auth status, settings
   (`src/server/http.ts:143-164` only gates POSTs). Binding `0.0.0.0` today, with no other change,
   publishes every transcript and artifact on the box.

5. **A long-lived container has no cleanup path.** There is no run delete, no run-level cancel, and
   no GC anywhere in the codebase. Each attempt writes `log.jsonl`, `stream.log`, `.pi-agent/`,
   `pi-session.jsonl`, and an artifacts dir under `runs/<runId>/stages/<stageId>/attempts/<n>/`
   (`src/runstore/workspaceLayout.ts:22-95`). A laptop install tolerates this. A container that
   runs nightly pipelines fills its volume and there is no supported way to reclaim it.

6. **Feature parity over MCP is close but not complete**, and the gaps are the ones a real user hits
   on day two: no skills install, no provider login, no checkout override / skip-gates / CI
   metadata on `start_run`, no run delete, no cancel, and inline pipelines can never be rerun.

---

## 2. Verified current state

Everything here was read in this worktree. Claims are cited; contradictions with the existing
analysis doc are flagged in the [spec review](container-ready-spec-review.md).

### 2.1 Network and reachability

| Fact | Evidence |
|---|---|
| Default port `3847` | `DEFAULT_PORT`, `src/server/createHttpHost.ts:16` |
| Bind hardcoded `127.0.0.1` for both hosts | `src/server/http.ts:840`, `src/server/mcpHost.ts:35` |
| CLI parses `--port` only; **no `--host`, no `STAGEFLOW_BIND`** | `src/cli.ts:57-58`; repo-wide search for `listenHost`/`STAGEFLOW_BIND` returns nothing outside planning docs |
| `host` exists as a *programmatic* option on `startUiServer` / `startMcpServer` | `UiServerOptions.host`, `McpServerOptions.host` — library callers only |
| `/mcp` gated by MCP SDK localhost Host **and** Origin validators, no override | `src/server/createHttpHost.ts:64-81` |
| Mutating REST gated by `assertLoopbackHttpAccess`; **reads are not gated** | `src/server/http.ts:143-164` (`isMutatingApi` is POST-only), `216-244` |
| Provider login/logout additionally require a non-empty loopback `Origin` | `src/server/http.ts:176-197` |
| A2A is bearer-authenticated and **not** loopback-gated | `src/a2a/registry.ts:114-118`; dispatched before the MCP gate in `createHttpHost` |
| No CORS headers, no WebSocket, no REST SSE. MCP session mode uses `GET /mcp` as its SSE channel | `src/server/` |
| `server.requestTimeout = 0` | `src/server/createHttpHost.ts` |
| `hostBaseUrl()` hardcodes `http://127.0.0.1:<port>` | `src/server/ensureGlobalService.ts:52-54` |
| UI default MCP URL hardcodes `127.0.0.1:3847` | `ui/src/mcpConnect.ts` |

**Consequence.** With a fix for bind only, `docker run -p 3847:3847` from the same laptop works for
MCP (the client sends `Host: localhost:3847`). A remote host, a LAN name, a Tailscale name, a
reverse proxy, or `https://sf.example.com` all return 403 with no diagnosable message. SSH tunnel is
the only remote path that works, and it works by accident of the Host header, not by design.

### 2.2 Process lifecycle

| Fact | Evidence |
|---|---|
| Stage workers are `fork()`ed CLI children running `internal run-stage` | `src/runtime/stageProcessLauncher.ts:208-212` |
| Children inherit the **entire** `process.env`, plus `SF_STAGE_WORKER=1` | same line — `env: { ...process.env, ...this.env, [SF_STAGE_WORKER]: "1" }` |
| **No `SIGTERM` / `SIGINT` handler** on `sf ui` or `sf mcp`; both block on a never-resolving promise | `src/cli.ts`; only `server.on("close")` → `mcpHandler.close()` |
| Per-stage cancel does SIGTERM then SIGKILL after 5 s | `src/runtime/stageProcessLauncher.ts:118-145` |
| Orphaned `running` stages are reconciled to failed **on next boot** | `src/runtime/runManager.ts:431-441` |
| `sf ui` **always** spawns a browser (`open` / `cmd` / `xdg-open`); no flag or env to suppress | `src/cli.ts:297-305, 398-412` |
| `sf run` and mutating `sf runs` auto-spawn a **detached** `sf mcp` if none answers health | `src/server/ensureGlobalService.ts:132-160` |
| Pipeline `verify` / completion `command` checks spawn arbitrary shell with `shell: true` | `src/runtime/completionCheckRunner.ts:195-198` |
| Concurrency: `STAGEFLOW_MAX_CONCURRENT_RUNS` default 3; stages-per-run and stage-process pool default unlimited | `src/runtime/runManager.ts:166-170`, `src/runtime/stageConcurrency.ts` |

**Consequence.** `docker stop` sends SIGTERM; Node's default action terminates the host immediately.
In-flight stage workers are orphaned, their Pi sessions die mid-tool-call, and SQLite WAL is not
closed cleanly. Nothing is corrupted — the next boot reconciles — but every in-flight run is lost
with no drain and no warning. Separately, as PID 1 the Node host does not reap grandchildren, and Pi's
`bash` tool spawns plenty of those.

### 2.3 State and filesystem

| Path | Contents | Writer |
|---|---|---|
| `~/.stageflow/` | global home, created at every CLI entry | `src/project/globalHome.ts:9-18` |
| `~/.stageflow/agent/` (0700) + `auth.json` | `sf_owned` provider credentials | `ensureSfOwnedAuthStore` |
| `~/.stageflow/settings.json` | max concurrent, credential source | `src/runtime/settingsFile.ts` |
| `~/.stageflow/service.log` | detached autostart log | `src/server/ensureGlobalService.ts:132-134` |
| `~/.stageflow/.stageflow/state.db` (+ `-wal`, `-shm`) | **the run store** | `src/server/bootstrap.ts:69` → `storeRootFor(globalHome)` |
| `~/.stageflow/.stageflow/runs/<runId>/…` | run + stage + attempt workspaces, logs, envelopes, artifacts, `.pi-agent` | `src/runstore/workspaceLayout.ts:22-95` |
| `~/.stageflow/.stageflow/a2a-artifacts/` | A2A artifact bytes | `src/a2a/store.ts:120-121` |
| `~/.pi/agent/auth.json` | `pi_home` provider credentials | `src/runtime/credentialBinding.ts:40-46` |
| `<gitRoot>/.stageflow/settings.json` | per-project settings | `src/runtime/settingsFile.ts:28-35` |
| `<gitRoot>/.pi/skills/<name>/` | installed skills | `src/cli/skillsCommand.ts:117` |

Other relevant facts: driver is `better-sqlite3` in WAL mode with `busy_timeout` default 5000 ms
(`src/runstore/sqlite/SqliteRunStore.ts:491-495`); there is **no `STAGEFLOW_HOME`**; there are no
lock files or PID files — port 3847 is the de-facto singleton lock; artifact reads deny any path
segment `.pi-agent` or basename `auth.json` (`src/mcp/readArtifact.ts:73-78`), but Pi's own file
tools have no equivalent deny list.

**Consequence.** The volume contract is "whatever `os.homedir()` resolves to." That is fragile in a
container: run with `--user 1000:1000` and no matching `/etc/passwd` entry and `os.homedir()` can
resolve to `/` or the value of `HOME`, silently relocating every durable path. And the store is a
SQLite WAL database with two writers (host + forked workers), which must not sit on a macOS or
Windows bind mount.

### 2.4 Checkout and git

- `resolveAndValidateCheckout` requires an existing directory with R+W+X. It does **not** require a
  git repo (`src/runtime/stageRoots.ts:67-94`).
- With no checkout, the run is "unbound" and the agent `cwd` is the run workspace
  (`src/runtime/stageRoots.ts:106-122`).
- One active run per `realpath(checkout)` (checkout lease, `src/runtime/runManager.ts`).
- **No git provisioning primitives exist anywhere.** `git` is executed only for
  `rev-parse --show-toplevel` (`src/project/findProjectRoot.ts:24`), `status --porcelain`
  (`src/config/migrateYaml.ts`), and `ls-files` for checkout fingerprinting
  (`src/runtime/gitCheckoutCapability.ts:15`). No clone, no fetch, no worktree, no branch, no push.
  No `simple-git` or `isomorphic-git` dependency.
- "Clone Chain" in the YAML dialect is DAG fork scheduling, unrelated to git.

**Consequence.** A container with no bind mount today can only run *unbound* pipelines that touch no
repository. That is a real but narrow product. Everything the host-owned-worktrees spec describes is
greenfield.

### 2.5 Harness parity

Reachable over MCP today: `list_pipelines`, `list_tasks`, `list_models`, `list_runs`, `get_health`,
`start_run` (path **or inline pipeline object**, path or inline task), `get_run`, `read_artifact`,
`validate`, `describe_pipeline`, `list_waiting`, `get_waiting_summary`, `answer_gate`,
`decide_feedback_loop`, `list_stage_events`, `tail_stage_log`, `get_stage_verification`,
`recover_manual_stage`, `stop_manual_recovery`, `get_envelope`, `retry_stage`, `resume_stage`,
`abandon_stage`, `rerun`, `wait_run`, `list_providers`, `list_project_mcp`, `probe_project_mcp`,
plus the `stageflow://runs/{runId}` resource with subscribe.

That is a genuinely good harness surface. HITL works end to end over MCP for every gate kind
(`src/tools/askOperator.ts:440-487` parses the answer; `src/runtime/stageHitl.ts:282-334` delivers
it), and `tail_stage_log` gives live assistant output by polling a byte offset
(`src/mcp/controlTools.ts:164-214`). The gaps:

| Missing over MCP | Where it exists today | Why it matters in a container |
|---|---|---|
| `skills install` | CLI only (`sf skills install`) | Harness cannot add a skill to a running container without `docker exec` |
| Provider login / logout | REST + CLI; OAuth is interactive-only (`src/cli/terminalAuthInteraction.ts`) | Credentials must be pre-seeded or set with `--api-key-env`; OAuth providers effectively need a `docker exec` session |
| `checkout` override, `skipGates`, CI metadata on start | REST `POST /api/runs`, CLI `sf run` | Harness cannot pin a checkout per run or run unattended-fail |
| Inline pipeline **rerun** | — | `rerun` hard-requires `meta.pipeline_path` (`src/runtime/runManager.ts:688-694`). Inline runs are un-retryable |
| Run delete / run-level cancel / GC | nowhere | No cleanup path at all |
| `export-run`, `graph`, `migrate-yaml`, `sf a2a *` | CLI only | Acceptable to leave CLI-only, but must be stated |
| Inline pipeline over REST | MCP only (`src/server/http.ts:362-365` requires a string) | UI in the container can't do what the harness can |

Two asymmetries worth calling out because they will produce confusing bug reports:

- **`sf mcp` serves the full operator REST API**, not just `/api/health` as `docs/mcp.md` claims
  (`src/server/mcpHost.ts:41-49`). Anyone sizing the container's exposure from the docs will
  under-count it.
- **REST catalog is single-project, MCP catalog is multi-project.** `GET /api/pipelines` browses
  only the boot `cwd` (`src/server/http.ts:630-638`), while MCP `list_pipelines` merges across
  `store.listProjectRoots()` (`src/mcp/catalogTools.ts:27-128`). In a container serving several
  mounted repos, the console and the harness will show different catalogs.

A2A is the only surface designed for off-box callers (bearer tokens, HTTPS `public_url` validation,
per-caller rate limits), but it is invoke-only against publications that must already be on disk,
the config is read once at boot with no reload, and callers can answer only `free_text` gates on
allowlisted stages (`docs/a2a.md:91-112`). In a container with no `/workspace` mount there is no
`a2a.yaml`, so A2A is simply disabled.

### 2.6 Image contents

| Item | State |
|---|---|
| **No Dockerfile, no compose file, no `.dockerignore`, no container CI** | verified by search |
| `engines.node` says `>=20` | `package.json:52-54` |
| Pi (`@earendil-works/pi-ai`, `pi-coding-agent`) requires `>=22.19`; `better-sqlite3@13` requires `>=22` | `package-lock.json:1367, 1423, 5437` |
| CI runs Node 22; publish/release run Node 24 | `.github/workflows/` |
| `install.sh` enforces Node ≥ 20 — below the real floor | `install.sh:6` |
| `better-sqlite3` is native with install scripts allowlisted; `@anthropic-ai/claude-agent-sdk` ships platform-specific optional deps | `package.json` `allowScripts`, `package-lock.json:72-88` |
| Runtime OS binaries: `git`, plus `bash` for Pi's tool and for `verify` commands | `src/project/findProjectRoot.ts`, `src/agent/piAdapter.ts:108-111`, `src/runtime/completionCheckRunner.ts` |
| `gh` is **not** invoked by Stageflow — it appears only in example stage prompts | search |
| UI assets resolve to `dist/ui`, sibling of `dist/server` | `src/server/http.ts:246-252` |
| Package ships `dist`, `skills`, README, LICENSE; `verify-pack` enforces `skills/stageflow/SKILL.md` | `package.json` `files`, `scripts/verify-pack.ts` |
| `/api/health` returns capacity only — **no version**; MCP `get_health` does include version | `src/server/http.ts:745`, `src/runtime/runManager.ts:294-311` |

---

## 3. What "container-ready" should mean here

I recommend two tiers, because collapsing them is what makes this look like a five-week project.

### Tier 1 — Containerized Host (the actual MVP)

A published multi-arch image that runs the Host headless, reachable from the operator's harness,
with durable state and a documented safe configuration. The Checkout arrives as a bind mount.

Acceptance test, runnable by a stranger:

1. `docker run` the image on a VPS with a data volume, an API key, and a control token.
2. From a laptop, point a coding agent's MCP client at the container and call `get_health`.
3. `start_run` with an inline pipeline and inline task — no files, no mount.
4. `tail_stage_log` shows live output; `list_waiting` shows the gate; `answer_gate` unblocks it.
5. `docker stop` mid-run drains cleanly; `docker start` shows the run in a sane, explained state.
6. Repeat step 3 against a bind-mounted repo via `task.checkout` and see files change on the host.
7. Delete the run and watch the volume shrink.
8. Without a control token and with a non-loopback bind, the container **refuses to start**.

### Tier 2 — Repository-bound Host (the mountless story)

`task.repository` + `ref`, a Host-side bare-clone cache and a `git worktree` per Run, credentials on
the Host, PR-raising as an ordinary stage, plus run-scoped skills so a harness can ship a `SKILL.md`
with the call. This is what the two locked child specs describe, and it is all greenfield.

Tier 2 is the better product. Tier 1 is what unblocks a user this month.

---

## 4. Gap register

Severity: **P0** blocks Tier 1 · **P1** required for a safe/supportable Tier 1 · **P2** Tier 2 or polish.

### Reachability

| # | Gap | Sev | Fix |
|---|---|---|---|
| R1 | No way to bind off-loopback from the CLI | **P0** | `--host` flag + `STAGEFLOW_BIND` env, precedence flag > env > `127.0.0.1`; wire into both `sf ui` and `sf mcp`; sanitize the *advertised* URL so binding `0.0.0.0` doesn't print a wrong link |
| R2 | `/mcp` Host+Origin gate has no escape hatch → 403 behind any proxy or remote name | **P0** | `STAGEFLOW_ALLOWED_HOSTS` resolver replacing the unconditional validators, defaulting to loopback. Must still validate `Host` (DNS-rebinding defence), never just skip the check |
| R3 | Same gate shape on mutating REST | **P0** | Same resolver in `assertLoopbackHttpAccess` |
| R4 | All GET `/api/*` ungated and unauthenticated | **P0** | Apply the auth check to reads too |
| R5 | `sf ui` always spawns a browser | **P0** | `--no-open` + `STAGEFLOW_NO_OPEN`; image sets the env. (`sf mcp` is already browser-free and is the better default entrypoint) |

### Authorization — **must ship in the same change as R2/R3**

| # | Gap | Sev | Fix |
|---|---|---|---|
| A1 | `/mcp` and REST have no authentication of any kind | **P0** | `STAGEFLOW_CONTROL_TOKEN` / `_FILE`, checked as `Authorization: Bearer` on `/mcp` and all `/api/*` except `/api/health`. Reuse A2A's ≥32-char validation and constant-time compare (`src/a2a/registry.ts:114-118`) |
| A2 | The unsafe configuration is reachable by accident | **P0** | **Refuse to start** when the resolved bind is non-loopback and no control token is set. One error naming both env vars. This is ~40 lines and it is the whole security model |
| A3 | Stage workers inherit the entire `process.env` | **P1** | Curated env for forked workers. The control token and provider keys must never be in stage `bash`; `GITHUB_TOKEN` only where a stage opts in |
| A4 | `verify` / completion `command` runs arbitrary shell | **P1** | Nothing to fix in the mechanism — but it is a second RCE path that does not require an agent, so it raises the cost of getting A1/A2 wrong. Document it |
| A5 | Two scopes would be cheap and useful | **P2** | `read` vs `drive`, so a dashboard token cannot start runs |

### Process lifecycle

| # | Gap | Sev | Fix |
|---|---|---|---|
| L1 | No SIGTERM/SIGINT handling; `docker stop` kills in-flight runs abruptly | **P0** | Handler that stops accepting starts, signals stage workers, marks in-flight runs recoverable, closes SQLite. Document the exit code and a compose `stop_grace_period` |
| L2 | No PID 1 reaper; forked workers and Pi's `bash` grandchildren zombie | **P0** | `tini` in the image / `init: true` in compose |
| L3 | `ensureGlobalService` can spawn a second detached host inside the container | **P1** | Env to disable autostart (or detect "I am the container entrypoint") so `docker exec … sf run` talks to the running host and never forks a rival |
| L4 | No liveness signal with build identity | **P1** | Add `version` + build sha to `GET /api/health` (MCP `get_health` already has version); use it as the Docker `HEALTHCHECK` |

### State and volumes

| # | Gap | Sev | Fix |
|---|---|---|---|
| S1 | Durable root is hardcoded off `os.homedir()`; no override | **P0** | `STAGEFLOW_HOME`, defaulting to `~/.stageflow`. Removes the `--user`/`HOME`-unset failure mode and makes the volume contract explicit |
| S2 | `~/.stageflow/.stageflow/` double nesting | **P2** | Cosmetic, but it will confuse every `VOLUME` line and every docs page. Fix while touching S1 |
| S3 | Provider credentials split across `~/.stageflow/agent` and `~/.pi/agent` | **P1** | Document both, or force `sf_owned` in the image so one volume covers it |
| S4 | SQLite WAL with two writers must not be on a bind mount | **P1** | Named volume; state it in the docs; the image should fail loudly if the store path looks like a bind mount on a non-Linux host (or at minimum warn) |
| S5 | **No run delete, no GC, no run-level cancel** | **P1** | `delete_run` + a retention TTL + `sf runs gc`, plus a disk-usage line in health. Without this the container is a slow disk leak |
| S6 | Pi's file tools have no read-deny list for the store or auth files | **P2** | Extend the instinct already in `src/mcp/readArtifact.ts:73-78` to the agent's own tools |

### Harness parity

| # | Gap | Sev | Fix |
|---|---|---|---|
| H1 | Path contract is undefined for an off-box caller | **P0** | Document it: inline pipeline + inline task is the mount-free path; file paths are **catalog-relative to the container's project root**, never host absolutes. Reject absolute paths from MCP with a clear error |
| H2 | `start_run` lacks `checkout`, `skipGates`, CI metadata | **P1** | Add to the MCP schema — REST already has them |
| H3 | Inline pipelines cannot be rerun | **P1** | Either persist the inline pipeline with the run and let `rerun` replay it, or add opt-in `save_as` that writes it to the catalog and gives the run a `pipeline_path` |
| H4 | No skills over MCP | **P1** | The run-scoped skills spec is the right answer; until then, document `docker exec … sf skills install` |
| H5 | No provider login over MCP; OAuth is interactive-only | **P1** | Make the headless path first-class: `STAGEFLOW_PROVIDER_*_API_KEY` / `_FILE` read at boot, so the image self-configures. `docker exec` for OAuth, documented |
| H6 | REST catalog single-project vs MCP multi-project | **P1** | Align them, or the console lies to the operator |
| H7 | `docs/mcp.md` says `sf mcp` serves health only; it serves everything | **P1** | Fix the doc — it understates the exposure people will secure |
| H8 | A2A is dead without a `/workspace` mount and needs a restart to change publications | **P2** | Accept and document, or add a config source outside `/workspace`. Do **not** add hot reload — the no-reload decision is deliberate and correct |
| H9 | A2A callers can only answer `free_text` gates | **P2** | Document as a known limit of the A2A contract |

### Image and delivery

| # | Gap | Sev | Fix |
|---|---|---|---|
| I1 | `engines.node` `>=20` is below the real floor | **P0** | `>=22.19`, and update `install.sh` |
| I2 | No Dockerfile | **P0** | Multi-stage; Node 22.19+ slim; `git`, `bash`, `ca-certificates`, `tini`; `npm ci --omit=dev` with `better-sqlite3` built; non-root `stageflow` user; `ENV STAGEFLOW_BIND=0.0.0.0 STAGEFLOW_NO_OPEN=1 STAGEFLOW_HOME=/data`; `EXPOSE 3847`; `VOLUME /data`; `HEALTHCHECK`; `ENTRYPOINT ["tini","--","sf"] CMD ["mcp"]` |
| I3 | `better-sqlite3` is native | **P0** | buildx `linux/amd64` + `linux/arm64`. Non-negotiable: M-series laptops and x86 VPSes |
| I4 | No compose file | **P1** | Versioned in-repo: `init: true`, `restart: unless-stopped`, log rotation, `ports: "127.0.0.1:3847:3847"`, named volume, optional `/workspace` mount, `env_file`, `stop_grace_period` |
| I5 | No container CI | **P1** | GHCR publish on tag: `:x.y.z`, `:x.y`, `:stable`, SBOM + provenance, base pinned by digest |
| I6 | No `docs/docker.md` | **P1** | One page a stranger can follow. Must state plainly: the isolation contract (no added caps, no `--privileged`, never mount the host Docker socket), the reverse-proxy status, update/rollback, backup, and how to build a derived image for extra tooling |

### Tier 2

| # | Gap | Sev |
|---|---|---|
| T1 | No git clone / fetch / worktree primitives at all | **P2** |
| T2 | `repository` + required `ref` on the task, XOR with `checkout` | **P2** |
| T3 | Bare-clone cache + worktree per RunId under `$STAGEFLOW_HOME` | **P2** |
| T4 | `STAGEFLOW_CHECKOUT` exported to stages; prompts must never hardcode a worktree path | **P2** |
| T5 | Worktree TTL and GC (folds into S5) | **P2** |
| T6 | Git credentials via helper / `GIT_ASKPASS` rather than raw token in stage env (folds into A3) | **P2** |
| T7 | Run-scoped `start_run.skills` (folds into H4) | **P2** |

---

## 5. Recommended order

Each phase is independently shippable and nothing later invalidates something earlier.

**Phase 0 — make the process containerizable.** R1, R5, L1, L2, S1, I1, L4.
Outcome: `sf mcp` runs headless in a container, binds where you tell it, stops cleanly, and keeps its
state in one explicit directory. Still loopback-only, still unauthenticated — which is fine, because
it is still unreachable.

**Phase 1 — open the door and lock it at the same time.** R2, R3, R4, A1, A2.
This is one change set, not two. The refuse-to-start rule (A2) is the cheapest complete mitigation:
it preserves the spirit of "Stageflow is not building an identity system" while making the dangerous
configuration unreachable by accident. Ship A3 (stage env allowlist) alongside if it fits; it is the
difference between "a stolen token starts runs" and "a prompt-injected stage exfiltrates your
GitHub token."

**Phase 2 — make it survivable.** S5 (delete + GC + cancel), S3, S4, L3, H1, H5, H6, H7.
This is the "someone actually runs it for a month" phase. Unglamorous and load-bearing.

**Phase 3 — ship the image.** I2, I3, I4, I5, I6.
Deliberately last: a Dockerfile written before Phase 0 lands has to be rewritten.

**Phase 4 — parity polish.** H2, H3, H4, A5, S6, H8, H9.

**Phase 5 — Tier 2.** T1–T7, i.e. the two locked child specs.

Rough sizing, for planning only: Phase 0 ≈ 2–3 days, Phase 1 ≈ 2–3 days, Phase 2 ≈ 4–6 days,
Phase 3 ≈ 2–3 days, Phase 4 ≈ 3–5 days, Phase 5 ≈ 1.5–2 weeks.

---

## 6. Positions I hold against the locked decisions

1. **"No operator auth" is not viable given the other locked decisions.** Decision 3 wants the image
   to bind `0.0.0.0`; decision 1 wants MCP published; decision 9 makes `start_run` accept an inline
   pipeline whose stages have `bash`. Those three together are an unauthenticated RCE endpoint with
   a `GITHUB_TOKEN` in the same process env. The security model today is an accident of a gate that
   decision 3 also wants to relax. Adopt A1 + A2.

2. **Repository + worktree should not gate the first image.** Bind-mount the checkout for Tier 1 and
   ship. The worktree work is the right long-term answer and is entirely greenfield; putting it
   before the Dockerfile delays the thing the user asked for by weeks.

3. **Run deletion and GC are container-ready requirements, not polish.** On a laptop you delete
   `~/.stageflow` by hand. In a container there is no hand.

4. **The default entrypoint should be `sf mcp`, not `sf ui`.** It is already browser-free, it serves
   the same REST API, and the console is served by a separate opt-in. That removes R5 from the
   critical path for the default configuration.

---

## 7. Method

Five parallel code investigations were run over this worktree, each scoped to one surface —
[server surface](8f203c3c-61e4-4e28-a9f0-7fa958785200),
[state and process model](ed077103-94da-459d-a536-944f54194a08),
[packaging and build](dd1df6e4-7aab-479e-8688-64343de84b6d),
[harness feature parity](f2a8b2bd-767b-4236-82c0-0f38d103b80f), and
[single-project assumptions](2feaae10-b519-4786-896c-f4a9efb02f8a) —
with no access to the existing spec, so their findings could not be anchored by it. The three claims
that contradict the existing analysis (bind flags, store location, `rerun` semantics) were then
re-verified by hand.
