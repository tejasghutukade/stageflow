---
status: implementation-brief
slot: 5
---

# Slot 5 — The Host can be bound anywhere, safely

## For the agent picking this up

**Stageflow** is a Node/TypeScript runtime for configurable multi-stage AI agent workflows. Users
author pipelines in YAML (`*.pipeline.yaml`, `*.task.yaml`); each stage runs in a fresh agent
session, and stages hand off to each other through typed envelopes and artifacts. The CLI is `sf`.

Three facts about the architecture matter for this slot:

1. **There is one HTTP host, on one port.** `sf ui` and `sf mcp` both call `createHttpHost`
   (`src/server/createHttpHost.ts`), which serves three surfaces on port `3847`: the operator REST
   API (`/api/*`), the MCP endpoint (`/mcp`), and — when configured — A2A
   (`/a2a`, `/.well-known/agent-card.json`). `sf ui` additionally serves the console's static
   files; `sf mcp` is the same thing headless. Both mount the **full** REST API.
2. **Run state lives in SQLite** under `~/.stageflow/`, outside any checkout.
3. **Stages are forked Node child processes** running a "Pi" coding agent that has a `bash` tool.
   A stage can run arbitrary shell. Today those children inherit the Host's entire `process.env`
   (`src/runtime/stageProcessLauncher.ts:208-212`) — provider API keys, and any `GITHUB_TOKEN`.

Stageflow is being containerized. The work is split into nine shipping slots; see
[`../pre-container-work.md`](../pre-container-work.md) for the full plan and build order. **This is
slot 5.** Slot 5 is the one that makes the Host reachable from outside the machine it runs on, and
therefore the one that has to put a lock on the door at the same moment it opens it.

You do not need to read the plan doc to do this work. Everything you need is below, and every
claim about current behaviour has been re-verified in this worktree with a file:line citation.

---

## Mission

Make it possible to run `sf ui` or `sf mcp` bound to an address other than `127.0.0.1` — and make
that configuration safe by construction rather than by accident. Concretely: a bind flag and env
var, a browser-suppression flag, an allowed-hosts resolver that replaces the hardcoded loopback
checks, a shared bearer control token with two scopes covering `/mcp` and every `/api/*` route, a
startup refusal when the bind is non-loopback and no token is set, finite HTTP server timeouts,
and a console that hands out the MCP URL you actually reached it on.

---

## The hard rule: open the door and fit the lock in one commit

**5.3 (allowed hosts) and 5.4 (control token) must land in the same commit. Never ship 5.3 alone.**

The reason is a specific, complete remote-code-execution chain, not a general principle:

1. Today `/mcp` is guarded by `localhostHostValidation()` and `localhostOriginValidation()`
   (`src/server/createHttpHost.ts:64-65`, applied at `:78-81`). Those two calls are the **only
   authentication `/mcp` has**. There is no token check, no session, no allow-list, nothing else.
2. MCP `start_run` accepts an **inline pipeline definition** — a whole pipeline authored in the
   tool call, with no file on disk and no catalog entry (`src/mcp/catalogTools.ts:54-69`, tool
   description at `:186`).
3. A pipeline stage runs an agent with a `bash` tool, and a stage's `verify` / completion `command`
   is executed through `spawn(command, { shell: true })`
   (`src/runtime/completionCheckRunner.ts:195-199`) — a second shell path that does not even
   require the agent to cooperate.
4. That child process is forked with `env: { ...process.env, ... }`
   (`src/runtime/stageProcessLauncher.ts:208-212`), so the shell it runs sees every secret the
   Host holds: provider API keys, a `GITHUB_TOKEN` if one is present, and — once 5.4 exists — the
   control token itself.

So: **relax the Host/Origin gate without adding the token and you have published an unauthenticated
endpoint on which any caller can compose a pipeline whose stages run arbitrary shell commands with
your credentials in their environment.** Not "weakened auth" — no auth.

Two consequences for how you work:

- Do not open a PR containing the allowed-hosts resolver without the bearer check. If you need to
  stage the work, build 5.4 **first** (a token check on a loopback-only server is harmless and
  fully testable), then 5.3 on top.
- The refuse-to-start check in 5.4 is the backstop for the same chain reached a different way
  (someone sets `STAGEFLOW_BIND=0.0.0.0` and forgets the token). Treat it as load-bearing, not as
  a nicety.

Note also gap 4 below: **every `GET /api/*` is already unauthenticated and not even loopback-gated
today.** Binding `0.0.0.0` with no other change publishes every run's stage transcripts, every
artifact's bytes, and provider auth status to anything that can reach the port. Extending the gate
to reads is part of this slot for that reason.

---

## Why this matters

- `docker run -p 3847:3847` against today's build publishes a port that nothing is listening on
  from outside the container's loopback namespace. The bind is the first blocker; everything else
  in the container story is downstream of it.
- Even with the bind fixed, a remote host name, a LAN name, a Tailscale name, or a reverse proxy
  all get `403` from `/mcp` with no diagnosable message, because the Host header will not be
  `localhost`. An SSH tunnel is the only remote path that works today, and it works by accident of
  the Host header rather than by design.
- The security model today is *"the gate happens to be loopback-only."* After this slot it is
  *"there is an allow-list and a token, and the unsafe combination cannot start."*

---

## Dependencies

