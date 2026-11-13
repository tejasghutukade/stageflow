---
layout: default
title: Functions API
---

# Functions API

The console, the HTTP API and the MCP tools all write functions through one service, so every path applies the same validation, revision and conflict checks. This page lists the REST routes, the request and response shapes, and the errors. The MCP tools are in the [MCP guide](mcp.md#function-tools). For what a function is, start at [Functions](functions.md).

Every `/api/*` request needs `Authorization: Bearer <token>` unless the Host was started with `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1` (see [Docker](docker.md)). Bodies are JSON, at most 256 KiB.

By default a request works on the Host's own project. Add `?project_root=<path>` to work on another registered project. A write needs a project root the Host is allowed to write to.

## Routes

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/functions` | List every function |
| `POST /api/functions` | Create a function |
| `GET /api/functions/<id>` | One function with its current revision |
| `PUT /api/functions/<id>` | Save a new revision |
| `DELETE /api/functions/<id>` | Delete a function nothing references |
| `POST /api/functions/<id>/duplicate` | Copy to a new id |
| `POST /api/functions/<id>/test` | Run the function in the sandbox |
| `GET /api/functions/<id>/revisions` | List its revisions |
| `GET /api/functions/<id>/revisions/<n>` | One stored revision |
| `GET /api/functions/<id>/invocations` | Recent tests and calls |

Any other method on one of these paths is `405` with `{ "code": "function.method_not_allowed" }`.

## List

```bash
curl -s -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" http://127.0.0.1:3847/api/functions
```

```json
{
  "functions": [
    {
      "id": "report_gate",
      "name": "Report gate",
      "description": "Accepts report.json when its score meets MIN_SCORE.",
      "kind": "verification",
      "revision": 2,
      "issues": [],
      "updatedAt": "2026-11-13T09:12:44.103Z"
    }
  ]
}
```

A function whose file is invalid still appears. Its `issues` say why, and `kind` and `name` may be `null`. The list is ordered by id.

## Create

```bash
curl -s -X POST http://127.0.0.1:3847/api/functions \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "definition": {
      "id": "report_gate",
      "name": "Report gate",
      "kind": "verification",
      "source": "export const access = { artifacts: \"read\", env: [\"MIN_SCORE\"], network: [] };\nexport default async function execute(context) {\n  const report = await context.artifacts.readJson(\"report.json\");\n  return { passed: report.score >= Number(context.env.MIN_SCORE) };\n}\n"
    }
  }'
```

`definition` has the fields in the [YAML catalog](yaml-catalog.md#functions). `format` is optional and is `"yaml"` (the default), `"yml"` or `"js"`. When the source declares `access`, leave out `capabilities` and `bindings`. If you send them they must match what the declaration derives, or the request fails with `function.access_conflict`.

The reply is `201` with the new function:

```json
{
  "id": "report_gate",
  "name": "Report gate",
  "description": null,
  "kind": "verification",
  "revision": 1,
  "createdAt": "2026-11-13T09:10:02.118Z",
  "updatedAt": "2026-11-13T09:10:02.118Z",
  "issues": [],
  "definition": { "id": "report_gate", "kind": "verification", "capabilities": [ ... ], "bindings": [ ... ], "...": "..." },
  "yaml": "id: report_gate\n...",
  "sourceHash": "a77c6d28…",
  "contractVersion": 1,
  "path": "functions/report_gate.function.yaml",
  "format": "yaml"
}
```

`definition.capabilities` and `definition.bindings` are always present. When the source declares access they are the derived lists, the ones a grant has to match.

## Save

```bash
curl -s -X PUT http://127.0.0.1:3847/api/functions/report_gate \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" -H "Content-Type: application/json" \
  -d '{ "baseRevision": 1, "summary": "Require a numeric score", "definition": { ... } }'
```

`baseRevision` is required and must be the revision you read. `summary` is optional text, at most 200 characters, stored with the revision. `definition` replaces the whole definition. The `id` and the `kind` cannot change (`function.id_immutable`, `function.kind_immutable`). Saving a definition that parses to the same content as the current one creates no new revision. The reply is the saved function.

If another save landed first, the reply is `409 function.conflict` with `current_revision`, and nothing is overwritten. Read the function again and merge.

## Duplicate

```bash
curl -s -X POST http://127.0.0.1:3847/api/functions/report_gate/duplicate \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" -H "Content-Type: application/json" \
  -d '{ "id": "report_gate_strict" }'
```

The copy has its own revision history. `format` is optional. Attachments are not copied: a new attachment of the copy still has to grant its access.

## Delete

`DELETE /api/functions/<id>` returns `{ "deleted": true }`. While a pipeline, reusable stage or agent references the function it returns `409 function.in_use` with `usages`: a list of `{ kind, path }`. Detach it from those first. If a catalog cannot be read, the delete is refused (`function.catalog_unreadable`) rather than guessed.

## Test

```bash
curl -s -X POST http://127.0.0.1:3847/api/functions/report_gate/test \
  -H "Authorization: Bearer $STAGEFLOW_CONTROL_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "input": { "envelope": { "payload": { "score": 82 } } },
    "mocks": {
      "files": [{ "root": "artifacts", "path": "report.json", "text": "{\"score\": 82}" }],
      "env": { "MIN_SCORE": "70" }
    }
  }'
