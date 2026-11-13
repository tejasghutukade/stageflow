---
layout: default
title: Functions
---

# Functions

A **function** is a small piece of JavaScript that lives in your project and that a stage or an agent can call. It runs in a sealed sandbox with no files, environment or network of its own. You write the logic. You list what it may touch, and the Host enforces that list.

Use a function when a rule is easier to write as code than as a prompt: "accept the report only if `score` is at least the bound threshold", "pick the next stage from the envelope", "write this note into the run's artifacts". A function returns the same answer for the same input, runs in milliseconds, and costs no model tokens.

This page explains what a function is and how to write, attach, test and debug one. Related pages:

- [Create your first function](guides-functions-first-function.md): a start-to-finish walkthrough.
- [Functions in the console](console-functions.md): the screens.
- [Functions API](function-api.md): REST routes, MCP tools and error shapes.
- [YAML catalog: Functions](yaml-catalog.md#functions): every field and the access declaration.

## The three kinds

A function has one **kind**, fixed when you create it. The kind decides where you can attach it and what it must return.

| Kind | What it does | Where you attach it | It must return |
|------|--------------|---------------------|----------------|
| `verification` | Checks what a stage produced and says whether it passes | A `verify` check on a stage (`type: function`) | `{ passed, message?, details? }` |
| `routing` | Picks which stages run next | The pipeline stage entry that owns `route` (`function:`) | `{ nextStageIds, reason? }` |
| `tool` | Gives a stage or an agent something it can call, with JSON in and JSON out | `tools.functions` on a stage or an agent | Any JSON value (checked against `output_schema` when you set one) |

A function is not a stage and does not call a model. A `command` check in `verify` is a separate mechanism and cannot be reached from a function.

## A first look

```yaml
# functions/report_gate.function.yaml
id: report_gate
name: Report gate
description: Accepts report.json when its score meets MIN_SCORE.
kind: verification
source: |
  export const access = {
    artifacts: "read",
    env: ["MIN_SCORE"],
    network: [],
  };
  export default async function execute(context) {
    const report = await context.artifacts.readJson("report.json");
    const threshold = Number(context.env.MIN_SCORE);
    const passed = report.score >= threshold;
    return { passed, message: passed ? "Score accepted" : "Score below threshold" };
  }
```

The `access` block at the top says what the function needs. `execute` is the code. Nothing else about the function's permissions is stored anywhere.

## Files and formats

A function is one file under the project's `functions/` folder. The file name is the id: `functions/report_gate.function.yaml` has `id: report_gate`. An id is lowercase letters, digits and `_`, starting with a letter, at most 64 characters. The id and the kind cannot change after you create the function.

You can author it in three on-disk forms. They are equivalent:

| File | Metadata | Code |
|------|----------|------|
| `<id>.function.yaml` or `<id>.function.yml` | YAML fields | The `source` field, a multiline string |
| `<id>.function.js` | YAML frontmatter between `---` lines | The rest of the file, as plain JavaScript |

```js
// functions/score_check.function.js
---
id: score_check
name: Score check
kind: verification
---
export const access = { artifacts: "read", env: ["MIN_SCORE"], network: [] };

export default async function execute(context) {
  const report = await context.artifacts.readJson("report.json");
  return { passed: report.score >= Number(context.env.MIN_SCORE) };
}
```

Use the `.js` form when the code is longer than the metadata. Editing an existing function keeps its format. If the same id exists in two formats, neither runs until you delete one (`function.format_conflict`).

Write function files from the [Functions page](console-functions.md), the [HTTP API or MCP tools](function-api.md), or by hand in an editor. The catalog file writer refuses them (`use_function_api`) so every write goes through the same checks.

Every other field (name, description, `timeout_ms`, and for tools `tool_name`, `tool_description`, `input_schema`, `output_schema`) is in the [YAML catalog](yaml-catalog.md#functions).

## Writing the code

A function is an ES module with one default export, `execute`, plain or `async`:

```js
export default async function execute(context) {
  return { passed: true };
}
```

The module is parsed when you save, not run, so a syntax error is reported before anything depends on it. The sandbox is plain JavaScript (the QuickJS engine). There is no `require`, no `import` of other modules or packages, no `process`, no `fetch`, no `setTimeout`. You can define helper functions in the same file. Return a JSON-serializable value: `undefined`, `NaN`, `BigInt`, functions and class instances are rejected rather than silently converted.

### What `context` holds

The Host fills `context` for you. It is a copy, so changing it cannot affect the pipeline.

| Field | Verification | Routing | Tool |
|-------|--------------|---------|------|
| `kind` | `"verification"` | `"routing"` | `"tool"` |
| `envelope` | The success envelope being checked (`payload`, `status`, …) | The verified success envelope | `null` |
| `children` | absent | The stages that may run next: `{ id, name }` | absent |
| `input` | `{}` | absent | The arguments the model passed, validated against `input_schema` |
| `execution` | `functionId`, `revision`, `checkId`, `phase`, `runId`, `stageId`, `attempt` | absent | `functionId`, `revision` and the run, stage, session and tool-call ids that apply |
| `env` | The environment values you listed in `access` | same | same |
| `artifacts`, `workspace`, `files` | File helpers, only for what you listed | same | same, with `write` when you asked for it |
| `http` | `request(...)`, only for origins you listed | same | same |
| `log(...)` | Bounded diagnostic logging | same | same |
| `signal` | `{ aborted }` cancellation flag | same | same |

### Files

`context.artifacts` is the current attempt's artifacts folder. `context.workspace` is the checked-out workspace. Each has the same six calls, with paths relative to that root:

| Call | Returns |
|------|---------|
| `exists(path)` | `true` or `false` |
| `stat(path)` | `{ size, file, directory }` |
| `readText(path)` | The file as a string (at most 1 MiB) |
| `readJson(path)` | The parsed JSON |
| `list(path = "")` | The immediate children as `{ name, type: "file" \| "directory", size }`, sorted by name. At most 1000 entries. Sensitive paths and symlinks that leave the root are left out |
| `write(path, content)` | `true`. Tool functions only. The write is atomic |

`context.files` offers the same calls with the root as the first argument (`context.files.readJson("artifacts", "report.json")`).

A path never grants access by itself. Absolute paths, `..`, symlinks that escape the root, device files and Stageflow's own credential and configuration stores are refused. A function with workspace write access can never create or replace an agent definition (`agents/**/*.agent.yaml`) or a function definition (`functions/**/*.function.*`).

### Environment

`context.env.NAME` holds the value of the Host environment variable `NAME`, for each name you listed in `access.env`. A required name that is missing stops the call before your code runs (`missing_binding`). An optional name (`"NAME?"`) is simply absent. Values you can read here are non-secret configuration. A provider token, a GitHub token, the control token or any value held in the secret store is never copied in.

### Network

A function cannot call `fetch`. To reach an API it asks the Host:

```js
const response = await context.http.request({
  method: "GET",
  origin: "https://api.example.com",
  path: "/v1/status",
});
// response is { status: 200, body: "..." }
```

The Host allows the request only if it matches an origin, method and path prefix you listed in `access.network`. The destination must be public https. The Host refuses loopback, private, link-local and cloud-metadata addresses, checks again after every redirect (at most 3), and never sends a credential to a new host. A request or response body is limited to 1 MiB. If you list a credential reference, the Host adds the stored credential to the request. Your code never sees the secret.

A read-only origin allows `GET`. An origin with `effect: "action"` (tools only) can change something on the other side, so the Host treats a failure after the request was sent as `uncertain_outcome`, not as a plain failure.

### What to return

**Verification.** Return an object with exactly `passed` (boolean) and, optionally, `message` (string) and `details` (any JSON). Any other field makes the check error with `invalid_output`. `passed: false` fails the check. You can run a check when the stage emits, after it finishes, or both (`when`).

```js
return { passed: false, message: "Score 61 is below 70", details: { score: 61, threshold: 70 } };
```

**Routing.** Return `{ nextStageIds, reason? }`. `nextStageIds` may only hold ids from `context.children`, each at most once. An empty list is allowed and means no next stage. An unknown or repeated id fails the routing. Edge `if` conditions still apply first: a stage whose `if` does not fire is not in `children`.

```js
const match = context.children.find((child) => child.id === lane);
return match ? { nextStageIds: [match.id], reason: "Selected " + match.id } : { nextStageIds: [], reason: "No match" };
```

**Tool.** Return any JSON. If the tool has an `output_schema`, the result must match it. The model sees the JSON as the tool result.

## Access: what a function may touch

A function starts with nothing. Anything it needs is declared, then granted.

1. **Declare it in the code.** The first statement of the source is `export const access = { ... }`:

   ```js
   export const access = {
     artifacts: "read",                     // "none" | "read" | "write" (write: tools only)
     workspace: "none",                     // the whole workspace; leave "none" unless needed
     files: [{ root: "workspace", path: "docs", access: "read" }],  // a narrower, path-scoped grant
     env: ["MIN_SCORE", "REGION?"],         // "?" marks a name optional
     network: ["https://api.example.com"],  // read-only; or { origin, effect, methods, path, credential }
   };
   ```

   The Host reads this as data and never runs it. Only whitespace and comments may come before it, and every value must be a plain literal. The full grammar and defaults are in [Access declaration](yaml-catalog.md#function-access). A function without an `access` block can list explicit `capabilities` and `bindings` instead.

2. **Grant it where you attach it.** Each stage or agent that attaches the function must grant every capability the function asks for. The grant repeats the capability id and the details (root and path, or origin and methods). The console fills this in for you after one click on **Allow**. By hand, copy the ids from the function's Access summary or from `sf validate`'s message.

3. **The Host enforces the intersection.** The effective permission is what the function declares, what the attachment grants, and what Host policy allows. A function cannot widen its own access, and a stage's other permissions never flow into a function.

When you change a function's access, existing attachments are not updated for you. They keep the grants they had until you grant the new access: `sf validate` reports `function.under_granted`, and the console shows **Access changed** with a **Review** button on the attachment.

Only tools can write files or call an API action. A verification or routing function that asks for either is rejected when you save.

## Attaching a function

**A verification check** goes on the stage body:

```yaml
stages:
  - id: write-report
    verify:
      - id: score-accepted
        type: function
        function: report_gate
        grants:
          - id: file_artifacts_report_json
            root: artifacts
            path: report.json
          - id: env_min_score
```

**A routing function** goes on the pipeline stage entry that owns `route`, beside it:

```yaml
stages:
  - id: decide
    function:
      id: lane_pick
      grants:
        - id: env_default_lane
    route:
      - to: ship
      - to: hold
```

**A tool** goes under `tools.functions` on a stage body or on an agent:

```yaml
tools:
  functions:
    - id: note_writer
      grants:
        - id: artifacts
          root: artifacts
          path: ""
        - id: env_note_label
```

The model calls a tool by its `tool_name`. Stages on the Claude and Cursor backends cannot call function tools, because the model would see a prefixed name. A stage that attaches one fails preflight with that reason.

Run `sf validate --pipeline <file>` before a run. It reports a missing function (`function.missing`), a function of the wrong kind (`function.kind_mismatch`), a capability with no grant (`function.under_granted`), a grant for something the function does not ask for (`function.grant_not_requested`), and a function defined twice or under the wrong id (`function.format_conflict`, `function.id_conflict`, `function.id_mismatch`). Details: [CLI reference](cli-reference.md).

## Revisions and runs

Every save creates a numbered, immutable **revision** of the whole definition: code, schemas, access and settings. Saving needs the revision you started from (`baseRevision`). If someone else saved first you get a conflict (`function.conflict`) and nothing is overwritten.

A run or an agent session captures the revision of each function it uses when it starts and keeps that revision through retries, resumes and restarts. Editing a function later affects new runs only. A resumed run never silently picks up newer code. If a function file is invalid on disk, new runs that use it are blocked. They do not fall back to the last good revision.

You cannot delete a function while a pipeline, reusable stage or agent still references it. The delete shows where it is used.

## Testing a function

Test before anything depends on it, from the console's Test panel, `POST /api/functions/<id>/test`, or the MCP `test_function` tool. A test runs the same sandbox, the same access checks and the same limits as a real call. It shows the value your function returned as is. The shape rules for its kind (`passed` being a boolean, `nextStageIds` holding only eligible ids, a tool result matching `output_schema`) are applied when a stage or an agent uses the result, so check the shape yourself in a test.

- **Mocks by default.** A test uses mock files, mock environment values and no network. A function that reads a file or a required variable fails with `missing_fixture` or `missing_binding` until the test supplies one. Through the API, pass `mocks: { files: [{ root, path, text }], env: { NAME: "value" } }`.
- **Real resources are opt-in, for one run.** `real: true` (the console's "Use real files, environment, and APIs" switch) reads the real artifacts and workspace, uses real environment values and makes real API calls, including any action you granted. It is off every time and is never remembered. Agents and evals cannot use it.
- **The sample is the whole `context`.** What you enter becomes `context`, so a tool test needs `{ "input": { ... } }`, a routing test needs `{ "envelope": { "payload": { ... } }, "children": [{ "id": "ship" }] }`, and a verification test needs `{ "envelope": { "payload": { ... } } }`.
- **Test unsaved code.** The console and the API accept `source` to run code you have not saved. Nothing is stored as a revision.

A test returns `{ ok, value?, code?, message?, logs, durationMs, revision, status }`. A function that ran and failed is a normal response with `ok: false`, not an HTTP error.

## History

Each test and each real call by a stage, a routing step or a tool is recorded with its kind (`test`, `verification`, `route`, `tool`), status (`succeeded`, `failed`, `uncertain`), result code, duration and the revision it ran. History is on the function's page and at `GET /api/functions/<id>/invocations`. Logs are scrubbed of secrets before they are stored or shown.

`uncertain` means the function may have changed something outside Stageflow before it stopped, so the Host does not retry it for you.

## Limits

| Limit | Value |
|-------|-------|
| Wall-clock time per call | 5 s by default, set with `timeout_ms` from 1 ms to 30 s |
| Source size | 64 KiB |
| Input or result JSON | 256 KiB |
| File read, file write, HTTP request or response body | 1 MiB |
| Entries from one `list` | 1000 |
| Log output | 16 KiB |
| Interpreter memory | 16 MiB by default, 64 MiB at most |
| HTTP redirects followed | 3 |
| Calls running at once on a Host | 4, with up to 16 waiting. A full queue returns `resource_limit` |
| Tool schemas | Root is an object, at most 8 levels deep, at most 64 properties per object |

A call that runs too long is killed. A function that loops forever cannot hold the Host.

## Result codes

A call that does not succeed carries one of these `code` values:

| Code | Meaning |
|------|---------|
| `syntax` | The source does not parse |
| `invalid_export` | There is no default export named `execute`, or it is not a function |
| `exception` | The code threw. The message is the error text |
| `invalid_input` | A tool's arguments do not match `input_schema` |
| `invalid_output` | The result is not JSON, has the wrong shape for its kind, or does not match `output_schema` |
| `missing_binding` | A required environment name has no value |
| `missing_fixture` | A test without `real` read a file that the test did not supply as a mock |
| `permission_denied` | The code asked for a file, variable or origin it was not granted |
| `not_found` | In a real run, a file it was allowed to read does not exist |
| `timeout`, `cancelled`, `killed` | The call ran too long, was cancelled, or was stopped |
| `memory`, `stack`, `resource_limit`, `job_limit` | A budget was exceeded, or the queue was full |
| `source_limit`, `input_limit`, `output_limit`, `file_limit` | A size limit was exceeded |
| `uncertain_outcome` | An action may have happened but the call did not finish cleanly |
| `duplicate` | A call with the same invocation id is already running |

Findings on a definition (shown on the page, in `sf validate`, and in API errors) use `function.*` codes. They are listed in [YAML catalog](yaml-catalog.md#functions) and in [Functions API](function-api.md#errors).

## Troubleshooting

| You see | Likely cause | What to do |
|---------|--------------|------------|
| `function.under_granted` in `sf validate`, or **Access changed** in the console | The function now asks for access the attachment does not grant | Open the attachment and choose **Review**, then **Allow**. By hand, add the grant it names |
| `function.grant_not_requested` | The attachment grants something the function no longer asks for | Remove that grant, or add the access back to the `access` block |
| `permission_denied` in a run | The code touched a file, variable or origin outside its `access` block | Add it to `access` and grant it on the attachment, or fix the path |
| `missing_binding` | A required variable is not set in the Host's environment | Set it where the Host starts (for Docker, `-e NAME=value`), or mark it optional with `"NAME?"` |
| `invalid_output` on a check | The result has a field other than `passed`, `message`, `details`, or `passed` is not a boolean | Return exactly the shape for the kind |
| A test passes alone and fails in a stage | The test used mocks. The stage reads the real artifacts | Re-run the test with `real` on, or give the mock the real file's shape |
| `function.access_conflict` | A file or request has explicit `capabilities` that differ from the `access` block | Delete `capabilities` and `bindings`, or make them match |
| `function.invalid_access` with a line and column | The `access` block is not a plain literal or is not the first statement | Move it to the top and use only strings, arrays, objects, `true`, `false`, `null`, numbers |
| `function.format_conflict` or `function.id_conflict` | The same id exists in two files | Delete one file |
| A stage fails preflight naming a prefixed tool | A Claude or Cursor stage attached a function tool | Use a Pi stage, or call the function from a verification or routing check |
| A test with mock files fails with `permission_denied` in Docker | `TMPDIR` is inside `STAGEFLOW_HOME`, as in the shipped Compose file, so the mock folder looks sensitive | Set `TMPDIR` outside the data directory |

## Security model

- **Nothing by default.** A function has no files, environment, network, `process` or module loading. Everything it can reach is listed in its `access` block and granted on the attachment.
- **The Host decides.** File paths are resolved and checked by the Host, not by the code. API destinations and credentials are checked by the Host on every request. The code cannot change its own grants or the reserved `context` keys.
- **Secrets stay out of code.** Credentials are added by the Host to a request. `context.env` never holds provider tokens, GitHub tokens or the control token, and logs are scrubbed.
- **Calls are bounded.** Every call has a time, memory, size and concurrency limit and runs in its own process that the Host can kill.
- **A function is not an operating-system boundary.** It runs as your user in a separate process, with the interpreter and the Host checks as the boundary. Run the whole Host in a container (see [Docker](docker.md)) when functions or stages handle untrusted input.

## Known limits

- Stages on the Claude and Cursor backends cannot call function tools.
- Pipeline, task and stage files are not protected from a tool with workspace write access, only agent and function definitions are.
- The console Test panel does not send mock files or environment values. Use the API for those.
- `list` inside a stage that runs in a container is covered by tests with a fake container filesystem, not yet by a real one.