| | |
|---|---|
| **Blocked by** | Nothing. This slot can be built against `main` as it stands. |
| **Blocks** | The Dockerfile (it sets `STAGEFLOW_BIND=0.0.0.0` and `STAGEFLOW_NO_OPEN=1`), and any remote-harness story. |
| **Adjacent, do not absorb** | Slot 6 removes wholesale `process.env` inheritance for stage workers — that is what stops the control token leaking into stage `bash`. Slot 6 depends on the token existing but you do not need to wait for it. Slot 7 splits health into `/livez` / `/readyz` / `/api/health`. Slot 8 writes the reverse-proxy and TLS deployment docs. Slot 9 replaces the single shared token with per-caller named tokens and run attribution. |

---

## Verified current state

Every line below was read in this worktree.

### Confirmed absent

A planning document once claimed some of this already existed. It does not:

| Thing | Status |
|---|---|
| `src/server/listenHost.ts` | **Does not exist.** No such file. |
| `STAGEFLOW_BIND` | **Does not exist** anywhere in `src/`, `ui/`, or tests. |
| `STAGEFLOW_NO_OPEN` | **Does not exist.** |
| `STAGEFLOW_CONTROL_TOKEN` | **Does not exist.** |
| `STAGEFLOW_ALLOWED_HOSTS` | **Does not exist.** |
| Any CORS header, WebSocket, or REST SSE endpoint | None. MCP session mode uses `GET /mcp` as its own SSE channel. |

You are writing all of this from scratch.

### Bind and CLI

| Fact | Evidence |
|---|---|
| Default port is `3847` | `DEFAULT_PORT`, `src/server/createHttpHost.ts:16` |
| `startUiServer` hardcodes the default bind | `const host = options.host ?? "127.0.0.1";` — `src/server/http.ts:840` |
| `startMcpServer` hardcodes the same default | `src/server/mcpHost.ts:35` |
| `host` exists as a *programmatic* option only | `UiServerOptions.host` (`src/server/http.ts:66`), `McpServerOptions.host` (`src/server/mcpHost.ts:25`). Library callers can set it; the CLI never does. |
| The CLI parses **only** `--port` (plus `--mcp-stateless`) | `src/cli.ts:167-175`. The whole flag loop is 20 lines; there is no `--host` branch. |
| Usage text confirms it | `sf ui [--port 3847] [--mcp-stateless]` / `sf mcp [--port 3847] [--mcp-stateless]` — `src/cli.ts:57-58` |
| `sf ui` passes no `host` to the server | `src/cli.ts:402-409` |
| `sf mcp` passes no `host` to the server | `src/cli.ts:421-428` |
| The advertised URL is built from the bind string verbatim | `` const url = `http://${host}:${boundPort}` `` — `src/server/createHttpHost.ts:120`, and `mcpUrl` at `:126`. Bind `0.0.0.0` and the CLI prints `http://0.0.0.0:3847`. |
| `openBrowser` is defined and called unconditionally | defined `src/cli.ts:297-306` (`open` / `cmd /c start` / `xdg-open`), called at **`src/cli.ts:412`** with no guard of any kind. In a slim image `xdg-open` is not installed and this spawn fails on every start. |
| `sf mcp` never calls `openBrowser` | `src/cli.ts:417-432` — it is already browser-free, which is why it is the better container entrypoint. |
| `hostBaseUrl()` hardcodes loopback | ``return `http://127.0.0.1:${resolveServicePort()}`;`` — `src/server/ensureGlobalService.ts:52-54` |
| The autostart probe hits `/api/health` with no credentials | `src/server/ensureGlobalService.ts:62` — **this is why `/api/health` must stay reachable in this slot; see 5.4.** |

### The `/mcp` gate

```64:81:src/server/createHttpHost.ts
  const validateMcpHost = localhostHostValidation();
  const validateMcpOrigin = localhostOriginValidation();
  // ...
    if (pathname === "/mcp") {
      if (!validateMcpHost(req, res) || !validateMcpOrigin(req, res)) {
        return;
      }
```

Both validators come from `@modelcontextprotocol/node` and are constructed with no arguments, so
there is no allow-list to widen and no override. `/mcp` is dispatched **after** A2A
(`src/server/createHttpHost.ts:72-76`) and before the operator routes.

### The REST gate

- `isMutatingApi(method, pathname)` — `src/server/http.ts:143-164`. **First line is
  `if (method !== "POST") return false;`.** It then matches an explicit allow-list of literal paths
  and regexes. This is fail-*open*: a route not in the list is ungated, so the next person to add a
  route gets no gate by default.
- `isCredentialMutatingApi` — `src/server/http.ts:166-174`. Provider login/logout only.
- `assertCredentialMutatingOrigin` — `src/server/http.ts:176-197`. Requires a **non-empty**
  loopback `Origin`; `403 {"error":"Origin required"}` / `403 {"error":"Forbidden origin"}`.
- `hostnameFromHostHeader` — `src/server/http.ts:199-209`. Strips `[...]` brackets and a numeric
  port. Correct; reuse it.
- `isLoopbackHostname` — `src/server/http.ts:211-214`. `localhost` | `127.0.0.1` | `::1`, lowercased.
  Note it does **not** cover the rest of `127.0.0.0/8`.
- `assertLoopbackHttpAccess` — `src/server/http.ts:216-244`. Requires a present `Host` header whose
  hostname is loopback (`403 {"error":"Forbidden host"}`); if `Origin` is present it must also be
  loopback, but an **absent** `Origin` is allowed.
- Where the gate is applied: `src/server/http.ts:277-287`, at the top of the returned route handler,
  inside `if (isMutatingApi(...))`. Nothing outside that `if` is gated.

