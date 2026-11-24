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
