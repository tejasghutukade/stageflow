import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildHtmlCsp, libraryCspSources } from "../src/artifacts/htmlManifest.js";
import { HTML_LIBRARIES } from "../src/artifacts/library/htmlLibraries.js";
import { startSandboxListener } from "../src/server/sandboxListener.js";

const chart = HTML_LIBRARIES.find((library) => library.name === "chartjs")!;
const d3 = HTML_LIBRARIES.find((library) => library.name === "d3")!;
const echarts = HTML_LIBRARIES.find((library) => library.name === "echarts")!;
const leaflet = HTML_LIBRARIES.find((library) => library.name === "leaflet")!;
const mermaid = HTML_LIBRARIES.find((library) => library.name === "mermaid")!;

function artifactHtml(sandboxOrigin: string): string {
  return `<canvas id="c" width="120" height="80"></canvas><div id="map" style="height:120px"></div>
<script>
var report = { checks: {} };
document.addEventListener("securitypolicyviolation", function (event) {
  report.checks[event.violatedDirective] = event.blockedURI || event.violatedDirective;
});
function pack() {
  var tag = document.querySelector("script[src*='chartjs@']");
  var canvas = document.getElementById("c");
  var drawn = false;
  try {
    new Chart(canvas, { type: "line", data: { labels: ["a"], datasets: [{ data: [1] }] }, options: { animation: false } });
    var pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (var i = 0; i < pixels.length; i++) if (pixels[i] !== 0) drawn = true;
  } catch (error) {
    report.chartError = String(error);
  }
  var mapOk = false;
  try {
    mapOk = typeof L.map(document.getElementById("map")).setView([0, 0], 2).getCenter === "function";
  } catch (error) {
    report.mapError = String(error);
  }
  try { (0, eval)("1"); report.evalRan = true; } catch (error) { report.evalRan = false; }
  fetch("https://example.com/nope").catch(function () {});
  report.chart = typeof Chart === "function" && drawn;
  report.d3 = typeof d3 === "object" && typeof d3.select === "function";
  report.echarts = typeof echarts === "object" && typeof echarts.init === "function";
  report.leaflet = typeof L === "object" && mapOk;
  report.integrity = !!(tag && tag.integrity && tag.integrity.indexOf("sha384-") === 0 && tag.crossOrigin === "anonymous");
  return JSON.parse(JSON.stringify(report));
}
function send() {
  if (!window.stageflow) return setTimeout(send, 20);
  var body = pack();
  delete body.checks;
  setTimeout(function () {
    var blocked = false;
    for (var key in report.checks) if (key.indexOf("connect-src") >= 0) blocked = true;
    body.fetchBlocked = blocked;
    window.stageflow.callBinding("probe", body);
  }, 400);
}
setTimeout(send, 50);
</script>`;
}

function blockedHtml(sandboxOrigin: string): string {
  return `<script>
document.addEventListener("securitypolicyviolation", function (event) {
  if (String(event.blockedURI || "").indexOf("/libs/") >= 0) window.__libsBlocked = event.violatedDirective;
});
var node = document.createElement("script");
node.src = ${JSON.stringify(`${sandboxOrigin}/libs/${chart.name}@${chart.version}/${chart.files[0]!.path}`)};
document.head.appendChild(node);
function send() {
  if (!window.stageflow) return setTimeout(send, 20);
  window.stageflow.callBinding("probe", { libsBlocked: window.__libsBlocked || "" });
}
setTimeout(send, 80);
</script>`;
}

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function page(sandboxOrigin: string, hostOrigin: string): string {
  const libraries = [chart, d3, echarts, leaflet].map((library) => ({ name: library.name, version: library.version }));
  const withLibs = buildHtmlCsp({}, libraryCspSources(sandboxOrigin, libraries));
  const bare = buildHtmlCsp({});
  const evalCsp = buildHtmlCsp({}, { ...libraryCspSources(sandboxOrigin, [{ name: mermaid.name, version: mermaid.version }]), needsEval: true });
  return `<!doctype html><body><pre id="out"></pre><script>
const sandboxOrigin = ${JSON.stringify(sandboxOrigin)};
const hostOrigin = ${JSON.stringify(hostOrigin)};
const seen = [];
function frame(id, html, csp, libraries, allowEval) {
  const el = document.createElement("iframe");
  el.id = id;
  el.setAttribute("sandbox", "allow-scripts allow-same-origin");
  el.src = sandboxOrigin + "/shell.html?parent=" + encodeURIComponent(hostOrigin);
  document.body.appendChild(el);
  return { el, html, csp, libraries, allowEval, nonce: "ab".repeat(16), loaded: false };
}
const sessions = {
  libs: frame("libs", ${jsString(artifactHtml(sandboxOrigin))}, ${JSON.stringify(withLibs)}, ${JSON.stringify(libraries)}, false),
  bare: frame("bare", ${jsString(blockedHtml(sandboxOrigin))}, ${JSON.stringify(bare)}, [], false),
  mermaid: frame("mermaid", "<p>m</p>", ${JSON.stringify(evalCsp)}, ${JSON.stringify([{ name: mermaid.name, version: mermaid.version }])}, true)
};
function sessionFor(source) {
  for (const [name, session] of Object.entries(sessions)) if (source === session.el.contentWindow) return [name, session];
  return null;
}
function reply(session, message) {
  session.el.contentWindow.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-relay", params: { nonce: session.nonce, message } }, sandboxOrigin);
}
window.addEventListener("message", (event) => {
  const found = sessionFor(event.source);
  if (!found || event.origin !== sandboxOrigin) return;
  const [kind, session] = found;
  const data = event.data;
  if (!data || data.jsonrpc !== "2.0") return;
  if (data.method === "sf/sandbox-error") {
    seen.push({ kind, method: "sf/sandbox-error", reason: data.params && data.params.reason });
    publish();
    return;
  }
  if (data.method === "sf/sandbox-ready" && !session.loaded) {
    session.loaded = true;
    const params = { html: session.html, csp: session.csp, nonce: session.nonce };
    if (session.libraries.length) params.libraries = session.libraries;
    if (session.allowEval) params.allowEval = true;
    session.el.contentWindow.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-load", params }, sandboxOrigin);
    return;
  }
  if (data.method !== "sf/sandbox-relay" || !data.params || data.params.nonce !== session.nonce) return;
  const message = data.params.message;
  if (message.method === "ui/initialize") {
    reply(session, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "stageflow", version: "0" }, hostCapabilities: { tools: { call: true }, sandbox: { permissions: {}, csp: session.csp } }, hostContext: { theme: "dark", styles: { variables: {} }, displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: {}, platform: "web" } } });
  }
  if (message.method === "tools/call") {
    seen.push({ kind, method: "tools/call", arguments: message.params && message.params.arguments });
    reply(session, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "{}" }], structuredContent: {} } });
    publish();
  }
});
function publish() {
  const libs = seen.find((entry) => entry.kind === "libs" && entry.method === "tools/call");
  const bare = seen.find((entry) => entry.kind === "bare" && entry.method === "tools/call");
  const mermaidError = seen.find((entry) => entry.kind === "mermaid" && entry.method === "sf/sandbox-error");
  if (!libs || !bare || !mermaidError) return;
  fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seen }) });
}
</script></body>`;
}