### Full route table and its current gate

This is the thing to work from. "Gate" is what runs *today*, before your change.

| Method | Route | Current gate | Source |
|---|---|---|---|
| any | `/mcp` | `localhostHostValidation()` + `localhostOriginValidation()` | `createHttpHost.ts:78-81` |
| GET | `/api/a2a/status` | **none** (dispatched before the operator routes) | `createHttpHost.ts:72-75` |
| POST | `/a2a` (JSON-RPC) | A2A bearer token, per caller | `a2a/server.ts:274-363`, `a2a/registry.ts:114-119` |
| GET | `/.well-known/agent-card.json` | A2A bearer token | `a2a/server.ts:321` |
| GET | `/a2a/contracts/*` | A2A bearer token | `a2a/server.ts:324` |
| GET | `/a2a/artifacts/*` | A2A bearer token | `a2a/server.ts:291-297` |
| GET | `/api/runs` | **none** | `http.ts:290` |
| GET | `/api/runs/:runId` (full detail, embeds stage event transcripts) | **none** | `http.ts:339-349` |
| GET | `/api/runs/:runId/artifact?path=` (raw artifact **bytes**) | **none** | `http.ts:295-322` |
| GET | `/api/runs/:runId/stages/:stageId/verification` (captured stdout/stderr) | **none** | `http.ts:324-337` |
| GET | `/api/tasks` | **none** | `http.ts:630` |
| GET | `/api/pipelines` | **none** | `http.ts:636` |
| GET | `/api/stages` (always 404) | **none** | `http.ts:642` |
| GET | `/api/models` | **none** | `http.ts:709` |
| GET | `/api/skills` | **none** | `http.ts:735` |
| GET | `/api/extensions` | **none** | `http.ts:740` |
| GET | `/api/health` | **none** | `http.ts:745` |
| GET | `/api/settings` | **none** | `http.ts:750` |
| GET | `/api/providers` | **none** | `providerRoutes.ts:47` |
| GET | `/api/providers/detect` | **none** | `providerRoutes.ts:37` |
| GET | `/api/providers/:id/auth` | **none** | `providerRoutes.ts:58` |
| GET | `/api/providers/:id/login/:sessionId` | **none** | `providerRoutes.ts:125` |
| GET | `/api/project-mcp` | **none** | `projectMcpRoutes.ts:34` |
| GET | static console files (`sf ui` only) | **none** | `http.ts:815-822` |
| POST | `/api/runs` | loopback Host/Origin | `http.ts:146`, `:352` |
| POST | `/api/runs/:runId/rerun` | loopback Host/Origin | `http.ts:150`, `:425` |
| POST | `/api/runs/:runId/stages/:stageId/answer` | loopback Host/Origin | `http.ts:151`, `:439` |
| POST | `…/feedback-decision` | loopback Host/Origin | `http.ts:152`, `:464` |
| POST | `…/retry` | loopback Host/Origin | `http.ts:153`, `:521` |
| POST | `…/resume` | loopback Host/Origin | `http.ts:154`, `:541` |
| POST | `…/recovery` | loopback Host/Origin | `http.ts:155`, `:561` |
| POST | `…/recovery/stop` | loopback Host/Origin | `http.ts:156`, `:595` |
| POST | `…/abandon` | loopback Host/Origin | `http.ts:157`, `:611` |
| POST | `/api/stages` | loopback Host/Origin | `http.ts:148`, `:649` |
| POST | `/api/pipelines` | loopback Host/Origin | `http.ts:149`, `:679` |
| POST | `/api/settings` | loopback Host/Origin | `http.ts:147`, `:760` |
| POST | `/api/providers/:id/login` | loopback Host/Origin **+ non-empty loopback `Origin`** | `http.ts:158`, `:166-197` |
| POST | `/api/providers/:id/login/:sid/answer` | same, plus strict Origin | `http.ts:159` |
| POST | `/api/providers/:id/login/:sid/cancel` | same, plus strict Origin | `http.ts:160` |
| POST | `/api/providers/:id/logout` | same, plus strict Origin | `http.ts:161` |
| POST | `/api/project-mcp/:name/probe` | loopback Host/Origin | `http.ts:162`, `projectMcpRoutes.ts:40` |

### A2A — the pattern to reuse

A2A is the only surface already designed for off-box callers, and it already does what 5.4 needs:

```114:119:src/a2a/registry.ts
  authenticate(authorization: string | undefined): string | undefined {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) return undefined;
    const hash = digest(match[1]);
    return this.credentials.find((credential) => timingSafeEqual(credential.hash, hash))?.id;
  }
```

- `digest` is `createHash("sha256").update(value).digest()` (`src/a2a/registry.ts:45-47`). Hashing
  both sides first means `timingSafeEqual` always compares two 32-byte buffers, so it never throws
  on a length mismatch and never leaks token length. **Copy this shape exactly.**
- Token validation at load: `if (!token || /\s/.test(token) || token.length < 32) throw new Error(…)`
  — `src/a2a/registry.ts:152-156`. Minimum 32 characters, no whitespace.
- A2A is bearer-authenticated and deliberately **not** loopback-gated, which is why it is dispatched
  first in `createHttpHost`. Leave A2A alone in this slot.

### HTTP server hardening (10.11)

```106:106:src/server/createHttpHost.ts
  server.requestTimeout = 0;
```

- `requestTimeout = 0` disables the timeout entirely. No `headersTimeout` override, no
  `maxConnections`, and no persistent `error` handler on the server.
