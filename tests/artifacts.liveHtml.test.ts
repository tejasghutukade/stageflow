import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPublishArtifactTool } from "../src/agents/artifactTools.js";
import { agentProjectKey } from "../src/agents/store.js";
import { buildHtmlCsp, validateHtmlManifest } from "../src/artifacts/htmlManifest.js";
import { liveHtmlDocumentCsp } from "../ui/src/redesign/artifacts/liveHtml/cspPolicy.ts";
import { scanHtml } from "../src/artifacts/htmlScan.js";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { ArtifactPublishError, HTML_CSP_LIST_MAX, HTML_SCAN_MAX_LINE_BYTES, LIVE_HTML_MAX_BYTES } from "../src/artifacts/limits.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import { listArtifacts, readArtifact } from "../src/artifacts/query.js";
import { extractSearchBody } from "../src/artifacts/search.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { artifactKeyHash, artifactStoreRoot } from "../src/artifacts/store.js";
import { readPublishedArtifactStoreReport } from "../src/artifacts/storeInventory.js";
import { ARTIFACT_USAGE, runArtifactCommand } from "../src/cli/artifactCommand.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import type { FunctionRunView } from "../src/functions/invoke.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes, setArtifactRouteRefreshInvokeForTests } from "../src/server/artifactRoutes.js";
import { createPublishArtifactTool } from "../src/tools/publishArtifact.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  setArtifactRouteRefreshInvokeForTests(undefined);
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function issuesOf(run: () => unknown): Array<{ path: string; message: string }> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactPublishError);
    const thrown = error as ArtifactPublishError;
    expect(thrown.code).toBe("artifact.invalid_shape");
    return thrown.issues ?? [];
  }
  throw new Error("expected artifact.invalid_shape");
}

describe("live.html manifest", () => {
  it("accepts a manifest with no bindings and normalises origins", () => {
    const manifest = validateHtmlManifest({
      format: "html",
      csp: { connectDomains: ["https://API.Example.com:443", "https://*.CDN.Example.com"] },
      libraries: [],
    });
    expect(manifest).toEqual({
      format: "html",
      csp: { connectDomains: ["https://api.example.com", "https://*.cdn.example.com"] },
      bindings: [],
    });
  });

  it("rejects domain shapes, duplicates, list size, libraries, library, and unknown keys", () => {
    const bad = [
      ["http://example.com", "must be an https origin"],
      ["example.com", "must be an https origin"],
      ["https://example.com/path", "must not include a path"],
      ["https://example.com?q=1", "must not include a path"],
      ["https://user:pw@example.com", "must not include a path"],
      ["https://127.0.0.1", "IP addresses"],
      ["https://[::1]", "IP address"],
      ["https://localhost/x", "must not include a path"],
      ["https://localhost", "localhost"],
      ["https://printer.local", ".local"],
      ["https://svc.internal", ".internal"],
      ["https://app.localhost", ".localhost"],
      ["data:text/html,hi", "must be an https origin"],
      ["javascript:alert(1)", "must be an https origin"],
      ["https://*.com", "single-level"],
      ["https://*.*.example.com", "single-level"],
    ] as const;
    for (const [origin, snippet] of bad) {
      const found = issuesOf(() => validateHtmlManifest({ format: "html", csp: { connectDomains: [origin] } }));
      expect(found[0]?.path, origin).toBe("manifest.csp.connectDomains[0]");
      expect(found[0]?.message, origin).toContain(snippet);
    }
    const duplicate = issuesOf(() =>
      validateHtmlManifest({
        format: "html",
        csp: { resourceDomains: ["https://CDN.Example.com", "https://cdn.example.com:443"] },
      }),
    );
    expect(duplicate[0]?.path).toBe("manifest.csp.resourceDomains[1]");
    expect(duplicate[0]?.message).toBe("duplicate origin");
    const tooMany = issuesOf(() =>
      validateHtmlManifest({
        format: "html",
        csp: { resourceDomains: Array.from({ length: HTML_CSP_LIST_MAX + 1 }, (_, index) => `https://h${index}.example.com`) },
      }),
    );
    expect(tooMany[0]?.path).toBe("manifest.csp.resourceDomains");
    expect(tooMany[0]?.message).toContain("at most");
    expect(validateHtmlManifest({ format: "html", csp: { frameDomains: [] } })).toEqual({
      format: "html",
      csp: {},
      bindings: [],
    });
    const frames = issuesOf(() =>
      validateHtmlManifest({ format: "html", csp: { frameDomains: ["https://embed.example.com"] } }),
    );
    expect(frames[0]).toEqual({
      path: "manifest.csp.frameDomains",
      message: "frameDomains is not supported: sandboxed artifacts cannot embed frames",
    });
    expect(issuesOf(() => validateHtmlManifest({ format: "html", csp: { frameDomains: "https://embed.example.com" } }))[0]).toEqual({
      path: "manifest.csp.frameDomains",
      message: "frameDomains must be an array",
    });
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.example`;
    expect(host.length).toBeGreaterThan(253);
    const longHost = issuesOf(() => validateHtmlManifest({ format: "html", csp: { baseUriDomains: [`https://${host}`] } }));
    expect(longHost[0]?.message).toContain("253");
    const libraries = issuesOf(() => validateHtmlManifest({ format: "html", libraries: ["chart"] }));
    expect(libraries[0]).toMatchObject({ path: "manifest.libraries", message: "libraries are not available yet" });
    const library = issuesOf(() => validateHtmlManifest({ format: "html", library: { name: "stageflow", version: "1.0.0" } }));
    expect(library.some((issue) => issue.path === "manifest.library")).toBe(true);
    const unknown = issuesOf(() => validateHtmlManifest({ format: "html", program: "<p></p>" }));
    expect(unknown[0]?.path).toBe("manifest.program");
  });
});

