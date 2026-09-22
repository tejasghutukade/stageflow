---
status: implementation-brief
slot: 6
---

# Slot 6 — A stage sees only what it declares, and what it needs

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage AI agent workflows. Users
author pipelines and tasks in YAML (`*.pipeline.yaml`, `*.task.yaml`, an optional `stageflow.yaml`
manifest); each stage runs in a fresh agent session, and stages hand off to each other through typed
envelopes and artifacts. The CLI is `sf`. `sf ui` and `sf mcp` both start one HTTP Host on port
`3847` serving the operator REST API (`/api/*`), an MCP endpoint (`/mcp`), and optionally A2A. Run
state lives in SQLite under `~/.stageflow/`, outside any checkout.

Four facts about the architecture matter for this slot:

1. **A stage is a forked Node child process.** `StageProcessLauncher.spawnAndWait` forks the CLI
   back into itself as `sf internal run-stage`
   (`src/runtime/stageProcessLauncher.ts:208-212`, worker entry `src/cli.ts:276`, `:434-441`).
2. **That child hosts a coding agent with a shell.** The backend is "Pi"
   (`@earendil-works/pi-coding-agent`); the stage tool allowlist is `read`, **`bash`**, `write`,
   `edit`, the emit tool, and optionally `ask_operator` / artifact write
   (`src/agent/piAdapter.ts:102-122`, `bash` at `:110`). There is a second shell path that does not
   need the agent to cooperate at all: `verify` / completion `command` checks run through
   `spawn(input.command, { shell: true })` (`src/runtime/completionCheckRunner.ts:195-199`).
3. **The child inherits the Host's entire environment.** One expression:
   `env: { ...process.env, ...this.env, [SF_STAGE_WORKER]: "1" }`
   (`src/runtime/stageProcessLauncher.ts:210`). Every stage's `bash` can read every secret the Host
   process holds.
4. **Provider credentials are the one thing that is already done right.** Model auth reaches the
   agent as a *file path*, not an env var — `resolveCredentialBinding` returns an `authPath` and
   that is handed to `ModelRuntime.create({ authPath })`
   (`src/runtime/credentialBinding.ts:22-26`, `:73-110`; `src/agent/providerAuth.ts:120-121`,
   `:133`). Keep that shape; this slot generalises it.

Stageflow is being containerized. The work is split into nine shipping slots; see
[`../pre-container-work.md`](../pre-container-work.md) for the full plan and build order. **This is
slot 6.** You do not need to read the plan doc. Everything you need is below, and every claim about
current behaviour has been re-verified in this worktree with a `file:line` citation. Where the plan
doc is wrong, this brief says so.

---

## Mission

Replace the inherited stage environment with a **constructed** one: a small base allowlist, the
`STAGEFLOW_*` run variables, the dependency-cache variables, and — only when a stage declares
them — that stage's secrets. Then make the constructed environment actually work in a Linux
container: a proxy dispatcher that Node's `fetch` honours, CA-bundle variables that reach the child,
`verify` running under `bash` instead of `/bin/sh`, shared package caches so worktree-per-run is not
a full `npm install` every time, file-backed credentials materialised per stage, MCP servers that
get more than five seconds to start, and a finite stage-process cap with an explicit heap ceiling so
the OOM killer stops being the scheduler.

---

## Why one slot covers seven fixes

Every item below is a change to **one expression**: the object passed as `env` to `fork()` at
`src/runtime/stageProcessLauncher.ts:210`, and the function that builds it.

- Removing ambient inheritance (6.1) is that expression.
- Declared secrets (6.2) and file-backed credentials (10.6) are what gets *added back* to it.
- The CA-cert variables (10.2) and the proxy variables (10.1) are entries in the same allowlist —
  and 10.1 additionally needs code, because passing `HTTPS_PROXY` to a process that ignores it
  changes nothing.
- The dependency-cache variables (10.5) are more entries, computed rather than passed through.
- `.mcp.json` interpolation (10.10) reads that same environment
  (`src/config/resolveStageMcpServers.ts:318-338`, via `src/runtime/stageAttemptBootstrap.ts:119-126`),
  so narrowing it converts working catalogs into `unresolved_var` load failures.
- The heap ceiling and process cap (11.1) are the sibling arguments to the same `fork()` call:
  `execArgv` next to `env`, and `readMaxActiveStageProcesses` in the same class constructor
  (`src/runtime/stageProcessLauncher.ts:91-95`).
- `verify` under `bash` (10.3) is the *other* place a stage's shell is constructed, and it needs the
  same curated environment or the two shells disagree about what a stage can see.

Doing these in separate slots means opening `stageProcessLauncher.ts` seven times and re-deciding
the allowlist each time. Redaction (6.3) is here for the same reason: the values this slot starts
injecting deliberately are the values that must never reach a log.

---

## Why this matters

- **Today a stage that writes a README can read your model keys and your GitHub token.** Not through
  a bug — through the documented `bash` tool, or through a one-line `verify` command. The current
  security boundary is an accident of the Host being loopback-only.
- **Slot 5 makes that worse before this slot makes it better.** Slot 5 introduces
  `STAGEFLOW_CONTROL_TOKEN`, the bearer that authorises `start_run`. With today's `fork`, that token
  would land in the environment of a process whose job is running arbitrary shell — so a stage could
  mint new runs, cancel runs, and read every other run's transcripts. The control token must never
  be in a stage environment, and this slot is what guarantees it.
- **A container is where all the ambient conveniences vanish at once.** On a laptop a stage inherits
  a working proxy config, a system CA bundle, an authenticated `gh`, a warm `~/.npm`, a `bash` at
  `/bin/sh`, and a passwd entry. In a Debian-slim image it inherits none of them, and each absence
  produces a different unhelpful error: a hung model call, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `gh:
  not authenticated`, a five-minute `npm install` per run, `[[: not found` with exit 2, and exit 137
  with no log line.
- **Exit 137 is the one that wastes a whole afternoon.** `DEFAULT_MAX_ACTIVE_STAGE_PROCESSES` is
  `Number.POSITIVE_INFINITY` (`src/runtime/stageConcurrency.ts:9`), and Node sizes its heap from the
  *cgroup* limit per process. Four forked workers in a 2 GB container each believe they may grow to
  about 1 GB. The kernel kills one, the run sits in `running`, and nothing recovers it.

---

## Dependencies

**Assumes shipped:**

- **Slot 1 — `$STAGEFLOW_HOME`.** The durable root is currently hardcoded as
  `path.join(os.homedir(), ".stageflow")` (`src/project/globalHome.ts:5`). Slot 1 makes it an
  env-configurable, boot-validated value. This slot needs it twice: the dependency caches live at
  `$STAGEFLOW_HOME/cache` (10.5), and `STAGEFLOW_HOME` itself must be in the child's environment
  because the worker calls `globalStageflowHome()` to open the store
  (`src/runtime/stageWorker.ts:33`). If slot 1 has not landed, use `globalStageflowHome()` and leave
  a single TODO — do not re-derive the root.