- The only `server.on("error", …)` is the **one-shot reject inside the listen promise**
  (`src/server/createHttpHost.ts:113-114`). After `listen` resolves, a later runtime `error` event
  has no listener, and an `error` event with no listener on an `EventEmitter` throws — taking the
  process down.

### The console's MCP URL

```1:25:ui/src/mcpConnect.ts
export const DEFAULT_MCP_URL = "http://127.0.0.1:3847/mcp";
// ...
  const loopback =
    location.hostname === "127.0.0.1" ||
    location.hostname === "localhost" ||
    location.hostname === "[::1]";
  if (!loopback) return DEFAULT_MCP_URL;
```

Reach the console at `http://build-box:3847`, open Settings → MCP, and it hands you
`http://127.0.0.1:3847/mcp` — an address pointing at your own laptop. The port is hardcoded too, so
even a loopback host on a non-default port gets the wrong answer from the fallback branch.

The console's REST calls all go through one wrapper, `api<T>()` at `ui/src/api/client.ts:34-46`,
which is the single place to attach an `Authorization` header.

---

## The work

### 5.1 — Bind resolution

**Today.** `startUiServer` and `startMcpServer` each default `host` to the string `"127.0.0.1"`
(`src/server/http.ts:840`, `src/server/mcpHost.ts:35`). The CLI never supplies one
(`src/cli.ts:402-409`, `:421-428`), so there is no way to change it without importing the library.

**Target.** One resolver, used by both commands:

```
sf ui  [--host <addr>] [--port <n>] [--no-open] [--mcp-stateless]
sf mcp [--host <addr>] [--port <n>] [--mcp-stateless]
```

Precedence: `--host` flag > `STAGEFLOW_BIND` env > `127.0.0.1`.

**Design decisions already made:**

- **New module `src/server/listenHost.ts`**, exporting `resolveListenHost({ flag, env })` and
  `advertisedHost(bind)`. One place, because `sf ui`, `sf mcp`, the refuse-to-start check, and the
  advertised-URL logic all need the same answer, and a second copy will drift.
- **Accept:** an IPv4 literal, an IPv6 literal (with or without brackets), and the two
  wildcard forms `0.0.0.0` and `::`. **Reject** hostnames, empty strings, anything with a port or a
  scheme, and anything else — a DNS name here is almost always a mistake, and resolving one at
  startup makes the bind non-deterministic. Validate with `node:net`'s `isIP()`, which returns `0`
  for non-IP input, rather than hand-rolling a regex.
- **Reject at startup, before `listen`,** with a message naming the flag, the env var, and the
  offending value. Failing on a bad bind at boot beats an `EADDRNOTAVAIL` from deep inside Node.
- **Sanitise the advertised URL, do not change the bind.** `advertisedHost("0.0.0.0")` returns
  `"127.0.0.1"`; `advertisedHost("::")` returns `"[::1]"`; anything else is returned as-is, with
  IPv6 literals bracketed. This affects only the `url` and `mcpUrl` fields built at
  `src/server/createHttpHost.ts:120,126` and the two `console.log` lines at `src/cli.ts:410-411`
  and `:429` — a printed link the user can actually click.
- **`0.0.0.0` remains a legal bind.** It is what the container image will set. It is simply never
  advertised verbatim.
- **Do not touch `hostBaseUrl()`** in `src/server/ensureGlobalService.ts:52-54`. That function is
  the local CLI talking to a local Host over loopback; it is correct as loopback and should stay
  that way. Add a comment saying so if it helps the next reader.

**Files likely to touch:** `src/server/listenHost.ts` (new), `src/cli.ts` (`parseArgs`, both
command blocks, `USAGE`), `src/server/http.ts` (`startUiServer`), `src/server/mcpHost.ts`,
`src/server/createHttpHost.ts` (advertised URL only).

### 5.2 — `--no-open` and `STAGEFLOW_NO_OPEN`

**Today.** `openBrowser(url)` is called unconditionally at `src/cli.ts:412`, right after the two
`console.log` lines. On Linux it spawns `xdg-open`, which does not exist in a slim image; the spawn
fails on every start.

**Target.** Suppress the browser when `--no-open` is passed or `STAGEFLOW_NO_OPEN` is set to a
truthy value. Flag wins; env is the fallback.

**Design decisions already made:**

- **`sf mcp` is the recommended container entrypoint** precisely because it never opens a browser
  (`src/cli.ts:417-432`). Say so in `docs/cli-reference.md`. `--no-open` exists so that `sf ui`
  is *usable* headless, not so that it becomes the default headless entrypoint.
- **`--no-open` is accepted only by `sf ui`.** Adding it to `sf mcp` implies `sf mcp` might
  otherwise open a browser, which is a lie.
- **Truthiness:** treat `STAGEFLOW_NO_OPEN` as set-means-on for any value other than `""` and `"0"`.
  Do not invent a parser; match whatever the repo already does for boolean env vars if a precedent
  exists, otherwise keep it to those two exceptions.
- **The spawn should not be able to kill the Host either way.** `openBrowser` currently has no
  error handling; the `spawn` object it builds will emit `error` on `ENOENT`. Attach a no-op
  `.on("error", …)` while you are in there — one line, and it removes the crash path that
  `--no-open` is otherwise the only defence against.

**Files likely to touch:** `src/cli.ts`.

### 5.3 — Allowed hosts (**same commit as 5.4**)