describe("buildHtmlCsp", () => {
  const empty =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

  it("emits the sandbox policy and sorts domains", () => {
    expect(buildHtmlCsp({})).toBe(empty);
    const filled =
      "default-src 'none'; script-src 'unsafe-inline' https://a.example.com https://b.example.com; style-src 'unsafe-inline' https://a.example.com https://b.example.com; img-src data: https://a.example.com https://b.example.com; font-src data: https://a.example.com https://b.example.com; media-src data: https://a.example.com https://b.example.com; connect-src https://api.example.com; frame-src 'none'; base-uri https://app.example.com; form-action 'none'; object-src 'none'";
    const csp = {
      resourceDomains: ["https://b.example.com", "https://a.example.com"],
      connectDomains: ["https://api.example.com"],
      frameDomains: ["https://embed.example.com"],
      baseUriDomains: ["https://app.example.com"],
    };
    expect(buildHtmlCsp({
      resourceDomains: csp.resourceDomains,
      connectDomains: csp.connectDomains,
      baseUriDomains: csp.baseUriDomains,
    })).toBe(filled);
    expect(buildHtmlCsp(csp)).toBe(filled);
    expect(buildHtmlCsp(csp)).not.toContain("embed.example.com");
    expect(buildHtmlCsp({ resourceDomains: ["https://a.example.com", "https://b.example.com", "https://a.example.com"] })).toBe(
      buildHtmlCsp({ resourceDomains: ["https://b.example.com", "https://a.example.com"] }),
    );
    expect(filled).not.toContain("unsafe-eval");
    expect(filled).not.toContain("'self'");
  });
});

function scan(html: string, csp: Parameters<typeof scanHtml>[1] = {}) {
  return scanHtml(html, csp);
}