- **Slot 2 — the `STAGEFLOW_CHECKOUT` contract and the `GIT_ASKPASS` design.** Slot 2 introduces
  worktree-per-run and the stable-path variables (`STAGEFLOW_CHECKOUT`, `STAGEFLOW_REPOSITORY`,
  `STAGEFLOW_REF`, `STAGEFLOW_BASE_SHA`, `STAGEFLOW_RUN_BRANCH`), the git identity variables
  (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`), and a `GIT_ASKPASS` helper so the Host can fetch without
  interpolating a token into a remote URL. **Slot 6 owns the mechanism that writes those into the
  child; slot 2 owns their values.** Agree the exact variable names with slot 2 before writing the
  allowlist, and build **one** credential-materialisation path used by both (10.6), not two.

**Coordinates with:**

- **Slot 5 — the control token.** `STAGEFLOW_CONTROL_TOKEN` (and any `_FILE` variant) must be on the
  permanent denylist: never in the base allowlist, never grantable through `secrets:`, and excluded
  even under the `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` escape hatch. That last exclusion is the
  point — an escape hatch that re-exposes the control token is not an escape hatch, it is the RCE
  chain with extra steps.
- **Slot 3 — GC.** The shared cache directory must survive slim GC and be excluded from per-run disk
  accounting and quotas. Tell slot 3 the path.
- **Slot 4 — the JSON-lines logger.** Redaction (6.3) belongs at the log *sink*, so a new log call
  site cannot leak by omission. If slot 4's logger exists, hook there; if not, hook the existing
  sinks listed in 6.3 and leave the sink-level hook as the follow-up.
- **Slot 7 — `sf doctor` and one config surface.** `sf doctor` **does not exist today** (no `doctor`
  subcommand in `src/cli.ts`). This slot defines four checks that belong in it — `bash` present,
  outbound TLS, every catalog `command` resolvable on `PATH`, and euid ≠ 0 for the Claude backend.
  Implement them as exported, independently callable functions in `src/preflight/` so slot 7 wires
  them up; expose them through `sf validate` where they are catalog-scoped.

---

## The environment contract

This table is the deliverable. Write it into `docs/yaml-catalog.md` and `docs/providers.md` as part
of the change, because it is a promise to users about what their stages can see.

| Blocked by default | Always included | Declared per stage |
|---|---|---|
| Provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) | `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL` | `secrets:` env entries, by exact name |
| `GITHUB_TOKEN` / `GH_TOKEN` and `_FILE` variants | `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `TMPDIR` | `secrets:` file entries, materialised read-only into a per-attempt credential dir |
| `STAGEFLOW_CONTROL_TOKEN` — **denylisted, never grantable** | `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` (10.2) | `GIT_ASKPASS` + helper, when a git-write secret is declared (6.2) |
| `AWS_*`, `GOOGLE_*`, `AZURE_*`, `NPM_TOKEN`, `SSH_AUTH_SOCK` | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` + lowercase forms (10.1) | `GH_CONFIG_DIR`, `AWS_CONFIG_FILE`, … pointing at materialised files (10.6) |
| Everything else in the Host's environment, including anything an operator exported by hand | `SF_STAGE_WORKER=1`, `STAGEFLOW_HOME`, `STAGEFLOW_*` run vars (slot 2's 2.6 table) | |
| | `STAGEFLOW_CACHE` + `npm_config_cache`, `PNPM_STORE_DIR`, `YARN_CACHE_FOLDER`, `UV_CACHE_DIR`, `GOMODCACHE`, `CARGO_HOME` (10.5) | |
| | `STAGEFLOW_STAGE_ARTIFACTS_DIR` (already injected for MCP interpolation, `src/runtime/stageAttemptBootstrap.ts:119-126`) | |
| | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (slot 2's 10.4) | |

Three rules that make the table unambiguous:

1. **The allowlist is a list of names, not a prefix rule.** No `STAGEFLOW_*` wildcard passthrough
   from the Host: the `STAGEFLOW_*` entries the child sees are *computed* by the Host, not copied.
   Otherwise `STAGEFLOW_CONTROL_TOKEN` matches the wildcard.
2. **The denylist wins over everything**, including the passthrough escape hatch and an explicit
   `secrets:` declaration.
3. **The same environment is used for both shells.** The `fork()` at
   `stageProcessLauncher.ts:208-212` and the `verify` spawn at `completionCheckRunner.ts:195-199`
   must be built by the same function. Two constructions will drift, and the drift is a hole.

---

## Verified current state

### The central line

```208:212:src/runtime/stageProcessLauncher.ts
    const child = fork(this.cliEntry, args, {
      cwd: input.rootDir,
      env: { ...process.env, ...this.env, [SF_STAGE_WORKER]: "1" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
```

`this.env` defaults to `process.env` as well (`:91`), so the spread is doubly ambient. There is no
`execArgv`, no `detached`, and no per-stage env input on `StageLaunchInput` (`:13-23`) — you are
adding one. The launcher is constructed with no options in both production paths
(`src/runtime/pipelineRunner.ts:79`, `src/runtime/runManager.ts:264`), so an `env` option exists on
`StageProcessLauncherOptions` (`:40-44`) but nothing ever passes it.

### Concurrency caps (11.1)

Both defaults are unlimited, as the plan says:

```1:11:src/runtime/stageConcurrency.ts
export const UNLIMITED_CONCURRENCY = Number.POSITIVE_INFINITY;

export const DEFAULT_MAX_ACTIVE_STAGES_PER_RUN = UNLIMITED_CONCURRENCY;

export const MAX_ACTIVE_STAGES_PER_RUN_ENV =
  "STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN";

export const DEFAULT_MAX_ACTIVE_STAGE_PROCESSES = UNLIMITED_CONCURRENCY;
```

The two caps are enforced in different places, and that difference matters:

- **Per-run fan-out** is a plain comparison in the scheduler — `if (activeCount >=
  maxActiveStagesPerRun) break;` (`src/runtime/pipelineScheduler.ts:1385`). It behaves correctly
  with `Infinity` and behaves correctly with a finite number. Low risk.
- **Global stage processes** go through `waitForCapacity`, which **returns immediately without
  taking a slot** when the cap is not finite (`src/runtime/stageProcessLauncher.ts:151-163`), and
  `releaseCapacity` symmetrically no-ops (`:165-174`). So `slotsHeld` and `waitQueue` are dead code
  in every default configuration today. Making the default finite switches on a queueing path that
  has never run outside tests. Treat it as new code: it recurses through `waitForCapacity` after
  being woken, and the wake-up in `releaseCapacity` pops exactly one waiter per release.

Exit classification currently discards the signal: `child.on("exit", (code) => …)`
(`:261-264`) feeds `resultFromExitCode` (`:56-70`), which maps `null` to the string `"stage process
exited"`. A SIGKILLed worker is therefore indistinguishable from any other abnormal exit.

### `verify` runs under `/bin/sh` (10.3)

```195:199:src/runtime/completionCheckRunner.ts
        child = spawn(input.command, {
          cwd: input.cwd,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
```

`shell: true` means `/bin/sh -c` on POSIX. It also passes **no `env`**, so the child inherits the
worker's environment implicitly — which is another reason this file is in this slot.

### `.mcp.json` interpolation reads the environment (10.10)

`interpolateString` resolves `${NAME}` against the passed `env` and **throws** `unresolved_var` when
the name is absent, unless the author wrote the `${NAME:-default}` form:

```204:213:src/config/resolveStageMcpServers.ts
    if (ENV_VAR_NAME.test(inner)) {
      const found = env[inner];
      if (found !== undefined) {
        return found;
      }
      throw new StageMcpError(
        `Unresolved MCP catalog variable "${inner}"`,
        "unresolved_var",
      );
    }
```

Interpolation applies to `command`, `url`, `cwd`, `args`, `env`, and `headers` (`:221-246`). The
caller passes `{ ...process.env, STAGEFLOW_STAGE_ARTIFACTS_DIR: … }`
(`src/runtime/stageAttemptBootstrap.ts:119-126`), i.e. the full ambient environment. This resolution
happens **inside the stage worker**, so it sees whatever the curated child environment contains.

### MCP connect timeout is a fixed constant (10.10)

`const DEFAULT_ISOLATED_MCP_CONNECT_TIMEOUT_MS = 5_000;` (`src/agent/piIsolatedMcp.ts:15`), consumed
at `:248` as `options?.timeoutMs ?? DEFAULT_…`. The option plumbing exists; nothing sets it, and no
env var or YAML key reaches it.

### Provider credentials go by file, not env — confirmed

`CredentialBinding` is `{ source, authPath, provisional }` (`src/runtime/credentialBinding.ts:22-26`);
`resolveCredentialBinding` picks between `$STAGEFLOW_HOME/agent/auth.json` and
`~/.pi/agent/auth.json` (`:73-110`); `providerAuth` only ever passes `binding.authPath` into
`ModelRuntime.create({ authPath, refreshOnCreate: false })`
(`src/agent/providerAuth.ts:120-121`, `:133`). **No provider API key is read from the environment
anywhere in `src/`.** This is load-bearing good news: removing ambient env does not break model
auth, and it is the precedent for how `secrets:` should deliver file-backed credentials.

### `STAGEFLOW_*` binding helpers (and a plan-doc correction)

`src/runtime/stageRoots.ts` exports the constant `STAGEFLOW_RUN_WORKSPACE` (`:21`) and a helper
`bindPiAgentDirEnv` that mutates `process.env.PI_CODING_AGENT_DIR` in-process and returns a restore
function (`:51-61`).

**The plan doc is wrong about one thing.** [`../pre-container-work.md`](../pre-container-work.md)
§2.6 lists `STAGEFLOW_RUN_WORKSPACE` as "exists today". It does not. `bindRunWorkspaceEnv` is an
explicit no-op:

```125:131:src/runtime/stageRoots.ts
export function bindRunWorkspaceEnv(_runWorkspaceDir: string): () => void {
  return () => {};
}

export function resetBindRunWorkspaceEnvForTests(): void {
  delete process.env[STAGEFLOW_RUN_WORKSPACE];
}
```

`tests/agent.piAdapter.session.test.ts:92-124` asserts the no-op deliberately, because mutating
`process.env` is unsafe with concurrent in-process stages. So **no stage sees
`STAGEFLOW_RUN_WORKSPACE` today** — `examples/github-release/publish-github-release.yaml:8` mentions
it in prose, and that prose is currently a lie. The fix falls out of this slot: the variable belongs
in the forked child's constructed `env`, which is per-process and needs no `process.env` mutation.
Keep `bindPiAgentDirEnv` for the in-process execution mode (`STAGEFLOW_STAGE_EXECUTION=inprocess`,
which is also what `VITEST=true` selects — `src/runtime/stageConcurrency.ts:17-32`).

### Redaction exists, and it is thin (6.3)

The whole of it:

```1:13:src/agent/streamLogRedact.ts
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\b[A-Za-z_]*KEY[A-Za-z_]*\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}['"]?/gi,
];
```

One call site: `src/runtime/stageStreamLog.ts:96`, applied to buffered assistant text before it is
appended to the stream log. **Nothing else is redacted** — not envelope payloads, not
`completionCheckRunner`'s captured stdout/stderr (which `get_stage_verification` returns verbatim),
not the launcher's stderr relay (`src/runtime/stageProcessLauncher.ts:223-239`), not stage events.
Pattern matching alone cannot catch a `github_pat_…` fine-grained token or a base64 blob, which is
why 6.3 adds value-based redaction.

### Confirmed absent, repo-wide

Verified with `rg` across `src/`, `ui/`, `tests/`, `docs/`, and `package.json`:

| Thing | Status |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` handling | **zero occurrences anywhere** |
| `ProxyAgent`, `EnvHttpProxyAgent`, `setGlobalDispatcher` | **zero occurrences**; `undici` is not a dependency and is not present in `node_modules` |
| `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` | **zero occurrences** |
| `--max-old-space-size`, `execArgv`, `/sys/fs/cgroup`, `os.totalmem()` | **zero occurrences** |
| `GITHUB_TOKEN` / `GH_TOKEN` read anywhere | **zero occurrences** — nothing needs a git credential yet; slot 2 introduces the first one |
| `sf doctor` | does not exist |
| Any stage YAML key for secrets | does not exist; stage keys are `system_prompt`, `model`, `io`, `verify`, `gate_kinds`, `skill`, `mcp`, `timeout_ms`, `agent` (`src/types/stage.ts:30-51`, `src/config/pipelineStageKeys.ts`) |

`package.json` declares `"engines": { "node": ">=20" }`, which constrains the proxy work — see 10.1.

---

## The work

### 6.1 — Construct the child environment instead of inheriting it

**Today.** `env: { ...process.env, ...this.env, [SF_STAGE_WORKER]: "1" }`
(`src/runtime/stageProcessLauncher.ts:210`). `verify` passes no `env` at all and inherits implicitly
(`src/runtime/completionCheckRunner.ts:195-199`).

**Target.** A new module — suggested `src/runtime/stageEnvironment.ts` — exporting one function:

```ts
buildStageEnvironment(input: {
  hostEnv: NodeJS.ProcessEnv;
  runVars: Record<string, string>;      // slot 2's STAGEFLOW_* set
  cacheVars: Record<string, string>;    // 10.5
  grants: ResolvedStageGrants;          // 6.2 / 10.6
}): { env: Record<string, string>; warnings: string[] }
```

It returns a plain object built from the allowlist in [The environment contract](#the-environment-contract),
never a spread of `hostEnv`. Both the `fork()` and the `verify` spawn take their `env` from it.
Thread the result through `StageLaunchInput` (`src/runtime/stageProcessLauncher.ts:13-23`) rather
than the constructor, because grants are per-stage while the launcher is per-Host.

**Design decisions already made:**

- **Allowlist by exact name, no prefix wildcards.** A `STAGEFLOW_*` wildcard would pass
  `STAGEFLOW_CONTROL_TOKEN` through.
- **`STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` is the escape hatch**, read from the *Host* environment
  only (a stage cannot set it for itself). It restores the old spread **minus the permanent
  denylist** — the control token, its `_FILE` variant, and any secret registered under 6.2 that this
  stage did not declare. Reason: an escape hatch that re-exposes the control token reinstates the
  exact chain slot 5 exists to close.
- **Using it logs one `WARN` per stage launch, and reports in `/api/health`.** A silent escape hatch
  becomes permanent.
- **Deprecation window: two minor releases.** Announce in the changelog on arrival, warn for both,
  then remove. Record the target version in the warning text so users are not guessing.
- **Named intermediate values, not `all`, are out of scope.** No `STAGEFLOW_STAGE_ENV_PASSTHROUGH=FOO,BAR`
  list — that is `secrets:` with worse ergonomics.
- **The in-process execution mode gets the same treatment on a best-effort basis only.**
  `STAGEFLOW_STAGE_EXECUTION=inprocess` shares the Host's `process.env` by construction and cannot
  be isolated without a fork. Document it as a development/test mode that does not carry the
  isolation guarantee, and say so in the same place the guarantee is stated.

**Files likely to touch.** `src/runtime/stageEnvironment.ts` (new),
`src/runtime/stageProcessLauncher.ts`, `src/runtime/completionCheckRunner.ts`,
`src/runtime/stageRoots.ts`, `src/runtime/stageAttemptBootstrap.ts`, `src/runtime/pipelineRunner.ts`,
`src/runtime/runManager.ts`.

### 6.2 — Declared per-stage secrets

**Today.** No such concept. Every stage has everything.

**Target.** A new stage YAML key, accepted on the pipeline stage entry and on an external stage file
with the same override semantics `mcp:` already has (pipeline entry wins on merge, `secrets: []`
clears a file list — see `docs/yaml-catalog.md` §Stage MCP):

```yaml
stages:
  - id: write-code
    uses: ./write-code.yaml
    # no secrets: — this stage cannot reach any credential

  - id: raise-pr
    uses: ./raise-pr.yaml
    secrets: [GITHUB_TOKEN, gh-cli]
```

An entry is either a bare name or a mapping for the escape hatch:

```yaml
    secrets:
      - gh-cli                                  # file credential, materialised read-only
      - name: GITHUB_TOKEN                      # git write access, delivered as a helper
      - { name: NPM_TOKEN, as: env }             # raw value in the environment, deliberately
```

Names resolve against a **Host secret registry** assembled once at boot. Each registry entry is one
of two kinds:

| Kind | Host source | What the stage gets |
|---|---|---|
| `env` | `NAME` or `NAME_FILE` in the Host environment | `NAME=<value>` in the child env, or a helper — see the git rule below |
| `file` | a declared source path on the Host | a read-only copy under the attempt's credential dir, plus the tool's own pointer variable (`GH_CONFIG_DIR`, `AWS_CONFIG_FILE`, `GIT_SSH_COMMAND`, …) |

**Design decisions already made:**

- **A credential HELPER, not the token value, for anything git or `gh` can use.** Declaring
  `GITHUB_TOKEN` grants `GIT_ASKPASS` pointing at the helper slot 2 already writes, and a
  materialised `gh` config — not `GITHUB_TOKEN=ghp_…`. Reason: the child's job is running `bash`,
  and a process that can run `bash` can read `/proc/self/environ`, `ps eww`, and its own
  `process.env`. Putting a bearer token in that environment makes it readable by the agent, by every
  `verify` command, and by every subprocess either spawns. A helper narrows the grant from "the
  token" to "the ability to authenticate this push", which is the grant the stage actually needs.
- **`as: env` exists, is one line in YAML, and warns.** Some tools genuinely only read an env var
  (`NPM_TOKEN`, many cloud SDKs). Refusing outright would just push users to
  `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all`, which is strictly worse. Make the narrow grant the default
  and the broad one explicit and noisy.
- **Undeclared means absent, with no fallback.** No "warn and pass anyway" mode. A soft default here
  is the same as no feature.
- **Two error codes, at two times.** `stage.unknown_secret` at load/validate time when a name is not
  in the registry (so `sf validate` catches a typo without a run), and `secret_unavailable` as a
  structured start failure when a registered name has no value on this Host (so the harness can tell
  "you misconfigured the pipeline" from "you misconfigured the Host").
- **The registry is Host configuration, not repository configuration.** A stage declares *which*
  secret; only the operator says *where it comes from*. Reason: after slot 2 the Host clones a remote
  on a caller's instruction, so anything read out of the worktree is untrusted input — a pull request
  must not be able to point a credential at a new source. This is the same trust boundary the plan
  doc records as 12.6.
- **Registry shape: reuse whatever slot 7's resolved host config becomes.** Until then, read it from
  the `stageflow.yaml` manifest at the *catalog* root plus `*_FILE` env conventions, and keep the
  reader behind one function so slot 7 can swap it.
- **Every declared name is recorded on the run** (names only, never values) so a run record answers
  "what could this stage reach".

**Files likely to touch.** `src/types/stage.ts`, `src/config/loadStage.ts` (mirror `parseStageMcp`
at `:95-150`), `src/config/pipelineStageKeys.ts`, `src/config/yamlDialect.ts`,
`src/config/validateCatalog.ts`, `src/runtime/stageSecrets.ts` (new — registry + resolution),
`src/runtime/stageEnvironment.ts`, `docs/yaml-catalog.md`.

### 6.3 — Redaction of secret values

**Today.** Pattern-based only, one call site (`src/agent/streamLogRedact.ts:1-13`, used at
`src/runtime/stageStreamLog.ts:96`).

**Target.** Value-based redaction on top of the pattern list, applied at every sink:

| Sink | Where | Status today |
|---|---|---|
| Stream log (assistant text) | `src/runtime/stageStreamLog.ts:96` | redacted (patterns only) |
| Worker stderr relay | `src/runtime/stageProcessLauncher.ts:223-239` | **not redacted** |
| `verify` captured stdout/stderr | `src/runtime/completionCheckRunner.ts:211-233`, surfaced by `get_stage_verification` | **not redacted** |
| Envelope payloads and failure reasons | `src/envelope/*`, run store | **not redacted** |
| Stage events | run store | **not redacted** |
| Git stderr | slot 2's `src/git/` error taxonomy | new code — build it redacted |

**Design decisions already made:**

- **Redact at the sink, not the call site.** One wrapper on the writer so a new log line cannot leak
  by omission. This is the same argument the plan doc makes in 11.5.
- **Redact known values, not just shapes.** The Host knows every registry value; replace exact
  matches with `[redacted:NAME]` so a reader can tell *which* secret was about to appear.
- **Only values of length ≥ 8**, and never a value equal to a common word, or `PATH`-like content
  will be shredded. Guard when the registry is populated, not at match time.
- **Also redact the base64 and URL-encoded forms of each value.** A token inside a `Basic` auth
  header or a URL is the realistic leak, and it costs two extra strings per secret.
- **Never log a secret value to say you redacted it.** Obvious; stated because it gets written by
  accident in the error path.

**Files likely to touch.** `src/agent/streamLogRedact.ts` (extend with a registry-aware redactor),
`src/runtime/stageStreamLog.ts`, `src/runtime/stageProcessLauncher.ts`,
`src/runtime/completionCheckRunner.ts`, slot 4's logger if present.

### 10.1 — Outbound proxy support

**Today.** Nothing. Zero occurrences of any proxy variable or dispatcher in the repo, and `undici`
is not a dependency.

**Why passing the variables is not enough.** Node's global `fetch` is undici, and undici
**deliberately ignores** `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` unless a dispatcher is installed.
Every model call and MCP HTTP call behind a corporate egress proxy fails as a timeout — a stage that
hangs and dies with no mention of a proxy.

**Target.** At **both** Host boot and worker boot, when any proxy variable is set, install a proxy
dispatcher: `setGlobalDispatcher(new EnvHttpProxyAgent())`. Report the resolved proxy state in health
output (names and hosts, never credentials embedded in a proxy URL).

**Design decisions already made:**

- **Add `undici` as an explicit dependency.** Node does not export `setGlobalDispatcher` or
  `EnvHttpProxyAgent` from any public built-in module, `undici` is not currently in the dependency
  tree, and `engines` says `>=20` where `node:http`-level proxying is not an option either. Pin it
  like the other deps.
- **Two boot sites, one function.** Export `installProxyDispatcher()` and call it from the Host
  entrypoints and from `handleInternalRunStage` (`src/cli.ts:276`). The worker is a separate process
  with its own global dispatcher — installing it only in the Host fixes nothing for stages.
- **No-op when no proxy variable is set.** Do not install a dispatcher unconditionally; it changes
  connection pooling behaviour for everyone to fix a problem most users do not have.
- **`NO_PROXY` must include the loopback host, and Stageflow enforces it rather than documenting
  it.** `ensureGlobalService` probes its own Host at `http://127.0.0.1:<port>/api/health`
  (`src/server/ensureGlobalService.ts:53`, `:62`); routed through a proxy that cannot reach it, the
  autostart path decides no Host is running and forks a rival. Append the loopback host and the
  configured bind address to the effective `NO_PROXY` when a proxy is configured, log that you did,
  and document it.
- **Proxy variables are passed through to stages as well as honoured in-process**, because a stage's
  `bash` runs `curl`, `npm`, and `git`, all of which read them natively.

**Files likely to touch.** `src/net/proxy.ts` (new), `src/cli.ts`, the `sf ui` / `sf mcp` boot paths,
`src/runtime/stageEnvironment.ts`, health output, `package.json`.

### 10.2 — CA trust must reach the worker

**Today.** No handling of any CA variable. The Host works by accident: Node honours
`NODE_EXTRA_CA_CERTS` natively at startup, and today's child inherits it through the `process.env`
spread.

**The regression this slot would otherwise ship.** The moment 6.1 lands, a TLS-intercepting proxy's
CA stops reaching stages. Stages fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while the Host's own
calls keep succeeding — which reads as "Stageflow's stages are broken", not "a variable is missing".

**Target.** `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `SSL_CERT_DIR` in the base allowlist. Add an
outbound-TLS reachability check to the preflight functions slot 7's `sf doctor` will call, reporting
the resolved CA paths and whether each exists.

**Design decisions already made:**

- **All three, not just the Node one.** `git`, `curl`, and `npm` in a stage's `bash` read the OpenSSL
  pair, not `NODE_EXTRA_CA_CERTS`. Shipping one of the three produces a stage where the model call
  works and `git push` does not.
- **Validate at boot that a set path exists**, and warn loudly if not. A typo'd
  `NODE_EXTRA_CA_CERTS` is silently ignored by Node, which is the worst possible failure mode.

**Files likely to touch.** `src/runtime/stageEnvironment.ts`, `src/preflight/` (new), health output.

### 10.3 — `verify` must run under `bash`

**Today.** `spawn(input.command, { shell: true })` (`src/runtime/completionCheckRunner.ts:195-199`)
resolves to `/bin/sh -c`. On macOS that is bash in POSIX mode and tolerates most bashisms. On
Debian-slim `/bin/sh` is dash; on Alpine it is busybox ash. Every `verify` using `[[ ]]`,
`pipefail`, `source`, `<(…)`, or brace expansion starts failing with a terse exit 2 that users read
as "my tests broke in the container".

**Target.** `spawn("bash", ["-c", input.command], { … })` with the curated environment from 6.1, and
`bash` as a hard preflight requirement with a named error.

**Design decisions already made:**

- **`bash`, not `sh`, and not configurable.** Picking `sh` would silently change the meaning of every
  existing `verify` command in `examples/` and `tests/fixtures/`. A shell knob is a knob nobody
  wants to own.
- **Resolve `bash` on `PATH`; do not hardcode `/bin/bash`.** It is `/usr/local/bin/bash` on Homebrew
  and `/run/current-system/sw/bin/bash` on NixOS.
- **A missing `bash` is a named startup error, not a per-check failure.** Discovering it once at boot
  beats discovering it as N confusing check failures.
- **`-o pipefail` is not added implicitly.** Changing the exit semantics of existing commands is a
  breaking change with no migration path. Document that `verify` runs under `bash -c` so authors can
  add `set -eo pipefail` themselves.

**Files likely to touch.** `src/runtime/completionCheckRunner.ts`, `src/preflight/`,
`docs/yaml-catalog.md` (the `command` check row at `:239`).

### 10.5 — Shared dependency caches

**Today.** Nothing exports a cache location. After slot 2, every Run gets a pristine worktree, so
every Run pays a full cold `npm install` before `verify` can run. Locally one checkout stays warm
forever, so this is invisible until it is the dominant cost of every run.

**Target.** One shared root at `$STAGEFLOW_HOME/cache`, exported into every stage:

| Variable | Value |
|---|---|
| `STAGEFLOW_CACHE` | `$STAGEFLOW_HOME/cache` |
| `npm_config_cache` | `$STAGEFLOW_CACHE/npm` |
| `PNPM_STORE_DIR` | `$STAGEFLOW_CACHE/pnpm` |
| `YARN_CACHE_FOLDER` | `$STAGEFLOW_CACHE/yarn` |
| `UV_CACHE_DIR` | `$STAGEFLOW_CACHE/uv` |
| `GOMODCACHE` | `$STAGEFLOW_CACHE/go/mod` |
| `CARGO_HOME` | `$STAGEFLOW_CACHE/cargo` |

Add `STAGEFLOW_CACHE` to slot 2's stable-path variable table so it is documented in one place with
`STAGEFLOW_CHECKOUT`.

**Design decisions already made:**

- **Created lazily at first stage launch, not at Host boot**, so a Host that never runs a stage does
  not create seven empty directories.
- **Excluded from per-run disk accounting and from slim GC.** It is not run state; a slim that
  deletes it converts "reclaim 200 MB of worktree" into "re-download the world on the next run".
  Report it as its own category in health disk usage. Tell slot 3.
- **Not per-run, and not read-only.** The whole point is cross-run warmth, which means concurrent
  writers. npm, pnpm, and cargo all handle concurrent access to their own cache; do not add a lock.
- **`CARGO_HOME` is not purely a cache and is included anyway.** It also holds `credentials.toml`
  and `bin/`. Reason: pointing it elsewhere leaves cargo cold, and nothing else in Stageflow writes
  cargo credentials. Note in the docs that `$CARGO_HOME/bin` is not added to `PATH`.
- **A stage may override any of these**, because a pipeline that needs isolation from the shared
  cache should be able to say so. The stage-level value wins.

**Files likely to touch.** `src/runtime/stageEnvironment.ts`, `src/project/globalHome.ts` (a
`cacheRoot()` helper beside slot 1's layout), slot 3's GC, health output.

### 10.6 — File-backed credentials

**Today.** Locally a stage inherits an authenticated `gh`, a loaded ssh-agent, and `~/.aws` by
accident, through `$HOME` and `SSH_AUTH_SOCK`. In a container none of it exists, so any pipeline
copied from `examples/` that shells out to `gh` fails. After 6.1, `$HOME` still points somewhere but
carries nothing.

**Target.** The `file` kind in 6.2's registry. For each declared file credential, at stage attempt
start: copy the Host source into `<attempt dir>/credentials/<name>/` with mode `0400`, set the tool's
pointer variable to it, and delete the directory when the attempt ends.

**Design decisions already made:**

- **One materialisation path, shared with slot 2's `GIT_ASKPASS` helper.** Slot 2 needs to write an
  executable helper into a Host-owned directory with tight modes and clean it up; that is the same
  operation. Build `src/runtime/credentialMaterialisation.ts` once and have slot 2's git code call
  it. Two implementations will diverge on exactly the details that matter (modes, cleanup on the
  error path, symlink handling).
- **Copy, do not symlink or bind-mount.** A symlink into the Host's real `~/.config/gh` gives the
  stage a writable handle on the operator's credentials and defeats the read-only intent.
  Bind-mounting needs privileges the container docs tell users never to grant.
- **Materialise into the attempt directory, never into the checkout.** A credential inside the
  worktree shows up in `git status` and can end up in a commit.
- **Cleanup is unconditional and idempotent**, on success, failure, timeout, and cancel. This is
  where slot 3's GC gets a second chance: a leftover `credentials/` directory must be reclaimed by
  slim.
- **`SSH_AUTH_SOCK` is not forwardable.** A socket cannot be copied, and forwarding the operator's
  agent hands a stage every key it holds. Declare an ssh *key file* instead and set
  `GIT_SSH_COMMAND` to use it with `IdentitiesOnly=yes`.

**Files likely to touch.** `src/runtime/credentialMaterialisation.ts` (new),
`src/runtime/stageSecrets.ts`, `src/runtime/stageAttemptBootstrap.ts`,
`src/runtime/stageEnvironment.ts`.

### 10.10 — Stage MCP servers

**Today.** Three separate problems, all verified:

1. The connect budget is a fixed `5_000` ms (`src/agent/piIsolatedMcp.ts:15`, used at `:248`). A
   typical catalog entry is `npx -y @modelcontextprotocol/server-…`; with a cold npm cache the first
   run of such a stage times out and the retry passes — intermittent, and invisible on a laptop with
   a warm cache.
2. Nothing resolves a catalog `command` against `PATH`. In a slim image with no `npx`, the spawn
   fails as a bare "failed to connect" with no mention of a missing binary.
3. Interpolation reads the environment and throws on absence
   (`src/config/resolveStageMcpServers.ts:204-213`), and today it is handed the whole ambient
   environment (`src/runtime/stageAttemptBootstrap.ts:119-126`).

**Target.**

- A configurable connect timeout with a higher default — **30 s** — settable per server in
  `.mcp.json` and by env var. Thread it into the existing `options.timeoutMs` at
  `src/agent/piIsolatedMcp.ts:248`; the plumbing is already there.
- `sf validate` and the preflight functions resolve every catalog `command` against `PATH` and name
  what is missing, with a distinct error code rather than a connect failure.
- **The breaking change, announced:** once 6.1 narrows the environment, every `${SOME_TOKEN}` in a
  `.mcp.json` that resolved from ambient environment becomes a hard `unresolved_var` error and the
  stage fails to start. See [Breaking changes this slot ships](#breaking-changes-this-slot-ships).

**Design decisions already made:**

- **30 s, not 10 s.** A cold `npx` fetch of a server package over a proxy is routinely more than
  10 s, and the cost of a too-generous timeout is a slower failure, while the cost of a too-tight one
  is a flaky pipeline.
- **`.mcp.json` interpolation resolves against the stage's curated environment, not the Host's.**
  Resolving against the Host would reintroduce ambient secret access through a config file in the
  repository — the exact thing 6.1 closes. So a server that needs a token requires the stage to
  declare that secret.
- **`${NAME:-default}` keeps working unchanged** (`src/config/resolveStageMcpServers.ts:199-203`).
  That is the documented migration for entries whose variable is optional.
- **`unresolved_var` gets a better message.** It must name the variable, the stage, the server, and
  the two fixes: declare it in `secrets:`, or use the `${NAME:-default}` form.
- **Pre-installing common MCP servers is image work, not code work** — slot 8/Dockerfile.

**Files likely to touch.** `src/agent/piIsolatedMcp.ts`, `src/config/resolveStageMcpServers.ts`,
`src/runtime/stageAttemptBootstrap.ts`, `src/config/validateCatalog.ts`, `src/preflight/`,
`docs/yaml-catalog.md` §Stage MCP, `docs/mcp.md`.

### 11.1 — Cgroup-aware heap sizing and a finite stage-process cap

**Today.** `DEFAULT_MAX_ACTIVE_STAGE_PROCESSES` is `Number.POSITIVE_INFINITY`
(`src/runtime/stageConcurrency.ts:9`), `waitForCapacity` short-circuits when the cap is not finite
(`src/runtime/stageProcessLauncher.ts:151-153`), there is no `execArgv` on the `fork`, and nothing in
the repo reads a cgroup limit or sets `--max-old-space-size`.

**Why it bites only in a container.** Node sizes its default old-space at roughly half the cgroup
limit **per process**. Fork one worker per stage and four processes each independently believe they
may grow to ~1 GB inside a 2 GB container. The OOM killer takes one — possibly the Host. The run
stays `running` and nothing recovers it until a restart.

**Target.**

- `readContainerMemoryLimit()`: read `/sys/fs/cgroup/memory.max` (cgroup v2), fall back to
  `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1), treat `"max"` and absurdly large v1 sentinel
  values as unlimited. **Explicitly not `os.totalmem()`**, which reports the host's memory inside a
  container and is the reason this bug is invisible in testing.
- A finite `DEFAULT_MAX_ACTIVE_STAGE_PROCESSES` derived from that limit and a per-worker budget,
  clamped to at least 1 and to a small ceiling. When no cgroup limit is discoverable, use a finite
  fallback — **4** — not `Infinity`.
- `execArgv: ["--max-old-space-size=<mb>"]` on the `fork`, with the per-worker budget in MB.
- Log the computed figures once at boot and report them in health output.
- A `worker_oom_killed` reason code: a child that exits on `SIGKILL` with no IPC result message and
  no envelope. Today the signal is discarded — `child.on("exit", (code) => …)`
  (`src/runtime/stageProcessLauncher.ts:261-264`) feeds `resultFromExitCode` (`:56-70`), which maps
  `null` to `"stage process exited"`.

**Design decisions already made:**

- **`fork`'s `execArgv` must be set explicitly.** It otherwise inherits the parent's `execArgv`, so a
  Host started with its own flags would silently propagate them and a Host started without would get
  no ceiling at all.
- **Reserve headroom for the Host before dividing.** The Host holds SQLite and the HTTP server; a
  formula that hands the entire cgroup to workers OOMs the supervisor, which is the worst outcome
  because nothing then reconciles the run.
- **Read the limit once at boot and cache it.** It does not change for the life of the process, and
  reading `/sys` per launch is noise in every strace and every test.
- **A missing or unreadable `/sys/fs/cgroup` is not an error.** macOS and bare-metal Linux have no
  such file; fall back silently.
- **`STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` keeps overriding the derived default**, and the reader
  already handles this (`src/runtime/stageConcurrency.ts:53-70`). Operators who have sized their
  deployment should not be second-guessed.
- **`DEFAULT_MAX_ACTIVE_STAGES_PER_RUN` stays `Infinity`.** It is enforced by a plain comparison in
  the scheduler (`src/runtime/pipelineScheduler.ts:1385`), so the global process cap already bounds
  real memory use. Adding a second finite cap changes fan-out semantics for every existing pipeline
  to solve a problem the first cap solved.
- **Treat `waitForCapacity` as new code.** Its queueing branch has never run in a default
  configuration, because the short-circuit at `:151-153` has always been taken. Test the queue
  explicitly: FIFO wake-up, release-on-error, release-on-throw from `spawnAndWait`, and no slot leak
  when a child fails to spawn.

**Files likely to touch.** `src/runtime/containerLimits.ts` (new), `src/runtime/stageConcurrency.ts`,
`src/runtime/stageProcessLauncher.ts`, `src/runtime/stageWorkerProtocol.ts` (the new reason code),
health output.

### 10.11 rider — The Claude backend cannot run as root

**Today.** The Claude backend passes `permissionMode: "bypassPermissions"` and
`allowDangerouslySkipPermissions: true`:

```303:304:src/agent/claudeAdapter.ts
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
```

The Claude Agent SDK **refuses** `bypassPermissions` when the effective uid is 0. The Docker default
user *is* root. Nothing in `src/` checks a uid — there is no `geteuid` call anywhere.

**Target.** A validated precondition with a named error, raised before the first stage launches, not
a Dockerfile comment. Check `process.geteuid?.() === 0` when the resolved backend for any stage is
Claude, and fail with a message naming the running uid and the fix (`--user`, or a non-root
`USER` in the image).

**Design decisions already made:**

- **Refuse, do not silently downgrade the permission mode.** A stage that suddenly needs interactive
  approval in a headless container hangs, which is harder to diagnose than a startup refusal.
- **Check at run start, not only in `sf doctor`.** `sf doctor` will not exist until slot 7, and the
  failure must not be discoverable only by running a doctor nobody ran. Export the check so slot 7
  can call the same function.
- **Scope the check to the Claude backend.** Pi runs fine as root; refusing root globally would
  break working Pi deployments for no reason.
- **`process.geteuid` is undefined on Windows.** Optional-call it; absent means not root.

**Files likely to touch.** `src/agent/claudeAdapter.ts`, `src/agent/resolveAgentPort.ts`,
`src/preflight/`, `docs/providers.md`.

---

## Breaking changes this slot ships

Two, both user-visible, both needing a changelog entry and a migration note. Write the migration
note **before** the code, because it is also the specification for the error messages.

### 1. Stages no longer inherit the Host's environment

**What breaks.** Any stage prompt, `verify` command, `skill`, or agent shell command that read an
ambient variable — a `$MY_API_BASE`, a `$CI`, a `$NPM_TOKEN`, an authenticated `gh` via `$HOME`, or a
proxy variable that happened to be exported. These stop being visible and start failing as "command
not authenticated" / "undefined variable" rather than as a Stageflow error.

**Migration.**

1. Add the variable to the stage's `secrets:` list if it is a credential.
2. If it is not a credential and not in the base allowlist, open an issue — the allowlist is meant to
   cover everything non-secret that a build genuinely needs, and a gap in it is a bug.
3. As a stopgap, set `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` on the Host. It warns on every stage
   launch and is removed after two minor releases. It does **not** restore the control token or any
   registered-but-undeclared secret.

**Announce.** Changelog, `docs/yaml-catalog.md` (the environment contract table),
`docs/providers.md` (that provider auth is unaffected, because it travels by `authPath`), and a
release note. The single most useful sentence: *"If your stage needed it, declare it."*

### 2. `.mcp.json` `${VAR}` interpolation now resolves against the stage environment

**What breaks.** A catalog entry like:

```json
{ "mcpServers": { "gh": { "command": "npx", "args": ["-y", "server-github"],
  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } } } }
```

resolved from ambient environment before this slot. Afterwards `GITHUB_TOKEN` is not in the stage
environment unless declared, and `interpolateString` **throws** `unresolved_var`
(`src/config/resolveStageMcpServers.ts:209-212`). The stage fails to start — it does not start with
an empty token.

**Migration.** Either declare the secret on every stage that lists that server:

```yaml
    mcp: [gh]
    secrets: [{ name: GITHUB_TOKEN, as: env }]
```

or make the variable optional with the already-supported default form
(`src/config/resolveStageMcpServers.ts:199-203`):

```json
"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN:-}" }
```

**Announce.** Changelog, `docs/yaml-catalog.md` §Stage MCP, `docs/mcp.md`. The `unresolved_var`
message must name the variable, the server, the stage, and both fixes — this error is the migration
guide for most users.

---

## Out of scope

- **Egress proxying infrastructure.** 10.1 is a *client* of a proxy an operator already runs. The
  reference compose with an `internal: true` network and a domain-allowlisting sidecar, the threat
  model, and the honest statement that a domain allowlist does not stop exfiltration through a broad
  allowed host like GitHub — that is slot 8, and it is documentation, not code. This slot contributes
  exactly one thing to it: the health field reporting whether proxy variables are set.
- **Per-stage CPU and memory limits — rejected, not deferred.** The operator owns CPU and memory via
  `docker run --cpus --memory`; Stageflow owns time, disk, and tokens because those map to run
  semantics it already tracks. Enforcing CPU and memory inside Stageflow needs cgroup manipulation
  or nested containers, i.e. privileges the container docs tell users never to grant. 11.1 *reads*
  the cgroup limit to size a heap; it does not set one.
- **Per-stage container sandboxing or docker-in-docker.** Same reason. The isolation boundary this
  slot builds is a curated environment plus a declared grant, not a new kernel namespace.
- **Wall-clock, disk, and token budgets (11.2)**, run queueing (11.3), and disk admission (11.4).
  Different slots.
- **Named per-caller tokens and quotas.** Slot 9.
- **The Dockerfile, the compose file, and pre-installing MCP servers at image build time.**
- **Slot 2's values.** This slot ships the mechanism that puts `STAGEFLOW_CHECKOUT`,
  `GIT_AUTHOR_NAME`, and the `GIT_ASKPASS` helper into the child. Slot 2 decides what they contain.
- **Mounting the user's dotfiles or forwarding their ssh-agent.** Explicitly rejected: reproducibility
  is what the container buys, and importing ambient laptop state trades it away.

---

## Acceptance criteria

**6.1 — constructed environment**

1. A stage whose `bash` runs `env` sees only allowlisted names, the `STAGEFLOW_*` set, the cache
   variables, and its own declared grants.
2. With `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and `STAGEFLOW_CONTROL_TOKEN` all set on the Host and a
   stage declaring no secrets, none of the three appears in the child's environment — and model
   calls still work, because provider auth travels by `authPath`.
3. With `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all`, ambient variables reappear, a warning is logged per
   stage launch, health reports the escape hatch as active, and `STAGEFLOW_CONTROL_TOKEN` is
   **still absent**.
4. The `fork` and the `verify` spawn receive environments built by the same function; no test can
   find a name present in one and absent from the other.

**6.2 / 10.6 — declared secrets**

5. `secrets: [GITHUB_TOKEN]` yields `GIT_ASKPASS` and a working `git push` in the stage — and
   `GITHUB_TOKEN` is **not** in `process.env` of the child or of its `verify` shell.
6. `secrets: [{ name: NPM_TOKEN, as: env }]` yields the value, plus a warning.
7. A name absent from the registry fails `sf validate` with `stage.unknown_secret`; a registered
   name with no Host value fails run start with `secret_unavailable`.
8. A declared file credential exists at mode `0400` under the attempt directory during the stage and
   is gone after it terminates — including after a failure, a timeout, and a cancel.
9. The credential directory is never inside the checkout, and `git status` in the worktree is clean
   of it.

**6.3 — redaction**

10. A stage that `echo`s its declared secret produces `[redacted:NAME]` in the stream log, the stderr
    relay, `get_stage_verification` output, and any envelope field.
11. The base64 form of a secret value is also redacted.
12. A git `auth_failed` error whose stderr contains a token is redacted before it is stored.

**10.1 / 10.2 — proxy and CA**

13. With `HTTPS_PROXY` set to a local recording proxy, a Host-side and a stage-side model call both
    traverse it.
14. `NO_PROXY` gains the loopback host automatically, and `ensureGlobalService`'s health probe does
    not go through the proxy.
15. `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `SSL_CERT_DIR` reach the stage; a set-but-missing
    path warns at boot.

**10.3 — bash**

16. A `verify` command using `[[ -f x ]]` and `set -o pipefail` passes on an image whose `/bin/sh`
    is dash.
17. A Host with no `bash` on `PATH` fails at startup with a named error, not per check.

**10.5 — caches**

18. Two runs of the same pipeline against the same repository share the npm cache; the second run's
    install is measurably faster.
19. Slim GC leaves `$STAGEFLOW_HOME/cache` intact, and health reports its size as its own category.

**10.10 — stage MCP**

20. An `npx`-based server with a cold cache connects within the new default timeout.
21. A catalog `command` not on `PATH` is reported by `sf validate` with the missing binary named.
22. A `${VAR}` that is not declared fails with an `unresolved_var` message naming the variable, the
    server, the stage, and both fixes.

**11.1 — limits**

23. In a 2 GB memory-limited container the derived process cap is finite and small, and each worker
    runs with an explicit `--max-old-space-size`; both figures appear in boot logs and health.
24. `os.totalmem()` appears nowhere in the sizing path.
25. A worker killed with `SIGKILL` and no envelope is recorded as `worker_oom_killed`, and the run
    reaches a terminal state without a restart.
26. With the cap set to 1, two concurrent stage launches serialise and both complete; no slot leaks
    after a spawn error.

**10.11 — Claude as root**

27. With euid 0 and a Claude-backed stage, run start fails with a named error printing the uid and
    the fix. With euid 0 and Pi-backed stages only, nothing changes.

---

## Testing

Tests live in `tests/*.test.ts` (vitest); fixtures in `tests/fixtures/pipelines|stages|tasks`. Prefer
extending fixtures over inline YAML when behaviour is catalog-driven.

One structural warning before you start: `readStageExecutionMode` returns `inprocess` when
`env.VITEST === "true"` (`src/runtime/stageConcurrency.ts:24-26`), so **the default test path does
not fork at all** and will not exercise `buildStageEnvironment` through `StageProcessLauncher`. Test
the two layers separately:

- **Unit-test `buildStageEnvironment` directly** with a synthetic `hostEnv`. This is where the
  allowlist, the denylist, the passthrough hatch, and the grant merging get their coverage, and it is
  fast and exhaustive.
- **Add a small number of real fork tests** that set `STAGEFLOW_STAGE_EXECUTION=process` explicitly
  and assert on what a child actually received — a fixture stage whose `verify` command is
  `env | sort` is the cheapest possible observation of the real thing.

Beyond that:

- **`verify` under `bash`.** A fixture check using `[[ ]]` plus a unit test asserting the spawn
  argv is `["bash", "-c", command]` and that `env` was passed explicitly.
- **Redaction.** Extend `tests/agent.streamLogRedact.test.ts` with registry-aware cases: exact value,
  base64 form, short-value guard, and a value that is a common word.
- **Cgroup parsing.** Pure function over file contents — `"max"`, a byte count, the v1 sentinel, a
  missing file, and a garbage file. No container needed.
- **The capacity queue.** Direct tests on `StageProcessLauncher` with `maxActiveStageProcesses: 1`,
  covering FIFO order, release on failure, and release when `fork` itself throws.
- **MCP interpolation.** `tests/` already covers `resolveStageMcpServers`; add the curated-env cases
  and assert the improved `unresolved_var` message names the variable and the stage.
- **Proxy.** Assert that `installProxyDispatcher` is a no-op with no proxy variables set and installs
  a dispatcher when one is, and that the effective `NO_PROXY` gained the loopback host. Do not test
  against a real proxy in the suite.

Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing.

**Manual verification is the real test for this slot.** The failures it fixes are container failures,
and the suite runs on your laptop where `/bin/sh` is bash and `$HOME` has a `~/.gitconfig`. Before
declaring done, run a pipeline inside a Linux container with a memory limit, no `~/.gitconfig`, no
`gh` auth, and a proxy in front of it — that is the environment every one of these items was written
for.

---

## Repo conventions

Read [`AGENTS.md`](../../../AGENTS.md) at the repo root first. The parts that bear on this slot:

- **Minimal, focused diffs.** Match the patterns in the file you are editing. Notably: do not
  restructure `StageProcessLauncher` because you are changing one argument to `fork`, and do not
  rewrite `completionCheckRunner`'s capture logic because you are changing the shell.
- **New stage YAML keys go on the YAML dialect, not on the IR type directly.**
  `src/types/stage.ts:26-29` says so explicitly: author new catalog contracts as YAML keys and map
  them in `compileTargetContract` (`src/config/yamlDialect.ts`). `secrets:` is a new catalog key —
  follow how `mcp:` is parsed (`src/config/loadStage.ts:95-150`, key list at
  `src/config/pipelineStageKeys.ts:40`) and how it merges between a pipeline entry and an external
  stage file (`docs/yaml-catalog.md:726`).
- **`tests/fixtures/` is canonical YAML**, and `examples/` must stay in sync when behaviour changes.
  Two concrete debts to pay here: `examples/github-release/publish-github-release.yaml:8` describes
  `STAGEFLOW_RUN_WORKSPACE` as available when it is not, and `examples/stage-mcp/` uses the
  `${ECHO_TOKEN:-local}` form — which is exactly the form that keeps working, so it is a good
  migration example to point at in the docs.
- **No comments unless the logic is non-obvious.** Three places here earn one: why the allowlist is
  name-based rather than prefix-based, why the cgroup file is read instead of `os.totalmem()`, and
  why `execArgv` is set explicitly rather than inherited.
- **JSON output and exit codes are a public contract** (`docs/ci.md`, `tests/cli.*.test.ts`). The new
  `worker_oom_killed` reason code and the Claude-as-root refusal both belong in it.
- **Never commit secrets or `.env` files.** Test secret values go in the test file as obvious
  literals like `"test-secret-value-0123456789"`.
- **Docs to update in the same change:** `docs/yaml-catalog.md` (the `secrets:` key, the environment
  contract table, `verify` under `bash`, the §Stage MCP timeout and interpolation change),
  `docs/providers.md` (that provider auth is unaffected, and the Claude-as-root precondition),
  `docs/mcp.md` (the interpolation breaking change), and `docs/cli-reference.md` if any flag is
  added. Public docs are indexed at `docs/README.md`.
- **Positioning:** user-facing copy leads with configurable stages and pipelines. Do not frame
  Stageflow as an SDLC-only tool — the `secrets:` docs should not read as a CI feature.

---

## Open questions for the human

1. **Where does the secret registry live until slot 7's one config surface exists?** Options: the
   `stageflow.yaml` manifest at the catalog root, a new `$STAGEFLOW_HOME/secrets.json`, or env
   conventions only (`NAME` / `NAME_FILE`, with file credentials undeclarable until slot 7).
   **Default if nobody answers: env conventions for `env` secrets, plus a manifest section for
   `file` credentials, behind one reader function slot 7 replaces.**
2. **Is `secrets:` the right key name, given it also carries file-backed credentials?** The plan doc
   says `secrets:`. `credentials:` is more accurate, `grants:` more accurate still and less familiar.
   **Default: `secrets:`, matching the plan and the word users will search for.**
3. **Does `secrets:` belong on the pipeline stage entry, the stage body, or both?** `mcp:` and
   `skill:` allow both with the pipeline entry winning, and the docs say prefer the entry
   (`docs/yaml-catalog.md:726`). Both is consistent; entry-only is arguably safer, since a reusable
   stage file that silently requests a credential is easy to miss in review. **Default: both, mirroring
   `mcp:`.**
4. **How long a deprecation window for `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all`?** Two minor releases is
   the assumption above. This depends on release cadence and on whether there are external users to
   break.
5. **Should the base allowlist be operator-extensible** — a `STAGEFLOW_STAGE_ENV_ALLOW=FOO,BAR` list —
   or is that just the passthrough hatch with extra steps? It is the honest answer for a
   non-credential variable the allowlist missed, and it is strictly narrower than `all`.
   **Recommendation: yes, and prefer it over the `all` hatch in the migration note.**
6. **What per-worker heap budget, and what ceiling on the derived process cap?** The formula needs
   two numbers this brief deliberately does not invent. They want measurement against a real
   pipeline, not a guess.
7. **Does `STAGEFLOW_CACHE` need to be excluded from backups as well as from GC?** Slot 8's backup
   work distinguishes irreplaceable from rebuildable state; the cache is emphatically rebuildable,
   and saying so here saves slot 8 a decision.
8. **Should a run record the secret *names* a stage declared, or also whether each resolved?** Names
   only is safe and cheap. Resolution status is more useful for debugging and discloses slightly more
   about the Host's configuration to anyone who can read a run.
