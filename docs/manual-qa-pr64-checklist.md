# Manual QA checklist — PR #64 (slots 1–9)

PR: [https://github.com/tejasghutukade/stageflow/pull/64](https://github.com/tejasghutukade/stageflow/pull/64)  
Package: `stageflow@0.25.0` (bins: `sf`, `stageflow`)  
Worktree: `/Users/tejasghutukade/.cursor/worktrees/software-factory/68d4`

Manual operator steps only. Do **not** use the package test suite.

---

## How to use this doc

- Tick every `- [ ]` as you go (print or edit a copy).
- Suggested order: **smoke → project registration → catalog → access → real run → capacity/interrupt → env/secrets → backup/restore → multi-project**.
- Always isolate state with a dedicated `STAGEFLOW_HOME` + `TMPDIR` (section 2). Never reuse your daily `~/.stageflow` for restore experiments.
- **Stop the Host** (`Ctrl-C` on `sf ui` / `sf mcp`, or kill the process on port 3847) before every `sf restore`. Restore probes `/livez` and refuses if the Host is up.
- Prefer a **separate consumer project** (`~/tmp/sf-consumer-pr64`). Seeded examples can be exercised by registering the worktree; identity/path-contract tests need a second folder.
- Default Host port: **3847**. Console: `http://127.0.0.1:3847`. MCP: `http://127.0.0.1:3847/mcp`.

---

## 0. Before you start — pitfalls you will hit

Read this once. Most “bugs” in this PR are expected breaks.


| Trap                           | What happens                                                                                                                                        | What to do                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boot cwd ≠ catalog**         | Starting `sf ui` inside a project does **not** register that project. Cold Host only sees **seeded** examples until something local ensures a root. | Run `sf run` from the project (auto-ensure), or `POST /api/projects` from loopback.                                                                                                            |
| **Ensure-then-start**          | Local `sf run` / `sf run-stage` call `POST /api/projects` then `start_run`. Remote MCP/HTTP **cannot invent** roots.                                | Ensure once from a trusted local client before remote harnesses use that `project_root`.                                                                                                       |
| **Absolute paths from MCP**    | Network callers sending `/Users/…/foo.pipeline.yaml` get `absolute_path_not_allowed`, not ENOENT.                                                   | Use catalog-relative paths + already-known `project_root`.                                                                                                                                     |
| **Curated stage env (Slot 6)** | Stages do **not** inherit Host ambient env. Undeclared `$MY_TOKEN` / `$CI` / ambient `gh` auth vanish.                                              | Declare `secrets:` on stage/pipeline; or Host `STAGEFLOW_STAGE_ENV_ALLOW=FOO,BAR`; stopgap `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` (deprecated WARN). See `docs/migration-stage-environment.md`. |
| **TMPDIR**                     | Host boot fails with `tmpdir_unusable` if `TMPDIR` is missing/unwritable.                                                                           | Always `export TMPDIR=…` and `mkdir -p` it.                                                                                                                                                    |
| **Control token ≥ 32 chars**   | Non-loopback bind without a drive token refuses start (exit `1`). With tokens set, scoped `/api/`* need `Authorization: Bearer …`.                  | Use a ≥32-char `STAGEFLOW_CONTROL_TOKEN`; `/livez`/`/readyz` stay auth-open (allowed-hosts only).                                                                                              |
| `sf ui` **vs autostart race**  | First `sf run` may spawn detached `sf mcp` on 3847. Then `sf ui` fails to bind.                                                                     | Start `sf ui --no-open` first if you want the console; or kill whatever owns 3847.                                                                                                             |
| `STAGEFLOW_NO_AUTOSTART`       | Truthy → CLI refuses to spawn Host; reason/code `autostart_disabled`.                                                                               | Start Host yourself, or unset the var. (There is no bare `NO_AUTOSTART`.)                                                                                                                      |
| **Never** `cp state.db`        | WAL mode → corrupt / partial copy.                                                                                                                  | Only `sf backup` / `sf restore`.                                                                                                                                                               |
| **Restore with Host up**       | Restore fails while `/livez` answers.                                                                                                               | Stop Host, restore, restart.                                                                                                                                                                   |
| **Schema too new**             | Older binary vs newer DB → `store_schema_too_new` (Host exit `4`).                                                                                  | Restore a backup taken with the older schema, or stay on this binary.                                                                                                                          |
| `--operator-cwd` **no-op**     | Flags on `sf run` warn and do nothing.                                                                                                              | Set `STAGEFLOW_OPERATOR_CWD` / `STAGEFLOW_OPERATOR_AGENT_DIR` **before** Host first starts.                                                                                                    |
| **Provider auth**              | Real agent stages need a logged-in provider.                                                                                                        | `sf providers login` or Settings in the console before Session E.                                                                                                                              |
| **No unregister in this PR**   | You cannot delete a registered root via API/CLI.                                                                                                    | Use a throwaway `STAGEFLOW_HOME` for isolation.                                                                                                                                                |


**Error codes to watch:** `unknown_project_root`, `absolute_path_not_allowed`, `ensure_project_not_allowed`, `path_outside_project_root`, `tmpdir_unusable`, `autostart_disabled`, `store_schema_too_new`, `busy_capacity`, `busy_checkout`, `busy_caller_quota`, `insufficient_disk`, `secret_unavailable`, `missing_tool`.

---

## 1. Install this unpublished build

Work from the worktree:

```bash
cd /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4
```

### Uninstall old globals first

- [x] `npm uninstall -g stageflow`
- [x] If an older package name lingered: `npm uninstall -g software-factory` (ignore if not installed)
- [x] Confirm: `which sf` → empty or not pointing at an old global

### A) Recommended — build + `npm link`

```bash
cd /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4
npm i
npm run build
npm run ui:build    # needed for operator console assets in dist/ui
npm link
```

- [x] `sf --version` → `0.25.0`
- [x] `sf --version --json` → JSON with `"version":"0.25.0"` (or equivalent field)
- [x] `which sf` → under your npm global prefix / link target
- [x] `stageflow --version` → same as `sf`

### B) Alternative — pack + global tgz

```bash
npm run build && npm run ui:build
npm pack                 # → stageflow-0.25.0.tgz
npm uninstall -g stageflow
npm i -g ./stageflow-0.25.0.tgz
```

- [ ] Same version checks as A

### C) Alternative — `file:` dep in consumer

```bash
mkdir -p ~/tmp/sf-consumer-pr64 && cd ~/tmp/sf-consumer-pr64
npm init -y
npm i /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4
npx sf --version
```

- [ ] `npx sf --version` → `0.25.0`

### D) Dev-only (no global) — from worktree

```bash
cd /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4
npm run build   # optional for typecheck; tsx runs source
npm run dev -- --version
npm run dev -- doctor
```

- [ ] Dev entry prints version / doctor without needing `npm link`

### Cleanup later (after QA)

```bash
npm unlink -g stageflow
# or: npm uninstall -g stageflow
npm i -g stageflow@latest   # when you want published again
```

- [ ] Noted for teardown (Appendix) — **SKIP agent** (human teardown)

---

## 2. Isolated test environment

Use a throwaway home for the entire checklist (or per destructive session).

```bash
export STAGEFLOW_HOME="$HOME/tmp/sf-home-pr64"
export TMPDIR="$HOME/tmp/sf-tmpdir-pr64"
mkdir -p "$STAGEFLOW_HOME" "$TMPDIR"

# Optional access-control sessions:
# export STAGEFLOW_CONTROL_TOKEN="$(python3 -c 'print("x"*32)')"   # ≥32 chars
# export STAGEFLOW_READ_TOKEN="$(python3 -c 'print("r"*32)')"

# Optional: refuse CLI autostart (Session H)
# export STAGEFLOW_NO_AUTOSTART=1
```

- [x] `echo $STAGEFLOW_HOME` and `echo $TMPDIR` are the paths you expect
- [x] Kill leftover Host on 3847 if needed:

```bash
lsof -iTCP:3847 -sTCP:LISTEN
# kill <pid>   # if something unexpected owns it
```

- [x] Confirm nothing answers: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3847/livez` → connection refused — **SKIP agent**: did not probe/kill 3847 (user may use it); agent used 3850 only

Put the exports in a small `~/tmp/sf-pr64-env.sh` and `source` it every new shell.

---

## 3. Scaffold a consumer project (outside the repo)

### 3a. Minimal consumer via `sf init` (preferred)

```bash
mkdir -p ~/tmp/sf-consumer-pr64
cd ~/tmp/sf-consumer-pr64
sf init
ls -la stageflow.yaml pipelines/ tasks/
```

Expected files (same as init templates):

- `stageflow.yaml` — catalog roots `pipelines/`, `tasks/`
- `pipelines/hello.pipeline.yaml` — single inline stage
- `tasks/hello.task.yaml`

- [x] `sf init` created the three paths (or skipped if already present)
- [x] `sf validate --pipeline pipelines/hello.pipeline.yaml --strict` exits 0

### 3b. Copy-paste minimal YAML (if you prefer not to use init)

After fixing `src/cli/initTemplates.ts`, re-run `npm run build && npm link` before relying on `sf init` again (an older linked binary still scaffolds the invalid pipeline).

`stageflow.yaml`:

```yaml
version: 1
catalog:
  pipelines:
    - pipelines
  tasks:
    - tasks
  patterns:
    pipeline: "*.pipeline.yaml"
    task: "*.task.yaml"
```

`pipelines/hello.pipeline.yaml`:

```yaml
id: hello
stages:
  - id: hello
    model: anthropic/claude-sonnet-4-5
    system_prompt: Say hello and emit a success envelope.
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
```

`tasks/hello.task.yaml`:

```yaml
id: hello
goal: Run the hello pipeline scaffold.
```

### 3c. Seeded examples (worktree as a registered project)

For richer catalogs (HITL, repo-bound demos), register the **worktree** by running from it once:

```bash
cd /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4
# after Host is up (or let sf run autostart):
sf validate --pipeline examples/hello-world/hello.pipeline.yaml --strict
```

Hello-world paths under the worktree:

- `examples/hello-world/hello.pipeline.yaml`
- `examples/hello-world/my-task.task.yaml`
- `examples/hello-world/research.yaml`

HITL walkthrough (needs agent + operator): `examples/mcp-hitl-tour/`.

**Identity tests (Session L)** need a **second** folder (e.g. `~/tmp/sf-consumer-pr64-b`) — do not only use the monorepo.

---

## Session A — Smoke: doctor, health, version, home layout

**Goal:** Binary + Host + durable root basics before any catalog drama.

**Prereqs:** Section 1 install, section 2 env.

1. - [x] `sf --version` → `0.25.0`
2. - [x] `sf doctor` (human) exits 0; store/home/migrations/git/bash/node look ok — pass from `/tmp`; fail from worktree cwd due to `.mcp.json` dead server (see findings F-10)
3. - [x] `sf doctor --json` → JSON with check objects (`store_openable`, `home_writable`, `migrations_complete`, …)
4. - [x] Start Host: `sf mcp --port 3850` (agent port; not 3847)
5. - [x] `curl -sS http://127.0.0.1:3850/livez` → `{"ok":true,"status":"live"}`
6. - [x] `curl -sS http://127.0.0.1:3850/readyz` → `ready: true` and checks for store/home/migrations/git
7. - [x] `curl -sS http://127.0.0.1:3850/api/health` → includes `version` (~0.25.0), `stageflow_home`, `catalog_roots`, capacity
8. - [x] `ls "$STAGEFLOW_HOME"` → expect at least `state.db` (and likely `-wal`/`-shm` after open), possibly `agent/`, `service.log`
9. - [x] Confirm **do not** use `sf doctor` as a container HEALTHCHECK mental model — `/livez` is the liveness probe (doctor stderr + behavior)

**If fail:** `tmpdir_unusable` → fix `TMPDIR`. `store_unsupported_filesystem` → not on network FS unless `STAGEFLOW_ALLOW_NETWORK_STORE=1`. Port in use → kill 3847 occupant.

---

## Session B — Project registration contract (THE big break)

**Goal:** Prove Host-global registry: ensure from trusted local; refuse invent from “remote”; boot cwd is not a catalog root.

**Prereqs:** Host running under isolated `STAGEFLOW_HOME`. Consumer at `~/tmp/sf-consumer-pr64`.

1. - [x] With a **fresh** home and Host just started, health `catalog_roots` → only **seeded** example roots (on 3850)
2. - [x] From consumer: `sf run … --json` (registration proof; run later cancelled)
3. - [x] Re-check health `catalog_roots` → **includes** absolute `…/sf-consumer-pr64`
4. - [x] Explicit ensure (loopback) on 3850 → 200 absolute project_root:

```bash
curl -sS -X POST http://127.0.0.1:3847/api/projects \
  -H 'Content-Type: application/json' \
  -d "{\"project_root\":\"$HOME/tmp/sf-consumer-pr64\"}"
```

Expected: `200` with `project_root` absolute path.

1. - [x] Relative body fails:
  `curl -sS -X POST … -d '{"project_root":"relative/path"}'` → `400` (“must be an absolute path”)
2. - [x] Missing field: `-d '{}'` → `400` (`project_root is required`)
3. - [x] **Trusted-only gate:** N/A — pure loopback only (no remote non-trusted client available)
4. - [x] Cold mental model: stop Host, start `sf mcp --port 3850` from `/tmp`. Health still lists previously **registered** roots from SQLite, not “cwd”.

**If fail:** Registration missing after `sf run` → Host not the one with this `STAGEFLOW_HOME` (env not exported in that shell). `unknown_project_root` on start → root never ensured.

---

## Session C — Catalog / path contract / seeded examples

**Goal:** Catalog-relative paths; seeded hello-world; absolute path rejection for network-shaped calls.

**Prereqs:** Consumer registered; optionally worktree registered.

1. - [x] `sf validate --pipeline ~/tmp/sf-consumer-pr64/pipelines/hello.pipeline.yaml --strict` → 0
2. - [x] From worktree (registers worktree if needed):
  `cd /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4`  
   `sf validate --pipeline examples/hello-world/hello.pipeline.yaml --strict`
3. - [x] Health / catalog list shows seeded examples (packaged examples under the install / worktree seed roots)
4. - [x] Path escape / absolute contract (MCP or HTTP `start_run` with absolute pipeline path as a **network** caller): expect `absolute_path_not_allowed`
5. - [x] Unknown absolute `project_root` on start → `unknown_project_root`
6. - [x] `..` escape outside selected root → `path_outside_project_root` (if easy to provoke via MCP tools)

**Seeded smoke run (needs provider):**

```bash
cd /Users/tejasghutukade/.cursor/worktrees/software-factory/68d4
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml \
  --json
```

1. - [x] Run appears in `sf runs list --json` from **any** cwd (global store) — list proof; agent cancelled long hello-world for timebox

---

## Session D — Access control (tokens, bind, allowed hosts, no-open)

**Goal:** Slot 5 surfaces. Stop Host between bind experiments.

**Prereqs:** Section 2 env; know how to restart Host.

### D1. `--no-open` and bind defaults

1. - [x] `sf ui --no-open --port 3852` starts without opening a browser
2. - [x] `sf mcp --no-open` → rejected (`--no-open is only valid with sf ui`)
3. - [x] Default bind is loopback: reachable at `http://127.0.0.1:3850`

### D2. Tokens

```bash
export STAGEFLOW_CONTROL_TOKEN="$(python3 -c 'print("c"*32)')"
export STAGEFLOW_READ_TOKEN="$(python3 -c 'print("r"*32)')"
# restart Host with these exported
```

1. - [x] Token shorter than 32 chars → Host refuses / validation error at start
2. - [x] `curl -sS http://127.0.0.1:3850/livez` still works **without** Bearer
3. - [x] `curl -sS http://127.0.0.1:3850/api/health` **without** Bearer → 401 when tokens configured
4. - [x] `curl -sS http://127.0.0.1:3850/api/health -H "Authorization: Bearer $STAGEFLOW_READ_TOKEN"` → 200
5. - [x] Mutating call with read token only → denied; with control token → allowed
  Example ensure:

```bash
curl -sS -X POST http://127.0.0.1:3847/api/projects \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"project_root\":\"$HOME/tmp/sf-consumer-pr64\"}"
```

1. - [x] Named drive token: `STAGEFLOW_CONTROL_TOKEN_CI` → SQLite `caller_id=ci`; **not** isolation

### D3. Non-loopback bind

1. - [x] `sf mcp --host 0.0.0.0` **without** control token → exit `1` (refuse listen)
2. - [x] With `STAGEFLOW_CONTROL_TOKEN` set (≥32) → listens; clients need Bearer for `/api/*`
3. - [x] Optional: `STAGEFLOW_ALLOWED_HOSTS=127.0.0.1,localhost` — mismatched `Host` rejected; loopback OK; `*` rejected as config

### D4. Open access when no tokens

1. - [x] Unset all `STAGEFLOW_*_TOKEN*` and restart → `/api/health` open again on loopback

**If fail:** Auth confusion on `/livez` — remember livez/readyz are not bearer-gated the same way as `/api/health`.

---

## Session E — First real run + operator console HITL

**Goal:** End-to-end agent run + console. Needs provider credentials.

**Prereqs:** `sf providers login` (or console Settings) for your model; prefer `sf ui --no-open` already running so autostart does not steal the port.

1. - [x] `cd ~/tmp/sf-consumer-pr64`
2. - [x] `sf run --pipeline pipelines/hello.pipeline.yaml --task tasks/hello.task.yaml` → exit 0 succeeded
3. - [x] `sf runs list` shows the run; `sf runs show --run <runId>`
4. - [ ] Open `http://127.0.0.1:3847` — run visible; stage detail / transcript / logs load — **SKIP agent** (human console UI)
5. - [ ] Optional richer catalog: from worktree run hello-world (Session C) and inspect envelope in UI — **SKIP agent** (UI)
6. - [ ] HITL (optional, longer): follow `examples/mcp-hitl-tour/README.md` — **SKIP agent** (human HITL browser tour)
7. - [x] `sf run --json --include stages > /tmp/sf-run-pr64.json` and skim JSON contract (`runId`, statuses, stages)

**If fail:** Provider not configured → configure before blaming the PR. Exit `2` → HITL waiting is success for that path. Queued message → capacity (Session G).

---

## Session F — Repository binding / worktrees (needs `GITHUB_TOKEN` / git auth)

**Goal:** Slot 2 — `--repository`/`--ref` vs `--checkout`; Host-owned bare clone + per-run worktree.

**Prereqs:** GitHub auth available to Host stages via declared `secrets:` / askpass; network; Host up.

Path-bound XOR repo-bound:

```bash
# Repo-bound (Host clones to $STAGEFLOW_HOME/repos/… and worktrees/<runId>/)
sf run \
  --pipeline pipelines/hello.pipeline.yaml \
  --task tasks/hello.task.yaml \
  --repository <owner>/<repo> \
  --ref main \
  --json
```

**Known broken — do not use CLI `--checkout`:** absolute (or CLI-resolved absolute) `--checkout` is rejected by Host as `absolute_path_not_allowed`. See [residual finding](residual-review-findings/2026-09-24-cli-checkout-absolute-path-rejected.md).

```bash
# BROKEN — CLI absolutizes then Host refuses absolute paths
sf run \
  --pipeline pipelines/hello.pipeline.yaml \
  --task tasks/hello.task.yaml \
  --checkout /path/to/existing/checkout \
  --json
```

**Working path-bound recipe** — catalog-relative `checkout:` in task YAML under a registered `project_root` (no `--checkout` flag):

```yaml
# tasks/hello.task.yaml
id: hello
goal: Path-bound smoke.
checkout: relative/path/to/checkout
```

```bash
sf run \
  --pipeline pipelines/hello.pipeline.yaml \
  --task tasks/hello.task.yaml \
  --json
```

1. - [x] Repo-bound run succeeds or at least creates worktree — **FAIL** public `octocat/Hello-World` → `repository_auth_failed` without token (F-02); partial `repos/github.com/octocat` only
2. - [x] Bare clone appears under `$STAGEFLOW_HOME/repos/…` — **FAIL** incomplete (auth fail; F-02)
3. - [ ] Two parallel repo-bound runs on same repo are allowed (own worktrees) — not `busy_checkout` — **SKIP** blocked by F-02
4. - [x] Two path-bound runs on **same** task-YAML `checkout:` → second gets `busy_checkout` (not queued). **Skip CLI `--checkout`** (known broken).
5. - [x] Task YAML with both `repository`+`ref` and `checkout` → `task.binding_conflict` (exit 1)
6. - [x] Mark **SKIP** private-repo paths — no GITHUB_TOKEN in agent env; public also failed auth (F-02)

**Secrets note:** Stage may need `secrets: [{ name: GITHUB_TOKEN, … }]` on the pipeline/stage for private repos; Slot 6 will not inherit ambient `GITHUB_TOKEN` unless declared or allowlisted.

---

## Session G — Cancel / delete / GC / queued (capacity)

**Goal:** Slot 3 lifecycle.

**Prereqs:** Host up; ability to start runs (even if they queue).

```bash
export STAGEFLOW_MAX_CONCURRENT_RUNS=1
export STAGEFLOW_MAX_QUEUED=2
# restart Host
```

1. - [x] Start run A (long / agent) so it occupies the single slot
2. - [x] Start run B → `queued` (stderr: `queued at position 1`)
3. - [x] Start run C queued; 4th → `busy_capacity`
4. - [x] `sf runs cancel --run <runId> --reason "qa cancel" --json` → cancelled (queued runs); cancel is terminal
5. - [x] `sf runs list --status cancelled` / `--status queued` filters work
6. - [x] `sf runs delete --run <runId> --json` (use `--force` if required by state)
7. - [x] `sf runs gc --dry-run --json` then `sf runs gc --json`
8. - [x] Optional: `STAGEFLOW_MIN_FREE_DISK_BYTES` absurdly high → `insufficient_disk` (failed, not queued)

Reset concurrency env after this session and restart Host.

---

## Session H — Interrupt / resume / NO_AUTOSTART / SIGTERM

**Goal:** Slot 4 daemon behaviour.

### H1. Autostart disabled

1. - [x] Stop Host completely
2. - [x] `export STAGEFLOW_NO_AUTOSTART=1`
3. - [x] `sf run --pipeline … --task …` → fails with `autostart_disabled` (does not spawn)
4. - [x] Keep `STAGEFLOW_NO_AUTOSTART=1`; start `sf mcp --port 3850` yourself; `sf run` works again

### H2. SIGTERM drain

1. - [x] Start a long-running stage
2. - [x] Send SIGTERM to the Host process (`kill -TERM <pid>`)
3. - [x] Observe drain within grace: stage → `interrupted`; Host exits `0`
4. - [x] `sf runs resume --run <runId> --stage <stageId> --json` resumes same attempt when applicable
5. - [ ] Optional: `STAGEFLOW_AUTO_RESUME_INTERRUPTED=1` — **SKIP** (optional; not exercised)

### H3. Process hygiene

1. - [x] After cancel/SIGTERM, no orphaned stage worker pegging CPU (`ps` / pgrep)

---

## Session I — Stage env + secrets (curated env)

**Goal:** Slot 6 — ambient env does **not** leak into stages.

**Prereqs:** Ability to author a tiny stage with `verify` or a bash step that prints env; Host restarted with known env.

1. - [x] Host started with `LEAK_PROBE=should-not-appear` in process env
2. - [x] Stage/verify → empty / unset without declaration (leak-probe succeeded)
3. - [x] `STAGEFLOW_STAGE_ENV_ALLOW=LEAK_PROBE` → stage sees it (leak-allow succeeded)
4. - [x] Missing → `secret_unavailable`; env-backed `GITHUB_TOKEN`+`as:env` OK; file-backed+`as:env` FAIL (F-04)
5. - [x] Confirm `verify` uses `bash -c` (`[[` syntax in leak-allow)
6. - [ ] Optional stopgap: `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` — **SKIP** optional

See `docs/migration-stage-environment.md`.

---

## Session J — Backup / restore / export / debug-run

**Goal:** Slot 8 data safety. **Host must be DOWN for restore.**

1. - [x] With Host up: `sf backup --json` → archive under `$STAGEFLOW_HOME/backups/`
2. - [x] `sf backup --db-only --out /tmp/sf-pr64-db-only.tgz`
3. - [x] `sf backup --no-credentials --out /tmp/sf-pr64-nocred.tgz`
4. - [x] `sf export --all --out /tmp/sf-pr64-export.json` (no `--json` flag)
5. - [x] `sf export-run --run <runId> --out /tmp/sf-pr64-one.json` (absolute `--out` under `/tmp` OK after realpath normalize)
6. - [x] `sf debug-run <runId> --out ./sf-pr64-debug.json` — writes UTF-8 JSON bundle (not `.tgz`)
7. - [x] **Stop Host**; confirm `/livez` down
8. - [x] `sf restore … --force --json` into throwaway home
9. - [x] Restart Host; prior runs/projects visible as expected
10. - [x] Attempt restore **with Host up** → fails (`restore_host_live`, exit 1)
11. - [x] Never use `cp state.db` as backup — confirmed via docs/pitfalls + backup/restore path used

HTTP equivalents (drive scope): `POST /api/backup`, `GET /api/export`, `POST /api/restore` — optional curl if you want parity.

---

## Session K — Doctor --pipeline / preflight / requires / named tokens (slot 9 polish)

**Goal:** Preflight parity and caller quotas.

1. - [x] `sf doctor --pipeline ~/tmp/sf-consumer-pr64/pipelines/hello.pipeline.yaml`
2. - [x] `sf doctor --pipeline … --strict --json`
3. - [x] `requires:` missing tool → `missing_tool` / doctor fail (`tool:` key not `name:`)
4. - [x] Declared secret missing → `secret_unavailable`
5. - [x] `sf debug-run` produces JSON bundle (manifest / stage_events / stream_log_tails) — not `.tgz`
6. - [ ] Named caller quota (optional): — **SKIP** time; `caller_id=ci` attributed in D2

```yaml
callers:
  ci: { max_concurrent: 1 }
  default: { max_concurrent: 1 }
```

   Use `STAGEFLOW_CONTROL_TOKEN_CI=…` and flood starts → `busy_caller_quota` when over quota / queue full. Remember: **attribution/quota only, not tenancy**.

1. - [x] `sf run-stage …` — **FAIL** with multiple roots: `unknown_project_root` / no CLI `--project-root` (F-06)

---

## Session L — Multi-project / two-folder identity

**Goal:** Two absolute roots stay distinct; global run list spans both.

```bash
mkdir -p ~/tmp/sf-consumer-pr64-b
cd ~/tmp/sf-consumer-pr64-b
sf init
# tweak task goal so you can tell projects apart
```

1. - [x] `sf run` from project A → ensures A
2. - [x] `sf run` from project B → ensures B (after fixing init `io` gap — F-05)
3. - [x] Health `catalog_roots` lists **both** absolute paths (+ worktree)
4. - [x] `sf runs list` shows runs from both; project_root distinct
5. - [ ] Console Start run can select/browse each registered project — **SKIP agent** (console UI)
6. - [x] Starting with wrong/unknown `project_root` → `unknown_project_root`
7. - [x] There is **no** unregister API — `DELETE /api/projects` → 404

---

## Appendix

### Env var cheat sheet


| Var                                                       | Role                                                |
| --------------------------------------------------------- | --------------------------------------------------- |
| `STAGEFLOW_HOME`                                          | Durable root (default `~/.stageflow`)               |
| `TMPDIR`                                                  | Must be writable; boot fails with `tmpdir_unusable` |
| `STAGEFLOW_BIND` / `--host`                               | Listen address (default `127.0.0.1`)                |
| `STAGEFLOW_NO_OPEN` / `--no-open`                         | `sf ui` only                                        |
| `STAGEFLOW_ALLOWED_HOSTS`                                 | Extra Host header allowlist                         |
| `STAGEFLOW_CONTROL_TOKEN` / `_FILE`                       | Drive (≥32); caller `default`                       |
| `STAGEFLOW_CONTROL_TOKEN_<NAME>` / `_FILE`                | Named drive; caller = lowercased `NAME`             |
| `STAGEFLOW_READ_TOKEN` / `_FILE`                          | Read-only                                           |
| `STAGEFLOW_NO_AUTOSTART`                                  | Disable CLI Host spawn → `autostart_disabled`       |
| `STAGEFLOW_AUTOSTART_TIMEOUT_MS`                          | Default `10000`; probe is `/livez`                  |
| `STAGEFLOW_SHUTDOWN_GRACE_MS`                             | Default `8000`                                      |
| `STAGEFLOW_MAX_CONCURRENT_RUNS`                           | Soft active cap → queue                             |
| `STAGEFLOW_MAX_QUEUED`                                    | Default `32`                                        |
| `STAGEFLOW_MIN_FREE_DISK_BYTES`                           | Floor → `insufficient_disk`                         |
| `STAGEFLOW_AUTO_RESUME_INTERRUPTED`                       | Default off                                         |
| `STAGEFLOW_MAX_AUTO_RESUMES`                              | Default `3`                                         |
| `STAGEFLOW_STAGE_ENV_ALLOW`                               | Comma allowlist into curated stage env              |
| `STAGEFLOW_STAGE_ENV_PASSTHROUGH`                         | `all` = deprecated ambient restore                  |
| `STAGEFLOW_ALLOW_NETWORK_STORE`                           | Allow network filesystem for store                  |
| `STAGEFLOW_OPERATOR_CWD` / `STAGEFLOW_OPERATOR_AGENT_DIR` | Set at Host start (not per `sf run`)                |
| `STAGEFLOW_BUILD_SHA`                                     | Provenance in health/backup                         |
| `STAGEFLOW_MCP_STATELESS` / `--mcp-stateless`             | Disable MCP sessions                                |


### Tear down / restore published `sf`

```bash
# stop Host on 3847
npm unlink -g stageflow    # if you used npm link
# or: npm uninstall -g stageflow
npm i -g stageflow@latest  # published
unset STAGEFLOW_HOME TMPDIR STAGEFLOW_CONTROL_TOKEN STAGEFLOW_READ_TOKEN STAGEFLOW_NO_AUTOSTART
# optional: rm -rf ~/tmp/sf-home-pr64 ~/tmp/sf-tmpdir-pr64 ~/tmp/sf-consumer-pr64*
```

### Intentionally NOT in this PR


| Missing                                       | Notes                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Dockerfile / compose / GHCR                   | `docs/docker.md`: not shipped in this slot package                         |
| `unregister_project` / `DELETE /api/projects` | Ensure + list only                                                         |
| MCP tools for backup/restore/export           | Use CLI or HTTP `POST /api/backup`, `GET /api/export`, `POST /api/restore` |
| Operator-console GC button                    | Use `sf runs gc`                                                           |


### Suggested pass/fail summary


| Session                       | Pass | Fail | Skip | Notes |
| ----------------------------- | ---- | ---- | ---- | ----- |
| A Smoke                       | 9    | 0    | 0    | doctor fail only if cwd=worktree `.mcp.json` (F-10) |
| B Project registration        | 7    | 0    | 1    | B7 N/A loopback |
| C Catalog / paths             | 7    | 0    | 0    | hello-world list proof; cancelled for time |
| D Access control              | 13   | 0    | 0    | port 3850 |
| E Real run + HITL             | 4    | 0    | 3    | E4–E6 human UI/HITL |
| F Repository / worktrees      | 2    | 2    | 2    | F-02 public auth; F3 skip; path busy_checkout OK |
| G Cancel / GC / queue         | 8    | 0    | 0    | |
| H Interrupt / autostart       | 8    | 0    | 1    | H2.5 auto-resume optional skip |
| I Curated env / secrets       | 5    | 1    | 1    | file+as:env fail F-04; I6 skip |
| J Backup / restore / export   | 11   | 0    | 0    | debug-run writes JSON |
| K Doctor / preflight / polish | 5    | 1    | 1    | run-stage multi-root F-06; K6 skip |
| L Multi-project identity      | 6    | 0    | 1    | L5 UI skip; init io gap F-05 |


**Overall:** agent-alone ~10/12 sessions pass with residual P1s · Blockers for human: E4–E6 UI/HITL, B7 remote ensure if available, install B/C/D parity, teardown · See `docs/residual-review-findings/2026-09-24-agent-qa-batch-findings.md`