# Artifacts

An **artifact** is a published, indexed output with an owner and a stable id. A **run file** is any file in a stage attempt's `artifacts/` folder. A run file becomes an artifact only when it is indexed.

This page covers the artifact index, static publishing, and live artifacts.

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

This is not live HTML. Live HTML is a separate kind. Its preview uses a second loopback origin; see [Live HTML artifacts: the sandbox origin](#live-html-sandbox).

`GET /api/runs/<runId>/artifact` keeps the file body and `text/plain; charset=utf-8`. For a path whose name ends in `.html` or `.htm` it also sends `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`.

## Live HTML artifacts: the sandbox origin {#live-html-sandbox}

A live-HTML document does not run on the console origin. `sf ui` starts a second listener in the same process. On a loopback console that listener binds loopback only (`127.0.0.1` and, when available, `::1`). In a container or on any other non-loopback console bind, it listens on all interfaces (`0.0.0.0`) only when `STAGEFLOW_SANDBOX_PORT` is set; auto-pick stays off. It serves `GET /shell.html`, `GET /shell.js`, `GET /livez`, and the vendored files under `GET /libs/<name>@<version>/<file>`. Every other path is 404, including anything under `/api`, `/mcp`, or `/a2a`. The listener never reads an artifact, a control token, or a cookie, and it never sends a cookie or a redirect. A successful library response sends `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`. Other sandbox responses do not.

The console page embeds the shell:

`<iframe sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="http://<sandbox-origin>/shell.html?parent=<console-origin>">`

`allow-same-origin` on that outer frame keeps the shell on the sandbox origin, so `postMessage` has a real `event.origin`. The shell then creates a nested frame with `sandbox="allow-scripts"` only (no `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`, or `allow-downloads`), `referrerpolicy="no-referrer"`, `allow=""`, and a `srcdoc` document. Model script runs only in that nested document. Its origin is opaque (`"null"`). The shell never trusts `"null"`: it accepts a nested message only when `event.source` is that frame's `contentWindow`.

The artifact HTML is not fetched from this listener. The console sends it once, in `sf/sandbox-load`. The shell installs that document only when the CSP string matches the manifest policy shape below. It writes a fresh document: a head whose first element is that CSP meta, then the bridge client script, then the artifact markup in the body. A leading artifact doctype is removed so the meta stays first. `<base>` and `<meta http-equiv="refresh">` are removed. Scripts in the artifact are left in place, including a CSP meta the artifact itself brought: a meta policy can only add limits. The shell does not evaluate a string from the console.

### Ports and hostname

`GET /api/health` includes `sandbox_origin` (`string` or `null`) and `sandbox_origins` (`string[]`). `sandbox_origin` is the origin for the default console hostname: `http://localhost:<sandbox-port>` when the console is on `127.0.0.1`, and `http://127.0.0.1:<sandbox-port>` when the console is on `localhost`. `sandbox_origins` lists both of those names, in that order. The console picks the entry whose hostname differs from `location.hostname`. Null `sandbox_origin` and an empty `sandbox_origins` mean the listener is off and the console keeps the scriptless preview. It does not run the artifact script on the console origin. Both values are `http` origins whose hostname is `localhost` or `127.0.0.1`, with a port and no userinfo, path, or query.

| Situation | Listener |
|---|---|
| `STAGEFLOW_SANDBOX_DISABLED=1` | Off |
| `STAGEFLOW_SANDBOX_PORT` set but not an integer from 1024 to 65535 | Off |
| `STAGEFLOW_SANDBOX_PORT` set and free | That port, no fallback if it is taken |
| `STAGEFLOW_SANDBOX_PORT` unset | First free port in `[consolePort+1, consolePort+20]` |
| None of those ports bind | Off |
| Bind is `0.0.0.0`, any non-loopback address, or `STAGEFLOW_IN_DOCKER=1` | Off, unless `STAGEFLOW_SANDBOX_PORT` is set; then `0.0.0.0` inside the process (no auto-pick) |
| Console hostname is an IPv6 literal (`::` or `::1`) | Off. The log event is `sandbox.ipv6_console_unsupported`. Chrome rejects `http://[::1]:port` in `frame-ancestors` |
| Bind fails for a reason other than the port being taken (`EACCES`, an unexpected code) | Off. The log event is `sandbox.listen_failed` and the field is the error code only. The Host still starts |

Cookies ignore ports, so the sandbox hostname is not the console's advertised hostname. A console on `127.0.0.1` advertises `http://localhost:<sandbox-port>`. A console on `localhost` advertises `http://127.0.0.1:<sandbox-port>`. On loopback the listener binds `127.0.0.1` and, when the socket exists, `::1` with `ipv6Only`, so both `127.0.0.1` and `localhost` answer (`localhost` may resolve to either). In Docker or on a non-loopback console bind with `STAGEFLOW_SANDBOX_PORT` set it binds `0.0.0.0` so a published port can reach it; `sandbox_origin` and `sandbox_origins` still use the loopback names above. It does not emit an IPv6 literal in `frame-ancestors` or in the shell's allowed `parent` list. A console opened on `[::1]` does not get a sandbox. The page reads `sandbox_origins` and frames the entry whose hostname differs from `location.hostname`, so a console opened as `http://localhost:<console-port>` uses `http://127.0.0.1:<sandbox-port>` and the cookie jars stay apart. If no entry differs, or the list is empty, the page uses `sandbox_origin` when that value is a valid `http` loopback origin with a port. Invalid entries are ignored. Do not add the sandbox origin to `STAGEFLOW_ALLOWED_HOSTS`. The shell never calls the Host.

On Host shutdown the sandbox listener stops accepting new connections at the start of the drain (`close` plus `closeIdleConnections`). Existing sockets are dropped with `closeAllConnections` when the drain finishes. The console can still finish its drain after the sandbox port is refusing new connections.

`sf mcp` does not start this listener. `sandbox_origin` on its health response is null and `sandbox_origins` is `[]`.

### What the shell guarantees

Response headers on `GET /shell.html`:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; media-src 'self' data: https:; connect-src https:; frame-src about:; base-uri https:; form-action 'none'; object-src 'none'; frame-ancestors <console origins>` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `no-store` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), clipboard-read=(), usb=(), serial=(), payment=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

The shell header is the ceiling. The browser applies it to the shell and, again, to the nested `srcdoc` document. A Content-Security-Policy `<meta>` can only add limits, so the nested document's effective policy is the intersection of this header and the manifest meta. The shell page is static audited code: the HTML contains no inline script and no event handler, the only script is `/shell.js`, and the query string is read in that script rather than written into the document. The header allows `https:` on the directives the nested document narrows (`script-src`, `style-src`, `img-src`, `font-src`, `media-src`, `connect-src`, and `base-uri`). `'unsafe-inline'` is on `script-src` and `style-src` so the inherited ceiling still lets the bridge script, the artifact script, and inline style run. `'self'` is on `script-src`, `style-src`, `img-src`, `font-src`, and `media-src` so the shell origin can serve `/shell.js` and the vendored library files. `connect-src` stays `https:` only, with no `'self'`, so a nested document cannot fetch `/shell.html` or `/libs`. `frame-src` is `about:` only. A `srcdoc` document's URL is `about:srcdoc`, which `about:` allows, and `https:` is not on `frame-src`. `form-action` and `object-src` stay `'none'`. `default-src` stays `'none'`. `base-uri` stays `https:`.

The meta policy is the manifest string (`script-src 'unsafe-inline'` plus the declared `resourceDomains`, and the same shape for style, image, font, media, connect, and base). `frame-src` in that string is always `'none'`. The shell accepts the load only when that string is exactly that shape: those directives, in that order, using only `'none'`, `'unsafe-inline'`, `data:`, and canonical `https` origins or single-level wildcards, with `frame-src`, `form-action`, and `object-src` each exactly `'none'`. An unknown directive, an `http:` origin, a wildcard in any other position, `'unsafe-eval'`, `'self'`, a `frame-src` other than `'none'`, a duplicate or missing directive, a newline, or a value longer than 8192 characters is refused. The shell posts `sf/sandbox-error` with `{ reason: "csp" }` and does not set `srcdoc`. The meta cannot widen the header. This check is what stops a malformed policy from being dropped by the browser and leaving only the ceiling.

`frame-ancestors` lists the console origins (the listen origin, both loopback names of that port, `STAGEFLOW_PUBLIC_URL` when set, and non-loopback allowed hosts). An IPv6 literal is left out. There is no `Cross-Origin-Resource-Policy` header: a framed navigation does not need one, and `same-origin` would refuse the embed.

Navigation of a child frame is checked against the embedding document's `frame-src` (CSP Level 3), not against the frame's own `connect-src`. The shell is the embedder of the `srcdoc` document. `frame-src` is `about:` only, which is enough for `about:srcdoc` and is not enough for an `https` URL. In Chrome 152 the embedder reports `securitypolicyviolation` for `frame-src` when the nested script assigns `location.href`, calls `location.assign` or `location.replace`, assigns `window.location` or `document.location`, or injects a meta refresh to an `https` URL. That blocks the request. The same Chrome still unloads the opaque `srcdoc` document, so the sentinel does not survive those calls. The shell treats the following `load` as a second load, removes the nested frame, stops the relay, and posts `sf/sandbox-error` with `{ reason: "navigated" }`. `connect-src` does not govern that navigation. A programmatic link click is cancelled by the bridge and the document stays. `form.submit` and `form.requestSubmit` are blocked by the `allow-scripts`-only sandbox before CSP, with no `securitypolicyviolation`, and the document stays. `window.open` returns null and the document stays. The manifest meta cannot widen `frame-src`: `buildHtmlCsp` always emits `frame-src 'none'`, and the shell accepts a load only when the meta's `frame-src` is `'none'`. An artifact cannot embed an `iframe`, `frame`, `object`, or `embed`.

The nested `sandbox="allow-scripts"` attribute is the isolation boundary. Inside it, inline script can run and `window.stageflow` can call the bridge. The document cannot read the console page, use the console origin's storage or cookies, open a popup, navigate the console tab, submit a form, or start a download. A link click whose `href` attribute starts with `#` (`<a>` and `<area>`) is cancelled and the document scrolls to that target: `#` and `#top` scroll to the top, and any other fragment uses `document.getElementById` after `decodeURIComponent`, then `getElementsByName`. The click does not write `location`. A missing target still does not navigate. Every other link is cancelled and reported as `ui/notifications/link-blocked`. A programmatic `location` write, including `location.hash`, `location.href`, `assign`, and `replace`, is unsupported. The bridge cannot reliably prevent it on an opaque `srcdoc` document. In Chrome 152 those `Location` properties are not replaceable, the Navigation API does not fire, and the fragment is resolved against the shell URL, so `frame-src about:` blocks it and the load guard removes the frame (`sf/sandbox-error` with `{ reason: "navigated" }`). The shell `frame-src` is what reports and blocks an `https` navigation. The sandbox keeps that navigation off the console tab.

What an artifact can send off the machine is a request or a resource load to an `https` origin declared in `connectDomains` or `resourceDomains`. Network and base URLs follow the intersection of the shell header and the manifest meta:

- `https` script, style, image, font, and media URLs are limited to `resourceDomains`. `data:` images, fonts, and media stay allowed.
- `fetch`, XHR, `EventSource`, `WebSocket`, and other `https` connections are limited to `connectDomains`.
- Child frames are not available. `frame-src` is `'none'` in the meta and `about:` on the shell, which is only enough for the shell's own `srcdoc` frame.
- A base URL is limited to `baseUriDomains`.
- Form submission, plugins, `http:` URLs, and any origin outside those lists are blocked. An empty manifest blocks every external request.

Timing and other side channels are not closed by this policy. `default-src 'none'` is the fallback for fetch directives (`script-src`, `img-src`, `connect-src`, and the rest). DNS prefetch and `preconnect` are not those fetches. A dynamic `<link rel="dns-prefetch">` inside a live document produced no `securitypolicyviolation` in Chrome 152 (`scripts/sandbox-browser-check.ts`, count 0), so a DNS lookup from that hint stays an open side channel. `X-DNS-Prefetch-Control: off` was not verified to change that: the same hint already produced no violation without the header, so this document does not claim the header closes explicit `dns-prefetch` or `preconnect` hints. The publish scan still rejects a `dns-prefetch` or `preconnect` link whose origin is not in `connectDomains`.

The shell relays only JSON-RPC messages that pass the bridge checks, only from the console origin named by `parent` (that value must be one of the origins baked into `/shell.js`) or from the nested frame. Every console message after the load carries the nonce from `sf/sandbox-load` (32 hex characters). Relay messages are capped at 256 KiB and 200 per second per direction, with at most 100 in-flight requests per direction. The HTML in the load is capped at 512 KiB. The shell sets the nested frame's height from `ui/notifications/size-changed`, clamped to 4,000 px, and forwards that notification. On the shell relay path only, `width` and `height` in that notification are clamped to 8,192 px and 4,000 px before the bridge parser runs; non-numeric dimensions are still rejected. The injected bridge client applies the same limits before it posts.

The bridge script inside the artifact document handles `<a>` and `<area>` clicks in the capture phase. An `href` that starts with `#` scrolls in place and does not change `location`. Any other link is `ui/notifications/link-blocked` with `href` truncated to 200 characters. The script also posts `ui/notifications/size-changed` from a `ResizeObserver`, debounced by 100 ms, with `width` and `height` clamped to those protocol limits. Programmatic `location` writes are unsupported and end in the load guard tearing the frame down.

When a nested request fails validation or exceeds relay limits, the shell replies to the nested frame with a JSON-RPC error (`-32600` invalid request, `-32602` invalid params, `-32601` method not found, or `-32000` rate or in-flight limit). Notifications with no usable id stay silent. Error messages are generic and do not echo attacker-controlled fields.

### Bridge

Messages are JSON-RPC 2.0. The protocol version string is `2026-01-26`. Methods:

| Method | Direction | Role |
|---|---|---|
| `ui/initialize` | nested to host | Request. Result carries `hostContext`, including the `--sf-*` variables the host may pass |
| `ui/notifications/initialized` | nested to host | Notification |
| `ui/notifications/size-changed` | nested to host | `{ width?, height }` |
| `ui/notifications/host-context-changed` | host to nested | Theme and variable updates |
| `ui/notifications/link-blocked` | nested to host | `{ href? }` |
| `ui/notifications/binding-updated` | host to nested | `{ binding_id }`. `binding_id` matches `^[a-z][a-z0-9_]{0,31}$` (1 to 32 characters). The shell forwards this only from the console into the nested frame |
| `tools/call` | nested to host | `{ name, arguments? }` for one declared binding id. Result is `{ content, structuredContent, isError?, _meta: { source: "cache" or "executed", fetched_at, retryable? } }`. `retryable`, when present, is a boolean |
| `ping` | either | Request |

Any other method is JSON-RPC error `-32601`. An id is a safe integer or a string of 1 to 64 visible ASCII characters. Unknown fields are rejected. The control token is not a field on any of these messages.

Shell messages, which are not bridge methods:

- `sf/sandbox-ready` — shell to console, `{ version: 1 }`, targeted at the `parent` origin.
- `sf/sandbox-load` — console to shell, once, `{ html, csp, nonce }`.
- `sf/sandbox-error` — shell to console, `{ reason }`. `reason` is `"csp"` when that CSP string is not the manifest policy shape (the nested document is not installed) or `"navigated"` when a second nested load is observed (the frame is removed and the relay stops).
- `sf/sandbox-relay` — either direction after the load, `{ nonce, message }` where `message` is a bridge message.

The page-side object is `window.stageflow` with `initialize()`, `callBinding(bindingId, args?)`, `onHostContextChanged(cb)`, `onThemeChanged(cb)`, and `onBindingUpdated(cb)`. `initialize` applies the host variables to the document element. `callBinding` validates `arguments` against the same JSON-object rules as the bridge (`callBinding` rejects immediately with `Error` code `invalid_arguments` when a key, value, depth, or size is invalid). It resolves to `structuredContent` on success. When the host answers `tools/call` with `isError: true`, `callBinding` rejects with an `Error`. If that result's `_meta.retryable` is `true`, the error's `retryable` property is `true`. Each request times out after 30 seconds (`ping` after 10 seconds) with `Error` code `timeout`. At most 100 requests may be pending at once. `onBindingUpdated` may be registered more than once. Each callback receives the `binding_id` string from `ui/notifications/binding-updated`.

Variables the host may pass: `--sf-ground`, `--sf-panel`, `--sf-raised`, `--sf-text-1`, `--sf-text-2`, `--sf-text-3`, `--sf-hairline`, `--sf-running`, `--sf-ok`, `--sf-needs`, `--sf-fail`, `--sf-font-ui`, `--sf-font-mono`.

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
| `artifact.invalid_kind` | kind is missing or not a static kind, `live.declarative`, or `live.html` |
| `artifact.html_csp_violation` | a live HTML document references an origin, URL, form, or refresh that its manifest does not allow |
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

A project agent publishes and reads artifacts when its definition grants the groups. `artifacts.read` grants the ask-first id `stageflow.get_artifact`. The model calls `stageflow_get_artifact` (list and read any owner's artifacts in the session's project). A `project_root` other than that project is `artifact.not_found`, and an omitted one means the session's project. `artifacts.write` grants the ask-first id `publish_artifact`. The model calls `publish_artifact`. The Host MCP tool `save_artifact` lets the caller pick an owner, so an agent session never receives it. `publish_artifact` always stores the owner as `agent:<this agent>`, the project as the session's project, and the source as that session (`kind: agent`, `source_session_id` set). `artifacts.cleanup` grants the ask-first id `stageflow.delete_artifact`. The model calls `stageflow_delete_artifact`, which deletes only an artifact this agent owns in the session's project. Another owner's key, or a `project_root` other than that project, is `artifact.not_found` and nothing is deleted. Omitting `project_root` still deletes only in the session's project. `artifacts.refresh` grants `stageflow.refresh_artifact` (ask-first id `stageflow.refresh_artifact`). It refreshes only an artifact this agent owns in the session's project. Another owner's key, or another project, is `artifact.not_found` and nothing runs.

`publish_artifact` takes the same arguments as the stage tool: `id`, `kind`, `title`, optional `description`, `tags`, and `summary`, and one of `path`, `content`, or `content_base64`. `path` is relative to the project root and uses the agent path guard: no absolute path, no `..`, no symlink, no `*.agent.yaml` under `agents/`, and nothing under `$STAGEFLOW_HOME` outside the project. The size is checked before the read. Over 5 MiB is `artifact.too_large`. For every kind except `static.image`, the bytes are checked as UTF-8 and scrubbed before they are stored, whether they came from `content`, `content_base64`, or `path`. Bytes that are not valid UTF-8 are `artifact.invalid_shape`. Image bytes are stored unchanged. Ask-first ids are `publish_artifact`, `stageflow.get_artifact`, `stageflow.delete_artifact`, and `stageflow.refresh_artifact`, and only when that group is granted. Those ids are what goes in `approvals.ask_first`. The names in the system prompt are the tools the model calls: `publish_artifact`, `stageflow_get_artifact`, `stageflow_delete_artifact`, and `stageflow_refresh_artifact`.

The system prompt gains a short section only when `artifacts.write` is granted, and one sentence about `stageflow_get_artifact` when the agent has `artifacts.read`. An agent with `artifacts.cleanup` is told to call `stageflow_delete_artifact`. An agent with `artifacts.refresh` is told to call `stageflow_refresh_artifact`. Other agents keep the same prompt and tool list.

An eval session publishes with `hidden = 1` under `eval:agent:<id>/<artifact id>`. Those rows stay out of the list, search, MCP, and this page. Under the eval `read_only` policy, `publish_artifact`, `stageflow_delete_artifact`, and `stageflow_refresh_artifact` are stubbed and write nothing. Under `real`, the session can delete a visible artifact owned by that agent, because `real` runs the real tools. See [Agent runtime](agent-runtime.md#artifacts-in-an-eval-session).

The Artifacts page shows an agent owner as `agent · <id>` and links to that agent's page.

`GET /api/runs/<id>` (the console run page), `sf run --json --include stages` and `sf runs show --json` add `published_artifacts` (`key`, `version`, `kind`, `title`) on a stage that published during that run. The list is the versions that run published, including an unchanged republish of a version another run created. `version` is the version that attempt published, not a later current version. A later run that republishes the same id does not remove an earlier run's entry. The field is left off when the list is empty. Hidden eval publishes are left off.

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

`live.declarative` is shipped as a program plus read-only bindings. Refresh is CLI, MCP, and the console. The console renders the program. See [Live artifacts](#live-artifacts).

### Caps and versions

Decoded content is at most **5 MiB**. The Host keeps the latest **`STAGEFLOW_ARTIFACT_VERSIONS_KEEP`** versions (default **10**, integer 1–1000) plus any pinned version. Publishing the same owner and id with identical bytes and kind returns **`unchanged: true`** (no new version row); title, description, tags, and summary still update.

### `expect`

`expect: [id, …]` on the stage body requires each id to be published in that attempt before a **success** envelope. A missing id fails emit with **`artifact.expected_missing`**. An unchanged republish still counts if the tool ran.

### Agents versus stages

Stages publish only when the body opts in. Agents publish when granted **`artifacts.write`** (`publish_artifact`, ask-first id **`publish_artifact`**). Agents read with **`artifacts.read`** (`stageflow_get_artifact`). Agents delete only their own published rows with **`artifacts.cleanup`**. The MCP tool **`save_artifact`** is for operators picking an owner; agent sessions never get it.

### Security

Never publish secrets. Text kinds are UTF-8-checked and scrubbed before store. **`static.html`** is rendered in a sandboxed preview without script execution or network. **`unchanged: true`** means the stored bytes and kind match the current version; metadata fields may still change.

## Live artifacts {#live-artifacts}

`live.declarative` is a published artifact whose content is an OpenUI Lang program and whose manifest names read-only tool functions. A refresh runs those functions and stores snapshots. It does not create a version, start a run, or call a model. The console renders the current library version. See [Live artifacts: rendering](#live-artifacts-rendering).

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

## Live HTML artifacts

`live.html` is one HTML document with inline JavaScript and CSS allowed. The content is UTF-8 and at most 256 KiB. The stored file is `document.html`. The manifest is:

```json
{
  "format": "html",
  "csp": {
    "connectDomains": ["https://api.example.com"],
    "resourceDomains": ["https://cdn.example.com"],
    "baseUriDomains": ["https://app.example.com"]
  },
  "bindings": [{ "id": "rows", "function": "revenue_by_week", "args": { "weeks": 12 } }],
  "refresh": { "on_view": true, "ttl_seconds": 300, "auto_seconds": 60 }
}
```

`format` must be `html`. `library` is rejected. `libraries` may be omitted or `[]`. A non-empty list names Host-vendored libraries; see [Live HTML artifacts: libraries](#live-html-libraries). `bindings` and `refresh` use the same rules and the same eligibility checks as `live.declarative`. Omitting `bindings` stores an empty list. An unknown manifest key is `artifact.invalid_shape`.

Each `csp` list is optional, has at most 8 entries, and defaults to none. An entry is `https://host[:port]` or a single-level wildcard `https://*.example.com`. The host is lowercased. Port 443 is omitted. Duplicates after that normalisation are rejected. A path, query, userinfo, `http:` URL, `data:` URL, `blob:` URL, `javascript:` URL, bare host, IP address, `localhost` name, or a name ending in `.local`, `.internal`, or `.localhost` is `artifact.invalid_shape`. Issue paths look like `manifest.csp.connectDomains[2]`. A hostname longer than 253 characters is rejected.

`frameDomains` may be omitted or `[]`. A non-empty `frameDomains` is `400` `artifact.invalid_shape` with the message `frameDomains is not supported: sandboxed artifacts cannot embed frames`. The empty value stays accepted so an older manifest shape still parses. The built policy does not copy that list.

The sandbox policy built from that manifest is exactly:

```text
default-src 'none'; script-src 'unsafe-inline' <resourceDomains>; style-src 'unsafe-inline' <resourceDomains>; img-src data: <resourceDomains>; font-src data: <resourceDomains>; media-src data: <resourceDomains>; connect-src <connectDomains or 'none'>; frame-src 'none'; base-uri <baseUriDomains or 'none'>; form-action 'none'; object-src 'none'
```

Declared origins are sorted. There is no `'unsafe-eval'` and no `'self'` in the meta policy. The nested document is an opaque `srcdoc` frame, so `'self'` in that meta would not name the sandbox origin. When `libraries` is non-empty, the meta policy adds one path source per selected library, `<shell origin>/libs/<name>@<version>/`, on `script-src` and `style-src`. A trailing slash is a directory prefix, so the document can load that library's files and not `/shell.js` or another library. Leaflet also adds that directory to `img-src` and `font-src`. `'unsafe-eval'` is added to `script-src` only for a library flagged `needsEval`. The shell header's `'self'` is the ceiling; the meta path sources are what the nested document must also satisfy.

## Live HTML artifacts: libraries {#live-html-libraries}

An artifact does not write library URLs. The manifest lists `{ "name", "version" }` pairs. The shell injects the `<script>` and stylesheet tags, with `integrity` (sha384) and `crossorigin="anonymous"`, from the sandbox origin (`/libs/<name>@<version>/<file>`), in the order declared, before the artifact markup. The artifact uses the library's global. At most 6 libraries, and each name once. An unknown name or version is `artifact.invalid_shape` with `unknown library <name>@<version>` and the available pairs.

| Name | Version | Global | Licence | Approx. size | Eval |
|------|---------|--------|---------|--------------|------|
| chartjs | 4.6.2 | `Chart` | MIT | 208 KiB | no |
| d3 | 7.9.2 | `d3` | ISC | 274 KiB | no |
| echarts | 6.1.0 | `echarts` | Apache-2.0 | 1.1 MiB | no |
| leaflet | 1.9.4 | `L` | BSD-2-Clause | 165 KiB (JS, CSS, marker images) | no |
| mermaid | 12.3.0 | `mermaid` | MIT | 5.3 MiB | yes |

Chart.js, D3, and ECharts are the minified UMD builds (`chart.umd.min.js`, `d3.min.js`, `echarts.min.js`). D3's CSV row compiler and ECharts's geoJSON fallback call `new Function` only on those paths; a chart, a selection, or `echarts.init` does not. Leaflet's CSS loads marker images from the same directory on the sandbox origin.

Mermaid 12.3.0 ships as one `mermaid.min.js` file (no dynamic `import()`), but its bundle calls `Function()` while starting (lodash's root lookup). That needs `'unsafe-eval'`. The library is in the catalog with `needsEval: true` and is refused unless the entry sets `allowEval: true` and the Host is started with `STAGEFLOW_ARTIFACT_ALLOW_EVAL_LIBS=1`. The shell is given that decision when it is served, and it rejects `'unsafe-eval'` unless the load message also sets `allowEval: true`. A console page cannot turn eval on by itself.

To select Chart.js:

```json
"libraries": [{ "name": "chartjs", "version": "4.6.2" }]
```

The page then uses `new Chart(...)`. External scripts and stylesheets on a declared `https` origin still need an `integrity` attribute (`sha256-`, `sha384-`, or `sha512-`, base64) and `crossorigin="anonymous"` (or an empty `crossorigin`). Publish checks the attribute shape. The browser checks the bytes. A script that points at `/libs` or at the sandbox origin is an undeclared origin: authors use the manifest, not a hand-written `src`.

A declared `https` origin is a request. It does not take effect until an operator approves that exact set. See [Live HTML artifacts: origin approval](#live-html-origin-approval). Vendored libraries are Host-owned and need no approval.

Upgrade a library by installing the exact version, running `node scripts/vendor-artifact-libs.mjs --update`, and committing the hash and size change in `src/artifacts/library/htmlLibraries.json`. `npm run build` copies the files into `dist/sandbox-libs` and copies that JSON next to the compiled catalog. The integrity test recomputes sha384 for every file and fails if the table drifted. The binaries are not committed.

Publish scans the document before anything is written. The scan is one forward pass. It stops when the document is over 256 KiB, a line is over 64 KiB, an attribute value is over 16 KiB, there are more than 20,000 elements, or 150 ms have passed. It collects `script src`, `link href` and `imagesrcset` (including a stylesheet `<link>` in the body), `img src` and `srcset`, `source` / `video` / `audio` / `track src`, `video poster`, `background` on `body` / `table` / `td` / `th` / `tr`, `input type=image` `src`, `base href`, form `action` and `formaction`, `meta http-equiv=refresh`, CSS in `<style>` and `style` attributes (`url()`, `image-set()`, `src()`, `image()`, and `@import`, after comments are removed and CSS escapes are decoded), and SVG `use` / `image` / `feImage` `href` and `xlink:href`. Any `iframe`, `frame`, `object`, or `embed` element is rejected on its own, with or without `src`, `srcdoc`, or `data`. It does not parse `import()` or `new URL(` inside scripts. Those URLs cannot be known statically.

An absolute or protocol-relative URL must be covered by the matching list: script, stylesheet, image, media, and font references use `resourceDomains`; a base URL uses `baseUriDomains`. Otherwise publish is `400` `artifact.html_csp_violation`. The issue path is the element and attribute, for example `img[0].src`, and the message names the origin and the list. An embedded frame or object uses the element path, for example `iframe[0]`, and the message `embedded frames and objects are not allowed`:

```json
{
  "error": "origin https://cdn.example.com is not declared in resourceDomains",
  "code": "artifact.html_csp_violation",
  "issues": [
    {
      "path": "img[0].src",
      "code": "html_csp_violation",
      "message": "origin https://cdn.example.com is not declared in resourceDomains"
    }
  ]
}
```

`javascript:` and `data:` URLs are rejected on `script`. `iframe`, `frame`, `object`, and `embed` are rejected as elements, before their URL is classified. `data:` is allowed on images, fonts, and media. A relative URL such as `script src="app.js"` is rejected with `relative URLs cannot be resolved inside a sandboxed document`. `meta http-equiv=refresh` is always rejected. A `form` `action` or `formaction` is always rejected. An `<a href>` is kept and returned as a warning, `links are disabled in the preview`. If a script body contains `fetch(`, `XMLHttpRequest`, `WebSocket`, or `EventSource` and `connectDomains` is empty, publish succeeds with the warning `script uses the network but connectDomains is empty: requests will be blocked`. A `live.html` publish whose manifest declares any origin also warns `origins need approval in the console before they take effect`. The stage and agent tool results include that warning. Warnings use the same `warnings` array as a declarative publish.

The same bytes and canonical manifest keep the current version. Search indexes the title, description, tags, and summary only, never the HTML body. Refresh, data, and query treat `live.html` as a live artifact: bindings run through the same engine as `live.declarative`. Eval-origin publishes are validated the same way and stay hidden.

The console runs the document only when the Host has a sandbox origin. Until that origin is available, the preview does not execute the document. `GET` of the content from the console origin sends `Content-Security-Policy: sandbox; default-src 'none'`.

## Live HTML artifacts: origin approval {#live-html-origin-approval}

`csp.connectDomains`, `csp.resourceDomains`, and `csp.baseUriDomains` are requests. `frameDomains` stays empty. Until an operator approves the exact set, the console sends the shell an empty CSP: the policy from `buildHtmlCsp` with no declared origins. Vendored library allowances still apply, including `'unsafe-eval'` only for a library the Host has already allowed. The artifact runs in that strict form. The page shows an approval banner above the frame. Removing every declared origin needs no approval and is treated as approved.

Approval is stored per artifact storage key and per set. The set is normalised (lowercase host, port 443 omitted, sorted, duplicates removed) and hashed with sha256 of that canonical JSON (`origins_hash`). Republishing the same set keeps the approval. Any change to the set is a new hash and needs approval again. The Host keeps at most 8 approval rows per artifact and drops the oldest. Deleting the artifact deletes its rows. The rows live in `state.db`, so backup includes them. Search does not read them.

An approved connect origin can receive any data the artifact can read, including bound function results. Approving is consent to that. A script or stylesheet loaded from an approved resource origin still needs an `integrity` hash (`sha256-`, `sha384-`, or `sha512-`) and `crossorigin="anonymous"`. Publish checks the attribute. The browser checks the bytes.

Approval is an operator action. There is no MCP tool and no in-session tool, so a stage or agent tool cannot approve. `POST /api/artifacts/<ownerKey>/<id>/origins/approve` and the matching revoke route need the control token. The stage environment builder never copies `STAGEFLOW_CONTROL_TOKEN`, `STAGEFLOW_CONTROL_TOKEN_FILE`, or `STAGEFLOW_CONTROL_TOKEN_*` into a stage, including when `STAGEFLOW_STAGE_ENV_PASSTHROUGH=all` or `STAGEFLOW_STAGE_ENV_ALLOW` names them. `sf artifact approve-origins` and `sf artifact revoke-origins` exit 1 with `approval is an operator action: refused inside a stage or agent session` when the process environment has a stage-session marker (`SF_STAGE_WORKER=1`, `SF_WORKER_STAGEFLOW_HOME`, `STAGEFLOW_STAGE_ARTIFACTS_DIR`, `STAGEFLOW_RUN_ID`, `STAGEFLOW_STAGE_ID`, `STAGEFLOW_RUN_WORKSPACE`, `STAGEFLOW_CHECKOUT`, `STAGEFLOW_REPOSITORY`, `STAGEFLOW_REF`, `STAGEFLOW_BASE_SHA`, or `STAGEFLOW_RUN_BRANCH`). `--yes` does not override that. `sf artifact origins` still reads. Agent sessions run in the Host process, so their shell inherits the Host environment and this CLI check does not see them. A model with unrestricted shell access and the operator's home directory can still bypass any of this: stages run with a curated environment, but a shell command runs as the operator and can read the control token file or `state.db` and write an approval itself. Hidden and eval-namespace artifacts are not approvable (`artifact.not_found`). A static or declarative artifact, or a live HTML manifest with no declared origins, is `artifact.invalid_shape` with the message `no origins to approve`.

`POST /api/artifacts/<ownerKey>/<id>/origins/approve` with `{ "origins_hash": "<sha256>", "version": 2 }` approves the current version, or `version` when that version exists. Unknown fields are rejected. The body cap is 64 KiB. The route needs the control token (`drive`) and the same Origin check as other `/api` writes. It returns `{ origins, approved: true, approved_at }`. `origins` is `{ connect, resource, base, hash, approved, approved_at }`. `DELETE /api/artifacts/<ownerKey>/<id>/origins/approval` revokes every set. `?origins_hash=` revokes one. `approved_by` is `api` for this route and `cli` for the CLI.

| Code | When |
|------|------|
| `artifact.not_found` | the artifact is missing, hidden, or eval, or `version` does not exist |
| `artifact.origins_mismatch` | 409. `origins_hash` is not the hash of the version being approved. The body includes `current_hash` |
| `artifact.invalid_shape` | no origins to approve, a bad hash, or an unknown field |
| `artifact.too_large` | the approve body is over 64 KiB |
| `artifact.ambiguous` | the owner and id exist in more than one project and `project_root` was omitted |

The record's `live.origins` carries the same object for `live.html`. Empty lists are `approved: true`. If the manifest declares any origin and `live.origins` is missing or not approved, the console sends the empty policy and shows the banner from the declared lists. A missing hash disables **Approve these origins** and the button reads **Reload to approve**. The console banner says nothing is allowed until you approve, lists each origin as text (not a link), and shows the first 8 characters of the hash when it has one. **Approve these origins** calls the route and rebuilds the frame with the full CSP and a new nonce. **Keep blocked** hides the banner for that view and leaves the empty policy. **Review origins** in that place, and the same button on the inspector Live origins row, shows the banner again. That choice stays in the page and is not stored. The open page re-reads `live.origins` on each live refresh tick and when the tab becomes visible, and rebuilds the frame when the hash or the approved flag changed, so a CLI revoke or a republish shows up without a manual reload. After approval, **Revoke** deletes the row and rebuilds the frame with the empty policy. The scriptless preview (no sandbox origin) has no banner. The inspector Live section reads `Origins: approved`, `not approved`, or `none`. The banner Details text states the same limit as this section: tools cannot approve, the API needs the control token, the CLI refuses in a session environment, and a shell that can read the operator's home directory can still bypass that.

### Live HTML artifacts: console behaviour

The detail page reads `sandbox_origin` and `sandbox_origins` from `GET /api/health`. Both are absent until the catalog's health poll returns. The page frames the `sandbox_origins` entry whose hostname differs from `location.hostname`. A console opened as `http://localhost:<console-port>` uses `http://127.0.0.1:<sandbox-port>`. A console opened as `http://127.0.0.1:<console-port>` uses `http://localhost:<sandbox-port>`. Each candidate has to be `http`, hostname `localhost` or `127.0.0.1`, port 1–65535, and no userinfo, path, query, or hash. Anything else is ignored. If no entry differs, or the list is empty, the page uses `sandbox_origin` when that value passes the same check. An IPv6 literal `location.hostname` does not embed the shell. A null result keeps the scriptless preview. The same poll updates the origin when the Host comes back.

When the origin is missing, the page shows: "Live preview needs the sandbox origin, which is not available on this Host. Showing a static preview with scripts disabled." The anchor text is "Live HTML artifacts: the sandbox origin" and it does not navigate. Under that notice, the page uses the same scriptless preview as `static.html` (Rendered / Source, empty sandbox, scripts disabled).

When the origin is a string, the page embeds:

`<iframe sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="{chosen sandbox origin}/shell.html?parent={console origin}">`

`allow-same-origin` is only on that outer frame. The page does not add `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`, or `allow-downloads`. The iframe URL is the shell and the console origin. It does not carry the control token, an API path, or the artifact.

The host bridge accepts `sf/sandbox-ready` only when `event.source` is that frame's `contentWindow` and `event.origin` is the chosen sandbox origin. It ignores `origin` `"null"`, other windows, a second ready, and any other `sf/*` method it does not handle. It then sends one `sf/sandbox-load` with the HTML, a CSP string, and a 128-bit hex nonce. When `live.origins.approved` is true, or the artifact declares no origins, that string is built from `manifest.csp`. When declared origins are missing or not approved, the string is the empty policy plus the selected libraries' directory path sources. Missing `live.origins` does not send the declared origins. Approving or revoking builds a new frame and a new nonce. `targetOrigin` is the chosen sandbox origin. Later host messages are `sf/sandbox-relay` with that nonce. Replies use the same envelope. The bridge drops a relay whose nonce does not match, whose inner message is over 256 KiB, or whose message fails the bridge parser, including an unknown method. It also drops traffic over 200 messages per second. It does not answer those drops. The console imports that parser from `src/artifacts/bridge/protocol.ts`. It does not keep a second copy. The CSP string the console sends is still built beside the frame (`liveHtmlDocumentCsp`), because `buildHtmlCsp` lives in a module that imports Node.

`ui/initialize` is answered with the host context: theme `dark`, `platform` `web`, locale, time zone, the container width, and only the `--sf-*` variables named by the bridge. `hostCapabilities.sandbox.csp` is the same policy string as the load. `ping` answers `{}`. `ui/notifications/initialized` is accepted and not answered. `ui/notifications/size-changed` sets the outer frame height, clamped to 200–4,000 px. `ui/notifications/link-blocked` shows "A link in this artifact was blocked" for five seconds. The console does not open the href and does not navigate. Recreating the frame clears that timer and the ready timer.

`sf/sandbox-error` replaces the tall frame with an alert. `navigated` says "This artifact tried to navigate away and was stopped for your safety." `csp` says "The sandbox refused this artifact's security policy (this is a bug: please report it)." Any other reason says "The sandbox stopped this artifact." Each alert has Retry and a collapsed Details block with the reason and the sandbox origin. Retry builds a new frame and a new nonce. The outer shell iframe is collapsed to a small height once the nested frame is gone. Messages that arrive after the error are ignored.

`tools/call` runs only a declared binding id. An unknown id returns `isError` with the message `unknown binding`. On an older version (`?v=`), every known binding returns `isError` with `no data for this version`. Arguments that are absent or equal to the binding's default args use the stored snapshot for the current version. If that snapshot is not in yet and the page is still loading or refreshing, the call waits up to 10 seconds. The wait is cancelled when the frame unmounts. If there is still no snapshot, or the refresh failed, the result is `isError` with the text `no data yet` and `_meta.retryable` `true`. The artifact's `callBinding` turns that into an error whose `retryable` property is `true`. Different arguments call `POST /api/artifacts/.../query` for that binding id. Identical calls share one in-flight request and a 30 second cache, the same window as the declarative preview. The cache key includes the project root, owner, artifact id, and version, so two projects do not share variant results. A success is `{ content, structuredContent, _meta: { source, fetched_at } }`. A network error, a query error, or HTTP 503 is `isError` with a short message. HTTP 503 also puts `retry_after_seconds` on `_meta` when the Host sent one. The frame may have 8 calls in flight and 20 per second. Past either limit the result is `isError` with `rate limited`.

When a default snapshot arrives, or its value changes, the page sends `ui/notifications/binding-updated` with `{ binding_id }` through `sf/sandbox-relay`. The message is the one `buildBindingUpdated` builds. The document can listen with `window.stageflow.onBindingUpdated`. The page sends that notice after **Refresh now** and after an automatic refresh when the value changed. The same value, including a new fetch time, does not send it. Variant results are not pushed; the document asks again with `tools/call`. The page sends at most 10 of these notices per second for each binding. A Host refresh still clears the 30 second variant cache.

Nothing on the bridge is the control token, an API URL, or a credential. The HTML and the CSP string are the document the operator already opened.

States: a skeleton while the HTML is loading and while the shell has not sent ready; "The sandbox did not start" after 5 seconds, with Retry and a Details block that shows the sandbox origin; the sandbox-stopped alert above; "Could not load the HTML" when the content request fails; the expiry card when the record is expired; "Library n/a" when the stored format is not `html`. The side panel still lists bindings, status, snapshots, declared origins, and Refresh now for the current version. HTML source stays in a collapsed block. An older version renders that version's HTML and says "Snapshots are for the current version." A fresh artifact with no stored snapshot shows its data when the first refresh lands. The page does not need a reload.

`sf artifact publish --kind live.html --file page.html --manifest manifest.json` publishes the document. The stage and agent tools pass `format`, `csp`, `bindings`, and optional `refresh`.

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

### Live artifacts: rendering

The detail page renders `format: openui-lang` with the Stageflow library. `live.format` on the artifact record is the manifest format. Another format shows **Cannot preview this format**, and the program text stays collapsed under **Program source**. The renderer is a lazy chunk: the main console bundle does not load `@openuidev/react-lang` or `@openuidev/react-ui`.

The theme is `createTheme` inside a `ThemeProvider` scoped to the preview (`.sf-live-artifact`), using the console `--sf-*` colors, Geist, and Geist Mono. Chart series use the status colors in this order: running, ok, needs, fail, queued. OpenUI otherwise paints a single series from the middle of the palette, so the renderer passes a palette that puts the first color on the first series. Bar charts use a wider bar cap so a bar fills its category band instead of staying a hairline. `TextContent` sizes are `small` (12px), `default` (13px), `large` (20px), `small-heavy` (12px, weight 600), and `large-heavy` (28px, weight 600). Long strings wrap inside the preview.

`Query(tool, args, default, refreshSeconds)` reads a bound function. When `args` match that binding's default args, the preview uses the stored snapshot. When `args` differ (a `$variable` filter), the preview posts `{ binding_id, args }` to `POST /api/artifacts/<ownerKey>/<id>/query` and uses `snapshot.value`. Those viewer args are the binding defaults with the filter values shallow-merged on top. Identical in-flight posts share one request. A repeat of the same args within 30 seconds reuses that result. The preview keeps at most 64 of those results and drops the oldest. That cache is cleared when a refresh starts and when a new default snapshot has a different value, so the next variant read is not a stale one. The `refreshSeconds` argument is ignored. OpenUI keeps a query result until its arguments change. A new default snapshot remounts the renderer only when the canonical JSON of a binding's value changes. A new `fetched_at` with the same value leaves the preview mounted, so a chosen filter stays put and that variant is not requested again. When the value does change, the renderer remounts and restores the viewer's `$variable` values. Names that are not in the program are dropped. A value that is not one of the current `Select` options is dropped. The filter stays selected, and the variant query runs for those args. A change to the program text, or to the library name or version, clears that saved state. The Host refresh policy and the console data hook decide when a snapshot is refreshed.

A result with no rows shows **No data**. A field the program reads that is missing from the snapshot shows **Data mismatch**. When the program has a `Select` or an `Input`, that state is a banner above the program so the filter stays usable and the chart shows its own empty state. The banner follows the rows in view: the default snapshot while the filter is on its default, and the variant after the viewer changes it. When that variant has rows, the banner becomes **Showing filtered data** and the chart shows the variant. A variant that is also empty keeps **No data**. A program with no inputs replaces the program with the card. While a default-args binding the program queries has no snapshot, and the page is still loading or refreshing, the preview shows a loading skeleton and does not mount the renderer, so it does not show **No data** for a query that has not finished. Status `error` with no snapshot shows **Error**, a short explanation, and `last_error_code` in monospace. Status `stale` keeps the snapshot and shows a stale banner with a relative refresh time (the absolute time on hover) and the same explanation. The preview does not leave an empty chart in those states.

Every string is plain text. The preview does not turn a string into a link, an image, or HTML. Button actions do nothing: `@OpenUrl`, `@ToAssistant`, and `Mutation` are ignored.

A program whose `library.version` is older, newer, or unknown, or whose library name is not `stageflow`, shows **This artifact was written for library …; preview unavailable**. The program text stays under **Program source**. An older version of the artifact (`?v=`) renders that version's program. The console does not fetch snapshots for an older version. A program with no `Query` still shows its text. A program with a `Query` shows **No data for this version** above that program, and those queries return empty. If snapshots are already in hand it says **Snapshots are for the current version: data shown is the latest**.

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

`POST /api/artifacts/<ownerKey>/<id>/refresh` runs every manifest binding, or only the ids in `{ "bindingIds": ["rows"] }`. The body may also set `ifStale` (boolean). The refresh body and the query body are at most 64 KiB. A larger body is `413` `artifact.too_large`. Publish still accepts a body up to 8 MiB. An empty `bindingIds` array is `400` `artifact.invalid_shape`. Omitting `bindingIds` runs every binding. An unknown id is `artifact.invalid_shape`. `ifStale` that is not a boolean is `400` `artifact.invalid_shape` at `ifStale`. `GET /api/artifacts/<ownerKey>/<id>/data` returns the current snapshots and does not run anything. Both take `project_root` the same way as the record route. A missing artifact, or a key from another project, is `404` `artifact.not_found`. More than one project and no `project_root` is `409` `artifact.ambiguous` with `project_roots`. A static artifact is `404` `artifact.not_live`. An expired artifact is `404` `artifact.content_unavailable` and is not refreshed. An unexpected failure is `500` with `artifact.refresh_failed` for refresh, `artifact.query_failed` for query, `artifact.approve_failed` for origin approve and revoke, `artifact.delete_failed` for delete, and `artifact.publish_failed` only for publish.

With `ifStale: true`, a binding runs only when its current snapshot is missing, its status is not `ok`, or its `fetched_at` is older than the effective TTL. The effective TTL is `refresh.ttl_seconds` when the manifest sets it (already at least 30; a smaller stored value is treated as 30) and **300 seconds** when `ttl_seconds` is omitted. A fresh snapshot is reused. That reuse does not call the function, does not write an invocation row, and does not change the snapshot row or `last_refreshed_at`. `ifStale: false` or an omitted `ifStale` runs the requested bindings.

The refresh response is `{ "status", "snapshots", "last_refreshed_at", "last_error_code", "errors" }`. `errors` is `{ "binding_id", "code" }`. Each snapshot is `{ "binding_id", "args_hash", "value", "fetched_at", "duration_ms", "status", "error_code" }` and, on a refresh, `source`. `source` is `executed` only when this call stored that snapshot. It is `cache` when the returned snapshot was already stored, including an `ifStale` reuse and a binding that failed and kept its previous snapshot. The data route uses the same shape without `source`, and with `errors: []`. When any binding failed with `artifact.resource_limit`, or the caller was refused because the execution queue or the joiner bound was full, the body also includes `retry_after_seconds` (30). If at least one stored snapshot can be shown, that response is `200` with `status: "stale"`. If nothing can be shown, the same body is `503`. It is never a bare `{ "error", "code" }` envelope. Other refresh results stay `200`.

Concurrent `ifStale` requests join an in-flight execution when they ask for the same bindings or for a subset of the bindings already running. A caller that also asks for a binding that is not in flight waits for the shared part and then runs only the missing bindings. Callers that join receive the same result object, including the same error when the shared execution fails. Joining waits on that shared promise and does not take an execution slot. At most 1,000 callers may join one flight; the next one is refused with the `artifact.resource_limit` body above. An `ifStale` caller that finds every requested snapshot still inside the TTL returns the cache and does not take a slot either. A manual refresh (`ifStale` omitted or false) does not join that flight. It queues its own execution. At most 32 of those executions wait behind the one that is running; the next one is refused with the same body. Aborting or disconnecting one caller does not cancel the shared execution. That caller's wait is released immediately, and the response is not written after the connection closes. A refresh does not start a run or call a model.

The default-args snapshot is one row per binding for that binding's manifest args hash. A refresh replaces that row and leaves other hashes (viewer variants) in place. A new version deletes every variant row and any row whose binding id or default args hash is not in the new manifest. An unchanged republish leaves snapshots alone. Publishing a non-live version deletes every snapshot. A stored value is not a version. The stored value is at most 1 MiB and at most 64 levels deep and 200,000 nodes. Over the byte or node cap is `artifact.snapshot_too_large`. Over the depth cap is `artifact.refresh_failed`. The previous snapshot stays. Before scrubbing, the Host checks an upper bound on the serialized JSON size and rejects over-limit values without walking string secrets. Values within the cap are scrubbed by walking the JSON: string leaves go through pattern redaction; property names that match `secret`, `token`, `passw`, `pwd`, `api_key` / `api-key`, `auth`, `credential`, `bearer`, `cookie`, `private`, `session`, `sid`, `csrf`, `xsrf`, `jwt`, or `signature` (case-insensitive substrings) have the whole value replaced by `[redacted]`, including arrays and objects. Other keys keep their shape.

The Host runs the function through the function executor with the attachment's grants, and with that function's timeout and body limits (4 running, 16 waiting). Credentials are resolved by the Host for granted capabilities only. Secret values, request URLs, and response bodies are not stored. Invocation history records `kind: artifact` and a code only. A cache hit writes no invocation row. A full executor queue is `artifact.resource_limit`: the previous snapshot stays, the status is `stale` when that snapshot exists and `error` when it does not, and the response includes `retry_after_seconds`. The view is not failed as a 429 or a generic 500. Any other function failure keeps the previous snapshot and sets `last_error_code` to the function code, or `artifact.refresh_failed` when the function has no code.

`status` is computed from every binding in the current manifest, not only the ones this call ran. It is `fresh` only when every binding has a successful snapshot for its current args hash and this call had no binding error. It is `stale` when at least one successful snapshot exists and some binding failed or has no snapshot. It is `error` when no binding has a successful snapshot. It is null before the first successful snapshot (including after a new version drops every snapshot). `refreshing` is set only while a refresh is in progress. A thrown failure, including a crash while storing the value, leaves `stale` or `error` with `artifact.refresh_failed`. On Host start, every row still marked `refreshing` is reset the same way. On the indexed-artifact repair pass, only rows that have been `refreshing` for more than ten minutes and are not in flight in this process are reset. `last_refreshed_at` is the newest successful `fetched_at` among current snapshots, including when only some bindings succeeded.

A new version (not an unchanged republish) deletes every non-default variant row, and any default row whose binding was removed or whose manifest args hash changed, then recomputes status from the default rows that remain. Variant rows never change `live_status`, `last_error_code`, or `last_refreshed_at`. An unchanged republish leaves snapshots and status alone. Publishing a non-live version deletes the snapshots. Delete, indexed-artifact removal, and retention delete snapshot rows by artifact key, so variant rows go with the artifact.

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

### Live artifacts: interaction {#live-artifacts-interaction}

A viewer can change filters and inputs in the page. That state stays in the page. It is not saved. When it changes a binding's arguments, the console calls `POST /api/artifacts/<ownerKey>/<id>/query`. The Host runs the read-only function. The browser does not.

The body is `{ "binding_id": "rows", "args": { "weeks": 4 }, "ifStale": true }`. `binding_id` is required. `args` is optional. Omitted `ifStale` means `true`. Any other field is `400` `artifact.invalid_shape`. `ifStale` that is not a boolean is the same code. An unknown `binding_id` is `400` `artifact.invalid_shape`. `project_root` works the same way as the record route. A static artifact is `404` `artifact.not_live`. An expired artifact is `404` `artifact.content_unavailable`. A hidden eval artifact is `404` `artifact.not_found`. The route uses the same control token and Origin checks as the other artifact routes. There is no MCP tool for this call.

The manifest `args` are the defaults. Viewer `args` are shallow-merged on top of them: a viewer key replaces that default, and nested objects are replaced as a whole. The merged object is checked with the same input-schema validator as publish. A failure is `400` `artifact.binding_args_invalid` with `issues` paths. The viewer object itself, before the merge, must be JSON: at most 8 KiB, at most 8 levels deep, at most 16 keys, and every key matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. Anything else is `artifact.binding_args_invalid`. Keys the schema does not allow fail the schema check. Keys the schema allows, including when `additionalProperties` is true, are kept.

The snapshot key is the `args_hash` of the merged arguments (the same canonical JSON hash as refresh). When that hash is the manifest default, the call is a normal refresh of that one binding and updates `live_status`, `last_error_code`, and `last_refreshed_at`. Any other hash is a variant. A variant is stored in `artifact_snapshots` on its own row. It does not change those artifact columns. `GET /data` still returns only the default-args rows.

A variant is fresh for the same effective TTL as refresh (`refresh.ttl_seconds`, or 300 seconds, and never below 30). `ifStale: true` (the default) reuses a fresh row and does not call the function. A stale row, a missing row, or `ifStale: false` runs the function again. At most 32 variant rows are kept per binding. The 33rd inserts and deletes the variant with the oldest fetch time in the same transaction. Equal `fetched_at` values break the tie by `args_hash` ascending. A new version deletes every variant row. Deleting the artifact deletes them too. There is no separate periodic cleanup.

Concurrent queries for the same artifact, binding, and args hash share one execution. That includes `ifStale: false`: a call that bypasses the cache joins an in-flight execution of that same hash instead of starting another one. It still is not served from a fresh stored snapshot. Joiners wait on that execution and do not take a slot. A fresh cache hit does not take one either. New executions of non-default variants are limited to 30 per rolling minute per artifact and 10 in flight per artifact. Across the process, viewer executions (a variant query, or any query with `ifStale: false`) are limited to 6 running or waiting at once, and new variant executions are limited to 120 per rolling minute. A refresh of the manifest default arguments, including `POST /refresh` and a query whose merged arguments are those defaults when `ifStale` is not false, does not take those viewer slots. Past any of these limits, or when the function executor queue is full, the body is the query result with `errors[].code` `artifact.resource_limit` and `retry_after_seconds` (30). If a stored snapshot exists for those arguments, the status is `200` and `snapshot.source` is `cache`. If none exists, the same body is `503`. It is never a bare `{ "error", "code" }` envelope.

The variant rows, the rate-limit windows, and the in-flight maps are per process. `sf artifact query` and `sf artifact refresh` run in the CLI's own process, so they keep their own counters and cache and do not join an execution the Host already started. Two Host processes do not share them either.

Eligibility is checked again at call time against the function revision read for that call. The executor runs that revision. A function that is missing, not granted, or no longer read-only does not run. The codes match refresh: `artifact.binding_unknown_function`, `artifact.binding_not_granted`, `artifact.binding_not_read_only`, and `artifact.function_changed`. The invocation history row is `kind: artifact`. That table has no column for an artifact key, a binding id, or an args hash, so those are not stored. Arguments and results are not stored there. Logs do not include argument values.

Every variant runs with the function's own access, not the viewer's, and the cached row is shared by every viewer of this Host. That matches the single-user control-token model. A hosted deployment has to key the cache and the rate limit by viewer scope before it can share a Host. The code marks that spot with `TODO(multi-tenant)`.

Writes (level 3) and asking the agent (level 4) are not available. The Host constant is `artifact.interaction_disabled`. This version has no route that performs either one, and a query never runs a function that is not read-only. The program validator and the manifest rules are unchanged.

The response is:

```json
{
  "binding_id": "rows",
  "args_hash": "…",
  "snapshot": {
    "value": { "weeks": 4 },
    "fetched_at": "…",
    "duration_ms": 5,
    "status": "ok",
    "error_code": null,
    "source": "executed"
  },
  "errors": []
}
```

`source` is `executed` when this call stored the row and `cache` when it reused one, including a failure that kept the previous variant. `snapshot` is `null` when nothing is stored for that hash. `errors` is `{ "binding_id", "code" }`.

`sf artifact query <ownerKey>/<id> --binding <id> [--args <json>] [--if-stale|--no-if-stale] [--project-root <wire id or path>] [--json]` calls the same function in-process. `--args` is a JSON object. Omitted `--if-stale` reuses a fresh variant. `--json` prints the response above. Human output prints the binding, args hash, source, and status, not the argument values or the snapshot value. A binding error exits 1 and still prints that object. `artifact.not_found`, `artifact.ambiguous`, `artifact.not_live`, `artifact.content_unavailable`, an unknown binding, and invalid arguments exit 1 with `{ "error", "code" }`.

### CLI

`sf artifact publish --kind live.declarative` takes the program from `--file` or `--stdin` and the manifest JSON from `--manifest`. `sf artifact list` marks a live row `LIVE` or `LIVE/<status>` (`fresh`, `stale`, `error`, `refreshing`). `sf artifact show` prints each binding (`id`, function, `read-only`), the refresh policy, and the last refreshed time. `--json` includes the `live` object. `sf artifact refresh <ownerKey>/<id>` runs the bindings, or only the ids given with repeated `--binding`. `--if-stale` applies the TTL rule above. It runs in the CLI process, so the function executor's limits apply to that process. The CLI process also has its own variant cache, rate-limit windows, and in-flight map, and it does not join a refresh or query the Host is already running. `--json` prints `{ status, snapshots, last_refreshed_at, last_error_code, errors }`, plus `source` on snapshots and `retry_after_seconds` when the executor queue is full. A binding failure exits 1 and still prints that object. `artifact.not_found`, `artifact.ambiguous`, `artifact.not_live`, and `artifact.content_unavailable` exit 1 with `{ error, code }`. `sf artifact query` runs one binding with viewer arguments. See [Live artifacts: interaction](#live-artifacts-interaction).

### MCP

`refresh_artifact` is group `artifacts.refresh`, risk external, toolset `artifacts`. Arguments are `key`, optional `project_root`, and optional `binding_ids`. REST refresh uses `bindingIds` in the JSON body; MCP uses `binding_ids`. `get_artifact` with `view: data` returns the same snapshot object for a live artifact and `artifact.not_live` for a static one. Snapshot JSON is capped at 200 KiB. Over the cap, the largest values are dropped first: those snapshots have `truncated: true`, `value: null`, and `size_bytes`, and the response stays JSON. An expired artifact is `artifact.content_unavailable`. An agent granted `artifacts.refresh` receives `stageflow_refresh_artifact`, bound to artifacts that agent owns in the session project.

### Chat UI parts

Agent chat can carry typed **ui** parts that reference an artifact instead of inlining its body. The envelope lives in shared runtime code as `src/artifacts/uiPart.ts` (`v: 1`, `kind: artifact-ref`, fields `key`, optional `version`, `title`, and `fallback: { text, url }`). Unknown `v` or `kind` values parse to an unsupported result; fallback text is capped at 2000 characters. The operator console maps each `kind` through `ui/src/chat/parts/registry.ts` and reuses `ArtifactView` for rendering. Wiring from tools and channels is added in later tickets.

### Console

The Artifacts list shows the live kind label and the status pill. The detail page renders the program (see [Live artifacts: rendering](#live-artifacts-rendering)) and keeps the program text under **Program source**. The Inspector **Live** section lists bindings with a Read-only badge, status, last refreshed time (a relative age, with the absolute time on hover), an **Updated Ns ago** line, last error code, and collapsed snapshot JSON. When `auto_seconds` is set it also says **Checking every Ns · data refreshed at most every Ms**, where M is the effective TTL (`refresh.ttl_seconds`, or 300 seconds when that field is omitted). Opening the current version loads the stored snapshots from the data route first, then refreshes with `ifStale: true` unless `on_view` is false. The page waits until the versions list identifies the latest version before that load, so an older version is not refreshed while the list is still loading. The interval pauses while the browser tab is hidden and, on becoming visible, refreshes immediately when the snapshot is older than `auto_seconds`. **Refresh now** calls the refresh route without `ifStale`. An older version (`?v=` when it is not the latest), an expired artifact, or a hidden artifact does not start that refresh. An older version does not read stored snapshots. It shows that version's program and manifest bindings. A program with no `Query` still renders. A program with a `Query` says **No data for this version**. When snapshots are already in hand it says snapshots are for the current version. An expired live artifact shows the same expiry explanation as a static artifact and hides the live program note and **Refresh now**. `artifact.content_unavailable` from the data route shows that explanation as well.