**Today.** Three separate hardcoded loopback checks: the two MCP SDK validators
(`src/server/createHttpHost.ts:64-65`), `assertLoopbackHttpAccess`
(`src/server/http.ts:216-244`), and `assertCredentialMutatingOrigin` (`:176-197`). None has an
override. The REST gate runs only for POSTs on an explicit allow-list (`isMutatingApi`,
`src/server/http.ts:143-164`), so every GET in the route table above is completely ungated.

**Target.** One resolver, `STAGEFLOW_ALLOWED_HOSTS`, defaulting to loopback, used by every gate.

**Design decisions already made:**

- **Still validate `Host`. Never provide a "skip the check" mode.** The Host header check is the
  DNS-rebinding defence: without it, a page on `evil.example` can resolve its own name to
  `127.0.0.1` and drive a browser into the Host. An allow-list widens the set of acceptable names;
  it never removes the comparison.
- **Format:** comma-separated hostnames and/or IP literals, optionally with a port
  (`build-box:3847,sf.example.com`). A bare name matches any port. Case-insensitive. Reject `*` —
  a wildcard is indistinguishable from no check, and the refuse-to-start rule in 5.4 exists so that
  nobody needs one.
- **Loopback is always allowed**, and is the entire list when the env var is unset. Setting the
  variable *adds* names; it never removes loopback, because the console, `ensureGlobalService`, and
  `docker exec … sf run` all reach the Host over loopback from inside the same box.
- **Replace the MCP SDK validators with our own resolver** rather than trying to configure them.
  `localhostHostValidation()` / `localhostOriginValidation()` are constructed with no arguments and
  there is nothing to widen; keeping them alongside a resolver would mean two sources of truth.
  Reuse `hostnameFromHostHeader` (`src/server/http.ts:199-209`) for parsing.
- **Origin handling keeps today's asymmetry.** An absent `Origin` stays allowed on ordinary routes
  (non-browser clients do not send one); a present `Origin` must be in the allow-list. Provider
  login/logout keeps its stricter rule — `Origin` **required** and in the allow-list — because
  those routes write credentials.
- **Extend the gate to reads, and make it fail-closed.** Replace the POST-only `isMutatingApi`
  allow-list with a check that applies to every `/api/*` request regardless of method, keeping
  `isMutatingApi` (or a renamed successor) only for the *scope* decision in 5.4. A route added
  tomorrow must be gated by default.
- **`/api/a2a/status` is served before the operator routes** (`src/server/createHttpHost.ts:72-75`),
  so the gate has to move up into `createHttpHost` or that route has to move down. It discloses a
  filesystem config path; treat it as a gated read.
- **Static console files stay ungated.** You cannot authenticate the page that is going to ask the
  user for the token. They are not `/api/*`.
- **Status codes:** keep `403` with the existing bodies — `{"error":"Forbidden host"}` and
  `{"error":"Forbidden origin"}` — so existing clients and tests do not need to relearn anything.
  Consider adding the rejected hostname to the message; it is the single most useful diagnostic for
  "why does my reverse proxy get a 403."

**Files likely to touch:** `src/server/allowedHosts.ts` (new), `src/server/createHttpHost.ts`,
`src/server/http.ts`, `src/server/providerRoutes.ts` and `src/server/projectMcpRoutes.ts` (only if
you choose to gate inside them rather than upstream — prefer upstream).

### 5.4 — Control token, scopes, and refuse-to-start (**same commit as 5.3**)

**Today.** There is no authentication on `/mcp` or on any `/api/*` route. The A2A surface is the
only authenticated one, and it is entirely separate.

**Target.**

| Env var | Grants | Notes |
|---|---|---|
| `STAGEFLOW_CONTROL_TOKEN` | `drive` (implies `read`) | The main token. |
| `STAGEFLOW_CONTROL_TOKEN_FILE` | `drive` | Reads the token from a file; trailing newline trimmed. |
| `STAGEFLOW_READ_TOKEN` | `read` only | Optional. A dashboard or status poller that must not start runs. |
| `STAGEFLOW_READ_TOKEN_FILE` | `read` | Same file semantics. |

Presented as `Authorization: Bearer <token>` on every request.

**Scope mapping:**

| Surface | Required scope |
|---|---|
| `GET /api/*` (all reads in the route table) | `read` |
| `POST /api/*` (all mutations in the route table) | `drive` |
| `/mcp`, any method | `drive` |
| `GET /api/health` | **none — stays open in this slot** |
| `/a2a*`, `/.well-known/agent-card.json` | unchanged: A2A's own per-caller tokens |
| static console files | none |

**Design decisions already made:**

- **`/mcp` requires `drive`, wholesale.** The MCP endpoint carries read tools and `start_run` over
  the same JSON-RPC POST body; separating them means parsing the body to decide authorization,
  which is both fragile and a new attack surface. A `read`-scoped token gets `403` on `/mcp`.
- **`/api/health` is the one open route in this slot, and only because
  `probeGlobalServiceDetailed` calls it with no credentials** (`src/server/ensureGlobalService.ts:62`)
  to decide whether to autostart a Host. Gating it here would break `sf run` on every machine.
  Slot 7 splits health into an open `/livez`, an open `/readyz`, and a token-gated rich
  `/api/health`; **do not build `/livez` in this slot** — just leave a comment at
  `src/server/http.ts:745` recording why the exemption exists and that slot 7 removes it.
- **Reuse A2A's validation verbatim:** minimum 32 characters, no whitespace, rejected at startup
  with a clear error (`src/a2a/registry.ts:152-156`).
