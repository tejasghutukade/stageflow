---
layout: default
title: Console — Artifacts
---

# Artifacts

**Artifacts** is in the left rail, in the **Activity** group, after **Pipeline runs**. The route is `#/artifacts`.

The page lists indexed deliverables. The project control defaults to the active catalog project (the same write root the Workshop and evals use: the workspace catalog when it is available, otherwise the first writable root). The control also lists each other catalog project, and **All projects**. All projects calls the list API with no `project_root`, and each row shows a short project label so the same stage in two projects stays distinct.

**Load more** requests the next page with `next_cursor` when the list is longer than one page.

Each row shows:

- a kind icon and a kind pill (Markdown, image, table, HTML, or text)
- the title (the file name, or the parent folder plus the file name when a stage lists two files with the same name)
- the owner (pipeline and stage)
- the source run, which opens that run. When the run is in the console's run list, the label is the short run id and the task label; otherwise it is the short run id
- when the row was updated

An artifact whose project is no longer registered is marked **Unregistered project**. Those rows show up under All projects.

The empty state explains that rows appear when a stage lists files in its success envelope, and that tool-output spill files are not listed. See [Artifacts](artifacts.md).

Search and the detail page are not on this screen yet.
