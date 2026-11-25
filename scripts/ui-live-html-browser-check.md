# Live HTML console check

Manual check for a reviewer. Do not run this as part of `npm test`. It needs a real Host (`sf ui`), a browser, and a project that can publish a function.

## Setup

1. From a Stageflow checkout, start the console with `npm run dev -- ui` (or `sf ui` from a build) so it binds loopback. Leave `STAGEFLOW_SANDBOX_DISABLED` unset.
2. Open the printed console URL as `http://localhost:<console-port>` (not `127.0.0.1`). Confirm `GET /api/health` includes `sandbox_origin` and `sandbox_origins` with both `http://localhost:<sandbox-port>` and `http://127.0.0.1:<sandbox-port>`. The iframe `src` host is `127.0.0.1`, not `localhost`. Repeat once by opening `http://127.0.0.1:<console-port>` and confirm the iframe host is then `localhost`.
3. In that project, publish a read-only function the artifact can bind, then publish a `live.html` artifact whose manifest declares that binding and a CSP. Example document:

```html
<!doctype html>
<p id="out">waiting</p>
<p id="section" style="margin-top: 2000px">Section</p>
<a id="hash-link" href="#section">Section</a>
<a id="out-link" href="https://example.com/out">Leave</a>
<button id="nav" type="button">Navigate</button>
<script>
  stageflow.onBindingUpdated(function () {
    stageflow.callBinding("rows").then(function (value) {
      document.getElementById("out").textContent = JSON.stringify(value);
    });
  });
  stageflow.initialize().then(function () {
    return stageflow.callBinding("rows");
  }).then(function (value) {
    document.getElementById("out").textContent = JSON.stringify(value);
  });
  document.getElementById("nav").addEventListener("click", function () {
    location.assign("https://example.com/out");
  });
</script>
```

Manifest: `format` `html`, `bindings` one entry with `id` `rows`, and `csp.connectDomains` only if the document should be allowed to fetch. An empty `connectDomains` list is enough for this check.

4. Open the artifact detail page on the current version.

## Expected

- The main area shows a frame titled "Live HTML artifact", not the scriptless "Static preview" notice.
- The frame's `sandbox` is `allow-scripts allow-same-origin`. Its `src` is `{the chosen sandbox origin}/shell.html?parent={the console origin}`. On a `localhost` console that host is `127.0.0.1`. The URL has no control token and no `/api/` path.
- The document runs. `#out` becomes the JSON of the default snapshot without reloading the page, including when the artifact had no stored snapshot and the first refresh is what produces it. The side panel lists the binding, its snapshot, and **Declared origins**.
- Click **Section**. The nested document scrolls to `#section`. The console URL does not change. The page does not show the blocked-link note or the navigation error card.
- **Refresh now** updates the snapshot. A document that registered `onBindingUpdated` updates `#out` without a reload when the value changed. An unchanged value does not push.
- Click **Leave**. The console URL does not change. The page shows "A link in this artifact was blocked" and does not show a navigation. The note goes away after about five seconds.
- Click **Navigate**. The console URL does not change. The page shows an alert: "This artifact tried to navigate away and was stopped for your safety." Details stay collapsed and include the reason `navigated` and the sandbox origin. The tall blank frame is gone. **Retry** runs the handshake again and `#out` shows the snapshot.
- DevTools on the console page: messages to the shell use `targetOrigin` equal to `sandbox_origin`, never `*`. The load payload is `html`, `csp`, and a 32-hex `nonce`. Later messages are `sf/sandbox-relay`. None of them contain the control token.
- Open an older version with `?v=`. The HTML is that version. The note says "Snapshots are for the current version." **Refresh now** is hidden. A `tools/call` from that document returns `isError` and the text `no data for this version`.
- Stop the sandbox (restart with `STAGEFLOW_SANDBOX_DISABLED=1`, or use a Host whose health `sandbox_origin` is null). Reload the detail page. The notice says live preview needs the sandbox origin, and the preview is the scriptless frame (empty `sandbox`, scripts do not run).

## Playwright sketch

Point the test at the running console. Do not start a second server for the shell.

1. `GET /api/health` and read `sandbox_origin`.
2. Open the detail URL.
3. `page.frameLocator` is not the artifact document. The artifact is a nested frame inside the shell. Locate `iframe[title="Live HTML artifact"]`, then the inner frame, then `#out`.
4. Assert the outer iframe `sandbox`, `referrerpolicy`, and `src` as above.
5. Assert `#out` is not `waiting` after the binding returns.
6. Click the inner link. Assert `page.url()` is unchanged and the note is visible.
7. Repeat with `sandbox_origin: null` and assert the scriptless notice.
