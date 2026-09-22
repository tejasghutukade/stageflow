---
status: analysis
---

# Container-ready analysis: Stageflow, with Intentic as the sophistication reference

Index: [container-ready](container-ready.md)

Independent analysis. Intentic is used as a maturity benchmark for containerization and
operational posture, not as a product to clone. Stageflow is a domain-agnostic staged-agent
runtime; Intentic is a workspace-per-container coding-agent product. The shapes differ, and the
places where they differ are as useful as the places where they agree.

No code was changed for this document.

> **Correction notice.** Section 3 ("Stageflow as it exists") was re-verified against the code and
> two of its load-bearing facts were wrong: the bind work does **not** exist in any form, and the
> run store has **already** moved out of the Checkout. Corrected passages are marked
> **[corrected]** inline. Sections 5–8 (analysis and recommendations) stand. Read
> [container-ready-spec-review](container-ready-spec-review.md) for the full list, and
> [container-ready-assessment](container-ready-assessment.md) for a verified replacement of §3.

---

## 1. Executive take

Stageflow can be made to *start* in Docker with a few days of work. It cannot be made
*container-ready* — in the sense the user actually means (headless Runs, published UI + MCP +
A2A, Repository → Worktree → PR) — without four things the locked decisions currently skip:

1. **A durable-state contract that does not depend on `os.homedir()`.** **[corrected]** — this item
   originally claimed the run store lived at `<git-root>/.stageflow/` and had to be moved out of the
   Checkout. It already has: `bootstrapStageflowHost` opens the store at `ctx.globalHome`
   (`src/server/bootstrap.ts:69`, `src/project/globalHome.ts:5`), so it sits at
   `~/.stageflow/.stageflow/state.db`, outside any Checkout. A stage's `bash` cannot reach it, and
   the `rm -rf .stageflow` scenario described here cannot happen. The instinct was right and
   matches Intentic, which mounts `/history` as a *separate volume outside `/work`* precisely so
   "an agent `rm -rf`-ing its workspace cannot reach the history that would let you recover from
   it" ([Docker setup](https://intentic.dev/docs/docker/)). What remains for a container is
   smaller: the path is hardcoded off `os.homedir()` with no `STAGEFLOW_HOME` override (fragile
   under `--user` with no passwd entry), the `.stageflow/.stageflow/` nesting is confusing to write
   a `VOLUME` line against, provider credentials are split across `~/.stageflow/agent` and
   `~/.pi/agent`, and a SQLite WAL database with two writers must not land on a bind mount.