describe("live.html scan", () => {
  const csp = { resourceDomains: ["https://cdn.example.com", "https://*.assets.example"] };

  it("checks each external reference against the declared list", () => {
    const ok = scan(
      `<img src="https://cdn.example.com/a.png"><img src="HTTPS://CDN.EXAMPLE.COM/b.png"><img src="//cdn.example.com/c.png"><img src="&#104;ttps://cdn.example.com/d.png"><script src="https://lib.assets.example/app.js"></script>`,
      { csp },
    );
    expect(ok.ok, JSON.stringify(ok.issues)).toBe(true);
    expect(ok.origins.img).toContain("https://cdn.example.com");
    expect(ok.origins.script).toContain("https://lib.assets.example");

    const missing = scan(`<img src="https://other.example/a.png">`, { csp });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]).toMatchObject({
      path: "img[0].src",
      code: "html_csp_violation",
      message: "origin https://other.example is not declared in resourceDomains",
    });
    const srcset = scan(`<img srcset="https://cdn.example.com/a.png 1x, https://other.example/b.png 2x">`, { csp });
    expect(srcset.issues.map((issue) => issue.message)).toEqual(["origin https://other.example is not declared in resourceDomains"]);
    expect(scan(`<script src="app.js"></script>`).issues[0]?.message).toBe(
      "relative URLs cannot be resolved inside a sandboxed document",
    );
    expect(scan(`<script src="javascript:alert(1)"></script>`).issues[0]?.message).toContain("javascript:");
    expect(scan(`<iframe src="data:text/html,hi"></iframe>`).issues[0]?.message).toBe("embedded frames and objects are not allowed");
    expect(scan(`<object data="javascript:alert(1)"></object>`).issues[0]?.message).toBe("embedded frames and objects are not allowed");
    expect(scan(`<embed src="data:text/html,x">`).issues[0]?.message).toBe("embedded frames and objects are not allowed");
    expect(scan(`<img src="data:image/png;base64,aaaa">`).ok).toBe(true);
    expect(scan(`<meta http-equiv="Refresh" content="0;url=https://cdn.example.com">`, { csp }).issues[0]?.message).toBe(
      "meta refresh is not allowed",
    );
    const baseOk = scan(`<base href="https://app.example.com/">`, { csp: { baseUriDomains: ["https://app.example.com"] } });
    expect(baseOk.ok, JSON.stringify(baseOk.issues)).toBe(true);
    expect(scan(`<base href="https://app.example.com/">`).issues[0]?.message).toContain("baseUriDomains");
    expect(scan(`<form action="/submit"></form>`).issues[0]?.message).toBe("form actions are disabled");
    expect(scan(`<button formaction="https://cdn.example.com/post">go</button>`, { csp }).issues[0]?.path).toBe("button[0].formaction");
    const imported = scan(`<style>@import url("https://cdn.example.com/a.css");</style>`, { csp });
    expect(imported.ok, JSON.stringify(imported.issues)).toBe(true);
    expect(scan(`<style>@import "https://evil.example/a.css";</style>`).issues[0]?.message).toContain("resourceDomains");
    expect(scan(`<div style="background: url(https://cdn.example.com/a.png)"></div>`, { csp }).ok).toBe(true);
    for (const html of [
      `<video poster="https://evil.example/p.png"></video>`,
      `<body background="https://evil.example/bg.png"></body>`,
      `<table background="https://evil.example/bg.png"></table>`,
      `<td background="https://evil.example/bg.png"></td>`,
      `<th background="https://evil.example/bg.png"></th>`,
      `<tr background="https://evil.example/bg.png"></tr>`,
      `<input type="image" src="https://evil.example/b.png">`,
      `<link rel="stylesheet" imagesrcset="https://evil.example/a.png 1x, https://cdn.example.com/b.png 2x">`,
      `<style>image-set("https://evil.example/a.png" 1x)</style>`,
      `<style>src("https://evil.example/a.woff")</style>`,
      `<style>image("https://evil.example/a.png")</style>`,
      `<style>u\\72l(https://evil.example/a.css)</style>`,
      `<style>url/**/(https://evil.example/a.png)</style>`,
      `<div style="background:u\\72l(https://evil.example/a.png)"></div>`,
      `<svg><feImage href="https://evil.example/a.svg"></feImage></svg>`,
      `<svg><image xlink:href="https://evil.example/a.svg"></image></svg>`,
      `<style>@import "https://evil.example/a.css";</style>`,
      `<style>@import url(https://evil.example/a.css);</style>`,
      `<body><link rel="stylesheet" href="https://evil.example/a.css"></body>`,
      `<style>url(//evil.example/a.png)</style>`,
    ]) {
      const found = scan(html, { csp });
      expect(found.ok, html).toBe(false);
      expect(found.issues[0]?.code, html).toBe("html_csp_violation");
      expect(found.issues[0]?.message, html).toContain("resourceDomains");
    }
    expect(scan(`<style>url("data:font/woff2;base64,aa")</style>`, { csp }).ok).toBe(true);
    expect(scan(`<style>url("data:image/png;base64,aa")</style>`, { csp }).ok).toBe(true);
    expect(scan(`<video poster="data:image/png;base64,aa"></video>`, { csp }).ok).toBe(true);
    expect(scan(`<style>url(./relative.css)</style>`, { csp }).issues[0]?.message).toContain("relative URLs");
    expect(scan(`<style>@import "./a.css";</style>`, { csp }).issues[0]?.message).toContain("relative URLs");
    for (const html of [
      `<iframe src="https://embed.example.com/x"></iframe>`,
      `<iframe></iframe>`,
      `<iframe srcdoc="<p>x</p>"></iframe>`,
      `<frame src="https://embed.example.com/x"></frame>`,
      `<object data="https://embed.example.com/x"></object>`,
      `<embed>`,
    ]) {
      const found = scan(html, { csp: { frameDomains: ["https://embed.example.com"] } });
      expect(found.ok, html).toBe(false);
      expect(found.issues[0], html).toMatchObject({
        code: "html_csp_violation",
        message: "embedded frames and objects are not allowed",
      });
    }
    const link = scan(`<a href="https://example.com/docs">docs</a><script>fetch("https://api.example")</script>`);
    expect(link.ok).toBe(true);
    expect(link.warnings.map((warning) => warning.message)).toEqual([
      "links are disabled in the preview",
      "script uses the network but connectDomains is empty: requests will be blocked",
    ]);
    const linked = scan(`<script>fetch("https://api.example")</script>`, { csp: { connectDomains: ["https://api.example"] } });
    expect(linked.warnings).toEqual([]);
  });

  it("stays bounded on hostile input", () => {
    const repeated = "<a ".repeat(Math.floor(LIVE_HTML_MAX_BYTES / 3));
    const started = performance.now();
    const before = process.memoryUsage().heapUsed;
    const line = scan(repeated);
    const delta = process.memoryUsage().heapUsed - before;
    expect(performance.now() - started).toBeLessThan(500);
    expect(delta).toBeLessThan(100 * 1024 * 1024);
    expect(line.ok).toBe(false);
    expect(line.issues[0]?.code).toBe("html_line_too_long");
    expect(scan("x".repeat(HTML_SCAN_MAX_LINE_BYTES + 8)).issues[0]?.code).toBe("html_line_too_long");
    expect(scan("<!--").ok).toBe(true);
    expect(scan(`<img alt="${"q".repeat(20_000)}`).issues[0]?.code).toBe("html_attr_too_long");
    let attrs = "<div";
    for (let index = 0; index < 100_000; index += 1) {
      if (index % 8_000 === 0) attrs += "\n";
      attrs += " x";
    }
    attrs += ">";
    expect(Buffer.byteLength(attrs)).toBeLessThanOrEqual(LIVE_HTML_MAX_BYTES);
    const attrStarted = performance.now();
    const attrBefore = process.memoryUsage().heapUsed;
    const parsed = scan(attrs);
    expect(parsed.ok).toBe(true);
    expect(performance.now() - attrStarted).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - attrBefore).toBeLessThan(100 * 1024 * 1024);
    let clock = 0;
    const timed = scan(`<p>${"a".repeat(10_000)}</p>`, {
      now: () => {
        clock += 1_000;
        return clock;
      },
    });
    expect(timed.issues[0]?.code).toBe("html_scan_timeout");
    const chunk = "url(".repeat(12_000);
    const repeatedUrls = `<style>${chunk}\n${chunk}\n${chunk}\n${"url(x)".repeat(8_000)}</style>`;
    const cssStarted = performance.now();
    const cssBefore = process.memoryUsage().heapUsed;
    const css = scan(repeatedUrls);
    expect(performance.now() - cssStarted).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - cssBefore).toBeLessThan(100 * 1024 * 1024);
    expect(css.issues.length).toBeGreaterThan(0);
    const openUrl = scan(`<style>url(https://evil.example/unterminated`);
    expect(openUrl.issues[0]?.code).toBe("html_csp_violation");
    const imports = scan("@import ".repeat(100_000));
    expect(imports.issues[0]?.code).toBe("html_document_too_large");
  });
});