```

| Field | Meaning |
|-------|---------|
| `input` | The whole `context` the function receives. A tool needs `{ "input": { ... } }`, a routing function `{ "envelope": ..., "children": [...] }` |
| `source` | Run this code instead of the saved source. Nothing is saved |
| `mocks.files` | Files to place in the test's artifacts or workspace: `{ root, path, text }` |
| `mocks.env` | Environment values for the names the function declares |
| `real` | `true` reads real files, uses real environment values and makes real API calls. Default `false`. Agents and evals cannot use it |
| `timeoutMs`, `memoryLimitBytes` | Optional overrides for this one run |

The reply is `200`, even when the function ran and failed:

```json
{
  "ok": true,
  "value": { "passed": true, "message": "Score accepted" },
  "logs": "",
  "durationMs": 14,
  "sourceHash": "a77c6d28…",
  "revision": 2,
  "kind": "test",
  "status": "succeeded"
}
```

When it failed, `ok` is `false` and `code` and `message` say why (see the [result codes](functions.md#result-codes)). `status` is `succeeded`, `failed` or `uncertain`. `revision` is `null` when you tested unsaved `source`. A `503 function.store_unavailable` means the Host has no function store.

## Revisions and invocations

`GET /api/functions/<id>/revisions` returns `{ "revisions": [ ... ] }`, oldest first, each with `revision`, `source` (`console`, `file` or `api`), `author`, `summary`, `sourceHash`, `contractVersion` and `createdAt`. `GET /api/functions/<id>/revisions/<n>` returns that revision with its full definition and YAML. A revision that does not exist is `404 function.revision_not_found`.

`GET /api/functions/<id>/invocations` returns `{ "invocations": [ ... ] }`, newest first. Each row has `id`, `revision`, `sourceHash`, `kind` (`test`, `verification`, `route` or `tool`), `status`, `durationMs`, `code` and `createdAt`. Inputs and results are not stored.

## Errors

A refused request returns the HTTP status below with a JSON body:

```json
{ "code": "function.invalid", "message": "Function definition is invalid", "issues": [ { "path": "source", "code": "function.invalid_access", "message": "…", "line": 3, "column": 12 } ] }
```

`message`, `issues`, `current_revision` and `usages` appear only when they apply. An issue has a `path`, a `code` and a `message`, and `line` and `column` when the problem is in the source.

| Status | `code` | When |
|--------|--------|------|
| 400 | `function.invalid` | A malformed path. A `project_root` the Host does not accept is a `400` with the catalog path error instead |
| 404 | `function.not_found`, `function.revision_not_found` | No such function or revision |
| 405 | `function.method_not_allowed` | The path exists but not for that method |
| 409 | `function.exists` | Create with an id that is taken |
| 409 | `function.conflict` | Save with a stale `baseRevision`. Carries `current_revision` |
| 409 | `function.in_use` | Delete while referenced. Carries `usages` |
| 409 | `function.catalog_unreadable` | A catalog could not be read, so references could not be checked |
| 422 | `function.invalid` | The body or the definition is invalid. Carries `issues` |
| 422 | `function.id_immutable`, `function.kind_immutable` | A save tried to change the id or the kind |
| 503 | `function.store_unavailable` | The Host has no function store |

Common `issues[].code` values:

| Code | Meaning |
|------|---------|
| `function.invalid_id`, `function.invalid_name`, `function.invalid_kind`, `function.invalid_timeout` | A field is missing or out of range |
| `function.invalid_source` | The source is not a module that exports a default `execute`, does not parse, or is over 64 KiB |
| `function.invalid_access` | The `access` block is not the first statement or not a plain literal. Carries `line` and `column` |
| `function.access_conflict` | Explicit `capabilities` or `bindings` differ from the `access` block |
| `function.invalid_capability`, `function.duplicate_capability`, `function.invalid_origin`, `function.invalid_methods` | A capability is malformed |
| `function.write_not_allowed`, `function.action_not_allowed` | A verification or routing function asked for a file write or an API action |
| `function.invalid_binding`, `function.unknown_binding`, `function.duplicate_binding` | A binding is malformed or names no env capability |
| `function.invalid_tool_name`, `function.invalid_tool_description`, `function.schema`, `function.schema_depth`, `function.tool_fields` | A tool's name, description or schema is wrong, or tool fields sit on another kind |
| `function.format_conflict`, `function.id_conflict`, `function.id_mismatch` | The id exists in two files, or the file name and the `id` disagree |

Findings that `sf validate` raises against an attachment (`function.missing`, `function.kind_mismatch`, `function.under_granted`, `function.grant_not_requested`, `function.routing_requires_route`, `function.routing_conflicts_with_if`) are described in the [CLI reference](cli-reference.md) and the [YAML catalog](yaml-catalog.md#functions).
