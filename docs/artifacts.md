# Artifacts

An **artifact** is a published, indexed output with an owner and a stable id. A **run file** is any file in a stage attempt's `artifacts/` folder. A run file becomes an artifact only when it is indexed.

This page covers the index and publishing static artifacts through the Host. Live artifacts are not part of this yet.

## What gets indexed

When a stage attempt finishes with a **success** envelope, Stageflow indexes each path in that envelope's `artifacts` list:

- Origin is `indexed`.
- Kind is inferred from the file extension (Markdown, image, table, HTML, or text).
- Title is the file name. When one stage attempt lists two files with the same name, the title includes the parent folder.
- Owner is the pipeline and the stage.
- Source is the run, stage and attempt.
- The file stays in the run workspace. It is not copied.
- `content_hash` is the sha256 of the file. A file larger than 64 MiB is still indexed, with `content_hash` null.

The artifact id is stable for a relative path. It is a readable slug of that path (the extension stays, so `report.md` and `report.csv` differ), cut short so the id fits `^[a-z][a-z0-9_-]{0,63}$`, plus `_` and 8 hex characters of sha256 of the normalised path. The suffix is always present, so `a/b.md` and `a-b.md` do not share an id. A name that does not start with a letter uses the prefix `artifact`. Ids never contain `::`.

Indexing one attempt replaces that attempt's indexed rows. Paths that are no longer listed are removed. A failure envelope, or a success envelope with an empty list, clears that attempt's indexed rows. A later successful attempt of the same stage and run updates the same owner and id and drops indexed rows from earlier attempts of that stage whose ids it did not list. A rewrite of an older attempt does not replace a newer attempt's row. Rows with origin `published` are left in place.

A stage that lists no artifacts leaves no indexed rows for that attempt. A failure envelope does not add rows.

The envelope `artifacts` list is still a list of strings. Indexing does not change that contract, CI JSON, or exit codes.

## What is not indexed

These are never indexed, even when they sit next to a declared file:

- Paths under `tool-output/` (spill files from large tool results).
- Paths that contain `.pi-agent`.
- A file named `auth.json`.
- Any path the existing artifact path guard denies (absolute paths, `..`, and the same denials as reading a run file).
- Files that are on disk but not listed in the success envelope.

Those files stay available from the run's files view.

## Projects

Each artifact belongs to one project. The stored project value on the run — an absolute path from the console, a catalog wire id from the CLI, or a seeded id such as `examples` — is resolved to one catalog wire id by matching the real path of the catalog roots. A run whose `project_root` is null uses the workspace catalog wire id (`workspace`), the same id the catalog uses for the workspace root.

Two projects can use the same pipeline id, stage id and file name. They do not share a row. Reading one artifact without a project, when that owner and id exist in more than one project, returns `409` with code `artifact.ambiguous` and the project ids. Pass `project_root` to pick one.

A project that is no longer registered keeps the last recorded id. Its artifacts stay in the index and are marked as an unregistered project.

Ids must not contain `::`. That separator is reserved for the storage key.

## Where the index lives

Rows are in `state.db` (`artifacts` and `artifact_versions`). See [Data directory](data-directory.md). Indexed files still live under the run workspace and follow run retention; the index row records when the run's retention window will drop them once the run has finished.

## When an indexed artifact expires

The row stays in the list after the run file is gone. `status` is `available` or `expired`. An expired row has `expired_at` (when it expired) and `expired_reason`:

| `expired_reason` | When it is set |
|---|---|
| `run_slimmed` | Retention slim dropped that file because it was over the slim size limit. Smaller indexed files of the same run stay `available`. |
| `run_purged` | Retention purge removed the run. |
| `run_deleted` | The run was deleted. |
| `file_missing` | The run has finished and the indexed file is no longer a contained file in that attempt's `artifacts/` directory. |

A later sweep does not change `expired_at`. Origin `published` is not expired by run retention. Each sweep repairs at most 100 available rows (the batch can be overridden in process). It resumes after the last key it examined and starts again at the first key after the end, so a long list of healthy rows does not hide a later missing file. A repair marks `run_deleted` when the run row is gone, and `file_missing` when the run row is still there but the file is not. If a slim does not finish, rows it marked `run_slimmed` whose files are still on disk go back to `available`.

