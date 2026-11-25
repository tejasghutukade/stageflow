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
| `artifact.invalid_kind` | kind is missing or not a static kind or `live.declarative` |
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

A project agent publishes and reads artifacts when its definition grants the groups. `artifacts.read` grants the ask-first id `stageflow.get_artifact`. The model calls `stageflow_get_artifact` (project-wide list and read). `artifacts.write` grants the ask-first id `publish_artifact`. The model calls `publish_artifact`. The Host MCP tool `save_artifact` lets the caller pick an owner, so an agent session never receives it. `publish_artifact` always stores the owner as `agent:<this agent>`, the project as the session's project, and the source as that session (`kind: agent`, `source_session_id` set). `artifacts.cleanup` grants the ask-first id `stageflow.delete_artifact`. The model calls `stageflow_delete_artifact`, which deletes only an artifact this agent owns in the session's project. Another owner's key, or a `project_root` other than that project, is `artifact.not_found` and nothing is deleted. Omitting `project_root` still deletes only in the session's project. `artifacts.refresh` grants `stageflow.refresh_artifact` (ask-first id `stageflow.refresh_artifact`). It refreshes only an artifact this agent owns in the session's project. Another owner's key, or another project, is `artifact.not_found` and nothing runs.

`publish_artifact` takes the same arguments as the stage tool: `id`, `kind`, `title`, optional `description`, `tags`, and `summary`, and one of `path`, `content`, or `content_base64`. `path` is relative to the project root and uses the agent path guard: no absolute path, no `..`, no symlink, no `*.agent.yaml` under `agents/`, and nothing under `$STAGEFLOW_HOME` outside the project. The size is checked before the read. Over 5 MiB is `artifact.too_large`. For every kind except `static.image`, the bytes are checked as UTF-8 and scrubbed before they are stored, whether they came from `content`, `content_base64`, or `path`. Bytes that are not valid UTF-8 are `artifact.invalid_shape`. Image bytes are stored unchanged. Ask-first ids are `publish_artifact`, `stageflow.get_artifact`, `stageflow.delete_artifact`, and `stageflow.refresh_artifact`, and only when that group is granted. Those ids are what goes in `approvals.ask_first`. The names in the system prompt are the tools the model calls: `publish_artifact`, `stageflow_get_artifact`, `stageflow_delete_artifact`, and `stageflow_refresh_artifact`.

The system prompt gains a short section only when `artifacts.write` is granted, and one sentence about `stageflow_get_artifact` when the agent has `artifacts.read`. An agent with `artifacts.cleanup` is told to call `stageflow_delete_artifact`. An agent with `artifacts.refresh` is told to call `stageflow_refresh_artifact`. Other agents keep the same prompt and tool list.

