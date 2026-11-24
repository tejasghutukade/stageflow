---
layout: default
title: Console — Artifacts
---

# Artifacts

**Artifacts** is in the left rail, in the **Activity** group, after **Pipeline runs**. The route is `#/artifacts`.

The page lists indexed deliverables. The project control defaults to the active catalog project (the same write root the Workshop and evals use: the workspace catalog when it is available, otherwise the first writable root). The control also lists each other catalog project, and **All projects**. All projects calls the list API with no `project_root`, and each row shows a short project label so the same stage in two projects stays distinct.

**Load more** requests the next page with `next_cursor` when the list is longer than one page.

Each row opens the artifact detail page (`#/artifacts/<ownerKey>/<id>`, with `project_root` when the row has a project). The row shows:

- a kind icon and a kind pill (Markdown, image, table, HTML, or text)
- the title (the file name, or the parent folder plus the file name when a stage lists two files with the same name)
- the owner (pipeline and stage)
- the source run. When the run is in the console's run list, the label is the short run id and the task label; otherwise it is the short run id. The link to that run is on the detail page
- when the row was updated
- an **Expired** pill when the indexed row is expired. The pill's tooltip is a short reason: cleaned up to save space (`run_slimmed`), run was purged, run was deleted, or file is missing. An unknown reason code is shown as itself.

An artifact whose project is no longer registered is marked **Unregistered project**. Those rows show up under All projects.

The empty state explains that rows appear when a stage lists files in its success envelope, and that tool-output spill files are not listed. See [Artifacts](artifacts.md).

## Detail

The detail page has a back crumb to **Artifacts**, the file in the main area, and a **Details** side panel.

The panel shows the title, kind, owner (pipeline and stage), size, content type, created and updated times, a short content hash, and links to the source run and stage.

Rendering:

| Kind | What you see |
|---|---|
| Markdown | The same Markdown view the run file reader uses |
| Image | The image, loaded with the console control token |
| Table | A CSV file, or a JSON array of objects. Column headers sort the visible rows. The first click sorts ascending, the second descending, and the third returns to file order. The header exposes that state. Numbers sort numerically, and equal values keep their order. The table shows the first 500 rows and says `showing first 500 of N` when the file has more |
| Text | Monospace text, including an extension the index stores as text |
| HTML | The source, with a note that an HTML preview comes in a later update |

A file the console cannot preview (unknown kind, or binary content) shows a card with the file info. Invalid CSV or JSON is shown as text with a note. When the record is expired, the main area explains the reason in a sentence (slimmed to save space, purged, deleted, or the file is missing) and the side panel still shows the metadata. An unknown reason code is included in that sentence. The content route answers an expired row with `404` `artifact.content_unavailable` and names the reason, including when the file is still on disk.

The console does not load non-image content larger than 5 MiB through this page.