async function openStore(): Promise<{ store: RunStore; home: string; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-html-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-html-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { store, home, project: registered };
}

const PAGE = "<p>Hello</p>";
const HTML_MANIFEST = { format: "html", bindings: [] as const };

function toolSource(): string {
  return "export const access = { network: [] };\nexport default async function execute() {\n  return { weeks: 1 };\n}\n";
}

async function writeFunction(project: string): Promise<void> {
  const source = toolSource();
  const file = functionFilePath(project, "revenue_by_week");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `id: revenue_by_week
name: revenue_by_week
kind: tool
tool_name: revenue_by_week
tool_description: Read revenue
input_schema:
  type: object
  additionalProperties: false
source: |
${source
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`,
  );
}

async function writeStage(project: string): Promise<void> {
  await writeFile(
    path.join(project, "stageflow.yaml"),
    "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  tasks: []\n",
  );
  await writeFile(
    path.join(project, "sales.pipeline.yaml"),
    `id: sales
stages:
  - id: summarize
    tools:
      functions:
        - id: revenue_by_week
`,
  );
}

function request(body?: unknown): IncomingMessage {
  if (body === undefined) return {} as IncomingMessage;
  const payload = Buffer.from(JSON.stringify(body));
  return {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

function captureResponse() {
  const sent: { status?: number; body?: Record<string, unknown>; headers?: Record<string, string | number> } = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>) {
      sent.status = status;
      sent.headers = headers;
    },
    end(payload?: Buffer | string) {
      if (typeof payload === "string" || Buffer.isBuffer(payload)) sent.body = { text: String(payload) };
    },
  } as unknown as ServerResponse;
  return { res, sent };
}