An eval session publishes with `hidden = 1` under `eval:agent:<id>/<artifact id>`. Those rows stay out of the list, search, MCP, and this page. Under the eval `read_only` policy, `publish_artifact`, `stageflow_delete_artifact`, and `stageflow_refresh_artifact` are stubbed and write nothing. Under `real`, the session can delete a visible artifact owned by that agent, because `real` runs the real tools. See [Agent runtime](agent-runtime.md#artifacts-in-an-eval-session).

The Artifacts page shows an agent owner as `agent · <id>` and links to that agent's page.

`sf run --json --include stages` and `sf runs show --json` add `published_artifacts` (`key`, `version`, `kind`, `title`) on a stage that published during that run. The list is the versions that run published, including an unchanged republish of a version another run created. `version` is the version that attempt published, not a later current version. A later run that republishes the same id does not remove an earlier run's entry. The field is left off when the list is empty. Hidden eval publishes are left off.

## CLI

- `sf artifact list` — table or `--json` page of indexed artifacts. Server-side filters match the list query above (`--project-root`, `--limit`, `--kind`, `--owner`, `--tag`, `--status`, `--live`, `--sort`, `--order`, `--q`). `--q` is the same search as `GET /api/artifacts?q=`. The human table includes a `STATUS` column (`expired` or blank) and a short run id. See [CLI reference](cli-reference.md#sf-artifact).
- `sf artifact show <ownerKey>/<id>` — a readable summary (key, title, kind, status, owner, source, updated, and expires or the expired reason). `--json` prints the record. Use `--project-root` when the key is ambiguous across projects.
- `sf artifact publish` — copy a file into the keep store. See [Publishing](#publishing) and [CLI reference](cli-reference.md#sf-artifact-publish).
- `sf artifact refresh <ownerKey>/<id>` — run the live bindings. Repeat `--binding <id>` to refresh some of them. `--if-stale` reuses a snapshot that is still inside the TTL. See [CLI reference](cli-reference.md#sf-artifact).
- `sf artifact delete <ownerKey>/<id>` — remove a published artifact and every version. See [CLI reference](cli-reference.md#sf-artifact-delete).
- `sf artifact read --run --path` — read a run workspace file by path (not the index). Unchanged from before the index shipped.

## MCP

The Host MCP server exposes an `artifacts` toolset. It is not loaded on a bare `/mcp` connection. Add `toolsets=artifacts` (core stays included) or `toolsets=all`. The run-file tool `run_files` is unchanged.

| Tool | Group | Risk |
|------|-------|------|
| `get_artifact` | `artifacts.read` | read |
| `save_artifact` | `artifacts.write` | write |
| `refresh_artifact` | `artifacts.refresh` | external |
| `delete_artifact` | `artifacts.cleanup` | destructive |

`get_artifact` with `list: true` uses the same filters as the list above (`kind`, `owner`, `tag`, `status`, `live`, `sort`, `order`, `project_root`, `limit`, `cursor`). `q` is passed to the same list search as [Search](#search). Without `list`, pass `key` as `<ownerKey>/<id>` and `view`: `record` (optional `version`), `versions`, `content`, or `data`.

`content` returns UTF-8 text for text kinds. A body over 200 KiB is cut to that cap, with `truncated: true` and `size_bytes` set to the full size. An image at or under 256 KiB includes `base64`. A larger image is `artifact.content_too_large_for_mcp`; read it from the console or the CLI. `view: data` on `live.declarative` returns the current snapshots. A static artifact is `artifact.not_live`. `refresh_artifact` runs the bindings. Snapshot JSON in both answers is capped at 200 KiB. Over the cap, the largest values are dropped (`truncated: true`, `value: null`, `size_bytes`).

`save_artifact` publishes a static artifact with the same fields as [Publishing](#publishing) (`owner`, `project_root`, `id`, `kind`, `title`, `description`, `tags`, `summary`, `content` or `content_base64`). The stored source is `mcp`. The result is `{ key, version, unchanged, project_root }`. The same bytes keep the current version (`unchanged: true`).

`delete_artifact` removes a published artifact and every version. It is irreversible. An indexed artifact is `artifact.not_deletable`.

Hidden artifacts never appear. `project_root` matches the other artifact routes: omit it and the same owner and id in more than one project is `artifact.ambiguous` with `project_roots`. Read calls do not write.

Details and error codes are in [MCP — Artifact tools](mcp.md#artifact-tools).

## Authoring artifacts {#authoring-artifacts}

Practical rules for stages and agents. Runnable walkthrough: [examples/artifacts/README.md](../examples/artifacts/README.md).

### Envelope list, publish, or both

| Mechanism | When to use |
|---|---|
| Envelope `artifacts` + `write_stage_artifact` | Hand files to the next stage, prove a file on disk with `verify type: artifact`, or show files on the run. Bytes follow **run retention** (indexed rows can expire). |
| `artifacts: { publish: true }` + `publish_artifact` | Deliverables operators search for later, versioned outputs, or agents that read across sessions. Bytes live in the **keep store** and survive run delete. |
| Both | Common pattern: write with `write_stage_artifact`, list on the envelope for indexing, and **also** `publish_artifact` when the deliverable should stay on the Artifacts page with a stable id. |

### Naming ids

Use short kebab-case slugs: `weekly-report`, not file paths. Pattern: `^[a-z][a-z0-9_-]{0,63}$`. No `::`. Prefer ids that describe the deliverable, not the run. Use `expect` only for ids the stage must publish before success.

### Search metadata

Set `title` (required, ≤ 120 characters). Add `description`, up to eight lowercase `tags`, and a `summary` (≤ 2000 characters) so console search and `sf artifact list --q` can find the artifact. Search indexes title, description, tags, summary, owner label, and the first 64 KiB of text bodies for markdown, text, and table kinds.

### Kinds

| Kind | Pick when |
|---|---|
| `static.markdown` | Reports, briefs, README-style prose |
| `static.table` | CSV or JSON array of objects |
| `static.text` | Logs or plain UTF-8 that is not Markdown |
| `static.image` | png, jpeg, gif, webp (bytes not scrubbed as UTF-8) |
| `static.html` | One HTML file; console preview is sandboxed without scripts |

`live.declarative` is shipped as an opaque program plus read-only bindings. Refresh is CLI, MCP, and the console. The visual renderer comes later. See [Live artifacts](#live-artifacts).

### Caps and versions

Decoded content is at most **5 MiB**. The Host keeps the latest **`STAGEFLOW_ARTIFACT_VERSIONS_KEEP`** versions (default **10**, integer 1–1000) plus any pinned version. Publishing the same owner and id with identical bytes and kind returns **`unchanged: true`** (no new version row); title, description, tags, and summary still update.

### `expect`

`expect: [id, …]` on the stage body requires each id to be published in that attempt before a **success** envelope. A missing id fails emit with **`artifact.expected_missing`**. An unchanged republish still counts if the tool ran.

### Agents versus stages

Stages publish only when the body opts in. Agents publish when granted **`artifacts.write`** (`publish_artifact`, ask-first id **`publish_artifact`**). Agents read with **`artifacts.read`** (`stageflow_get_artifact`). Agents delete only their own published rows with **`artifacts.cleanup`**. The MCP tool **`save_artifact`** is for operators picking an owner; agent sessions never get it.

### Security

Never publish secrets. Text kinds are UTF-8-checked and scrubbed before store. **`static.html`** is rendered in a sandboxed preview without script execution or network. **`unchanged: true`** means the stored bytes and kind match the current version; metadata fields may still change.

## Live artifacts {#live-artifacts}

`live.declarative` is a published artifact whose content is an OpenUI Lang program and whose manifest names read-only tool functions. A refresh runs those functions and stores snapshots. It does not create a version, start a run, or call a model. The visual renderer is a later step. Until then, the record, the data route, and the refresh route expose the program, the bindings, and the latest snapshots.

### Manifest

`POST /api/artifacts` sends `kind: live.declarative`, the program as `content` (or `content_base64`), and `manifest`:

```json
{
  "format": "openui-lang",
  "library": { "name": "stageflow", "version": "1.0.0" },
  "bindings": [ { "id": "rows", "function": "revenue_by_week", "args": { "weeks": 12 } } ],
  "refresh": { "on_view": true, "ttl_seconds": 300, "auto_seconds": 60 }
}
```

`program` inside the manifest is optional. When it is present it must equal `content`. The Host stores the program text twice: as the content file (`program.txt`) and again inside the manifest (`artifact_versions.manifest_json` and `manifest.json` on disk). The 128 KiB cap counts that program text once, as the content bytes, not a second time for the manifest copy. Publish parses the program. See [Live artifacts: programs](#live-artifacts-programs).

| Field | Rule |
|---|---|
| `format` | `openui-lang`. Any other value is `artifact.invalid_shape` (`unsupported format`) |
| `library.name` | `stageflow`. Another name is `artifact.invalid_shape` |
| `library.version` | `1.0.0`, the current library. Publish accepts only that version. An older stored version is reported as needing migration when it is rendered |
| `program` | OpenUI Lang text, at most 128 KiB, at most 2,000 statements, at most 64 `Query` calls, and at most 20 levels of nesting. Over the byte cap is `413` `artifact.too_large` |
| `bindings` | At most 8. `id` matches `^[a-z][a-z0-9_]{0,31}$` and is unique. `function` is a function id. `args` is a JSON object of at most 8 KiB |
| `refresh.on_view` | Optional boolean. Omitted means the console refreshes when the artifact is opened. `false` skips that open refresh. Automatic refresh while the tab is open still follows `auto_seconds` |
| `refresh.ttl_seconds` | Optional integer of at least 30. Omitted means 300 seconds. A snapshot is fresh while its age is less than or equal to this TTL |
| `refresh.auto_seconds` | Optional integer of at least 30. When set, a visible console tab repeats the stale check on that interval |

A bad manifest is `400` `artifact.invalid_shape` with `issues[].path`. `args` are data. The Host does not run them as code.

The stage and agent `publish_artifact` tools take the same program as `content` and pass `format`, `library`, `bindings`, and optional `refresh` instead of one `manifest` object. MCP `save_artifact` takes `manifest`, the same object as this route. The same bytes-and-manifest hash keeps the current version (`unchanged: true`). The hash is the program plus the canonical manifest JSON. Title, description, tags, and summary still update.

### Live artifacts: programs

The language is a subset of OpenUI Lang. One statement per line: `name = Expression`. The entry statement is `root`. Forward references are allowed. `$variables` hold local filter state. `Query(tool, args, default, refreshSeconds)` reads a bound function. `tool` is that function's id, not the binding id. `args` may use `$variables`. `refreshSeconds` is optional. A program with no `Query` is static content and is allowed.

A `Query` is accepted only when its first argument is exactly one double-quoted string literal: no single quotes, concatenation, operators, ternary, references, variables, or backslash escapes. That literal must equal the `function` of a declared binding. `@Query(...)` is a `Query`. Any other tool-name shape is `artifact.program_invalid` with the message `the tool name must be a single string literal that matches a bound function`.

`Query` and `Mutation` are read from the same parse tree the renderer uses, including calls nested in props, arrays, ternaries, and function arguments. Either name is `inline-reserved` unless it is the whole right-hand side of a statement. An `@` call that is not `@Set`, `@Reset`, `@Run`, or `Action` is `unknown-function`. A component outside the vocabulary is `unknown-component`.

Characters outside string literals and comments are rejected with `invalid-character` when they are Unicode format or space characters other than a normal space, tab, carriage return, or line feed. That includes U+200B–U+200F, U+2060–U+2064, U+FEFF, NBSP and the other `Zs` spaces, U+000B, U+000C, U+0085, U+2028, and U+2029. A string literal may contain them.

Accepted:

```text
data = Query("get_usage", {range: $range}, {rows: []})
rows = data.rows
root = TextContent("x")
```

Rejected:

```text
Query("get_usage" + "_evil", {})
Query("get_usage" || "evil", {})
Query("get_usage" ?? "evil", {})
Query("get_usage" == "x" ? "evil" : "get_usage", {})
@Query("evil", {})
Query("get_usag\e", {})
root = TextContent(Query("get_usage", {}).nope)
root = TextContent("aaa
```

`Query` and `Mutation` used inside a component (`inline-reserved`) are rejected. An unterminated string, which the parser would otherwise close, is rejected (`unterminated-string`). Every string is rendered as plain text and never becomes a link or an image. A URL-like string in `TextContent` or `Tag`, including `javascript:` and `data:`, publishes with the warning `URL-like text: rendered as plain text`.

Scanning is linear in the program size. One field-access chain is recorded once, not once per prefix. Limits, past which publish returns `artifact.program_invalid`:

| Limit | Rejection |
|---|---|
| 128 KiB | `program-too-large` (content bytes; the route uses `413` `artifact.too_large`) |
| 2,000 statements | `statement-limit` |
| 64 `Query` calls | `too-many-queries` |
| 32 KiB of string literals | `string-literal-budget` |
| 5,000 array or object literal elements | `literal-budget` |
| 20 nested brackets | `nesting-limit` |
| line longer than 16 KiB | `line-too-long` |
| identifier longer than 128 characters | `identifier-too-long` |
| statement larger than 64 KiB | `statement-too-large` |
| field chain longer than 64 segments | `chain-too-long` |
| more than 20,000 field accesses | `too-many-field-accesses` |
| a disallowed Unicode space or format character outside a string or comment | `invalid-character` |
| more than 250 ms while scanning or reconciling | `program too complex` |

Publish resolves each distinct bound function once, before reconcile, and passes that in-memory map into reconcile. Reconcile does not read function files. At most two program validations run in one process. Further publishes wait, and the wait yields between validations. A 33rd waiter is `429` `artifact.resource_limit` with `{ "error", "code" }`. Nothing is written.

Every opted-in stage or agent gets this Live artifacts block, including an owner with no bindable functions. With no functions the block is the vocabulary, one syntax line, and `no bindable functions: write data into the program`. With functions, each description is capped at 200 characters and each function's input/output rendering at 600 characters. If those caps would put the section over 4,500 estimated tokens, the input/output rendering is shortened further until it fits. Token estimates are `characters / 4`: vocabulary 1,763; the block with no functions 1,808; 20 functions with short descriptions 2,430; 20 functions with long descriptions and long schemas 4,390.

`scripts/artifacts/live-program-regression.ts` writes its JSON to `--out-dir`. The default is the operating-system temp directory `stageflow-live-regression`, not a directory in this repo.

Publish accepts only library `stageflow` version `1.0.0` (`LIBRARY_NAME` / `LIBRARY_VERSION`). A stored artifact stays tied to the version that wrote it. `libraryVersionStatus` returns `current`, `older`, `newer`, or `unknown` so a later renderer can show a needs-migration state. An older or newer version is `artifact.invalid_shape` at publish.

| Component | Props, in order |
|---|---|
| `Stack` | children, direction, gap, align, justify, wrap |
| `Card` | children, variant, direction, gap, align, justify, wrap |
| `CardHeader` | title, subtitle |
| `TextContent` | text, size |
| `Callout` | variant, title, description, visible |
| `Table` | columns |
| `Col` | label, data, type |
| `Tag` | text, icon, size, variant |
| `Stat` | label, value, tone |
| `StatusPill` | tone, label |
| `SectionCard` | title, body |
| `LineChart` | labels, series, variant, xLabel, yLabel, height |
| `BarChart` | labels, series, variant, xLabel, yLabel, height |
| `Series` | category, values |
| `Select` | name, items, placeholder, rules, value, size |
| `SelectItem` | value, label |
| `Input` | name, placeholder, type, rules, value |
| `Button` | label, action, variant, type, size |

`Stack` and `Card` take an array of children. Optional props may be omitted from the end or passed as `null`. `Select` and `Input` bind a `$variable` for local filter state. `Button` actions are `@Set`, `@Reset`, or `@Run` of a Query.

These are rejected because they load remote content, run a write, or start an agent turn (levels 3 and 4 stay off):

- `Image`, `Carousel`, `ImageGallery`, `Link`, `Embed`, `Markdown`, `Form`, and any other component not in the table (`unknown-component`)
- `Mutation`, `@ToAssistant`, `@OpenUrl`, and `@Run` of a Mutation (`excluded-feature`)
- A `Query` whose tool is not a binding function (`unknown-tool`). The message lists the declared function ids
- A field read that is not in the function's `output_schema` when the function declares one (`unknown-field`). The message names the valid fields at that level. Array pluck (`usage.rows.day`) walks `items`. A read through an alias (`rows = data.rows`, then `rows.day`) and a `Query` inside a conditional are checked the same way
- More than 2,000 statements, more than 64 `Query` calls, more than 20 levels of nesting, a line over 16 KiB, an identifier over 128 characters, a statement over 64 KiB, string literals over 32 KiB, more than 5,000 array or object literal elements, a field chain over 64 segments, more than 20,000 field accesses, a disallowed character outside a string or comment, or a scan or reconcile that exceeds 250 ms (`program too complex`)
- A cyclic reference graph (`reference-cycle`)

A `Query` whose literal args differ from the binding args is a warning (`binding-args`), not an error. `$variable` args are not a mismatch. A binding that the program never queries is a warning (`binding-unused`). A function with no `output_schema` skips the field check and adds a warning (`output-schema-missing`). A program that has no `root` but does call `Stack` still publishes, with a `no-root` warning. The publish response includes `warnings` when any of these apply. Errors reject the publish with `400` `artifact.program_invalid` and `issues[]` (`path` is the statement id, `code` is the parser or reconcile code, at most 20 issues, sorted by line). Nothing is written when publish is rejected.

Example that fails, then the fix:

```text
root = NotAThing("x")
```

`artifact.program_invalid`, issue code `unknown-component`. The corrected program is `root = TextContent("x")`.

```text
usage = Query("other", {range: "7"}, {rows: []})
root = TextContent("x")
```

`unknown-tool` when the only binding function is `get_usage`. `usage = Query("get_usage", {range: $range}, {rows: []})` matches a binding whose function id is `get_usage`.

### Bindings

At publish, and again at refresh, the Host reads the function once (its stored revision and source hash) and checks that revision. The executor runs that same revision. If the file changes while the check is in progress, the refresh does not run the edited source. If that revision can no longer be loaded, the binding fails with `artifact.function_changed`.

| Check | Code |
|---|---|
| The function exists and is `kind: tool` | `artifact.binding_unknown_function` |
| The owner holds it. The message says why. See below | `artifact.binding_not_granted` |
| Declared access is read-only. See below | `artifact.binding_not_read_only` |
| `args` match the function `input_schema` | `artifact.binding_args_invalid` (`issues` paths) |
| The return value matches `output_schema` when the function has one | `invalid_output` (the function code). The previous snapshot stays |

The read-only rule looks at declared access only: each network entry must be `effect: read` with methods only `GET` or `HEAD`, and the function must not declare write access to artifacts, the workspace, or files. A function with no network access can be bound. A tool that holds a credential and sends `GET` to an endpoint that changes something is not detectable. That is the function author's responsibility. A function with env access or file read access can be bound. Its return value, which may include env values or file contents, is stored in the snapshot. Scrubbing replaces sensitive key names and secret-shaped strings. It does not know which strings are secrets. Do not bind a function that returns secrets.

The owner check reads the catalog, not a resolved pipeline (so an under-granted attachment still loads):

- No `stageflow.yaml` fails with "Project has no stageflow.yaml".
- A manifest with no `catalog.pipelines` fails with "Manifest has no catalog.pipelines".
- A pipeline id that is not in the catalog fails with "was not found in the catalog". A file listed under `catalog.exclude` fails with "excluded from the catalog".
- A catalog file that cannot be read (a busy or interrupted read, after one retry) fails with `503` `artifact.catalog_unavailable`. The message says the catalog could not be read and to retry. That is not `artifact.binding_not_granted`.
- A missing stage fails with "Stage … was not found". A stage that does not list the function says it does not attach that function.
- A `uses:` file that cannot be parsed is skipped with a warning. The scan continues. That stage does not grant the function. A `uses:` file for the stage that owns the binding that still cannot be read after one retry is `artifact.catalog_unavailable`, not a missing pipeline.
- When more than one catalog file in the project declares the same pipeline id, only the first non-excluded path in catalog order is that pipeline. A later file does not grant the function.
- A missing agent file fails with "Agent … was not found".

Refresh passes the attachment's `grants` and no other capability. `grants: []`, or an attachment that omits `grants`, passes no capabilities. The grants are read again from the owner's current attachment at refresh. If that attachment cannot be resolved, the binding fails closed with `artifact.binding_not_granted` and the reason above.

### Refresh and snapshots

`POST /api/artifacts/<ownerKey>/<id>/refresh` runs every manifest binding, or only the ids in `{ "bindingIds": ["rows"] }`. The body may also set `ifStale` (boolean). An empty `bindingIds` array is `400` `artifact.invalid_shape`. Omitting `bindingIds` runs every binding. An unknown id is `artifact.invalid_shape`. `ifStale` that is not a boolean is `400` `artifact.invalid_shape` at `ifStale`. `GET /api/artifacts/<ownerKey>/<id>/data` returns the current snapshots and does not run anything. Both take `project_root` the same way as the record route. A missing artifact, or a key from another project, is `404` `artifact.not_found`. More than one project and no `project_root` is `409` `artifact.ambiguous` with `project_roots`. A static artifact is `404` `artifact.not_live`. An expired artifact is `404` `artifact.content_unavailable` and is not refreshed.

With `ifStale: true`, a binding runs only when its current snapshot is missing, its status is not `ok`, or its `fetched_at` is older than the effective TTL. The effective TTL is `refresh.ttl_seconds` when the manifest sets it (already at least 30; a smaller stored value is treated as 30) and **300 seconds** when `ttl_seconds` is omitted. A fresh snapshot is reused. That reuse does not call the function, does not write an invocation row, and does not change the snapshot row or `last_refreshed_at`. `ifStale: false` or an omitted `ifStale` runs the requested bindings.

The refresh response is `{ "status", "snapshots", "last_refreshed_at", "last_error_code", "errors" }`. `errors` is `{ "binding_id", "code" }`. Each snapshot is `{ "binding_id", "args_hash", "value", "fetched_at", "duration_ms", "status", "error_code" }` and, on a refresh, `source`. `source` is `executed` only when this call stored that snapshot. It is `cache` when the returned snapshot was already stored, including an `ifStale` reuse and a binding that failed and kept its previous snapshot. The data route uses the same shape without `source`, and with `errors: []`. When any binding failed with `artifact.resource_limit`, or the caller was refused because the execution queue or the joiner bound was full, the body also includes `retry_after_seconds` (30). If at least one stored snapshot can be shown, that response is `200` with `status: "stale"`. If nothing can be shown, the same body is `503`. It is never a bare `{ "error", "code" }` envelope. Other refresh results stay `200`.

Concurrent `ifStale` requests join an in-flight execution when they ask for the same bindings or for a subset of the bindings already running. A caller that also asks for a binding that is not in flight waits for the shared part and then runs only the missing bindings. Callers that join receive the same result object, including the same error when the shared execution fails. Joining waits on that shared promise and does not take an execution slot. At most 1,000 callers may join one flight; the next one is refused with the `artifact.resource_limit` body above. An `ifStale` caller that finds every requested snapshot still inside the TTL returns the cache and does not take a slot either. A manual refresh (`ifStale` omitted or false) does not join that flight. It queues its own execution. At most 32 of those executions wait behind the one that is running; the next one is refused with the same body. Aborting or disconnecting one caller does not cancel the shared execution. That caller's wait is released immediately, and the response is not written after the connection closes. A refresh does not start a run or call a model.

A snapshot is one row per binding for that binding's current args hash. Older hashes and bindings removed from the manifest are deleted. A new result replaces the current row. It is not a version. The stored value is at most 1 MiB and at most 64 levels deep and 200,000 nodes. Over the byte or node cap is `artifact.snapshot_too_large`. Over the depth cap is `artifact.refresh_failed`. The previous snapshot stays. Before scrubbing, the Host checks an upper bound on the serialized JSON size and rejects over-limit values without walking string secrets. Values within the cap are scrubbed by walking the JSON: string leaves go through pattern redaction; property names that match `secret`, `token`, `passw`, `pwd`, `api_key` / `api-key`, `auth`, `credential`, `bearer`, `cookie`, `private`, `session`, `sid`, `csrf`, `xsrf`, `jwt`, or `signature` (case-insensitive substrings) have the whole value replaced by `[redacted]`, including arrays and objects. Other keys keep their shape.

The Host runs the function through the function executor with the attachment's grants, and with that function's timeout and body limits (4 running, 16 waiting). Credentials are resolved by the Host for granted capabilities only. Secret values, request URLs, and response bodies are not stored. Invocation history records `kind: artifact` and a code only. A cache hit writes no invocation row. A full executor queue is `artifact.resource_limit`: the previous snapshot stays, the status is `stale` when that snapshot exists and `error` when it does not, and the response includes `retry_after_seconds`. The view is not failed as a 429 or a generic 500. Any other function failure keeps the previous snapshot and sets `last_error_code` to the function code, or `artifact.refresh_failed` when the function has no code.

`status` is computed from every binding in the current manifest, not only the ones this call ran. It is `fresh` only when every binding has a successful snapshot for its current args hash and this call had no binding error. It is `stale` when at least one successful snapshot exists and some binding failed or has no snapshot. It is `error` when no binding has a successful snapshot. It is null before the first successful snapshot (including after a new version drops every snapshot). `refreshing` is set only while a refresh is in progress. A thrown failure, including a crash while storing the value, leaves `stale` or `error` with `artifact.refresh_failed`. On Host start, every row still marked `refreshing` is reset the same way. On the indexed-artifact repair pass, only rows that have been `refreshing` for more than ten minutes and are not in flight in this process are reset. `last_refreshed_at` is the newest successful `fetched_at` among current snapshots, including when only some bindings succeeded.

A new version (not an unchanged republish) deletes snapshot rows whose binding id and args hash are not in the new manifest, then recomputes status from what remains. An unchanged republish leaves snapshots and status alone. Publishing a non-live version deletes the snapshots.

Lock order for one artifact is the publish lock, then the refresh lock. Publish holds only the publish lock, so a new version can commit while a refresh is running the function. The snapshot write checks that the artifact and the version it started with are still there. If the artifact was deleted, the result is discarded with `artifact.not_found`. If a new version was published, the result is discarded and the refresh returns the stored state. Delete takes both locks in that order, and it deletes snapshot rows in the same transaction as the artifact row. A delete started from inside the refresh runs immediately, and the snapshot write then sees that the artifact is gone. Indexed-artifact deletes remove snapshot rows for those keys too. At most 32 refresh executions wait behind the one that is running. Callers joined to an in-flight execution, and `ifStale` callers served from a fresh snapshot, do not take those slots. A joiner past 1,000 on one flight, or an execution past the 32 waiting slots, gets `artifact.resource_limit` in the refresh result body (`200` with the last `ok` snapshot, or `503` when there is none), including `retry_after_seconds`. Delete and other mutating callers still queue on the refresh lock, ahead of refresh callers that are waiting to run, and without that cap. Disconnecting one caller releases only that caller's wait. The shared execution still finishes.

One artifact runs one refresh execution at a time. Overlapping callers share that execution instead of lining up another copy. The read-only check and the revision pin happen once for that execution. In-flight entries are removed when the execution finishes, including when it fails. The list and record include `live` for this kind:

```json
"live": {
  "status": "fresh",
  "last_refreshed_at": "…",
  "last_error_code": null,
  "bindings": [ { "id": "rows", "function": "revenue_by_week", "args": { "weeks": 12 } } ],
  "refresh": { "on_view": true, "ttl_seconds": 300, "auto_seconds": 60 },
  "library": { "name": "stageflow", "version": "1.0.0" }
}
```

Static records omit `live`. `GET /api/artifacts?live=true` and `?kind=live` still select the `live.` family.

An eval-origin publish uses the same hidden `eval:` namespace as a static publish. Owner and project rules are unchanged.

### CLI

`sf artifact publish --kind live.declarative` takes the program from `--file` or `--stdin` and the manifest JSON from `--manifest`. `sf artifact list` marks a live row `LIVE` or `LIVE/<status>` (`fresh`, `stale`, `error`, `refreshing`). `sf artifact show` prints each binding (`id`, function, `read-only`), the refresh policy, and the last refreshed time. `--json` includes the `live` object. `sf artifact refresh <ownerKey>/<id>` runs the bindings, or only the ids given with repeated `--binding`. `--if-stale` applies the TTL rule above. It runs in the CLI process, so the function executor's limits apply to that process. `--json` prints `{ status, snapshots, last_refreshed_at, last_error_code, errors }`, plus `source` on snapshots and `retry_after_seconds` when the executor queue is full. A binding failure exits 1 and still prints that object. `artifact.not_found`, `artifact.ambiguous`, `artifact.not_live`, and `artifact.content_unavailable` exit 1 with `{ error, code }`.

### MCP

`refresh_artifact` is group `artifacts.refresh`, risk external, toolset `artifacts`. Arguments are `key`, optional `project_root`, and optional `binding_ids`. REST refresh uses `bindingIds` in the JSON body; MCP uses `binding_ids`. `get_artifact` with `view: data` returns the same snapshot object for a live artifact and `artifact.not_live` for a static one. Snapshot JSON is capped at 200 KiB. Over the cap, the largest values are dropped first: those snapshots have `truncated: true`, `value: null`, and `size_bytes`, and the response stays JSON. An expired artifact is `artifact.content_unavailable`. An agent granted `artifacts.refresh` receives `stageflow_refresh_artifact`, bound to artifacts that agent owns in the session project.

### Console

The Artifacts list shows the live kind label and the status pill. The detail page shows the program as monospace text and says the visual renderer comes in a later update. The Inspector **Live** section lists bindings with a Read-only badge, status, last refreshed time (a relative age, with the absolute time on hover), an **Updated Ns ago** line, last error code, and collapsed snapshot JSON. When `auto_seconds` is set it also says **Checking every Ns · data refreshed at most every Ms**, where M is the effective TTL (`refresh.ttl_seconds`, or 300 seconds when that field is omitted). Opening the current version loads the stored snapshots from the data route first, then refreshes with `ifStale: true` unless `on_view` is false. The page waits until the versions list identifies the latest version before that load, so an older version is not refreshed while the list is still loading. The interval pauses while the browser tab is hidden and, on becoming visible, refreshes immediately when the snapshot is older than `auto_seconds`. **Refresh now** calls the refresh route without `ifStale`. An older version (`?v=` when it is not the latest), an expired artifact, or a hidden artifact does not start that refresh. An older version does not read stored snapshots. It shows that version's program and manifest bindings, and says snapshots are for the current version. An expired live artifact shows the same expiry explanation as a static artifact and hides the live program note and **Refresh now**. `artifact.content_unavailable` from the data route shows that explanation as well.