- **Reuse A2A's comparison verbatim:** sha256-digest both sides, then `timingSafeEqual` on the two
  fixed-length buffers (`src/a2a/registry.ts:45-47`, `:114-119`). Do not write `===`. Do not call
  `timingSafeEqual` on raw token buffers of differing length — it throws.
- **Hash once at startup, not per request.** Store the digests; never keep the plaintext token in
  a field that could end up in a log line, a health payload, or an error message.
- **`_FILE` wins over the plain variable when both are set**, and setting both is a startup error
  rather than a silent preference — compose and Kubernetes deliver secrets as files, and a
  half-migrated config should be loud.
- **`401` for missing or malformed credentials, `403` for a valid token with insufficient scope.**
  Send `WWW-Authenticate: Bearer` on the `401`. Body shape matches the rest of the API:
  `{"error":"..."}`.
- **Auth runs after the host/origin gate, not before.** A request from a disallowed host should
  never get to test tokens.
- **When no token is configured at all and the bind is loopback, every route behaves exactly as it
  does today.** Local `sf ui` must not start demanding a token. The token is opt-in on loopback and
  mandatory off it.
- **The console must learn to send the token.** With reads gated, a console served over a
  non-loopback bind cannot load anything until it has one. Add a token field to the console
  (persisted in `localStorage`), and attach `Authorization` in the single `api<T>()` wrapper at
  `ui/src/api/client.ts:34-46`. Audit for any request that bypasses that wrapper — artifact URLs
  used directly as `src`/`href` attributes cannot carry a header and need a different answer
  (a short-lived query-string grant, or leaving artifact bytes on the loopback-only path).
- **Refuse to start** when the resolved bind is non-loopback and no `drive` token is configured.
  Check this in the same place bind resolution happens, **before `server.listen`**, in both `sf ui`
  and `sf mcp`. Exit non-zero.

**The exact error message.** Print this to stderr verbatim:

```
Refusing to start: Stageflow is configured to bind 0.0.0.0, which is reachable from outside this
machine, but no control token is set.

Anyone who can reach this port could start a pipeline run, and pipeline stages execute arbitrary
shell commands with this process's environment — including provider API keys.

Set one of:
  STAGEFLOW_CONTROL_TOKEN=<at least 32 characters>
  STAGEFLOW_CONTROL_TOKEN_FILE=/path/to/secret

Or bind to loopback instead:
  --host 127.0.0.1   (or unset STAGEFLOW_BIND)
```

Substitute the actual resolved bind for `0.0.0.0`. Do not soften this into a warning, and do not
add a `--i-know-what-im-doing` flag: the unsafe configuration has no legitimate use that a token
does not also satisfy.

**Files likely to touch:** `src/server/controlToken.ts` (new), `src/server/createHttpHost.ts`,
`src/server/http.ts`, `src/cli.ts`, `ui/src/api/client.ts`, plus a console settings surface under
`ui/src/pages/` or `ui/src/components/`.

### 10.11 rider — Request timeout, connection cap, error handler

**Today.** `server.requestTimeout = 0` (`src/server/createHttpHost.ts:106`) — no timeout at all. No
`maxConnections`. The only `error` listener is the one-shot reject inside the listen promise
(`:113-114`), so a runtime `error` after startup has no handler and will throw out of the
`EventEmitter`.

**Target.** Finite timeouts, a bounded connection count, and an `error` listener that survives
startup.

**Design decisions already made:**

- **Set `server.requestTimeout` to a finite value** — 60 s is a reasonable default; make it
  overridable via `STAGEFLOW_REQUEST_TIMEOUT_MS`. Node's `requestTimeout` bounds *receiving the
  entire request* and responds `408` when it expires; it does **not** bound how long a response may
  stream. A long-lived MCP SSE response is therefore not at risk from this setting.
- **The MCP exemption that actually matters is the socket-level one.** `server.timeout` (idle
  socket) defaults to `0` in modern Node — **leave it at `0`**. If you find you need it, exempt the
  MCP route explicitly with `res.setTimeout(0)` inside the `/mcp` branch at
  `src/server/createHttpHost.ts:78`. Whichever you choose, prove it with a test that holds an MCP
  session open past the timeout and asserts it is still alive; this is the one item in the slot
  where the documented behaviour and the observed behaviour are worth checking against each other.
- **Set `server.maxConnections`** to a finite default (256 is ample for an operator console plus a
  handful of MCP clients) with an env override. Unbounded connections on a port that is now
  publishable is a trivial resource exhaustion.
- **Attach the persistent error handler after `listen` resolves**, so it does not compete with the
  one-shot reject. Log and continue; do not exit on a per-connection error.

**Files likely to touch:** `src/server/createHttpHost.ts`.

### 10.11 rider — The console hands out the wrong MCP URL

**Today.** `mcpEndpointUrl` returns the hardcoded `DEFAULT_MCP_URL`
(`http://127.0.0.1:3847/mcp`) for any non-loopback origin (`ui/src/mcpConnect.ts:1`, `:14-18`).
A user who reached the console at `http://build-box:3847` is handed an address that points at their
own laptop — and if anything is listening there, at the wrong Stageflow.

**Target.** Derive the MCP URL from `window.location` for **every** origin, not just loopback.

**Design decisions already made:**

- **Derive from `window.location` unconditionally.** The console is served by the same server that
  serves `/mcp`, on the same origin, so `${location.protocol}//${location.host}/mcp` is correct by
  construction — including port, including HTTPS behind a proxy.
