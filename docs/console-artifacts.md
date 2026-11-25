---
layout: default
title: Console — Artifacts
---

# Artifacts

**Artifacts** is in the left rail, in the **Activity** group, after **Pipeline runs**. The route is `#/artifacts`.

The page lists indexed deliverables. The project control defaults to the active catalog project (the same write root the Workshop and evals use: the workspace catalog when it is available, otherwise the first writable root). The control also lists each other catalog project, and **All projects**. All projects calls the list API with no `project_root`, and each row shows a short project label so the same stage in two projects stays distinct.

**Load more** requests the next page with `next_cursor` when the list is longer than one page.

**All / Live / Static** tabs set a `live` or `static` kind filter. Tab counts on the loaded page only (there is no separate count endpoint).

Filter controls for kind, owner, tag, and status, plus a sort menu (updated, title, size), call the list API with the same query parameters as [Listing artifacts](artifacts.md#listing-artifacts). Title sort is ASCII case-insensitive, with the artifact key breaking ties. Kind filters treat `_` and `%` as literal characters. A tag uses the same `[a-z0-9_-]{1,32}` rule as publish, including tags that start with a digit or `_`. Filter and tab choices are stored in the hash query (`#/artifacts?…`) so reload and back/forward keep them. The project control writes `project_root` into that query when it is not **All projects**. **Load more** sends the list cursor, which is base64url JSON and can carry a title that contains a newline, a quote, `|`, or `:`.

The search box sends `q` after a short pause and stores that text in the same hash query. **Clear** removes it. While a search is showing, the bar says `1 match` or `N matches` (`match_count` from the list). A query with no letters or numbers, such as `((`, shows the same empty state as any other search that matches nothing, with the hint "Try letters or numbers". The filters stay in place. An expired artifact is removed from the search index when it expires. What is indexed, and what is left out, is [Search](artifacts.md#search).

**⌘K** adds an **Artifacts** group when the palette query is at least two characters. It requests the top five matches (`q` and `limit=5`). Choosing one opens that artifact. Changing the query clears the previous hits immediately. A slow response that belongs to an older query is ignored. If the request fails, the group stays empty and the rest of the palette still works.

Each row opens the artifact detail page (`#/artifacts/<ownerKey>/<id>`, with `project_root` when the row has a project). The row shows:

- a kind icon and a kind pill (Markdown, image, table, HTML, or text)
- the title (the file name, or the parent folder plus the file name when a stage lists two files with the same name)
- the owner (pipeline and stage)
- the source run. When the run is in the console's run list, the label is the short run id and the task label; otherwise it is the short run id. The link to that run is on the detail page
- when the row was updated
- a status pill: **Available** (ok) for indexed rows; **Expired** (fail) when the indexed row is expired, with a tooltip for the short reason (cleaned up to save space, run was purged, run was deleted, or file is missing). Live artifacts use **Fresh** (ok), **Stale** (needs attention), **Error** (fail), and **Refreshing** (running) when they exist in the index.
- when `expires_at` is set, a short note such as **expires today**, **expires in N days**, or **expired** (after the retention date)

An artifact whose project is no longer registered is marked **Unregistered project**. Those rows show up under All projects.

When there are no rows and no filters are active, the empty state explains that rows appear when a stage lists files in its success envelope, and that tool-output spill files are not listed (see [Artifacts](artifacts.md)). When filters are active and nothing matches, a separate empty state offers **Clear filters**.

## Detail

The detail page has a back crumb to **Artifacts**, the file in the main area, and a **Details** side panel.

The panel shows the title, kind, owner (pipeline and stage), size, content type, created and updated times, a short content hash, and links to the source run and stage.

Published artifacts also list **Versions** in that panel: version number, created time, size, a short hash, and a Current marker on the latest one. A pinned version is marked Pinned. Choosing an older version opens it read-only at `#/artifacts/<ownerKey>/<id>?v=<N>` (and `project_root` when the page already has one). A banner says `Viewing version N of M` and links back to the latest. The main area renders that version with the kind stored for it, so an older markdown version stays on the markdown view after a later publish uses another kind. There is no editor.

### Live

A `live.declarative` detail page renders the program: charts, tables, cards, and text, themed from the console tokens. `TextContent` `large-heavy` is the KPI size. The program text stays under **Program source**. A loading skeleton shows while a queried binding has no snapshot and the first load or a refresh is still running. It does not show **No data** in that gap. When the snapshot arrives, the chart renders it. A later default snapshot remounts the preview only when its value changed. A refresh that only moves the fetch time leaves the preview mounted, so a chosen filter stays selected and is not requested again. When the value changes, the preview remounts, keeps that filter, and loads the filter's data. Changing the program text or the library version clears the filter. **No data** and **Data mismatch** replace the program when it has no `Select` or `Input`. When it has one, the message is a banner and the filter stays on the page. If the filter's own result has rows, the banner becomes **Showing filtered data**. **Refresh now**, and a default snapshot whose value changed, drop the short variant cache (30 seconds, at most 64 results). **Error** and a stale banner use a short explanation, with the code in small monospace. The stale time is a relative age, and the absolute time is on hover. An unknown format says it cannot be previewed. A library version other than the current one says the preview is unavailable. See [Live artifacts: rendering](artifacts.md#live-artifacts-rendering).

The **Details** panel has a **Live** section: each binding's id, function id, compact JSON args, and a **Read-only** badge; a status pill (**Fresh** when every binding has a snapshot, **Stale** when some do, **Error** when none do, **Refreshing** while a refresh runs, or **Live** before the first refresh); last refreshed time as a relative age, with the absolute time on hover; **Updated Ns ago** when a snapshot time is known; last error code; and each snapshot as collapsed JSON. A value longer than 32 KB says `showing first 32 KB`. **Refresh now** posts to the refresh route with a full refresh (`ifStale` false), stays disabled with **Refreshing…** while it runs, shows an error with `role=alert`, and replaces the snapshots and status when it succeeds. Opening the current version loads stored snapshots from the data route first, without running a function, and shows them immediately. It then posts one refresh with `ifStale: true` when `refresh.on_view` is not false, so a fresh snapshot does not run the function. When `refresh.auto_seconds` is set, the page says **Checking every Ns · data refreshed at most every Ms** (M is `refresh.ttl_seconds`, or 300 seconds when it is omitted) and repeats that stale check on that interval while the tab is visible. A hidden tab pauses the interval. Showing the tab again refreshes immediately when the snapshot is older than the interval. A full function queue keeps the last snapshot, marks it stale, and waits `retry_after_seconds` before the next automatic try. The page does not load snapshots or refresh until the versions list has identified the latest version. An older version (`?v=` when that version is not the latest, including when the record itself is that older version) does not call the data route and does not refresh. An expired live artifact shows the same expiry explanation as a static artifact (the sentence for `expired_reason`) in the main area, and does not show the live program note or **Refresh now**. A data response of `404` `artifact.content_unavailable` shows that explanation as well. A hidden artifact still shows the stored snapshots and does not refresh.

`?v=<N>` shows that version's program and that version's manifest bindings. The console does not load snapshots for an older version. A program with no `Query` still renders. A program with a `Query` shows **No data for this version** above the program. When snapshots are already in hand it says **Snapshots are for the current version: data shown is the latest**. The Inspector still says **Snapshots are for the current version.** Refresh now is hidden on an older version.

A published artifact has **Delete**. The dialog names the artifact and says that every version and the stored files will be removed, and that this cannot be undone. After it is deleted, the console returns to the list. If the delete fails, the dialog closes and the error is shown next to **Delete**. Indexed artifacts do not show Delete.

Rendering:

| Kind | What you see |
|---|---|
| Markdown | The same Markdown view the run file reader uses |
| Image | The image, loaded with the console control token |
| Table | A CSV file, or a JSON array of objects. Column headers sort the visible rows. The first click sorts ascending, the second descending, and the third returns to file order. The header exposes that state. Numbers sort numerically, and equal values keep their order. The table shows the first 500 rows and says `showing first 500 of N` when the file has more |
| Text | Monospace text, including an extension the index stores as text |
| HTML | A static preview. See [Static HTML](#static-html) below |
| Live | The rendered program, with **Program source** collapsed underneath. Empty, mismatched, stale, and error states stay visible |
| Live HTML | The sandboxed document when the Host has a sandbox origin, otherwise the scriptless preview. See [Live HTML](#live-html) |

A file the console cannot preview (unknown kind, or binary content) shows a card with the file info. Invalid CSV or JSON is shown as text with a note. When the record is expired, the main area explains the reason in a sentence (slimmed to save space, purged, deleted, or the file is missing) and the side panel still shows the metadata. An unknown reason code is included in that sentence. The content route answers an expired row with `404` `artifact.content_unavailable` and names the reason, including when the file is still on disk.

The console does not load non-image content larger than 5 MiB through this page.

## Static HTML

`static.html` (a `.html` or `.htm` file) renders in the detail page inside a frame. The frame shows the document's text and inline styles, and images whose source is a `data:` URL. A **Rendered** / **Source** toggle defaults to Rendered. Source is the same monospace text view as other text files.

This is not the live-HTML kind. Live HTML is a separate kind. See [Live HTML](#live-html). The preview puts the artifact in an iframe with an empty `sandbox` attribute and prepends a document whose head starts with the Content-Security-Policy meta (`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`). The empty sandbox stops scripts, reading or writing the console page, its storage, or the control token, form submission, popups, and navigation of the console tab. The policy meta, first in that head, stops network loads of images, fonts, stylesheets, frames, and fetches, and blocks form actions and `<base>` URLs. The sandbox does not stop the frame from navigating itself, so the preview removes `href` and `xlink:href` on links and image maps unless the value starts with `#`, removes `ping`, and sets the title "Link disabled in static preview" when a removed link had no title. The same `href` and `xlink:href` removal applies to `<use>`, `<image>`, `<feImage>`, and `<script>` inside `<svg>`. A fragment link such as `#top` or `#icon` still works. Comments end at `-->`, `--!>`, `<!-->`, or `<!--->`; other `<!`, `<?`, CDATA, and `</` sequences that are not an end tag are skipped until the next `>`. Tags inside comments, or inside `<script>`, `<style>`, `<textarea>`, or `<title>`, are left as written. The preparer reads the text once, including an unterminated tag or quote, so a large document stays linear in its length. Meta refresh and `<base>`, `<iframe>`, `<object>`, `<embed>`, and external stylesheets are removed before the frame is filled.

The preview says "Static preview: scripts and network access are disabled." The same frame is used from a run's Files tab for `.html` and `.htm`. Markdown, images, and other files on that tab are unchanged.

The Host still serves the bytes as `text/plain` with `nosniff`, so opening the content URL directly does not render the file as a page. For `static.html` it also sends `Content-Security-Policy: sandbox; default-src 'none'`. The run file route sends that same header for `.html` and `.htm`.

## Live HTML

`live.html` uses the same detail page as other artifacts. The side panel keeps the live block: status, last refresh, bindings, snapshots, declared origins (connect, resource, frame, and base), and **Refresh now** on the current version. **HTML source** is collapsed under the preview. An older version (`?v=`) shows that version's document and the note **Snapshots are for the current version.** Refresh now is hidden. Calls from the document for data return no data for that version. An expired record uses the same expiry card as other artifacts. The main area does not run the document on the console origin.

When `GET /api/health` has no usable sandbox origin, the preview is the scriptless HTML frame and a notice that live preview needs the sandbox origin. When the origin is present and the artifact declares external origins that are not approved, including when `live.origins` is missing, a banner sits above the frame: "This artifact asks to contact external servers. Nothing is allowed until you approve." It lists the requested origins as text, grouped as send and receive (connect), load scripts, styles, images and fonts (resources), and base URL. It says an approved origin can receive any data the artifact can read, including bound data. **Approve these origins** allows that set and rebuilds the frame. If the hash is missing the button is disabled and reads **Reload to approve**. **Keep blocked** hides the banner for this view and leaves the artifact blocked. **Review origins**, under the hidden banner and on the Live origins row, shows the banner again for this page only. The page re-reads approval on each refresh tick and when the tab becomes visible, and rebuilds the frame when the approved state or hash changed. After approval, a row reads "Origins approved (revoke)" and **Revoke** blocks the set again. The scriptless preview has no banner. The Live section of the inspector shows `Origins: approved`, `not approved`, or `none`. Details on the banner says tools cannot approve, the API needs the control token, the CLI refuses inside a stage or agent session, and a shell that can read the operator's home directory can still bypass that.

When the origin is present, the page frames the loopback name that is not the page's hostname (`localhost` frames `127.0.0.1`, and `127.0.0.1` frames `localhost`) at `{that origin}/shell.html` and talks to it only through the host bridge. The frame URL does not include the control token. A link inside the artifact does not navigate the console. If the shell does not start within five seconds, the page says **The sandbox did not start** and offers **Retry**. If the shell reports that the artifact navigated away, or that the security policy was refused, the tall frame is replaced by an alert and **Retry** builds a new frame. A hash link inside the document scrolls. A fresh artifact shows its first snapshot without a reload. A later change to a default snapshot is pushed to the document with `onBindingUpdated`. What the bridge sends and refuses is [Live HTML artifacts: console behaviour](artifacts.md#live-html-artifacts-console-behaviour).
