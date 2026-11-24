# Artifacts

An **artifact** is a published, indexed output with an owner and a stable id. A **run file** is any file in a stage attempt's `artifacts/` folder. A run file becomes an artifact only when it is indexed.

This page covers the index that is filled in automatically. Publishing live artifacts is not part of this yet.

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

## Opening an artifact

`GET /api/artifacts/<ownerKey>/<id>` returns the record. `GET /api/artifacts/<ownerKey>/<id>/content` returns the bytes of the indexed file. Both accept `project_root`. When that query is omitted and the same owner and id exist in more than one project, the response is `409` with code `artifact.ambiguous`.

The content route reads the file through the same contained-path rules as a run file. The stored path is resolved against that attempt's `artifacts/` directory, so a path that stays inside the run workspace but leaves `artifacts/` (a `..` segment, an absolute path, or a symlink to a sibling file) is `403` `artifact.content_unavailable` with "Artifact path denied". An unknown key is `404` `artifact.not_found`. When the run or the file is gone, the response is `404` `artifact.content_unavailable`. An expired row is the same `404`, and the message names the reason (`run_slimmed`, `run_purged`, `run_deleted`, or `file_missing`), even when the file is still on disk. Text, Markdown, CSV, JSON, and HTML are `text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff`. HTML is not served as `text/html` here. Images are the image bytes with their image type. A non-image larger than 5 MiB is `413` `artifact.too_large` and is not sent. Images may be larger than that.

## CLI

- `sf artifact list` — table or `--json` page of indexed artifacts (`--project-root`, `--limit`; `--q`, `--kind`, `--owner`, and `--live` filter client-side for now). The human table includes a `STATUS` column (`expired` or blank) and a short run id. See [CLI reference](cli-reference.md#sf-artifact).
- `sf artifact show <ownerKey>/<id>` — a readable summary (key, title, kind, status, owner, source, updated, and expires or the expired reason). `--json` prints the record. Use `--project-root` when the key is ambiguous across projects.
- `sf artifact read --run --path` — read a run workspace file by path (not the index). Unchanged from before the index shipped.