- **Keep the `localhost` / `[::1]` → `127.0.0.1` normalisation** that exists today
  (`ui/src/mcpConnect.ts:19-22`). MCP clients are happier with the literal, and it costs nothing.
- **Keep `DEFAULT_MCP_URL` for the `viteDev` branch only** (`ui/src/mcpConnect.ts:13`) — in dev the
  page is served by Vite on a different port than the API, so deriving from `location` is wrong
  there and only there.
- **Have the server inject its advertised origin** as the authoritative answer where it can. The
  `advertisedHost()` helper from 5.1 already computes it. A `window.location`-derived value is
  correct for every case a browser can actually reach, so treat injection as the belt to that
  braces rather than a blocker — if it adds a new server-render path, skip it and say so.
- **`mcpConnect.ts` has an existing test file** (`ui/src/mcpConnect.test.ts`) that passes a
  `LocationLike`. Extend it; do not rewrite the signature.

**Files likely to touch:** `ui/src/mcpConnect.ts`, `ui/src/mcpConnect.test.ts`.

---

## Out of scope

- **No user accounts, no RBAC, no SSO, no OAuth resource-server behaviour.** A single shared bearer
  with two scopes is a deliberate and proportionate choice for a self-hosted single-operator tool.
  Anything more is surface area with no current user.
- **No per-caller named tokens, no `caller_id` on runs, no per-caller quotas.** That is slot 9, and
  it is where the "one shared token means `list_runs` can't tell anyone apart" problem gets solved.
- **No reverse-proxy, TLS, or deployment documentation.** Slot 8. This slot must not add a TLS
  listener; terminating TLS is the proxy's job.
- **No `/livez` or `/readyz`, and no change to what `/api/health` returns.** Slot 7.
- **No curated stage-worker environment.** Slot 6. It matters — until it lands, the control token
  you add here is visible to every stage's `bash` — but it is a different change set with a
  different blast radius, and coupling them makes both harder to review.
- **No changes to A2A.** Its auth is already correct for its purpose.
- **No CORS headers.** Nothing currently needs cross-origin access, and adding CORS to an endpoint
  that runs shell commands deserves its own decision.
- **No Dockerfile.** It comes after all nine slots.

---

## Acceptance criteria

**Bind (5.1)**

1. `sf ui --host 0.0.0.0` and `sf mcp --host 0.0.0.0` both listen on all interfaces.
2. `STAGEFLOW_BIND=0.0.0.0 sf mcp` does the same; an explicit `--host 127.0.0.1` overrides it.
3. With neither set, both commands bind `127.0.0.1` exactly as they do today.
4. `sf ui --host not-an-address` exits non-zero before listening, with a message naming `--host`,
   `STAGEFLOW_BIND`, and the rejected value.
5. Bound to `0.0.0.0`, the printed console and MCP URLs say `127.0.0.1`, not `0.0.0.0`.
   Bound to `::`, they say `[::1]`.

**Browser (5.2)**

6. `sf ui --no-open` and `STAGEFLOW_NO_OPEN=1 sf ui` start without spawning a browser.
7. Without either, `sf ui` opens a browser as it does today.
8. A failing browser spawn does not crash or fail the Host.

**Allowed hosts (5.3)**

9. Default configuration: a request to `/mcp` or any `/api/*` route with `Host: evil.example` gets
   `403 {"error":"Forbidden host"}`.
10. With `STAGEFLOW_ALLOWED_HOSTS=build-box:3847`, the same request with `Host: build-box:3847`
    passes the host gate; `Host: other-box:3847` still gets `403`.
11. Loopback is accepted whether or not `STAGEFLOW_ALLOWED_HOSTS` is set.
12. `STAGEFLOW_ALLOWED_HOSTS=*` is rejected at startup.
13. **`GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/artifact`, and every other GET in the
    route table are now gated** — a disallowed `Host` gets `403` on reads, not just on POSTs.
14. Provider login/logout still require a present `Origin`, and that `Origin` must now be in the
    allow-list.

**Control token (5.4)**

15. With no token configured and a loopback bind, every route behaves exactly as before — no `401`
    anywhere, and the existing test suite passes unchanged except where it asserts the new gates.
16. With `STAGEFLOW_CONTROL_TOKEN` set: `GET /api/runs` with no `Authorization` returns `401` and a
    `WWW-Authenticate: Bearer` header; with the correct bearer it returns `200`.
17. `POST /api/runs` and `/mcp` both require the `drive` scope; a `STAGEFLOW_READ_TOKEN` bearer gets
    `403` on both and `200` on `GET /api/runs`.
18. `GET /api/health` answers `200` with no credentials in every configuration, and
    `ensureGlobalService`'s autostart path still works.
19. A token shorter than 32 characters, or containing whitespace, is rejected at startup.
20. Setting both `STAGEFLOW_CONTROL_TOKEN` and `STAGEFLOW_CONTROL_TOKEN_FILE` is a startup error.
21. `STAGEFLOW_BIND=0.0.0.0` with no `drive` token exits non-zero with the verbatim message above
    and never calls `listen`.
22. `STAGEFLOW_BIND=0.0.0.0` **with** a valid token starts normally.
23. The token value appears in no log line, no error message, and no health payload.
24. The operator console, served from a non-loopback bind with a token configured, can be given the
    token and then loads and drives runs normally.

**Server hardening (10.11)**

25. `server.requestTimeout` is finite; a client that opens a connection and dribbles a request body
    is cut off with `408`.