async function call(store: RunStore, method: string, pathname: string, body?: unknown) {
  const { res, sent } = captureResponse();
  const url = new URL(pathname, "http://127.0.0.1");
  await handleArtifactRoutes(request(body), method, url.pathname, url, store, res, (response, status, payload) => {
    json(response, status, payload);
    sent.status = status;
    sent.body = payload as Record<string, unknown>;
  });
  return sent;
}

describe("live.html publish", () => {
  it("rejects a CSP violation before writing and returns warnings, versions, and a hidden eval publish", async () => {
    const { store, home, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const owner = { kind: "stage" as const, pipeline: "sales", stage: "summarize" };
    await expect(
      publishArtifact(db, {
        owner,
        projectRoot: project,
        id: "page",
        kind: "live.html",
        title: "Page",
        bytes: Buffer.from(`<img src="https://cdn.example/a.png">`),
        manifest: HTML_MANIFEST,
        publishSource: "api",
        roots,
      }),
    ).rejects.toMatchObject({ code: "artifact.html_csp_violation" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_versions`).get()).toEqual({ n: 0 });
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "page");
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(storageKey)))).toBe(false);

    const warned = await publishArtifact(db, {
      owner,
      projectRoot: project,
      id: "page",
      kind: "live.html",
      title: "Html title token",
      description: "desc token",
      tags: ["tagtoken"],
      summary: "summary token",
      bytes: Buffer.from(`<a href="https://example.com/docs">docs</a><p>uniquetokenhtmlbody</p>`),
      manifest: HTML_MANIFEST,
      publishSource: "api",
      roots,
    });
    expect(warned.version).toBe(1);
    expect(warned.unchanged).toBe(false);
    expect(warned.warnings?.map((warning) => warning.message)).toEqual(["links are disabled in the preview"]);
    const again = await publishArtifact(db, {
      owner,
      projectRoot: project,
      id: "page",
      kind: "live.html",
      title: "Html title token",
      bytes: Buffer.from(`<a href="https://example.com/docs">docs</a><p>uniquetokenhtmlbody</p>`),
      manifest: { format: "html", bindings: [] },
      publishSource: "api",
      roots,
    });
    expect(again).toMatchObject({ version: 1, unchanged: true });
    const changed = await publishArtifact(db, {
      owner,
      projectRoot: project,
      id: "page",
      kind: "live.html",
      title: "Html title token",
      bytes: Buffer.from(`<a href="https://example.com/docs">docs</a><p>uniquetokenhtmlbody</p>`),
      manifest: { format: "html", csp: { connectDomains: ["https://api.example.com"] }, bindings: [] },
      publishSource: "api",
      roots,
    });
    expect(changed.version).toBe(2);
    const record = readArtifact(db, "stage:sales:summarize", "page", project, roots);
    expect(record.kind).toBe("live.html");
    expect(record.live?.format).toBe("html");
    expect(record.live?.csp).toEqual({ connectDomains: ["https://api.example.com"] });
    const row = db.prepare(`SELECT relative_path FROM artifact_versions WHERE version = 2`).get() as { relative_path: string };
    expect(row.relative_path).toBe("document.html");
    expect(extractSearchBody("live.html", Buffer.from("uniquetokenhtmlbody"))).toBe("");
    const found = listArtifacts(db, { limit: 10, q: "uniquetokenhtmlbody" }, roots);
    expect(found.artifacts).toEqual([]);
    expect(listArtifacts(db, { limit: 10, q: "Html title token" }, roots).artifacts.map((item) => item.kind)).toEqual(["live.html"]);
    expect(listArtifacts(db, { limit: 10, kind: "live" }, roots).artifacts).toHaveLength(1);

    const report = await readPublishedArtifactStoreReport(db, home);
    expect(report.hash_mismatches).toEqual([]);
    expect(report.missing_content).toEqual([]);
    expect(report.orphan_directories).toEqual([]);

    const hidden = await publishArtifact(db, {
      owner,
      projectRoot: project,
      id: "secret",
      kind: "live.html",
      title: "Secret",
      bytes: Buffer.from(PAGE),
      manifest: HTML_MANIFEST,
      publishSource: "api",
      roots,
      hidden: true,
      ownerNamespace: "eval",
    });
    expect(hidden.key.startsWith("eval:")).toBe(true);
    expect(listArtifacts(db, { limit: 10, q: "Secret" }, roots).artifacts).toEqual([]);
  });

  it("refreshes and queries a bound live.html artifact through the routes", async () => {
    const { store, project } = await openStore();
    await writeFunction(project);
    await writeStage(project);
    setArtifactRouteRefreshInvokeForTests(async () => {
      const view: FunctionRunView = {
        ok: true,
        value: { weeks: 1 },
        logs: "",
        durationMs: 1,
        sourceHash: "abc",
        revision: 1,
        kind: "artifact",
        status: "succeeded",
      };
      return view;
    });
    const published = await call(store, "POST", "/api/artifacts", {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      project_root: project,
      id: "page",
      kind: "live.html",
      title: "Page",
      content: PAGE,
      manifest: {
        format: "html",
        bindings: [{ id: "rows", function: "revenue_by_week", args: {} }],
        refresh: { ttl_seconds: 30 },
      },
    });
    expect(published.status).toBe(200);
    const key = `/api/artifacts/stage:sales:summarize/page`;
    const root = `project_root=${encodeURIComponent(project)}`;
    const refreshed = await call(store, "POST", `${key}/refresh?${root}`, {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body?.status).toBe("fresh");
    const data = await call(store, "GET", `${key}/data?${root}`);
    expect(data.status).toBe(200);
    expect((data.body?.snapshots as Array<{ value: unknown }>)[0]?.value).toEqual({ weeks: 1 });
    const queried = await call(store, "POST", `${key}/query?${root}`, { binding_id: "rows", args: {} });
    expect(queried.status).toBe(200);
    const violated = await call(store, "POST", "/api/artifacts", {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      project_root: project,
      id: "bad",
      kind: "live.html",
      title: "Bad",
      content: `<img src="https://cdn.example/a.png">`,
      manifest: HTML_MANIFEST,
    });
    expect(violated.status).toBe(400);
    expect(violated.body?.code).toBe("artifact.html_csp_violation");
  });

  it("publishes through the stage tool, the agent tool, and the CLI", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    const stageTool = createPublishArtifactTool({
      runWorkspaceDir: project,
      stageId: "summarize",
      attempt: 1,
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          { owner: { kind: "stage", pipeline: "sales", stage: "summarize" }, projectRoot: project, source: {} },
          body,
        ),
    });
    const stage = await stageTool.execute("call-1", {
      id: "page",
      kind: "live.html",
      title: "Page",
      content: PAGE,
      format: "html",
      csp: { resourceDomains: ["https://cdn.example.com"] },
    });
    expect(stage.isError).toBeUndefined();
    const stageBad = await stageTool.execute("call-2", {
      id: "bad",
      kind: "live.html",
      title: "Bad",
      content: `<script src="https://cdn.example/app.js"></script>`,
      format: "html",
    });
    expect(stageBad.isError).toBe(true);
    expect(JSON.parse(stageBad.content[0]!.text).code).toBe("artifact.html_csp_violation");
    const agentTool = createAgentPublishArtifactTool({
      agentId: "helper",
      projectRoot: project,
      stageflowHome: path.join(project, "home"),
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          { owner: { kind: "agent", agent: "helper" }, projectRoot: project, source: { sessionId: "sess-1" } },
          body,
        ),
    });
    const agent = await agentTool.execute("call-3", {
      id: "board",
      kind: "live.html",
      title: "Board",
      content: PAGE,
      format: "html",
    });
    expect(agent.isError).toBeUndefined();
    const agentBad = await agentTool.execute("call-4", {
      id: "board-bad",
      kind: "live.html",
      title: "Board",
      content: `<iframe src="https://embed.example/x"></iframe>`,
      format: "html",
    });
    expect(JSON.parse(agentBad.content[0]!.text).code).toBe("artifact.html_csp_violation");

    const page = path.join(project, "page.html");
    const manifest = path.join(project, "manifest.json");
    await writeFile(page, PAGE);
    await writeFile(manifest, JSON.stringify(HTML_MANIFEST));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) };
    expect(ARTIFACT_USAGE).toContain("--manifest");
    expect(
      await runArtifactCommand(
        ["publish", "--owner", "sales:summarize", "--id", "cli-page", "--kind", "live.html", "--title", "CLI", "--file", page, "--manifest", manifest, "--project-root", project, "--json"],
        { cwd: project, projectRoot: project, io },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.join("\n")).key).toBe("stage:sales:summarize/cli-page");
    stdout.length = 0;
    const bad = path.join(project, "bad.html");
    await writeFile(bad, `<img src="https://cdn.example/a.png">`);
    expect(
      await runArtifactCommand(
        ["publish", "--owner", "sales:summarize", "--id", "cli-bad", "--kind", "live.html", "--title", "CLI", "--file", bad, "--manifest", manifest, "--project-root", project, "--json"],
        { cwd: project, projectRoot: project, io },
      ),
    ).toBe(1);
    expect(JSON.parse(stdout.join("\n")).code).toBe("artifact.html_csp_violation");
  });

  it("uses the same CSP string the console sends in sf/sandbox-load", () => {
    const samples = [
      {},
      { connectDomains: ["https://api.example.com"] },
      {
        resourceDomains: ["https://cdn.example.com", "https://cdn.example.com"],
        baseUriDomains: ["https://app.example.com"],
        connectDomains: ["https://b.example.com", "https://a.example.com"],
      },
    ];
    for (const sample of samples) {
      expect(liveHtmlDocumentCsp(sample)).toBe(buildHtmlCsp(sample));
    }
  });
});