export async function runLibraryChecks(): Promise<void> {
  const probe = await startSandboxListener({
    consoleOrigins: ["http://127.0.0.1:9"],
    hostPort: 49000,
    listenHost: "127.0.0.1",
    env: {},
  });
  const missing = await fetch(`${probe.origin}/libs/chartjs@${chart.version}/not-a-file.js`);
  const listed = await fetch(`${probe.origin}/libs/${chart.name}@${chart.version}/${chart.files[0]!.path}`);
  console.log(`${missing.status === 404 ? "PASS" : "FAIL"} unlisted library path is 404 (${missing.status})`);
  console.log(`${listed.headers.get("access-control-allow-origin") === "*" && missing.headers.get("access-control-allow-origin") === null ? "PASS" : "FAIL"} ACAO only on a listed library file`);
  await probe.close();

  const host = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url ?? "").startsWith("/report")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(204);
        res.end();
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          seen: Array<{ kind: string; method: string; reason?: string; arguments?: Record<string, unknown> }>;
        };
        const libs = body.seen.find((entry) => entry.kind === "libs" && entry.method === "tools/call")?.arguments ?? {};
        const bare = body.seen.find((entry) => entry.kind === "bare" && entry.method === "tools/call")?.arguments ?? {};
        const mermaidError = body.seen.find((entry) => entry.kind === "mermaid" && entry.method === "sf/sandbox-error");
        const lines: Array<[string, boolean]> = [
          ["chart.js draws on a canvas", libs.chart === true],
          ["d3 global exists", libs.d3 === true],
          ["echarts global exists", libs.echarts === true],
          ["leaflet map initialises", libs.leaflet === true],
          ["injected tag has integrity and crossorigin", libs.integrity === true],
          ["undeclared /libs script is blocked", String(bare.libsBlocked || "").includes("script-src")],
          ["library CSP still blocks eval", libs.evalRan === false],
          ["library CSP still blocks an undeclared https origin", libs.fetchBlocked === true || typeof libs["connect-src"] === "string"],
          ["mermaid eval is refused by the shell", mermaidError?.reason === "csp" || mermaidError?.reason === "library"],
        ];
        let failed = 0;
        for (const [name, pass] of lines) {
          if (!pass) failed += 1;
          console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
        }
        console.log(JSON.stringify(libs));
        void shutdown(failed === 0 ? 0 : 1);
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page(sandboxOrigin, hostOrigin));
  });
  let sandboxOrigin = "";
  let hostOrigin = "";
  let sandbox: { close: () => Promise<void> } | undefined;
  const shutdown = async (code: number) => {
    if (sandbox) await sandbox.close();
    host.close();
    setTimeout(() => process.exit(code), 50);
  };
  host.listen(0, "127.0.0.1", async () => {
    const address = host.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    hostOrigin = `http://127.0.0.1:${port}`;
    sandbox = await startSandboxListener({
      consoleOrigins: [hostOrigin],
      hostPort: port,
      listenHost: "127.0.0.1",
      env: {},
    });
    sandboxOrigin = sandbox.origin ?? "";
    console.log(JSON.stringify({ hostOrigin, sandboxOrigin, url: `${hostOrigin}/` }));
    console.log("Open that URL in a browser, or drive it with Playwright. This process waits for the page report.");
    setTimeout(() => {
      console.log("FAIL browser did not report");
      void shutdown(1);
    }, 75000).unref();
  });
}