2. **An optional control token.** Locked decision 2 says no operator auth. Stageflow already
   ships per-caller bearer tokens for A2A (`callers[].token_env` in `a2a.yaml`,
   [docs/a2a.md](../a2a.md)) — so the primitive exists. The result of the locked decision is
   internally inconsistent: the *narrow* surface (A2A, invoke-only, digest-pinned) is
   authenticated and reachable off-loopback, while the *total-control* surface (MCP + mutating
   REST) is unauthenticated. Intentic's whole published-service story rests on hashed,
   scoped, revocable control tokens ([Authorising a call](https://intentic.dev/api/auth/)). The
   cheap version for Stageflow is one shared bearer token, refused-to-start if bind is
   non-loopback and no token is set. That is ~100 lines and it is the difference between "their
   networking" and "a remote code-execution endpoint."

3. **Fixing the loopback Host/Origin gate, or writing it down as a hard constraint.**
   `/mcp` is gated by `localhostHostValidation()` / `localhostOriginValidation()` in
   `src/server/createHttpHost.ts`, and mutating REST is gated by `assertLoopbackHttpAccess` in
   `src/server/http.ts`. `docker run -p 3847:3847` works (the client sends `Host: localhost`).
   A reverse proxy, a LAN hostname, or `https://sf.example.com` does **not** — it 403s. Locked
   decision 3 accepts this and prescribes an SSH tunnel. That is defensible and it matches
   Intentic's posture in spirit (no inbound port, reach it through a tunnel), but Intentic
   *automates* the tunnel and Stageflow would be handing the operator a manual one. Either add an
   allowed-hosts env var or document "reverse proxy is unsupported" explicitly, because silently
   403ing behind nginx is the single most likely first-contact failure.

4. **Image and process hygiene that Intentic gets right in one compose file.** `init: true`,
   `restart: unless-stopped`, log rotation, minimal capabilities, no host Docker socket, pinned
   DNS, named volumes, and an image that prints its own run command
   ([Quickstart](https://intentic.dev/docs/quickstart/), [Docker setup](https://intentic.dev/docs/docker/)).
   Stageflow's stage workers are `fork()`ed Node children — without PID 1 reaping they become
   zombies. Node 22.19 is required by Pi and `package.json` still says `>=20`. `better-sqlite3` is
   native, so the image needs multi-arch builds. None of this is hard; all of it is load-bearing.

The locked implementation order ("bind → repository+worktree → skills → Dockerfile") is directionally
right but omits Phase 0 plumbing (store relocation, PID 1, signals, secret files, health/version)
and omits the auth decision entirely. A more complete phase list is in §7.

---

## 2. How Intentic is containerized / deployed (facts, cited)

### 2.1 Shape: one image, two containers, three volumes, one network

Every install route produces identical objects, derived from the sandbox slug
([Docker setup](https://intentic.dev/docs/docker/)):

| Object | Name | Contents |
|---|---|---|
| Container | `intentic-sandbox-<slug>` | daemon, agent, workspace |
| Container | `intentic-sandbox-tunnel-<slug>` | outbound tunnel connector (surfaced in [Troubleshooting](https://intentic.dev/docs/troubleshooting/)) |
| Volume | `intentic-workspace-<slug>` | `/work` — repos and files |
| Volume | `intentic-history-<slug>` | `/history` — git history, transcripts, checkpoints, identity, durable daemon records |
| Volume | `intentic-docker-<slug>` | `/var/lib/docker` — in-sandbox engine storage (rebuildable cache) |
| Network | `intentic-workspace-<slug>` | where the connector reaches the daemon by alias |

There is **no Kubernetes story** in the docs. The documented happy path is a single container on
"a laptop, a desktop, or a VPS" ([Quickstart](https://intentic.dev/docs/quickstart/)); scaling out
is *remote runners* (one more container of the same image in execution-only mode, dialling the
parent over one outbound socket) rather than an orchestrator
([Remote runners](https://intentic.dev/docs/remote-runners/)).

### 2.2 The compose file, verbatim-relevant bits

From [Quickstart](https://intentic.dev/docs/quickstart/):

```yaml
image: ghcr.io/intentic/sandbox:stable
pull_policy: always
init: true
cap_add: [SYS_ADMIN, SYS_PTRACE]
restart: unless-stopped
dns: [1.1.1.1, 1.0.0.1]
extra_hosts: [host.docker.internal:host-gateway]
logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }
ports: ["127.0.0.1:${LOCAL_PORT}:8788"]
volumes: [work:/work, history:/history, docker-engine:/var/lib/docker]
```

Four routes are documented — desktop app, `curl | sh` setup command, Compose, plain `docker run` —
all producing the same objects, so a sandbox can move between management styles later.

### 2.3 Ports: none inbound

> "Nothing is published to the network. The sandbox is reached over a private tunnel that its own
> agent dials outward... Inside the container the daemon serves the tunnel on `8787` and preview
> servers on `5173`; neither is bound on your machine."
> — [Docker setup](https://intentic.dev/docs/docker/)

The one published port is `127.0.0.1:<derived>:8788`, and the docs are explicit that it is a
latency shortcut for a browser on the same machine, not a way in. If the port is taken, every
install path retries with `--no-local-publish` and the sandbox works over the tunnel
([Troubleshooting](https://intentic.dev/docs/troubleshooting/)). TLS and the public hostname
(`https://<slug>.intentic.dev`) live at the tunnel/hub, not in the container. There is no reverse
proxy configuration to write.

### 2.4 Auth for a published service

This is the most developed part of Intentic's model and the one most relevant to Stageflow
([Access & sharing](https://intentic.dev/docs/access/), [Authorising a call](https://intentic.dev/api/auth/)):

| Mechanism | Detail |
|---|---|
| Owner binding | Trust-on-first-use: first verified Google identity to reach a new sandbox becomes owner. The platform cannot name one. |
| Person credential | Browser presents a Google ID token *directly to the daemon*; daemon verifies against Google's keys, then mints its own session (`POST /system/session`, `authorization: Bearer …`). Signing secret never leaves the box. |
| Program credential | `x-intentic-control: ict_…`. Shown once at mint; only the hash is stored; revocable individually; optional expiry; last-use and minter recorded. |
| Scopes | `editor` (one conversation), `read` (viewer reads), `drive` (start/answer/steer/stop turns), `land` (also merge/discard). Scope is *chosen at mint*, not inferred from the caller. |
| Hard floor | "no token reaches the sandbox's own trust surface: secrets, connected accounts, the member roster, sessions, this token list, the terminal, logs, exports, money and the network." |
| Member tiers | Desk / Viewer / Collaborator / Maintainer / Owner, enforced by the daemon, re-resolved on *every request* so removal takes effect on the next action. |
| Open routes | Only `/health` plus webhook/enrolment routes, each with its own narrow check. `/health` "deliberately checks nothing." |

They also say the uncomfortable part out loud: "at `drive` and above, a stolen token is the
agent's reach, because driving an agent means editing files and running commands in this sandbox."

### 2.5 Volumes, secrets, and what the agent may read

- Workspace (`/work`) and recovery state (`/history`) are **separate volumes**, deliberately, so a
  destructive agent command in the workspace cannot reach the recovery record
  ([Docker setup](https://intentic.dev/docs/docker/)).
- Backup is "ordinary named Docker volumes, so whatever you already use to back up a volume works
  here"; the docker-engine volume is explicitly skippable.
- Secrets live in a store "in a file the agent is not allowed to read," on the daemon's file-route
  denylist; `/secrets` lists names only; `/secrets/reveal` is the single owner-only exception; and
  secrets can be *gated* behind named approvers with `use` or `conversation` scope
  ([Secrets API](https://intentic.dev/api/secrets/), [Capabilities](https://intentic.dev/docs/capabilities/)).
- Credentials are substituted "by reference at the moment a command runs" rather than living in the
  repo.

### 2.6 How work starts, and git/GitHub credentials

- The workspace is durable and long-lived; repos are cloned into `/work` through the daemon's git
  API (`/git`, 45 calls — [Sandbox API](https://intentic.dev/api/)).
- Isolation is **one git worktree per repo per isolated conversation**, with that composition
  *mounted at `/work` for the turn*, so "parallel agents see the paths every project instruction
  already names while editing different branches" ([Architecture](https://intentic.dev/docs/architecture/)).
  The rationale is spelled out in [One worktree per agent](https://intentic.dev/blog/one-worktree-per-agent/):
  a branch is a pointer, not an isolated directory.
- "Landing is the single door back" — one reviewed operation applies the conversation's delta to the
  main tree.
- GitHub arrives as a *capability*: "The agent gets the CLI on its PATH and your credential in its
  environment," plus an auto-generated `.claude/skills/github/SKILL.md` that names the exact
  variables ([Capabilities](https://intentic.dev/docs/capabilities/)). Env vars are suffixed with
  the connection id so two GitHub accounts don't collide.
- Finished conversations are archived after three days by default, because "a finished card holds a
  full checkout of every repo: a lane that grew forever would be disk that grew forever"
  ([Troubleshooting](https://intentic.dev/docs/troubleshooting/)).

### 2.7 External harness surfaces

- A 310-route HTTP API generated from a shared typed contract, published as OpenAPI 3.1 at
  `openapi.json` ([Sandbox API](https://intentic.dev/api/)).
- MCP servers are a *capability kind* — the sandbox consumes external MCP servers; it does not
  primarily present itself as one ([Capabilities](https://intentic.dev/docs/capabilities/)).
- ACP editor bridge via `npx @intentic/acp-bridge` with a one-conversation-scoped token
  ([Your own machine](https://intentic.dev/docs/your-machine/)).
- CI integration: `intentic/gate-action` / `npx @intentic/gate run`, three calls (`POST /agent`,
  poll `GET /agents/{id}`, optional `POST /agents/{id}/land`), terminating `completed` / `parked` /
  `failed` / `timeout` ([Authorising a call](https://intentic.dev/api/auth/)).
- Skills are a first-class API: `GET /skills` (joined across 7 origins, with `origin`, `enabled`,
  `switchable`, `editable`, `removable`), `POST /skills` (create/rewrite by name),
  `GET /skills/read`, `POST /skills/switch`, `POST /skills/remove`
  ([Skills API](https://intentic.dev/api/skills/)).

### 2.8 Sandboxing posture: fat userland, thin capability grant

Intentic is explicit that the container *is* the boundary, not a per-command sandbox:

- Runs unprivileged with exactly two capabilities: `SYS_ADMIN` (per-turn mount namespaces so a
  worktree can stand in for `/work`) and `SYS_PTRACE` (diagnosing a stalled PID 1).
- "The host's Docker socket is never mounted. That single fact is what bounds everything an agent
  can do."
- A nested Docker Engine is baked in but dormant until the operator flips `privileged: true`
  themselves — and on a Compose-managed sandbox that edit deliberately stays the operator's.
- Toolchain changes are **environment overlays**: the agent *proposes* a Dockerfile layer
  (`RUN`/`ENV` only, pinned base), nothing changes until the owner approves, and the rebuild runs
  outside the container against the approved hash. "An agent can never rebuild its own environment
  without your sign-off." Non-Dockerfile needs (tun device, `--privileged`, `--gpus`) ride as
  allowlisted `# intentic:runtime` directives so an overlay cannot smuggle arbitrary docker flags.
  ([Docker setup](https://intentic.dev/docs/docker/))

### 2.9 Env var contract and 12-factor-ness

Partially 12-factor, with a twist worth stealing. The container's env is a **declared allowlist that
ships with the image**, and the image prints its own run command
([Docker setup](https://intentic.dev/docs/docker/)):

```
tr '\n' '\0' < sandbox.env | docker run -i --rm --entrypoint intentic \
    ghcr.io/intentic/sandbox:stable sandbox run-command \
    --slug '<SLUG>' --image ghcr.io/intentic/sandbox:stable \
    --base-image ghcr.io/intentic/sandbox:stable --format sh
```

> "The scripts don't hard-code it and neither should your tooling: ask the image, and a stale
> caller still starts a new image correctly."

NUL-framed stdin is used because a private key is multi-line — i.e. they hit the classic
env-var-can't-hold-a-PEM problem and solved it at the boundary. Boot-time env vars are few
(`CONNECT_TOKEN`, `SANDBOX_GRANT`, `SANDBOX_PUBLIC_URL`, `PLATFORM_URL`, `GOOGLE_CLIENT_ID`,
`INGRESS_URL`, `OWNER_EMAIL`, `LOCAL_PORT`); everything else is runtime state in volumes, and
per-capability secrets go into the daemon's store rather than the process env
([Quickstart](https://intentic.dev/docs/quickstart/)).

Configuration-as-code is a separate artifact: `sandbox.toml`, `schemaVersion = 1`, unknown keys are
errors, derived on demand (never stored, so it cannot drift), credential-free and safe to publish,
with repos/workspace/capabilities/secret-names/overlay/settings sections. Import is preview-first
and additive-only; overlays arrive as *proposals*, automations arrive *disabled*, extensions arrive
*off* ([Sandbox definitions](https://intentic.dev/docs/sandbox-definitions/)).

### 2.10 Update, rollback, lifecycle

`/update`, `/rebuild`, `/cleanup` vanity-host scripts with `.ps1` twins. Update pulls `:stable` and
recreates the container in place, preserving `/work` and `/history`. A failed update self-reverts;
one bad release is rolled back centrally. Promises: files never touched, updates offered not forced,
breaking changes flagged *before* you take them, "nothing we ship can take your data hostage"
([Docker setup](https://intentic.dev/docs/docker/), [Updates & rollback](https://intentic.dev/docs/updates/)).

Diagnostics are two commands: `docker ps -a --filter name=intentic-sandbox` and
`curl https://…/health` returning `{ "ok": true, "sandboxId", "boot", "announce" }`, with
`docker logs --tail 200` as the next step ([Troubleshooting](https://intentic.dev/docs/troubleshooting/)).

---

## 3. Stageflow as it exists (facts)

### 3.1 Product and execution model

Configurable multi-stage agent workflows. Pi is the agent backend as an in-process SDK. Stages get
`bash`/read/write/edit plus Stageflow tools. **Isolation is a fresh agent session, not an OS or
container sandbox.** Stages are domain-agnostic; Stageflow validates shape and wiring, not domain
semantics ([AGENTS.md](../../AGENTS.md)).

### 3.2 Host, ports, and the loopback gate — verified in this worktree

| Fact | Evidence |
|---|---|
| Long-lived Host is `sf ui` or `sf mcp`, default port 3847 | `DEFAULT_PORT = 3847`, `src/server/createHttpHost.ts`; [cli-reference.md](../cli-reference.md) |
| **[corrected]** Default bind `127.0.0.1`, hardcoded | Not `DEFAULT_LISTEN_HOST` in `listenHost.ts` (that file does not exist). It is the literal fallback in `options.host ?? "127.0.0.1"` — `src/server/http.ts:840`, `src/server/mcpHost.ts:35`. |
| **[corrected]** `--host` / `STAGEFLOW_BIND` / `--no-open` / `STAGEFLOW_NO_OPEN` **do not exist** | This row originally claimed they existed and were merely uncommitted. They do not exist in any form. `src/server/listenHost.ts` has never existed on any branch (`git log --all -- src/server/listenHost.ts` is empty); a repo-wide search for `listenHost`, `STAGEFLOW_BIND`, `STAGEFLOW_NO_OPEN`, and `resolveListenHost` outside planning docs returns nothing. `src/cli.ts:57-58` parses `--port` only, and `sf ui` unconditionally calls `openBrowser(url)` (`src/cli.ts:398-412`). The bind address is hardcoded `options.host ?? "127.0.0.1"` in `startUiServer` (`src/server/http.ts:840`) and `startMcpServer` (`src/server/mcpHost.ts:35`); `host` is a programmatic option with no CLI or env path to it. **This is the single hardest blocker and it is net-new work.** |
| **[corrected]** Advertised URL is **not** sanitised | `advertiseListenHost` does not exist. `createHttpHost` builds the printed URL directly from the bind host, so once a bind flag is added it must also map `0.0.0.0` / `*` / `::` back to `127.0.0.1` for display. |
| `/mcp` is **hard-gated to loopback** | `createHttpHost` applies `localhostHostValidation()` and `localhostOriginValidation()` from `@modelcontextprotocol/node` to `/mcp` unconditionally. No env override exists. |
| Mutating REST is loopback-gated; reads are not | `assertLoopbackHttpAccess` is called only under `isMutatingApi(method, pathname)` in `createOperatorRoutes` (`src/server/http.ts`). `GET /api/runs`, `GET /api/health`, artifact reads, etc. have **no** host/origin check. |
| Mutating REST + MCP are otherwise **unauthenticated** | No bearer/token check anywhere on those paths. |
| A2A **is** authenticated and **is not** loopback-gated | `boot.a2a?.handle(...)` runs in `createHttpHost` *before* the MCP gate and before the operator routes. A2A does its own per-caller bearer check (`callers[].token_env`, ≥32 chars, unique), per-caller rate limiting and admission caps, and validates `public_url` as an HTTPS origin (HTTP only on loopback) — `src/a2a/registry.ts`, [docs/a2a.md](../a2a.md). |
| `sf run` is a client that may auto-start `sf mcp` | `src/server/ensureGlobalService.ts` probes `http://127.0.0.1:<port>/api/health` |
| **[corrected]** Mutating `sf runs …` verbs **require** the Host and send over HTTP | The opposite of what this row said. `src/cli/runsCommand.ts:384-394` calls `ensureGlobalService` then issues HTTP; reads open the global store directly (`:374-380`). The old claim came from a stale passage in `docs/cli-reference.md`, since corrected. |

### 3.3 State, catalog, checkout

- Store backend is SQLite/WAL only (`SF_STORE=sqlite`; `disk` rejected).
- **[corrected] Store root is the global home, not the project.** This bullet originally said the
  store was project-local and the move to `~/.stageflow/` was unimplemented. `storeRootFor(rootDir)`
  does append `.stageflow` to whatever it is given (`src/runstore/paths.ts`), but
  `bootstrapStageflowHost` passes `ctx.globalHome`, not `ctx.projectRoot`
  (`src/server/bootstrap.ts:69`) — so the store is at `~/.stageflow/.stageflow/state.db`, and stage
  workers open the same one (`src/runtime/stageWorker.ts:33-37`). Project-local `.stageflow/` now
  holds only `settings.json`. The `global-stageflow-service` spec this bullet cited was deleted in
  `0bbf060` and is substantially implemented; what is *not* implemented from it is remote access.
  There is still no `STAGEFLOW_HOME`.
- Catalog YAML lives in the git project (`stageflow.yaml`, `*.pipeline.yaml`, `*.task.yaml`,
  `*.stages.yaml`).
- Checkout is an **existing local directory** requiring R/W/X (`resolveAndValidateCheckout`,
  `src/runtime/stageRoots.ts`), held under an exclusive lease (`busy_checkout`).
- **No clone, worktree, branch, or PR primitives exist.** PR in examples is a stage prompt using
  `gh` plus `GITHUB_TOKEN`.
- Stage workers are `fork()`ed CLI processes (`sf internal run-stage`); mode `process` by default,
  `STAGEFLOW_STAGE_EXECUTION=inprocess` mainly for tests. Default unlimited stages per run; run
  concurrency soft max 3 (`STAGEFLOW_MAX_CONCURRENT_RUNS`).

### 3.4 Harness surfaces, as they actually are

| Capability | MCP | HTTP REST | A2A |
|---|---|---|---|
| Start a run from a pipeline **path** | yes | yes | n/a (invokes a publication) |
| Start a run from an **inline pipeline object** | **yes** — `pipeline` may be a JSON object `{ id, stages }`; a string is always a path, never YAML ([mcp.md](../mcp.md)) | no — path only | no |
| Inline task | yes (`task` xor `task_path`) | yes | n/a (`{ capability, input }`) |
| `rerun` an inline-pipeline run | **no** — no `pipeline_path` to replay from | n/a | n/a |
| Write catalog YAML | **no catalog-write tools** | create requires a git project | no |
| Upload/pass skills | **no** | `skill` rejected on create-stage | **no** |
| Auth | none | none (mutating = loopback only) | per-caller bearer token |
| Config hot reload | n/a | n/a | **no** — `a2a.yaml` read once at startup; editing requires restart; publications are digest-pinned and drift-fail |

Skills today: stage YAML `skill: <name>`, resolved from disk at `<git-root>/.pi/skills/`, installed
by `sf skills install --from-path|--from-zip` ([cli-reference.md](../cli-reference.md)).

### 3.5 Runtime requirements and gaps for an image

| Item | State |
|---|---|
| Node | Pi engines require ≥ 22.19; `package.json` says `"node": ">=20"` — stale and would let a broken image build |
| Native deps | `better-sqlite3@^13` with `allowScripts` — needs prebuild or toolchain, and **multi-arch** (arm64 laptops + amd64 VPS) |
| OS deps | `git`, `bash`; examples also need `gh` |
| PID 1 | Not addressed. Stage workers are forked children; without an init/reaper they zombie |
| Signals | No documented SIGTERM drain for in-flight runs or forked stage workers |
| Health | `GET /api/health` returns `manager.getHealth()`; **no version/build field** (specified in [get-health-version-field.md](get-health-version-field.md), not shipped) |
| Provider auth | Files under `~/.stageflow/agent` or `~/.pi`; headless path is `sf providers login --api-key-env` ([providers.md](../providers.md)) |
| Dockerfile / compose | **None exist** |
| HITL in a container | A parked run waits forever unless something answers; `--skip-gates` fails the stage instead |

---

## 4. Locked Stageflow decisions

Reproduced as given. These are current intent, not proven-correct. §5 and §6 argue with several of
them.

| # | Decision |
|---|---|
| 1 | v1 is a **self-hosted Host** in Docker — same process as local `sf ui` / `sf mcp`. Headless Runs *and* published UI + MCP + A2A. |
| 2 | **No Stageflow operator auth.** If users want a gate they add it themselves. Local consume is `localhost:3847`. A server is "their networking." |
| 3 | Default listen stays `127.0.0.1`. `--host` / `STAGEFLOW_BIND` exists; the image uses `0.0.0.0`. Host/Origin stays localhost-oriented (SSH tunnel for a remote box). |
| 4 | The container **is** the Host. UI/MCP/A2A from the laptop via `-p 3847:3847`. CLI is `docker exec … sf …`. No host-installed `sf` talking into the container in v1 (path mapping). |
| 5 | Optional bind-mount `/workspace` = Catalog + path Checkout. No mount: MCP inline still works; A2A needs on-disk pipelines + `a2a.yaml`. |
| 6 | **Checkout** stays a local directory. **Repository** is GitHub-only `owner/repo` (or a github.com URL) + **required ref**. XOR: repository OR checkout path OR unbound. Both → error. |
| 7 | Host keeps a bare-clone cache + **worktree per RunId** under `~/.stageflow`. That worktree is the Checkout. Kept until run delete/gc. Not a shared dirty clone. |
| 8 | `GITHUB_TOKEN` / `GH_TOKEN` on the **container env only**. The harness does not send a token on `start_run`. **PR is a stage** (`gh`), not a Host API. No GitHub App in v1. |
| 9 | MCP is the external **harness**. `start_run` with an inline JSON pipeline object is create+run (not a YAML string; not durable; no `rerun`). A2A stays invoke-of-publications-already-on-disk. |
| 10 | `repository` + `ref` on the inline **task**. `skills` on `start_run` as name → files (at least `SKILL.md`). Stages still `skill: name`. Skills materialize for that Run only. |
| 11 | Eventual image is a **fat agent machine**: Node ≥ 22.19, git, bash, `gh`. Not a security sandbox. Derived `FROM` for extras. Dockerfile only after Host features exist. |
| 12 | Agreed order: bind + PID 1/no-browser + HOME contract + headless creds → repository+worktree → `start_run` skills → Dockerfile. |

---

## 5. Independent gap analysis (Intentic-informed)

Labels: **(a) decided** — restating a locked decision; **(b) agree** — my independent conclusion
matches it; **(c) disagree/extend** — my conclusion differs or goes further.

### 5.1 Auth on a published agent-control API — the biggest gap

**(c) disagree.** Locked decision 2 says no operator auth, "a server is their networking." The
problem is not philosophical, it is that the locked decision set *also* says the image binds
`0.0.0.0` (#3) and publishes UI + MCP + A2A (#1). An unauthenticated MCP endpoint that can
`start_run` an arbitrary inline pipeline whose stages have `bash` is remote code execution, with a
`GITHUB_TOKEN` (#8) sitting in the same process env. The blast radius is: run any command in the
container, read and exfiltrate `GITHUB_TOKEN` and provider keys, push to any repo that token
reaches. Today the loopback Host/Origin gate is the only thing preventing that — which means the
security model is an accident of a gate that decision 3 also wants to keep only "localhost-oriented."

Intentic's answer is not heavyweight. Strip the Google/identity/tier machinery and what remains is
one sentence from [api/auth](https://intentic.dev/api/auth/): a program presents a header-borne
token; the daemon stores only its hash; it carries a scope chosen at mint; it is revocable. Stageflow
already implements the 80% version for A2A. Concretely:

| Recommendation | Cost | Why |
|---|---|---|
| `STAGEFLOW_CONTROL_TOKEN` (or `_FILE`) checked on `/mcp` + mutating REST | small | one shared bearer; no identity model |
| **Refuse to start** when bind is non-loopback and no token is set | trivial | makes the unsafe config impossible rather than documented |
| Two scopes: `read` and `drive` | small | Intentic's `read` exists "for exactly that reason rather than as a politeness" |
| Keep `GET /api/health` open and contentless | trivial | Intentic: `/health` "deliberately checks nothing" |
| Reuse the `a2a.yaml` `callers[].token_env` pattern | none — exists | consistency, and secrets never land in YAML |

Note also the current asymmetry: **reads are not gated at all**. `GET /api/runs`, artifact reads,
and stage events have no host/origin check. Bound to `0.0.0.0` that is a transcript/artifact leak
even before anyone writes anything.

### 5.2 Loopback Host/Origin vs a published service

**(b) agree with the SSH-tunnel posture; (c) extend on mechanics.** Intentic's no-inbound-port
design is the strongest thing in their deployment story, and locked decision 4's
`-p 3847:3847` is precisely their loopback-shortcut port. Where Stageflow diverges is that Intentic
never relies on the published port for remote access, and Stageflow's SSH tunnel is the operator's
manual work.

Mechanical problems to resolve before a Dockerfile ships:

1. `/mcp` uses `localhostHostValidation()` with **no escape hatch**. An SSH tunnel to
   `localhost:3847` passes. nginx/Caddy/Traefik at `sf.example.com` does **not**. Neither does a
   Tailscale hostname. Either add `STAGEFLOW_ALLOWED_HOSTS` (comma list, applied to both the MCP
   validators and `assertLoopbackHttpAccess`) or state "reverse proxy unsupported; tunnel only" in
   the Docker doc. Silence here guarantees a 403 nobody can diagnose.
2. Apply whatever gate exists to **reads**, not just mutations.
3. A2A already bypasses both gates and validates `public_url` as HTTPS — so A2A is, today, the only
   surface designed for network exposure. That is worth saying out loud in the docs rather than
   discovering it.

### 5.3 The durable-state contract — `/history` is still the model **[corrected]**

This section originally argued the run store had to be moved out of the Checkout. It is already
out: `bootstrapStageflowHost` opens it at `ctx.globalHome` (`src/server/bootstrap.ts:69`). Reasons 1
and 3 below are therefore already satisfied; reason 2 stands and is joined by two the original
missed.

1. ~~**Self-destruction.**~~ **Already prevented.** The store is not under the Checkout, so a
   stage's `bash` cannot reach it. The principle still matches Intentic, which mounts `/history`
   outside `/work` explicitly to prevent this ([Docker setup](https://intentic.dev/docs/docker/)),
   and it is the reason worktrees must also live under Host home rather than in `/workspace`.
2. **Volume topology.** Stageflow wants `/workspace` as an *optional* bind mount (#5). Keeping the
   store out of it is what makes the "no mount" mode possible at all, and it avoids putting a
   SQLite WAL database on a bind mount across a macOS/Windows virtiofs boundary — a well-known
   corruption and performance hazard. This one is a live requirement for the image, not a fix.
3. ~~**Multi-project.**~~ **Already satisfied.** One global store serves every project; runs carry
   a `project_root` column and `listProjectRoots()` exists. (The `global-stageflow-service` spec
   cited here was deleted in `0bbf060` and is substantially implemented.) The residual multi-project
   problem is different: REST catalog browse is single-project while MCP is multi-project.
4. **No `STAGEFLOW_HOME` (new).** The durable root is hardcoded off `os.homedir()`. Under `--user`
   with no matching passwd entry this silently relocates every durable path. A container needs an
   explicit override.
5. **Credentials split across two homes (new).** `~/.stageflow/agent/auth.json` and
   `~/.pi/agent/auth.json` (`src/runtime/credentialBinding.ts:40-46`). One volume must cover both,
   or the container re-authenticates on every restart.

Recommended split, Intentic-shaped:

| Path | Kind | Contents | Agent-writable |
|---|---|---|---|
| `/workspace` | optional bind mount | Catalog YAML, `a2a.yaml`, path-Checkouts | yes |
| `/home/stageflow/.stageflow` | **named volume** | `state.db` (+WAL), run workspaces, bare-clone cache, per-Run worktrees, provider auth | worktrees yes; store **no** |

And: the store and provider credentials should be on a read-deny list for stage file tools, the way
Intentic's capability manifest is on the daemon's secret denylist
([Capabilities](https://intentic.dev/docs/capabilities/)). `sf artifact read` already denies
`.pi-agent` segments and `auth.json` — extend the same instinct to the store.

### 5.4 Repository → Worktree: agreed, under-specified on lifecycle and path stability

**(b) agree** with decisions 6 and 7 — bare-clone cache plus `git worktree` per RunId is exactly
what Intentic does and exactly why ([One worktree per agent](https://intentic.dev/blog/one-worktree-per-agent/),
[Architecture](https://intentic.dev/docs/architecture/)). Two things the locked decisions
under-specify:

1. **GC is not optional.** "Keep until run delete/gc" needs an actual default TTL and an `sf runs gc`
   verb. Intentic archives finished agents after **three days by default** — "on where almost
   everything else is off" — precisely because each holds a full checkout
   ([Troubleshooting](https://intentic.dev/docs/troubleshooting/)). A container whose data volume
   grows one full checkout per Run forever will fill a VPS disk in a week of nightly runs.
2. **Path stability.** Intentic mounts the worktree *at `/work`* so "parallel agents see the paths
   every project instruction already names." Stageflow's Checkout will be
   `~/.stageflow/worktrees/<runId>/` — a different absolute path every Run. Every stage prompt,
   skill, or verify command containing a path will break. Minimum fix: guarantee an env var
   (`STAGEFLOW_CHECKOUT`, alongside the existing `STAGEFLOW_RUN_WORKSPACE`) and document that stage
   prompts must use it and never a literal path. Better: a stable per-run symlink.
3. **Repository is GitHub-only (#6).** Fine for v1, but note that `ref` + bare-clone cache is
   host-agnostic; the GitHub restriction really only buys the `owner/repo` shorthand and the `gh`
   assumption. Don't bake "github.com" into the clone path resolution.

### 5.5 `GITHUB_TOKEN` on container env + "PR is a stage" is the weakest security decision

**(c) disagree, partially.** Decision 8 is operationally simple and I agree with "no GitHub App in
v1." But two consequences deserve to be stated rather than inherited:

1. **Every stage's `bash` gets the token.** Stage workers are `fork()`s of the CLI, so they inherit
   the Host's whole environment. A prompt-injected stage — from a fetched issue, a dependency
   README, an A2A caller's input — can read `GITHUB_TOKEN` and push anywhere it reaches.
   Intentic's counter-design is exactly this: secrets in a store the agent cannot read, substituted
   by reference at command time, with optional named-approver gates
   ([Secrets API](https://intentic.dev/api/secrets/)). Stageflow does not need that machinery, but
   it does need a **stage env allowlist** so provider keys and any control token are *not* in stage
   `bash`, and the `gh` token is present only for stages that declare they need it.
2. **`drive` and `land` collapse into one privilege.** Intentic separates them deliberately:
   "the usual arrangement is a program that works and a person who decides," and `land` is the one
   press a collaborator's grant turns into a request ([api/auth](https://intentic.dev/api/auth/),
   [Access](https://intentic.dev/docs/access/)). Making PR a stage means anything that can start a
   run can push. Cheap mitigations that don't require a Host-side PR API: use a fine-grained PAT
   scoped to the target repo, use a git credential helper / `GIT_ASKPASS` so the token isn't a plain
   env var, and record the push in the run record so it's auditable.

### 5.6 Harness completeness vs the user's own bar

The stated bar: "an external harness can use MCP/A2A to do what it can do now (create pipeline, run
pipeline, etc.), pass skills linked on a stage, and when a checkout is a GitHub repo the Host pulls
it, makes a worktree, stages work there and can raise a PR."

| Bar item | MCP | A2A | Gap |
|---|---|---|---|
| Create + run a pipeline | met (inline object) | **not met** | A2A invokes on-disk publications only; it cannot accept a pipeline |
| Rerun / durability | **not met** | met (publications are digest-pinned) | inline runs have no `pipeline_path` |
| Pass skills | **not met** | **not met** | not implemented on any surface |
| Repository → worktree → PR | **not met** | **not met** | no git primitives exist |
| Works with no `/workspace` mount | yes | **no** | A2A needs `a2a.yaml` + pipelines on disk, read **once at startup**, no hot reload |

Two specific observations:

- **A2A in a mountless container is effectively dead (decision 5).** No mount means no `a2a.yaml`
  and no publication pipelines, and A2A is `disabled`. Even with a mount, publications are read once
  at boot and are digest-pinned, so changing them means restarting the container. Either accept and
  document "A2A requires `/workspace` and a container restart to change publications," or add a
  config source that can come from env / a mounted file outside `/workspace`. Do **not** add hot
  reload — the no-hot-reload decision is correct and deliberate ([docs/a2a.md](../a2a.md)).
- **Inline-no-rerun (decision 9) is a real ergonomic cliff.** A harness that authored a pipeline
  inline and got a failure cannot retry the same pipeline. The minimal fix that keeps "inline is not
  durable" intact: an optional `save_as` on `start_run` that writes the pipeline into the Catalog
  (requires `/workspace`) and gives the run a `pipeline_path`. That is opt-in, explicit, and does not
  turn MCP into a catalog-write surface by default.
- **Skills (decision 10) needs more than materialization.** Intentic exposes list-with-origin,
  read, switch, remove, and joins seven origins into one answer
  ([Skills API](https://intentic.dev/api/skills/)). Stageflow's run-scoped materialization is the
  right *scope* choice, but a harness will immediately need: a `list_skills` that says where each
  skill came from (project `.pi/skills`, operator agent dir, or this Run), and a defined precedence
  when a run-scoped skill shadows a project one. Otherwise debugging "which SKILL.md did the stage
  actually load" is guesswork.

### 5.7 Operational layers Intentic has that the locked plan omits entirely

| Layer | Intentic | Stageflow locked plan | Recommendation |
|---|---|---|---|
| PID 1 / reaping | `init: true` | in #12 as "PID 1" | `--init` or tini; verify forked stage workers are reaped |
| Signals | journal records in-flight work across daemon restarts ([Architecture](https://intentic.dev/docs/architecture/)) | absent | SIGTERM → stop accepting starts, signal stage workers, mark runs recoverable, flush WAL; document `stop_grace_period` |
| Restart policy | `restart: unless-stopped` | absent | ship in compose |
| Log rotation | `json-file`, 10m × 3 | absent | ship in compose; keep logs on stdout |
| DNS pinning / `host.docker.internal` | both set | absent | `extra_hosts: host.docker.internal:host-gateway` is genuinely useful for stages hitting a laptop service |
| Non-root user | "runs unprivileged" | absent | non-root `stageflow` uid; note bind-mount uid/gid friction on Linux and document `--user` |
| Capability posture | exactly `SYS_ADMIN` + `SYS_PTRACE`, host docker socket never mounted | #11 "not a security sandbox" | state explicitly: **no** added caps, **no** `--privileged`, **never** mount the host docker socket. This is Stageflow's whole isolation story once it ships an image |
| Healthcheck | `/health` with boot info | `/api/health` without version | land [get-health-version-field](get-health-version-field.md); use it as the Docker `HEALTHCHECK` |
| Multi-arch image | GHCR `:stable` | absent | buildx amd64 + arm64 — mandatory for `better-sqlite3` on both an M-series laptop and a VPS |
| Secret files | secrets store + NUL-framed stdin for multi-line values | `GITHUB_TOKEN` env only | support `*_FILE` for every secret env var; compose/swarm/k8s secrets are files, and an env var cannot hold a PEM |
| Printed run contract | image prints its own `docker run` | absent | at minimum version a compose file *in the repo* alongside the image; a `sf docker run-command` is the Intentic-grade version |
| Update/rollback | self-reverting update, volume-preserving, documented promises | absent | document: image update never touches the data volume; SQLite migrations forward-only; state the rollback caveat if a newer schema was written |
| Backup | "ordinary named Docker volumes" | absent | one paragraph naming the volume and what's in it |
| Config-as-code | `sandbox.toml`, derived, credential-free, `schemaVersion` exact, unknown keys error | `stageflow.yaml` + `a2a.yaml` | not needed for v1, but adopt the *rule*: unknown keys are errors, not discarded |

### 5.8 Sandboxing: agree with the fat-userland call, with one correction

**(b) agree** with decision 11. Intentic reaches the same conclusion — the container is the
boundary, the image is a full dev userland, and the safety comes from *not* mounting the host docker
socket rather than from restricting the agent. Stageflow doesn't even need their `SYS_ADMIN`
(they use it for per-turn mount namespaces; Stageflow's separate worktree directories achieve
the same isolation without mount tricks).

One correction worth borrowing: Intentic's **environment overlay** flow means the agent can propose
toolchain additions but "can never rebuild its own environment without your sign-off," with
`RUN`/`ENV`-only layers on a pinned base and runtime flags restricted to an allowlist
([Docker setup](https://intentic.dev/docs/docker/)). Stageflow's "derived `FROM` for extras" (#11)
is the manual equivalent and is fine — but the docs should say plainly that a stage installing
packages at runtime (`apt-get`, `npm i -g`) produces an unreproducible container that vanishes on
update, and that the supported path is a derived image.

### 5.9 Risks of publishing an unauthenticated agent-control API

Stated bluntly, because this is the decision most likely to be regretted:

| Risk | Mechanism | Severity |
|---|---|---|
| Remote code execution | unauthenticated `start_run` + inline pipeline + stage `bash` | critical |
| Credential exfiltration | `GITHUB_TOKEN` and provider keys in the stage process env | critical |
| Supply-chain push | that token can push/PR to any repo it reaches | high |
| Provider-spend abuse | unauthenticated runs burn the operator's model budget | high |
| Data disclosure | **reads are not gated at all** — transcripts, artifacts, envelopes | high |
| Store destruction | store inside the Checkout; a stage can `rm -rf .stageflow` | high |
| DNS-rebinding | the loopback Host check is the only defence; an allowed-hosts escape hatch must keep checking `Host`, not drop the check | medium |
| Silent 403 behind a proxy | `localhostHostValidation` with no override | medium (availability) |
| Disk exhaustion | one full worktree per Run, no GC | medium |
| Zombie processes | forked stage workers with no PID 1 reaper | medium |

The cheapest complete mitigation is §5.1's refuse-to-start rule: *binding off-loopback without a
control token is a startup error.* It preserves decision 2's spirit (Stageflow is not building an
identity system) while making the dangerous configuration unreachable by accident.

---

## 6. Recommended container-ready bar (my version)

Differences from the locked decisions are labelled.

**Definition.** Stageflow is container-ready when: (1) a single published image runs the Host
headless with no browser and no interactive prompts; (2) a harness can create-and-run, observe,
answer gates, and rerun over MCP, and invoke publications over A2A; (3) a Run can be bound to a
GitHub Repository + ref and get its own worktree, and a stage can raise a PR; (4) all durable state
is in one named volume that no stage can destroy; (5) the image is multi-arch, non-root,
signal-correct, health-checked, and version-stamped; (6) there is one compose file and one docs page
that a stranger can follow on Docker Desktop and on a VPS; and (7) the unsafe network configuration
cannot be reached without an explicit opt-in.

| Requirement | vs locked |
|---|---|
| Default bind `127.0.0.1`; `--host` / `STAGEFLOW_BIND`; image `0.0.0.0` | agree (#3) — **[corrected]** not implemented; does not exist in any form. Net-new, and the first thing to build |
| `--no-open` / `STAGEFLOW_NO_OPEN`; no browser in the image | agree (#12) — **[corrected]** not implemented; `sf ui` unconditionally spawns a browser. (`sf mcp` is already browser-free, which is one reason it is the better default entrypoint) |
| `STAGEFLOW_ALLOWED_HOSTS` applied to `/mcp` *and* REST; still validates `Host` | **extends #3** — otherwise reverse proxy is a silent 403 |
| Host/Origin gate applied to reads too | **extends #2** |
| Optional `STAGEFLOW_CONTROL_TOKEN` / `_FILE`; **required** when bind is non-loopback | **disagrees with #2** |
| Two scopes (`read`, `drive`); `GET /api/health` always open | **disagrees with #2** |
| The container is the Host; CLI is `docker exec … sf …`; `-p 3847:3847` | agree (#4) |
| Optional `/workspace` bind mount for Catalog + path Checkout | agree (#5) |
| Store, cache, worktrees, provider auth in a **named volume**, never in `/workspace` | **extends #7** (store relocation isn't in the locked set) |
| Store + provider auth on the stage read-deny list | **extends #11** |
| Repository = `owner/repo` + required `ref`; XOR with checkout | agree (#6) |
| Bare-clone cache + worktree per RunId | agree (#7) |
| **Default worktree TTL + `sf runs gc`** | **extends #7** |
| **`STAGEFLOW_CHECKOUT` env var; prompts must not hardcode paths** | **extends #7** |
| `GITHUB_TOKEN` from container env or `GITHUB_TOKEN_FILE`; PR is a stage | agree (#8), plus file variant |
| **Stage env allowlist; token/keys not blanket-inherited by stage `bash`** | **extends #8** |
| MCP is the harness; inline pipeline object = create+run | agree (#9) |
| **Optional `save_as` on `start_run` so an inline run is rerunnable** | **extends #9** |
| `skills` on `start_run`, run-scoped | agree (#10) |
| **`list_skills` with origin + documented precedence** | **extends #10** |
| A2A stays invoke-only, no hot reload | agree (#9) |
| **Document A2A as `/workspace`-required, or add a non-`/workspace` config source** | **extends #5** |
| Fat agent machine; derived `FROM` for extras; not a security sandbox | agree (#11) |
| **No added caps, no `--privileged`, never mount the host docker socket — stated as the isolation contract** | **extends #11** |
| Node ≥ 22.19 in `engines` and in the image; multi-arch amd64+arm64 | **extends #11** |
| `--init` / tini; SIGTERM drain; documented exit codes | agree (#12), specified |
| `HEALTHCHECK` on `/api/health` carrying version | **extends #12** |
| Versioned compose file + one Docker docs page | **extends #12** |

---

## 7. Suggested implementation phases

Ordered so that each phase is independently shippable and nothing later invalidates something
earlier. Phases 0–1 are new relative to the locked order; 2–4 refine it.

### Phase 0 — Make the process containerizable (no product features)

1. **[corrected] Implement bind resolution from scratch.** This item originally read "land the
   in-flight bind work" on the false premise that it was written but uncommitted. Nothing exists.
   Build `--host` + `STAGEFLOW_BIND` with flag > env > `127.0.0.1` precedence, wire it into both
   `sf ui` and `sf mcp`, reject malformed values, and sanitise the *advertised* URL so `0.0.0.0`
   prints as `127.0.0.1`. Add `--no-open` / `STAGEFLOW_NO_OPEN` in the same pass. Nothing else in
   this plan is testable in a container until this lands, so it goes first.
2. **[corrected] `STAGEFLOW_ALLOWED_HOSTS` — do not ship this alone.** Replace the unconditional
   `localhostHostValidation()` / `localhostOriginValidation()` on `/mcp` with a resolver that
   defaults to loopback and accepts an explicit list (still validating `Host`, never skipping the
   check); apply the same resolver in `assertLoopbackHttpAccess`. Extend the gate to non-mutating
   API reads. **Merge this with Phase 1 items 9 and 10 into one change set** — the loopback gate is
   currently the only authentication `/mcp` has, so relaxing it without a control token ships an
   unauthenticated remote-code-execution endpoint.
3. **[corrected] HOME contract.** The store relocation this item asked for is already done (see
   §3.3). What remains: introduce `STAGEFLOW_HOME` so the durable root is explicit rather than
   `os.homedir()`-derived, flatten the `~/.stageflow/.stageflow/` nesting, bring
   `~/.pi/agent/auth.json` under the same volume contract, confirm nothing durable is written under
   the Checkout, and add the store and provider-auth paths to the stage read-deny list.
4. **PID 1 and signals.** `--init`/tini in the image; a SIGTERM/SIGINT handler that stops accepting
   new starts, propagates to forked stage workers, marks in-flight runs recoverable, and closes
   SQLite cleanly. Document the resulting exit code and a compose `stop_grace_period`.
5. **Headless credentials.** Boot-time provider auth from env or file:
   `sf providers login --api-key-env` semantics applied automatically, plus `*_FILE` support for
   every secret-bearing env var (`GITHUB_TOKEN_FILE`, provider key files, `STAGEFLOW_CONTROL_TOKEN_FILE`).
6. **`engines.node` → `>=22.19`.**
7. **Health/version.** Land [get-health-version-field](get-health-version-field.md); `/api/health`
   returns package version + git sha + whether A2A is enabled.
8. **Env contract doc.** One table: every `STAGEFLOW_*` / `SF_*` / provider / git var, whether it is
   read at boot or per-run, whether a `_FILE` variant exists, and — explicitly — whether stage
   `bash` inherits it.

### Phase 1 — Control-plane safety (my addition; conflicts with locked #2)

9. **`STAGEFLOW_CONTROL_TOKEN`** checked as a bearer / `x-stageflow-control` header on `/mcp` and
   the REST API. Hash at rest if it is ever stored; prefer env/file only. Reuse the A2A ≥32-char
   validation.
10. **Refuse to start** when the resolved bind is non-loopback and no control token is configured.
    One clear error naming both env vars.
11. **Scopes `read` / `drive`.** Minimum viable split so a dashboard token cannot start runs.
12. **Stage env allowlist.** Stage workers receive a curated env, not `process.env`. Provider keys go
    through the existing `authPath` mechanism; `GITHUB_TOKEN` is passed only to stages that opt in.

### Phase 2 — Repository and Worktree

13. **Task schema**: `repository` (`owner/repo` or github.com URL) + required `ref`, XOR with
    `checkout`, unbound still allowed; both → validation error with a named code.
14. **Bare-clone cache** under `$STAGEFLOW_HOME/repos/<host>/<owner>/<repo>.git`, fetch-on-demand,
    concurrent-fetch-safe.
15. **Worktree per RunId** under `$STAGEFLOW_HOME/worktrees/<runId>`, becomes the Checkout, recorded
    on the run, removed on run delete.
16. **`STAGEFLOW_CHECKOUT`** exported to every stage; docs rule that prompts and verify commands must
    use it.
17. **GC**: default TTL for finished-run worktrees, `sf runs gc`, and a disk-usage line in
    `sf runs list`/health.
18. **Git credentials**: a credential helper or `GIT_ASKPASS` so pushes work without the raw token in
    stage env. Record push/PR results on the run.

### Phase 3 — Harness completeness

19. **`skills` on `start_run`**: name → files (`SKILL.md` required), materialized into a run-scoped
    skills dir, resolvable by stage `skill: name` with documented precedence over project
    `.pi/skills`.
20. **`list_skills`** with `origin` (`project` | `operator` | `run`) and `enabled`.
21. **Optional `save_as`** on `start_run` so an inline pipeline can be persisted and later `rerun`
    (requires `/workspace`). Inline-without-`save_as` keeps today's non-durable behaviour.
22. **A2A container story**: either an `a2a.yaml` source that is not inside `/workspace`, or an
    explicit doc statement that A2A requires the mount and a restart to change publications.

### Phase 4 — Image and delivery

23. **Dockerfile**: multi-stage; Node 22/24 slim base; `git`, `bash`, `gh`, `ca-certificates`,
    `tini`; `npm ci --omit=dev` with `better-sqlite3` prebuilt; non-root `stageflow` user;
    `ENV STAGEFLOW_BIND=0.0.0.0 STAGEFLOW_NO_OPEN=1`; `EXPOSE 3847`;
    `VOLUME /home/stageflow/.stageflow`; `HEALTHCHECK` on `/api/health`;
    `ENTRYPOINT ["tini","--","sf"] CMD ["ui"]`.
24. **Multi-arch buildx** (`linux/amd64`, `linux/arm64`) — non-negotiable given `better-sqlite3`.
25. **GHCR publish** on tag: `:<x.y.z>`, `:<x.y>`, `:stable`; SBOM + provenance attestation; pin the
    base by digest.
26. **`docker-compose.yml` in the repo**, versioned with the image: `init: true`,
    `restart: unless-stopped`, `logging` rotation, `extra_hosts`, `ports: "127.0.0.1:3847:3847"`,
    named data volume, optional `/workspace` bind mount, `env_file`.
27. **`docs/docker.md`**: what the image contains; what gets created; the two happy paths (Docker
    Desktop with `-p`, and a VPS reached over an SSH tunnel); reverse-proxy/TLS status stated
    plainly; `docker exec … sf …` for CLI; update and rollback; backup; how to build a derived image
    for extra tooling; the isolation contract ("no added caps, no `--privileged`, never mount the
    host docker socket").

### Phase 5 — Operational maturity (Intentic-grade polish)

28. **Update/rollback doc**: image update never touches the data volume; SQLite migrations are
    forward-only; state what happens if a newer schema is rolled back.
29. **Resource guidance**: each stage is a separate Node process running an agent; publish
    recommended `STAGEFLOW_MAX_CONCURRENT_RUNS` / `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` per
    container size, and document that Stageflow imposes no cgroup caps of its own.
30. **HITL in a container**: document the unattended default (park, don't `--skip-gates`), and give
    a harness-side pattern for noticing parks — the existing `list_waiting` /
    [get-waiting-summary](get-waiting-summary.md) spec is the right hook.
31. **Printed run contract** (optional): `sf docker run-command` that emits the supported
    `docker run` line for the current image, so operator tooling doesn't hard-code flags.
32. **Derived host definition** (optional): a credential-free, derived-on-demand description of a
    Host's Catalog roots, publications, and settings — Stageflow's narrow `sandbox.toml` analogue,
    with the "unknown keys are errors" rule.

---

## 8. Explicit non-goals / things not to copy

| Intentic feature | Why Stageflow should not copy it |
|---|---|
| Platform / discovery plane, vanity hostnames, reachability hub | Requires hosted infrastructure and an account system. Stageflow's value is a self-hosted runtime; an SSH tunnel or the operator's own proxy is the right v1. |
| Trust-on-first-use Google owner binding, member tiers, presence roster | A full identity and collaboration model. Take the *control token* idea only. |
| Outbound tunnel container | Genuinely better than published ports, but it needs a rendezvous service. Note it as a future option, don't build it. |
| Desktop app, installer, `curl \| sh` vanity endpoints | Distribution surface for a consumer product. Stageflow ships an npm package and an image. |
| Nested Docker Engine, `SYS_ADMIN` mount namespaces, GPU/VPN/tun runtime directives | Stageflow's separate worktree directories give the same isolation without capabilities. Adding `SYS_ADMIN` or `--privileged` would trade real safety for nothing. |
| Capability catalog / extension marketplace / manifest trust model | Huge surface area. Stageflow already has `mcp:` allowlists per stage and `.mcp.json` — that's the right scope. |
| Conversation / chat / persona model, "front desk", fleet board | Stageflow's unit is a Run over a declared DAG, not a conversation. Don't import the mental model. |
| Hosted tier and remote runners | Distributed execution before single-container execution works is premature. |
| Agent-proposed environment overlays with an approval gate | Elegant, but it presumes a long-lived mutable box and an interactive owner. Derived `FROM` images are the correct answer for a pipeline runtime. |
| Full `sandbox.toml` fidelity and bundles | Borrow the *rules* (derived not stored, credential-free, unknown keys are errors); skip the artifact. |
| SDLC framing — "land", "prepush", "chores", "issues", "CI" as product primitives | Stageflow is domain-agnostic stages. Releases, research, ops runbooks, and content review are equally valid. Do not let a Docker docs page turn Stageflow into a coding-agent product; the container docs should use Host / Run / Catalog / Checkout / Repository / Worktree / Harness / Operator, and PR-raising should read as *one example stage*. |

---

## 9. Sources

Intentic:

- https://intentic.dev/docs/
- https://intentic.dev/docs/quickstart/
- https://intentic.dev/docs/docker/
- https://intentic.dev/docs/architecture/
- https://intentic.dev/docs/access/
- https://intentic.dev/docs/capabilities/
- https://intentic.dev/docs/sandbox-definitions/
- https://intentic.dev/docs/remote-runners/
- https://intentic.dev/docs/your-machine/
- https://intentic.dev/docs/updates/
- https://intentic.dev/docs/troubleshooting/
- https://intentic.dev/api/
- https://intentic.dev/api/auth/
- https://intentic.dev/api/git/
- https://intentic.dev/api/skills/
- https://intentic.dev/api/secrets/
- https://intentic.dev/blog/one-worktree-per-agent/
- https://intentic.dev/sitemap-0.xml (used to enumerate the docs tree)

Other:

- https://a2a-protocol.org/v1.0.0/specification/ (referenced by `docs/a2a.md`)

Stageflow repository (read for §3, at commit `3a25568` plus uncommitted worktree changes):
`AGENTS.md`, `package.json`, `docs/cli-reference.md`, `docs/mcp.md`, `docs/a2a.md`,
`docs/providers.md`, `docs/specs/global-stageflow-service.md` (deleted in `0bbf060`; read from its
parent commit),
`docs/specs/get-health-version-field.md`, `docs/specs/get-waiting-summary.md`,
`src/cli.ts`, `src/server/listenHost.ts`, `src/server/createHttpHost.ts`, `src/server/http.ts`,
`src/server/mcpHost.ts`, `src/server/ensureGlobalService.ts`, `src/runstore/paths.ts`,
`src/runtime/stageRoots.ts`, `src/a2a/registry.ts`.