26. An MCP session held open past the request timeout stays alive and keeps receiving events.
27. `server.maxConnections` is finite.
28. A runtime `error` event on the server after startup is logged and does not terminate the
    process.

**Console MCP URL (10.11)**

29. `mcpEndpointUrl({ hostname: "build-box", port: "3847", protocol: "http:" })` returns
    `http://build-box:3847/mcp`.
30. `mcpEndpointUrl({ hostname: "sf.example.com", port: "", protocol: "https:" })` returns
    `https://sf.example.com/mcp`.
31. Loopback and `viteDev` behaviour is unchanged.

---

## Testing

Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing. All three must pass.

Existing files to extend rather than replace:

| File | What to add |
|---|---|
| `tests/server.createHttpHost.test.ts` | Host/Origin allow-list on `/mcp`, bearer + scope on `/mcp`, request timeout, `maxConnections`, persistent error handler |
| `tests/server.http.test.ts` | The read gate across the route table, scope mapping for GET vs POST, `401` vs `403`, the `/api/health` exemption |
| `tests/server.ensureGlobalService.test.ts` | Autostart still works with a token configured on the Host |
| `tests/a2a.server.test.ts` | Regression only: A2A's own auth is untouched and still dispatches before the MCP gate |
| `ui/src/mcpConnect.test.ts` | The non-loopback cases in acceptance criteria 29–31 |

New test files worth adding: `tests/server.listenHost.test.ts` (parse and advertise), and
`tests/server.controlToken.test.ts` (validation, `_FILE`, scope resolution, refuse-to-start).

Table-drive the route gating. A test that walks the full route table from **Verified current state**
and asserts the expected scope for each entry is the one test that will catch the next ungated route
somebody adds — which is exactly the failure mode that produced gap R4 in the first place.

For manual verification, the honest end-to-end check is not a unit test: build the CLI, start
`STAGEFLOW_BIND=0.0.0.0 STAGEFLOW_CONTROL_TOKEN=<32+ chars> sf mcp` on one machine, point a coding
agent's MCP client at `http://<that-machine>:3847/mcp` with the bearer configured from a second
machine on the same network, and confirm `get_health` succeeds with the token and `401`s without it.
Then drop the token from the command and confirm the Host refuses to start.

---

## Repo conventions

Read [`AGENTS.md`](../../../AGENTS.md) at the repo root first. The parts that bear on this slot:

- **Minimal, focused diffs.** Match the patterns in the file you are editing. Do not refactor
  surrounding code that your change does not require — for example, do not restructure
  `createOperatorRoutes` because you are adding a gate to it.
- **No comments unless the logic is non-obvious.** The `/api/health` exemption and the
  `requestTimeout`-vs-socket-timeout distinction are two places where a comment genuinely earns its
  place; most of the rest of this work does not need any.
- **JSON output and exit codes are a public contract** — see `docs/ci.md` and `tests/cli.*.test.ts`.
  A new non-zero exit path (refuse-to-start) belongs in that contract; document it.
- **Never commit secrets or `.env` files.** Test tokens go in the test file as obvious literals.
- **Docs to update in the same change:** `docs/cli-reference.md` (the new `--host` and `--no-open`
  flags, and the note that `sf mcp` is the better headless entrypoint) and `docs/mcp.md` (the
  bearer header, the two scopes, and the allowed-hosts requirement for remote clients). Public docs
  are indexed at `docs/README.md`.
- **Positioning:** user-facing copy leads with configurable stages and pipelines. Do not frame
  Stageflow as an SDLC-only tool.

---

## Open questions for the human

1. **Is a separate `STAGEFLOW_READ_TOKEN` wanted now, or should `read` wait for slot 9's named
   tokens?** Two env vars is the cheapest way to get two scopes, but slot 9 replaces the whole
   scheme with per-caller tokens. Shipping `read` now costs a few lines and one extra concept in
   the docs; deferring it means the only token anyone has is a `drive` token. **Default if nobody
   answers: ship both, since the plan calls for two scopes.**
2. **Artifact bytes and `Authorization`.** `GET /api/runs/:id/artifact` returns raw bytes with a
   media type (`src/server/http.ts:295-322`) and the console may reference it directly from an
   `<img>` or download link, which cannot carry a header. Acceptable answers: keep artifact reads on
   the loopback-only path for now, add a short-lived signed query grant, or have the console fetch
   the bytes and build a blob URL. This needs a decision before the console work is finished.
3. **Should `STAGEFLOW_ALLOWED_HOSTS` accept a trusted-proxy mode that reads `X-Forwarded-Host`?**
   Slot 8 documents the reverse-proxy deployment, and a proxy that rewrites `Host` makes the
   allow-list trivial. Recommendation: **no** for this slot — never trust a forwarding header
   without an explicit trusted-proxy configuration, and that configuration belongs with the
   deployment docs.
4. **Exit code for refuse-to-start.** Every CLI failure path currently returns `1`
   (`src/cli.ts:447-450`). Slot 4 proposes publishing a defined exit-code table. Should
   refuse-to-start claim a distinct code now, or return `1` and get a specific code when that table
   is written?
5. **Does `isLoopbackHostname` need to cover the rest of `127.0.0.0/8`?** Today it matches only
   `localhost`, `127.0.0.1`, and `::1` (`src/server/http.ts:211-214`). `127.0.0.2` is loopback and
   is currently treated as remote. Probably harmless, possibly surprising; worth a decision while
   the file is open.