`expires_at` is the time the run's retention window will purge the run. It is set once, when the run reaches `succeeded`, `failed`, or `cancelled`, from that status's purge window (including `STAGEFLOW_PURGE_*_MS`). It stays null while the run has not finished, and it is not updated after it is set. The list query accepts `status=available` or `status=expired`.

## Listing artifacts

`GET /api/artifacts` returns `{ "artifacts": […], "next_cursor": string | null }`. Pagination is keyset on the active sort column with `key` ascending as a stable tiebreak in both orders. Pass `cursor` from `next_cursor` to continue; the cursor must match the same `sort` and `order`.

The cursor is base64url-encoded JSON: `{ "sort", "order", "primary", "key" }`. `primary` is a number for `size` (a missing size is `-1`) and a string for `title` and `updated`, so a title may contain newlines, quotes, `|`, or `:`. `updated` compares the ISO timestamp as text. `title` compares with SQLite `NOCASE` (ASCII case-insensitive) and breaks ties on `key`. `size` compares the numeric byte size. An older cursor that is two newline-separated fields still means `updated` descending.

| Query | Meaning |
|---|---|
| `project_root` | Catalog wire id (same resolution as other artifact routes). Omit for all projects. |
| `limit` | Page size, 1–100 (default 50). |
| `cursor` | Opaque page token from `next_cursor`. |
| `status` | `available` or `expired` (indexed row status). |
| `kind` | Exact kind (`static.markdown`) or family prefix (`static`, `live`). `_` and `%` are literal. A value with no `.` matches kinds that start with that name and a dot. A value that contains a `.` matches that kind only. |
| `owner` | `stage:<pipeline>:<stage>`, `agent:<id>`, or a case-insensitive substring matched against owner fields. |
| `tag` | Exact lowercase tag. The pattern is the publish rule `[a-z0-9_-]{1,32}`, so a tag may start with a digit or `_`. |
| `live` | `true` — only kinds starting with `live.`; `false` — exclude live kinds. |
| `sort` | `updated` (default), `title`, or `size`. Default order is `desc` for `updated` and `size`, `asc` for `title`. Title order is ASCII case-insensitive. |
| `order` | `asc` or `desc` (overrides the default for the chosen `sort`). |
| `q` | Search text. See [Search](#search). |

Invalid `sort`, `order`, `kind`, `tag`, `live`, `status`, or `q` values return `400` with code `artifact.invalid_filter`. A query that is only punctuation or search operators is `artifact.invalid_filter` ("query has no searchable terms"). Malformed cursors return `artifact.invalid_shape`; a cursor whose sort, order, or search text does not match the request returns `artifact.invalid_filter`.

A local list call against about 1,000 rows should stay under 200 ms on a typical laptop; CI tests use a 500 ms bound. A search of 1,000 artifacts uses the same 500 ms CI bound.

## Search

`q` matches title, description, tags, summary, the owner label (`stage:<pipeline>:<stage>` or `agent:<id>`, plus the pipeline, stage, and agent ids), and extracted body text. The id is included only in the text-scan fallback.

Body text is the first 64 KiB of UTF-8, cut on a character boundary, with control characters turned into spaces. That covers `static.markdown`, `static.text`, and `static.table` (CSV and JSON, as text). HTML text, image bytes, and live data snapshots are not indexed. Hidden artifacts (`hidden = 1`, including eval artifacts) are not indexed and are not returned. An expired, deleted, or hidden artifact is removed from the index in the same transaction as that change. A new publish replaces the indexed text, so the previous version's words stop matching.

The index is a regular FTS5 table, `artifact_fts`, not a contentless one. A regular table stores `key` (unindexed) so a row can be deleted and replaced by key. The tokenizer is `unicode61` with `remove_diacritics 2`, so `café` matches `cafe`, and prefix indexes of 2 and 3 characters serve prefix queries. Rank is `bm25` with weights title 10, tags 10, summary 5, description 5, owner 2, body 1. A smaller score ranks first, so a title hit stays above a body hit.

The query is split into words. Operators (`AND`, `OR`, `NOT`, `NEAR`), quotes, parentheses, asterisks, and `column:` filters are dropped, not passed through. The remaining words are quoted and combined with `AND`. The last word is a prefix (`revenue` matches `revenue` and `revenues`). If nothing remains, the response is `400` `artifact.invalid_filter`.

Search pages with an offset cursor (`{ "mode": "search", "q", "offset", ...filters }`), ordered by rank then `key`. Walking `next_cursor` returns each hit once and then stops. `sort` is not applied while `q` is set. The page includes `match_count`. Filters (`project_root`, `kind`, `owner`, `tag`, `status`, `live`) still apply. Omitting `status` matches every status, including expired, the same way the list does. `status=expired` returns expired hits. An expired artifact is removed from the search index when it expires, same as delete or hide. After that, title, description, tags, summary, and owner still match through the text scan; body text does not. Rank order is unchanged: indexed hits use `bm25`, and a row that is no longer in the index sorts after those hits.

If FTS5 cannot be created, migration 027 still succeeds and records `artifact_search_meta.fts = unavailable`. If the table is missing later, or the meta value is `unavailable`, the Host tries the same `CREATE VIRTUAL TABLE` again when it starts and after `sf restore`. Success marks every artifact dirty and logs once; the repair pass then reindexes titles and bodies. If creation still fails, search logs once per process and scans `title`, `description`, `tags`, `summary`, `owner`, and `id` with bound `LIKE` patterns (`%` and `_` are literal). That scan does not read body text and orders by `updated_at` descending, then `key`. A later start on a build that has FTS5 recreates the table and body search fills in as the repair pass runs. An index update that fails does not fail publish, indexing, retention, or delete. The key is stored in `artifact_search_dirty`. Repair handles 200 keys per pass. A key whose body cannot be read is moved behind the others and the pass resumes after the last key it examined, so one stuck key does not block the rest. At Host start the repair runs in slices until the dirty table is empty or 3 seconds have passed, yielding between slices, and continues on a later tick when the pass made progress. `sf doctor` prints `search index: N artifacts pending`. After an upgrade, body search is complete once that count reaches 0.

## Opening an artifact

`GET /api/artifacts/<ownerKey>/<id>` returns the record. `GET /api/artifacts/<ownerKey>/<id>/content` returns the bytes of the indexed file. Both accept `project_root`. When that query is omitted and the same owner and id exist in more than one project, the response is `409` with code `artifact.ambiguous`.

The content route reads the file through the same contained-path rules as a run file. The stored path is resolved against that attempt's `artifacts/` directory, so a path that stays inside the run workspace but leaves `artifacts/` (a `..` segment, an absolute path, or a symlink to a sibling file) is `403` `artifact.content_unavailable` with "Artifact path denied". An unknown key is `404` `artifact.not_found`. When the run or the file is gone, the response is `404` `artifact.content_unavailable`. An expired row is the same `404`, and the message names the reason (`run_slimmed`, `run_purged`, `run_deleted`, or `file_missing`), even when the file is still on disk. Text, Markdown, CSV, JSON, and HTML are `text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff`. HTML is not served as `text/html` here. When the artifact kind is `static.html`, the response also sends `Content-Security-Policy: sandbox; default-src 'none'`. Other kinds do not get that header. Images are the image bytes with their image type. A non-image larger than 5 MiB is `413` `artifact.too_large` and is not sent. Images may be larger than that.

## Static HTML

An indexed `.html` or `.htm` file has kind `static.html`. The console renders it in an iframe whose `sandbox` attribute is empty: no `allow-scripts`, no `allow-same-origin`, no `allow-forms`, no `allow-popups`, and no `allow-top-navigation`. That attribute stops scripts, access to the console page and its storage, forms, popups, and navigation of the console tab. It does not stop the frame from navigating itself when a link has an `href`.

The frame document always starts with `<!doctype html><html><head>` and a Content-Security-Policy meta element as the first element in that head, then `</head><body>`, then the artifact markup:

`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`

A leading `<!doctype html>` on the artifact is removed before that wrapper. Other doctype declarations are left in place. The policy is in the document head even when the artifact's first tag is not `<head>`, including a `<head>` inside a `<textarea>` or a `<head>` after body content. `default-src 'none'` blocks subresource loads (images, fonts, stylesheets, and fetches) except `data:` images and inline styles. `form-action 'none'` blocks form submission targets. `base-uri 'none'` blocks `<base>` URLs. `default-src` does not block the iframe from navigating to a normal link.

Before the frame is filled, the console removes `<meta http-equiv="refresh">`, `<base>`, `<iframe>`, `<object>`, `<embed>`, and `<link>` elements whose `href` is an absolute URL with a host or a protocol-relative URL. On `<a>` and `<area>`, it removes `href` and `xlink:href` unless the value starts with `#`, removes `ping`, and sets `title` to "Link disabled in static preview" when it removed one of those links and the element had no `title`. The same `href` and `xlink:href` removal applies to `<use>`, `<image>`, and `<feImage>`, and to `<script>` inside `<svg>`. Fragment links such as `<a href=#top>` and `<use href="#icon">` stay. The check is case-insensitive and covers quoted and unquoted values. It does not decode HTML entities, so an entity-obfuscated `javascript:` or `https` value does not start with `#` and loses its `href`. `<script>` elements are left in the file; the empty sandbox stops them from running. `<form action>` is left in place; the sandbox and `form-action 'none'` block submission. A comment ends at `-->`, at `--!>`, and immediately for `<!-->` and `<!--->`. `<!` that is not a comment or a doctype, `<?`, `<![CDATA[`, and `</` followed by a character that is not a letter are skipped until the next `>`, and a tag after that `>` is still neutralised. The pass does not look for tags inside a comment or inside `<script>`, `<style>`, `<textarea>`, or `<title>` (the end tag is matched without regard to case). An unterminated tag, comment, or quoted attribute is read once through to the end of the input, so the work is linear in the length of the text. Running the pass twice leaves the wrapper and the policy meta as they are.

The preview can show text, structure, and inline styles, plus images that use a `data:` URL. The console fetches the file itself and passes the text into the frame. The frame does not request the content URL, because that request would need the control token.

This is not live HTML. Live HTML is a separate kind and is not rendered by this preview.

`GET /api/runs/<runId>/artifact` keeps the file body and `text/plain; charset=utf-8`. For a path whose name ends in `.html` or `.htm` it also sends `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`.

## Publishing

`POST /api/artifacts` copies a static artifact into `$STAGEFLOW_HOME/artifacts/` and records a version. The body is:

| Field | Required | Notes |
|---|---|---|
| `owner` | yes | `{ "kind": "stage", "pipeline", "stage" }` or `{ "kind": "agent", "agent" }` |
| `project_root` | when more than one project is registered | Catalog wire id or path, resolved the same way as other artifact routes |
| `id` | yes | `^[a-z][a-z0-9_-]{0,63}$`. `::` is rejected |
| `kind` | yes | `static.markdown`, `static.image`, `static.table`, `static.text`, or `static.html` |
| `title` | yes | At most 120 characters |
| `description` | no | At most 2000 characters |
| `tags` | no | At most 8, each lowercase `[a-z0-9_-]{1,32}` |
| `summary` | no | At most 2000 characters |
| `content` | text kinds | Inline text. Markdown and text must be valid UTF-8. HTML is stored as given |
| `content_base64` | images, or any kind instead of `content` | Decoded bytes. An image must be png, jpeg, gif, or webp |
| `source` | no | `console` or `api`. Omitted means `api` |

Send `content` or `content_base64`, not both. Decoded content is at most 5 MiB. `content_base64` is standard base64 with no whitespace. The encoded length is checked before decoding (at most `ceil(5 MiB / 3) * 4` characters). Invalid characters or padding are `artifact.invalid_shape`. Non-zero bits in the unused trailing portion of a base64 group are accepted. A decoded body over 5 MiB is `413` `artifact.too_large`. A table is CSV with a consistent column count, or a JSON array of objects.

A stage owner's pipeline and stage ids use the catalog id pattern: lowercase kebab-case, 1–64 characters (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`). An agent id uses `^[a-z][a-z0-9_]{0,63}$` and must already exist in that project. A value with a path separator, `..`, NUL, or the wrong shape is `400` `artifact.invalid_shape` with an `issues` path. If the agent table cannot be read, the publish is accepted and the response includes `agent_unverified: true`.

The response is `{ "key", "version", "project_root", "url", "unchanged" }`. `key` is `stage:<pipeline>:<stage>/<id>` or `agent:<id>/<id>`. Publishing the same owner and id again writes version N+1. Previous versions stay as they were. If the bytes and kind match the current published version, the response is that version with `unchanged: true` and no new version is written. Title, description, tags, and summary are still updated. Provenance is not. `artifacts.source` is the publisher kind of the latest changed version (`console`, `api`, `mcp`, `stage`, or `agent`). Each version row stores the run, stage, attempt, and session of the publisher that wrote that version. An unchanged republish does not rewrite those columns and does not touch older version rows. The artifact row's run, stage, attempt, and session follow that same latest changed version.

An indexed row with the same key becomes `published`. The new bytes are version N+1 in the keep store. The old indexed version row stays and still points at the run file until that version is pruned or the run file is gone. `expires_at` is cleared and the row is `available`. Run retention does not expire it after that.

Publishes and deletes of one key run one at a time in the Host process, in arrival order. Content is written to a unique staging directory under the key, then the next version number is claimed in an immediate database transaction and that directory is renamed to `v<N>`. A failure rolls the transaction back and removes only the staging directory or the `v<N>` directory that attempt created. At the start of a publish, staging directories named `.staging-*` under that key that are older than 10 minutes are removed. That sweep is best effort and does not fail the publish. A directory that is still in use is left alone.

A crash after the rename and before the database commit leaves a `v<N>` directory with no `artifact_versions` row. The next publish of that key treats that directory as a stale orphan: it removes the directory (or, when the path is a symlink, the link only) and reuses N. Removal stays inside the key directory and does not follow symlinks. A version row whose directory is missing is kept. The next publish takes the next number after the highest row and does not overwrite that row.

Bytes live in `$STAGEFLOW_HOME/artifacts/<keyHash>/v<N>/`, where `keyHash` is the first 32 hex characters of sha256 of the storage key. The directory holds the content file and `manifest.json`. The version row stores the sha256, the size, and `manifest_json` as `{"kind":"..."}` for that version.

The Host keeps the latest `STAGEFLOW_ARTIFACT_VERSIONS_KEEP` versions (default 10, integer 1–1000) plus any version with `pinned = 1`. There is no API to set `pinned` yet. The current version is never pruned. A prune failure is logged and does not fail the publish.

`GET /api/artifacts/<ownerKey>/<id>/versions` lists versions newest first: `version`, `size_bytes`, `content_hash`, `created_at`, `pinned`, `current`, and `kind` (the kind stored for that version). The record and content routes accept `version`. A record read with `version` returns that version's `kind`. An unknown version is `404` `artifact.not_found`. Published bytes are served with the same content types, `nosniff`, and size cap as indexed content, using the viewed version's kind.

`DELETE /api/artifacts/<ownerKey>/<id>` removes every version, the rows, and the store directory. It is irreversible. It takes the same per-key lock as publish, so a publish and a delete of one key cannot interleave. A second delete, or a delete of a key that is already gone, is `404` `artifact.not_found`. A publish that runs after a delete creates the artifact again, and version numbers start again at 1. An indexed artifact is `409` `artifact.not_deletable`: those rows are removed only when their run is deleted. Deleting a run, agent, or pipeline does not delete published artifacts.

Validation errors are `{ "error", "code", "issues": [{ "path", "message" }] }`.

| Code | When |
|---|---|
| `artifact.invalid_id` | id, owner, or project id is missing, contains `::`, or is not a slug |
| `artifact.invalid_kind` | kind is missing or not one of the static kinds |
| `artifact.invalid_shape` | any other field is the wrong shape, including tags, title, description, summary, image bytes, table text, and UTF-8 |
| `artifact.too_large` | decoded content is over 5 MiB |
| `artifact.not_found` | key or version does not exist |
| `artifact.not_deletable` | delete was asked for an indexed artifact |
| `artifact.ambiguous` | owner and id, or a missing `project_root`, match more than one project |

## Authoring from a stage

A stage publishes by opting in. Add an `artifacts` block to the stage body (the stage file or an inline stage, not a pipeline-level default):

```yaml
artifacts:
  publish: true
  expect: [weekly-note]
```

`publish: true` gives that stage the `publish_artifact` tool and a short section in its system prompt. Omit the block, or set `publish: false`, and the prompt and tool list are unchanged. `expect` lists ids the attempt must publish before a success envelope. A missing id is `artifact.expected_missing`. `expect` without `publish: true` is `stage.invalid_artifacts`. A publish in that attempt counts even when the bytes and kind are unchanged and no new version is written. An attempt that never calls the tool does not count, including a retry after an earlier attempt published the same id.

The tool takes `id`, `kind`, `title`, and one of `path`, `content`, or `content_base64`. `path` has to stay inside that attempt's artifacts directory. A symlink is refused. The file size is checked before the bytes are read, and a file over 5 MiB is `artifact.too_large` without reading the whole file. Kinds are `static.markdown`, `static.image`, `static.table`, `static.text`, and `static.html`. Publishing the same id again writes the next version. For every kind except `static.image`, the bytes are checked as UTF-8 and scrubbed for secrets before they are stored, including text passed as `content_base64` or read from `path`. Bytes that are not valid UTF-8 are `artifact.invalid_shape`. Image bytes are stored unchanged. The call does not finish the stage; the stage still emits an envelope. The stored source is `stage`, with that run, stage, and attempt on the version that this call created.

A stage eval run (`origin: eval`) publishes with `hidden = 1`. Those rows stay out of the list, search, MCP, and CLI. A normal run publishes a visible row. `hidden` is not a field on the REST or MCP body.

This is separate from the envelope `artifacts` string list (those paths are indexed when the envelope succeeds) and from function `access.artifacts` (which run files a function may read). See [Stage artifacts](yaml-catalog.md#stage-artifacts).

## Agents

A project agent publishes and reads artifacts when its definition grants the groups. `artifacts.read` grants the ask-first id `stageflow.get_artifact`. The model calls `stageflow_get_artifact` (project-wide list and read). `artifacts.write` grants the ask-first id `publish_artifact`. The model calls `publish_artifact`. The Host MCP tool `save_artifact` lets the caller pick an owner, so an agent session never receives it. `publish_artifact` always stores the owner as `agent:<this agent>`, the project as the session's project, and the source as that session (`kind: agent`, `source_session_id` set). `artifacts.cleanup` grants the ask-first id `stageflow.delete_artifact`. The model calls `stageflow_delete_artifact`, which deletes only an artifact this agent owns in the session's project. Another owner's key, or a `project_root` other than that project, is `artifact.not_found` and nothing is deleted. Omitting `project_root` still deletes only in the session's project. `artifacts.refresh` can be granted and adds no tool yet.

`publish_artifact` takes the same arguments as the stage tool: `id`, `kind`, `title`, optional `description`, `tags`, and `summary`, and one of `path`, `content`, or `content_base64`. `path` is relative to the project root and uses the agent path guard: no absolute path, no `..`, no symlink, no `*.agent.yaml` under `agents/`, and nothing under `$STAGEFLOW_HOME` outside the project. The size is checked before the read. Over 5 MiB is `artifact.too_large`. For every kind except `static.image`, the bytes are checked as UTF-8 and scrubbed before they are stored, whether they came from `content`, `content_base64`, or `path`. Bytes that are not valid UTF-8 are `artifact.invalid_shape`. Image bytes are stored unchanged. Ask-first ids are `publish_artifact`, `stageflow.get_artifact`, and `stageflow.delete_artifact`, and only when that group is granted. Those ids are what goes in `approvals.ask_first`. The names in the system prompt are the tools the model calls: `publish_artifact`, `stageflow_get_artifact`, and `stageflow_delete_artifact`.

The system prompt gains a short section only when `artifacts.write` is granted, and one sentence about `stageflow_get_artifact` when the agent has `artifacts.read`. An agent with `artifacts.cleanup` is told to call `stageflow_delete_artifact`. Other agents keep the same prompt and tool list.

An eval session publishes with `hidden = 1` under `eval:agent:<id>/<artifact id>`. Those rows stay out of the list, search, MCP, and this page. Under the eval `read_only` policy, `publish_artifact` and `stageflow_delete_artifact` are stubbed and write nothing. Under `real`, the session can delete a visible artifact owned by that agent, because `real` runs the real tools. See [Agent runtime](agent-runtime.md#artifacts-in-an-eval-session).

The Artifacts page shows an agent owner as `agent · <id>` and links to that agent's page.

`sf run --json --include stages` and `sf runs show --json` add `published_artifacts` (`key`, `version`, `kind`, `title`) on a stage that published during that run. The list is the versions that run published, including an unchanged republish of a version another run created. `version` is the version that attempt published, not a later current version. A later run that republishes the same id does not remove an earlier run's entry. The field is left off when the list is empty. Hidden eval publishes are left off.

## CLI

- `sf artifact list` — table or `--json` page of indexed artifacts. Server-side filters match the list query above (`--project-root`, `--limit`, `--kind`, `--owner`, `--tag`, `--status`, `--live`, `--sort`, `--order`, `--q`). `--q` is the same search as `GET /api/artifacts?q=`. The human table includes a `STATUS` column (`expired` or blank) and a short run id. See [CLI reference](cli-reference.md#sf-artifact).
- `sf artifact show <ownerKey>/<id>` — a readable summary (key, title, kind, status, owner, source, updated, and expires or the expired reason). `--json` prints the record. Use `--project-root` when the key is ambiguous across projects.
- `sf artifact publish` — copy a file into the keep store. See [Publishing](#publishing) and [CLI reference](cli-reference.md#sf-artifact-publish).
- `sf artifact delete <ownerKey>/<id>` — remove a published artifact and every version. See [CLI reference](cli-reference.md#sf-artifact-delete).
- `sf artifact read --run --path` — read a run workspace file by path (not the index). Unchanged from before the index shipped.

## MCP

The Host MCP server exposes an `artifacts` toolset. It is not loaded on a bare `/mcp` connection. Add `toolsets=artifacts` (core stays included) or `toolsets=all`. The run-file tool `run_files` is unchanged.

| Tool | Group | Risk |
|------|-------|------|
| `get_artifact` | `artifacts.read` | read |
| `save_artifact` | `artifacts.write` | write |
| `delete_artifact` | `artifacts.cleanup` | destructive |

`artifacts.refresh` is a group with no tool yet. Refresh is not part of this toolset.

`get_artifact` with `list: true` uses the same filters as the list above (`kind`, `owner`, `tag`, `status`, `live`, `sort`, `order`, `project_root`, `limit`, `cursor`). `q` is passed to the same list search as [Search](#search). Without `list`, pass `key` as `<ownerKey>/<id>` and `view`: `record` (optional `version`), `versions`, `content`, or `data`.

`content` returns UTF-8 text for text kinds. A body over 200 KiB is cut to that cap, with `truncated: true` and `size_bytes` set to the full size. An image at or under 256 KiB includes `base64`. A larger image is `artifact.content_too_large_for_mcp`; read it from the console or the CLI. `view: data` is `artifact.not_live` until live snapshots exist.

`save_artifact` publishes a static artifact with the same fields as [Publishing](#publishing) (`owner`, `project_root`, `id`, `kind`, `title`, `description`, `tags`, `summary`, `content` or `content_base64`). The stored source is `mcp`. The result is `{ key, version, unchanged, project_root }`. The same bytes keep the current version (`unchanged: true`).

`delete_artifact` removes a published artifact and every version. It is irreversible. An indexed artifact is `artifact.not_deletable`.

Hidden artifacts never appear. `project_root` matches the other artifact routes: omit it and the same owner and id in more than one project is `artifact.ambiguous` with `project_roots`. Read calls do not write.

Details and error codes are in [MCP — Artifact tools](mcp.md#artifact-tools).
