import { createServer, type Server } from "node:http";
import { connect as connectNet } from "node:net";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_ERROR, MAX_FRAME_WIDTH_PX, parseBridgeMessage, parseSandboxLoadParams } from "../src/artifacts/bridge/protocol.js";
import { buildHtmlCsp, libraryCspSources } from "../src/artifacts/htmlManifest.js";
import { HTML_LIBRARIES } from "../src/artifacts/library/htmlLibraries.js";
import { ShutdownController } from "../src/server/shutdown.js";
import {
  consoleHostIsIpv6,
  parseSandboxOrigin,
  shellContentSecurityPolicy,
  shellDocumentHeaders,
} from "../src/server/sandboxPolicy.js";
import {
  attachSandboxShutdown,
  startSandboxListener,
  type SandboxBind,
  type SandboxListener,
} from "../src/server/sandboxListener.js";
import {
  BRIDGE_CLIENT_SOURCE,
  SHELL_HTML,
  acceptArtifactCsp,
  allowMessageRate,
  buildLiveDocument,
  clampFrameHeight,
  clampFrameWidth,
  clampSizeChangedParams,
  prepareSizeChangedMessage,
  createLoadGuard,
  isHashNavigation,
  planHashClick,
  resolveHashScrollTarget,
  shellHtmlSha256,
  shellScript,
  truncateHref,
} from "../src/server/sandboxShell.js";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cspSources(policy: string, directive: string): string[] {
  const part = policy.split("; ").find((entry) => entry.startsWith(`${directive} `));
  if (!part) return [];
  return part.slice(directive.length + 1).split(" ").filter((token) => token.length > 0);
}

function cspSourceMatches(source: string, url: string, selfOrigin: string): boolean {
  if (source === "'none'" || source === "'unsafe-inline'" || source === "'unsafe-eval'") return false;
  if (source === "'self'") {
    try {
      return new URL(url).origin === selfOrigin;
    } catch {
      return false;
    }
  }
  if (source.endsWith(":") && !source.includes("//")) return url.startsWith(source);
  let base: URL;
  try {
    base = new URL(source);
  } catch {
    return false;
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (base.protocol !== target.protocol || base.host !== target.host) return false;
  const pathPart = source.slice(`${base.protocol}//${base.host}`.length);
  if (!pathPart.startsWith("/")) return true;
  if (pathPart.endsWith("/")) return target.pathname.startsWith(pathPart);
  return target.pathname === pathPart;
}

function cspIntersectionAllows(header: string, meta: string, directive: string, url: string, selfOrigin: string): boolean {
  const headerSources = cspSources(header, directive);
  const metaSources = cspSources(meta, directive);
  const headerHit = headerSources.some((source) => cspSourceMatches(source, url, selfOrigin));
  const metaHit = metaSources.some((source) => cspSourceMatches(source, url, selfOrigin));
  return headerHit && metaHit;
}
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const listeners: SandboxListener[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("busy");
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

async function start(
  env: NodeJS.ProcessEnv,
  listenHost: string,
  hostPort: number,
  origins = ["http://127.0.0.1:3847"],
  bind?: SandboxBind,
) {
  const listener = await startSandboxListener({
    consoleOrigins: origins,
    hostPort,
    listenHost,
    env,
    ...(bind ? { bind } : {}),
  });
  listeners.push(listener);
  return listener;
}

describe("sandbox listener", () => {
  it("binds loopback only and serves the shell routes", async () => {
    const listener = await start({}, "127.0.0.1", 22000);
    expect(listener.reason).toBe("listening");
    expect(listener.origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(listener.addresses.every((address) => address === "127.0.0.1" || address === "::1")).toBe(true);
    expect(listener.addresses).not.toContain("0.0.0.0");
    const origin = listener.origin!;
    const html = await fetch(`${origin}/shell.html?parent=http%3A%2F%2F127.0.0.1%3A3847`);
    expect(html.status).toBe(200);
    expect(await html.text()).toBe(SHELL_HTML);
    const headers = shellDocumentHeaders(["http://127.0.0.1:3847"]);
    for (const [name, value] of Object.entries(headers)) {
      expect(html.headers.get(name)).toBe(value);
    }
    expect(html.headers.get("set-cookie")).toBeNull();
    expect([...html.headers.keys()].some((name) => name.startsWith("access-control-"))).toBe(false);
    expect(html.headers.get("cross-origin-resource-policy")).toBeNull();
    const names = [...html.headers.keys()].sort();
    expect(names).toEqual(
      [
        "cache-control",
        "connection",
        "content-length",
        "content-security-policy",
        "content-type",
        "cross-origin-opener-policy",
        "date",
        "keep-alive",
        "permissions-policy",
        "referrer-policy",
        "x-content-type-options",
      ].sort(),
    );
    const script = await fetch(`${origin}/shell.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("http://127.0.0.1:3847");
    const live = await fetch(`${origin}/livez`);
    expect(live.status).toBe(200);
    expect(await live.text()).toBe("ok\n");
    const head = await fetch(`${origin}/shell.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-security-policy")).toBe(headers["Content-Security-Policy"]);
    expect((await fetch(`${origin}/libs/chart.js`)).status).toBe(404);
    expect((await fetch(`${origin}/api/health`)).status).toBe(404);
    expect((await fetch(`${origin}/shell.html`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${origin}/nope`, { method: "PUT" })).status).toBe(404);
    const blocked = await fetch(`${origin}/livez`, { method: "POST" });
    expect(blocked.status).toBe(405);
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  it("serves only listed library files and only those responses send Access-Control-Allow-Origin", async () => {
    const listener = await start({}, "127.0.0.1", 22100);
    const origin = listener.origin!;
    const chart = HTML_LIBRARIES.find((library) => library.name === "chartjs")!;
    const file = chart.files[0]!;
    const url = `${origin}/libs/${chart.name}@${chart.version}/${file.path}`;
    const body = await fetch(url);
    expect(body.status).toBe(200);
    expect(body.headers.get("content-type")).toBe("application/javascript");
    expect(body.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(body.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(body.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.headers.get("set-cookie")).toBeNull();
    expect(body.headers.get("content-security-policy")).toBeNull();
    expect(body.headers.get("referrer-policy")).toBeNull();
    const bytes = Buffer.from(await body.arrayBuffer());
    expect(bytes.length).toBe(chart.bytes);
    const again = await fetch(url);
    expect(again.status).toBe(200);
    expect(again.headers.get("content-type")).toBe(body.headers.get("content-type"));
    expect(again.headers.get("cache-control")).toBe(body.headers.get("cache-control"));
    expect(again.headers.get("cross-origin-resource-policy")).toBe(body.headers.get("cross-origin-resource-policy"));
    expect(again.headers.get("access-control-allow-origin")).toBe(body.headers.get("access-control-allow-origin"));
    expect(Buffer.from(await again.arrayBuffer())).toEqual(bytes);
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(chart.bytes));
    expect(head.headers.get("access-control-allow-origin")).toBe("*");
    const leaflet = HTML_LIBRARIES.find((library) => library.name === "leaflet")!;
    const png = leaflet.files.find((entry) => entry.path.endsWith(".png"))!;
    const image = await fetch(`${origin}/libs/${leaflet.name}@${leaflet.version}/${png.path}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    const css = await fetch(`${origin}/libs/${leaflet.name}@${leaflet.version}/leaflet.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const missing = [
      `${origin}/libs/${chart.name}@${chart.version}/nope.js`,
      `${origin}/libs/${chart.name}@9.9.9/${file.path}`,
      `${origin}/libs/notalib@1.0.0/a.js`,
      `${origin}/libs/${chart.name}@${chart.version}/../package.json`,
      `${origin}/libs/${chart.name}@${chart.version}/%2e%2e/%2e%2e/package.json`,
      `${origin}/libs/${chart.name}@${chart.version}/..%2f..%2fpackage.json`,
      `${origin}/libs/${chart.name}@${chart.version}//${file.path}`,
      `${origin}/libs/${chart.name}@${chart.version}/%2e%2e%2fpackage.json`,
    ];
    for (const target of missing) {
      const response = await fetch(target);
      expect(response.status, target).toBe(404);
      expect(response.headers.get("access-control-allow-origin"), target).toBeNull();
    }
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(url, { method: "POST" })).headers.get("access-control-allow-origin")).toBeNull();
    const shell = await fetch(`${origin}/shell.js`);
    expect(shell.headers.get("access-control-allow-origin")).toBeNull();
    const live = await fetch(`${origin}/livez`);
    expect(live.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects an oversized header", async () => {
    const listener = await start({}, "localhost", 23000);
    expect(listener.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const status = await new Promise<string>((resolve) => {
      const socket = connectNet(listener.port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      socket.write(`GET /shell.html HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\nX-Big: ${"a".repeat(9000)}\r\n\r\n`);
    });
    expect(status === "" || status.includes("431")).toBe(true);
  });

  it("selects a hostname that differs from the console and answers localhost on ::1", async () => {
    const onLoopback = await start({}, "127.0.0.1", 24000);
    const onLocalhost = await start({}, "localhost", 24100);
    expect(new URL(onLoopback.origin!).hostname).toBe("localhost");
    expect(new URL(onLocalhost.origin!).hostname).toBe("127.0.0.1");
    expect(onLoopback.addresses).toContain("::1");
    const body = await fetch(`${onLoopback.origin}/livez`);
    expect(await body.text()).toBe("ok\n");
  });

  it("disables a pinned port that is taken and does not scan onward", async () => {
    const busy = await listen();
    const listener = await start({ STAGEFLOW_SANDBOX_PORT: String(busy.port) }, "127.0.0.1", busy.port + 50);
    expect(listener.origin).toBeNull();
    expect(listener.reason).toBe("pinned-taken");
    expect(listener.port).toBe(0);
  });

  it("uses a free pinned port and refuses an invalid one", async () => {
    const probe = await listen();
    const port = probe.port;
    await new Promise<void>((resolve) => probe.server.close(() => resolve()));
    servers.splice(servers.indexOf(probe.server), 1);
    const pinned = await start({ STAGEFLOW_SANDBOX_PORT: String(port) }, "127.0.0.1", 25000);
    expect(pinned.port).toBe(port);
    expect(pinned.reason).toBe("listening");
    const invalid = await start({ STAGEFLOW_SANDBOX_PORT: "80" }, "127.0.0.1", 25100);
    expect(invalid.reason).toBe("invalid-port");
    const text = await start({ STAGEFLOW_SANDBOX_PORT: "abc" }, "127.0.0.1", 25200);
    expect(text.reason).toBe("invalid-port");
  });

  it("stays off for a wildcard bind, docker, and an explicit disable", async () => {
    expect((await start({}, "0.0.0.0", 26000)).reason).toBe("remote-bind");
    expect((await start({ STAGEFLOW_IN_DOCKER: "1" }, "127.0.0.1", 26100)).reason).toBe("remote-bind");
    expect((await start({ STAGEFLOW_SANDBOX_DISABLED: "1" }, "127.0.0.1", 26200)).reason).toBe("disabled");
  });

  it("binds all interfaces in a container when STAGEFLOW_SANDBOX_PORT is set, loopback otherwise", async () => {
    const binds: Array<{ host: string; port: number; ipv6Only: boolean }> = [];
    const capture: SandboxBind = async (host, port, ipv6Only, handler) => {
      binds.push({ host, port, ipv6Only });
      return new Promise((resolve, reject) => {
        const server = createServer(handler);
        server.once("error", reject);
        server.listen({ port, host, ipv6Only }, () => resolve(server));
      });
    };
    const local = await start({}, "127.0.0.1", 26300, ["http://127.0.0.1:3847"], capture);
    expect(local.reason).toBe("listening");
    expect(binds.some((entry) => entry.host === "127.0.0.1")).toBe(true);
    expect(binds.some((entry) => entry.host === "0.0.0.0")).toBe(false);
    binds.length = 0;
    const probe = await listen();
    const port = probe.port;
    await new Promise<void>((resolve) => probe.server.close(() => resolve()));
    servers.splice(servers.indexOf(probe.server), 1);
    const docker = await start(
      { STAGEFLOW_IN_DOCKER: "1", STAGEFLOW_SANDBOX_PORT: String(port) },
      "0.0.0.0",
      26400,
      ["http://127.0.0.1:3847"],
      capture,
    );
    expect(docker.reason).toBe("listening");
    expect(docker.port).toBe(port);
    expect(binds).toEqual([{ host: "0.0.0.0", port, ipv6Only: false }]);
    expect(binds.some((entry) => entry.host === "127.0.0.1" || entry.host === "::1")).toBe(false);
  });

  it("returns null when every scanned port is taken", async () => {
    let hostPort = 0;
    for (let attempt = 0; attempt < 20 && hostPort === 0; attempt += 1) {
      const probe = await listen();
      const candidate = probe.port;
      await new Promise<void>((resolve) => probe.server.close(() => resolve()));
      servers.splice(servers.indexOf(probe.server), 1);
      const taken: Server[] = [];
      let ok = true;
      for (let offset = 1; offset <= 20; offset += 1) {
        const server = createServer((_req, res) => res.end("x"));
        const bound = await new Promise<boolean>((resolve) => {
          server.once("error", () => resolve(false));
          server.listen(candidate + offset, "127.0.0.1", () => resolve(true));
        });
        if (!bound) {
          ok = false;
          break;
        }
        taken.push(server);
      }
      if (ok) {
        servers.push(...taken);
        hostPort = candidate;
      } else {
        await Promise.all(taken.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      }
    }
    expect(hostPort).toBeGreaterThan(0);
    const listener = await start({}, "127.0.0.1", hostPort);
    expect(listener.origin).toBeNull();
    expect(listener.reason).toBe("no-port");
  });

  it("close releases the port and a fresh process exits", async () => {
    const listener = await start({}, "127.0.0.1", 27000);
    const port = listener.port;
    await listener.close();
    listeners.pop();
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => again.close(() => resolve()));

    const file = path.join(repoRoot, ".sandbox-exit-check.ts");
    await writeFile(
      file,
      `import { startSandboxListener } from "./src/server/sandboxListener.ts";
startSandboxListener({ consoleOrigins: ["http://127.0.0.1:9"], hostPort: 28000, listenHost: "127.0.0.1", env: {} }).then((listener) => listener.close());
`,
    );
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, file], { cwd: repoRoot, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 8000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    await rm(file, { force: true });
    expect(code).toBe(0);
  });
});

describe("sandbox shell", () => {
  it("locks the shell document to its hash and the nested sandbox attribute", () => {
    expect(shellHtmlSha256()).toBe(createHash("sha256").update(SHELL_HTML).digest("hex"));
    expect(shellHtmlSha256()).toBe("e56ff183423f79802cb836a04a39a42fd5b1e26c39ae8c59d75224fe52f62a2e");
    const scripts = [...SHELL_HTML.matchAll(/<script\b([^>]*)>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toContain('src="/shell.js"');
    expect(SHELL_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(SHELL_HTML).not.toMatch(/javascript:/i);
    const script = shellScript(["http://127.0.0.1:3847"]);
    const sources = `${script}\n${BRIDGE_CLIENT_SOURCE}`;
    expect(script).toContain('setAttribute("sandbox", "allow-scripts")');
    expect(sources).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|allow-modals|allow-downloads/);
    expect(sources).not.toMatch(/\beval\s*\(|new\s+Function|innerHTML|document\.write/);
    expect(BRIDGE_CLIENT_SOURCE).toContain("window.stageflow");
    expect(BRIDGE_CLIENT_SOURCE).toContain("ResizeObserver");
    expect(isHashNavigation("#top")).toBe(true);
    expect(isHashNavigation("https://example.com")).toBe(false);
    expect(truncateHref("a".repeat(250)).length).toBe(200);
    expect(clampFrameHeight(9000)).toBe(4000);
    expect(clampFrameWidth(9000)).toBe(MAX_FRAME_WIDTH_PX);
    expect(clampFrameWidth(-1)).toBe(0);
    expect(clampFrameWidth(Number.NaN)).toBe(0);
    expect(clampFrameWidth(100.7)).toBe(101);
    expect(BRIDGE_CLIENT_SOURCE).toContain(`var MAX_W = ${MAX_FRAME_WIDTH_PX}`);
    expect(BRIDGE_CLIENT_SOURCE).toContain("validateCallArgs");
    const bucket: number[] = [];
    for (let i = 0; i < 200; i += 1) expect(allowMessageRate(bucket, 1000)).toBe(true);
    expect(allowMessageRate(bucket, 1000)).toBe(false);
  });

  it("uses the shell header as the https ceiling", () => {
    expect(shellContentSecurityPolicy(["http://127.0.0.1:3847", "http://localhost:3847"])).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; media-src 'self' data: https:; connect-src https:; frame-src about:; base-uri https:; form-action 'none'; object-src 'none'; frame-ancestors http://127.0.0.1:3847 http://localhost:3847",
    );
    expect(shellContentSecurityPolicy([])).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; media-src 'self' data: https:; connect-src https:; frame-src about:; base-uri https:; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
    );
    expect(shellScript(["http://127.0.0.1:3847"])).toContain("function createLoadGuard");
    expect(shellContentSecurityPolicy(["http://127.0.0.1:3847"])).toContain("connect-src https:");
    expect(shellContentSecurityPolicy(["http://127.0.0.1:3847"])).not.toContain("connect-src 'self'");
    expect(shellContentSecurityPolicy(["http://127.0.0.1:3847"])).not.toContain("connect-src https: 'self'");
  });

  it("intersects the shell header with library path sources", () => {
    const origin = "http://127.0.0.1:4311";
    const header = shellContentSecurityPolicy(["http://127.0.0.1:3847"]);
    const all = libraryCspSources(origin, HTML_LIBRARIES.map((library) => ({ name: library.name, version: library.version })));
    const meta = buildHtmlCsp({}, all);
    for (const library of HTML_LIBRARIES) {
      for (const file of library.files) {
        const url = `${origin}/libs/${library.name}@${library.version}/${file.path}`;
        const directive = file.kind === "script" ? "script-src" : file.kind === "style" ? "style-src" : "img-src";
        expect(cspIntersectionAllows(header, meta, directive, url, origin), url).toBe(true);
      }
    }
    const chartOnly = buildHtmlCsp({}, libraryCspSources(origin, [{ name: "chartjs", version: "4.6.2" }]));
    const chartJs = `${origin}/libs/chartjs@4.6.2/chart.umd.min.js`;
    const leafletCss = `${origin}/libs/leaflet@1.9.4/leaflet.css`;
    const d3Js = `${origin}/libs/d3@7.9.2/d3.min.js`;
    expect(cspIntersectionAllows(header, chartOnly, "script-src", chartJs, origin)).toBe(true);
    expect(cspIntersectionAllows(header, chartOnly, "style-src", leafletCss, origin)).toBe(false);
    expect(cspIntersectionAllows(header, chartOnly, "script-src", d3Js, origin)).toBe(false);
    expect(cspIntersectionAllows(header, chartOnly, "script-src", `${origin}/shell.js`, origin)).toBe(false);
    expect(cspIntersectionAllows(header, chartOnly, "script-src", "https://cdn.example.com/app.js", origin)).toBe(false);
    expect(cspIntersectionAllows(header, meta, "connect-src", `${origin}/libs/chartjs@4.6.2/chart.umd.min.js`, origin)).toBe(false);
  });

  it("wraps live HTML with the meta policy first and drops base and refresh", () => {
    const csp = buildHtmlCsp({ connectDomains: ["https://api.example.com"] });
    const html = `<!DOCTYPE html>\n<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body><script>var marker = "<base href=evil>";</script><p>ok</p></body></html>`;
    const doc = buildLiveDocument(html, csp, "window.stageflow = {};");
    expect(doc.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">`)).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("window.stageflow"));
    expect(doc.indexOf("window.stageflow")).toBeLessThan(doc.indexOf("<body>"));
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc).toContain("var marker");
    expect(doc).toContain(`content="default-src 'none'"`);
    const stripped = doc.replace('var marker = "<base href=evil>"', "");
    expect(stripped).not.toMatch(/<base/i);
    expect(stripped.toLowerCase()).not.toContain('http-equiv="refresh"');
    const context = vm.createContext({ TextEncoder, URLSearchParams }) as {
      __sfBuildLiveDocument: (html: string, csp: string) => string;
    };
    vm.runInContext(shellScript(["http://127.0.0.1:1"]), context);
    const fromShell = context.__sfBuildLiveDocument(html, csp);
    const shellStripped = fromShell.replace('var marker = "<base href=evil>"', "");
    expect(shellStripped).not.toMatch(/<base/i);
    expect(fromShell).toContain("var marker");
    expect(fromShell).toContain(`content="default-src 'none'"`);
    expect(fromShell.indexOf("Content-Security-Policy")).toBeLessThan(fromShell.indexOf("<body>"));
    expect(fromShell.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("agrees with the bridge parser on relay decisions", () => {
    const context = vm.createContext({ TextEncoder, URLSearchParams }) as {
      __sfAcceptRelay: (value: unknown) => boolean;
    };
    vm.runInContext(shellScript(["http://127.0.0.1:1"]), context);
    const samples = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: "init", method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "a", version: "1" }, appCapabilities: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kpi.summary", arguments: { range: "7d" } } },
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 150, width: 300 } },
      { jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: "#no" } },
      { jsonrpc: "2.0", method: "ui/notifications/initialized" },
      { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } },
      { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "rows" } },
      { jsonrpc: "2.0", id: 1, method: "ping", toString: 1 },
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: "x", error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 1, method: "nope" },
      { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "1999-01-01", appInfo: { name: "a", version: "1" }, appCapabilities: {} } },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "../x" } },
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9000 } },
      { jsonrpc: "2.0", id: 1, method: "ping", extra: true },
      null,
      "ping",
    ];
    for (const sample of samples) {
      expect(context.__sfAcceptRelay(sample)).toBe(parseBridgeMessage(sample).ok);
    }
  });

  it("accepts only a buildHtmlCsp policy and the shell copy agrees", () => {
    const accepted = [
      buildHtmlCsp({}),
      buildHtmlCsp({ connectDomains: ["https://api.example.com"] }),
      buildHtmlCsp({
        resourceDomains: ["https://cdn.example.com", "https://b.example.com"],
        connectDomains: ["https://api.example.com", "https://*.api.example.com"],
        baseUriDomains: ["https://app.example.com"],
      }),
      buildHtmlCsp({
        resourceDomains: ["https://*.assets.example.com"],
        connectDomains: Array.from({ length: 8 }, (_, index) => `https://h${index}.example.com`),
      }),
    ];
    const empty = accepted[0]!;
    const full = accepted[2]!;
    expect(full).toContain("frame-src 'none'");
    expect(buildHtmlCsp({ frameDomains: ["https://embed.example.com:8443"] })).toBe(
      buildHtmlCsp({}),
    );
    const rejected: Array<[string, string]> = [
      ["unknown directive", `${empty}; worker-src 'none'`],
      ["http origin", empty.replace("connect-src 'none'", "connect-src http://api.example.com")],
      ["nested wildcard", empty.replace("connect-src 'none'", "connect-src https://*.*.example.com")],
      ["mid wildcard", empty.replace("connect-src 'none'", "connect-src https://foo.*.example.com")],
      ["bare wildcard", empty.replace("connect-src 'none'", "connect-src https://*")],
      ["star host", empty.replace("connect-src 'none'", "connect-src *")],
      ["unsafe-eval", empty.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' 'unsafe-eval'")],
      ["self", empty.replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'")],
      ["duplicate directive", `default-src 'none'; ${empty}`],
      ["missing directive", empty.replace(/; object-src 'none'$/, "")],
      ["newline", `${empty}\n`],
      ["carriage return", empty.replace("default-src", "default-src\r")],
      ["huge", "a".repeat(9000)],
      ["empty", ""],
      ["unsorted connect", full.replace(
        "connect-src https://*.api.example.com https://api.example.com",
        "connect-src https://api.example.com https://*.api.example.com",
      )],
      ["duplicate origin", empty.replace("connect-src 'none'", "connect-src https://api.example.com https://api.example.com")],
      ["none mixed with origin", empty.replace("connect-src 'none'", "connect-src 'none' https://api.example.com")],
      ["mismatched resource list", empty.replace("img-src data:", "img-src data: https://cdn.example.com")],
      ["scheme only", empty.replace("connect-src 'none'", "connect-src https:")],
      ["path", empty.replace("connect-src 'none'", "connect-src https://api.example.com/v1")],
      ["ip", empty.replace("connect-src 'none'", "connect-src https://127.0.0.1")],
      ["localhost", empty.replace("connect-src 'none'", "connect-src https://localhost")],
      ["single-label wildcard", empty.replace("connect-src 'none'", "connect-src https://*.com")],
      ["uppercase", empty.replace("connect-src 'none'", "connect-src https://API.example.com")],
      ["port 443", empty.replace("connect-src 'none'", "connect-src https://api.example.com:443")],
      ["blob", empty.replace("connect-src 'none'", "connect-src blob:")],
      ["data on connect", empty.replace("connect-src 'none'", "connect-src data:")],
      ["trailing semicolon", `${empty};`],
      ["double space", empty.replace("default-src 'none'", "default-src  'none'")],
      ["nine origins", buildHtmlCsp({
        connectDomains: Array.from({ length: 9 }, (_, index) => `https://n${index}.example.com`),
      })],
      ["backslash", empty.replace("connect-src 'none'", "connect-src https://exa\\mple.com")],
      ["frame origin", empty.replace("frame-src 'none'", "frame-src https://embed.example.com")],
      ["frame https scheme", empty.replace("frame-src 'none'", "frame-src https:")],
      ["frame about", empty.replace("frame-src 'none'", "frame-src about:")],
      ["frame star", empty.replace("frame-src 'none'", "frame-src *")],
    ];
    const context = vm.createContext({ TextEncoder, URLSearchParams }) as {
      __sfAcceptCsp: (csp: string) => boolean;
    };
    vm.runInContext(shellScript(["http://127.0.0.1:1"]), context);
    for (const policy of accepted) {
      expect(acceptArtifactCsp(policy), policy).toBe(true);
      expect(context.__sfAcceptCsp(policy), policy).toBe(true);
    }
    for (const [name, policy] of rejected) {
      expect(acceptArtifactCsp(policy), name).toBe(false);
      expect(context.__sfAcceptCsp(policy), name).toBe(false);
    }
    const origin = "http://127.0.0.1:4311";
    const chart = libraryCspSources(origin, [{ name: "chartjs", version: "4.6.2" }]);
    const leaflet = libraryCspSources(origin, [{ name: "leaflet", version: "1.9.4" }]);
    const mermaid = libraryCspSources(origin, [{ name: "mermaid", version: "12.3.0" }]);
    const withLib = buildHtmlCsp({ resourceDomains: ["https://cdn.example.com"] }, chart);
    const withAssets = buildHtmlCsp({}, leaflet);
    const withEval = buildHtmlCsp({}, { ...mermaid, needsEval: true });
    expect(acceptArtifactCsp(withLib)).toBe(false);
    expect(acceptArtifactCsp(withLib, origin)).toBe(true);
    expect(context.__sfAcceptCsp(withLib, origin)).toBe(true);
    expect(acceptArtifactCsp(withLib, "http://localhost:4311")).toBe(false);
    expect(acceptArtifactCsp(withLib, "http://127.0.0.1:9")).toBe(false);
    expect(acceptArtifactCsp(withAssets, origin)).toBe(true);
    expect(acceptArtifactCsp(withEval, origin, false)).toBe(false);
    expect(acceptArtifactCsp(withEval, origin, true)).toBe(true);
    expect(context.__sfAcceptCsp(withEval, origin, false)).toBe(false);
    expect(context.__sfAcceptCsp(withEval, origin, true)).toBe(true);
    const bare = withLib.replace(chart.libraryDirs[0]!, origin);
    expect(acceptArtifactCsp(bare, origin)).toBe(false);
    expect(context.__sfAcceptCsp(bare, origin)).toBe(false);
    const fileSource = withLib.replace(chart.libraryDirs[0]!, `${chart.libraryDirs[0]}chart.umd.min.js`);
    expect(acceptArtifactCsp(fileSource, origin)).toBe(false);
    const queried = withLib.replace(chart.libraryDirs[0]!, `${chart.libraryDirs[0]}?x=1`);
    expect(acceptArtifactCsp(queried, origin)).toBe(false);
    const otherLib = withLib.replace(chart.libraryDirs[0]!, leaflet.libraryDirs[0]!);
    expect(acceptArtifactCsp(otherLib, origin)).toBe(false);
    const swapped = withLib.replace(`script-src 'unsafe-inline' ${chart.libraryDirs[0]}`, `script-src 'unsafe-inline'`);
    expect(acceptArtifactCsp(swapped, origin)).toBe(false);
  });

  it("replies sf/sandbox-error and skips srcdoc when the CSP is not the manifest shape", () => {
    const messages: unknown[] = [];
    const parent = { postMessage(data: unknown) { messages.push(data); } };
    const frame = {
      attrs: {} as Record<string, string>,
      style: {} as Record<string, string>,
      contentWindow: null as null,
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      addEventListener() {},
    };
    const listeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
    const context = vm.createContext({
      TextEncoder,
      URLSearchParams,
      location: { search: "?parent=http://127.0.0.1:3847" },
      document: { getElementById: () => frame },
      window: {
        parent,
        addEventListener: (_type: string, fn: (event: { source: unknown; origin: string; data: unknown }) => void) => {
          listeners.push(fn);
        },
      },
    });
    vm.runInContext(shellScript(["http://127.0.0.1:3847"]), context);
    const nonce = "ab".repeat(16);
    const send = (csp: string) => {
      listeners[0]!({
        source: parent,
        origin: "http://127.0.0.1:3847",
        data: { jsonrpc: "2.0", method: "sf/sandbox-load", params: { html: "<p>hi</p>", csp, nonce } },
      });
    };
    send("default-src *");
    send(`${"a".repeat(9000)}`);
    expect(messages).toContainEqual({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    expect(messages.filter((message) => (message as { method?: string }).method === "sf/sandbox-error")).toEqual([
      { jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "csp" } },
      { jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "csp" } },
    ]);
    expect(frame.attrs.srcdoc).toBeUndefined();
    const csp = buildHtmlCsp({ resourceDomains: ["https://cdn.example.com"] });
    send(csp);
    expect(frame.attrs.sandbox).toBe("allow-scripts");
    expect(frame.attrs.srcdoc?.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">`)).toBe(true);
    const before = messages.length;
    send("default-src *");
    expect(messages).toHaveLength(before);
  });

  it("createLoadGuard keeps the first nested load and tears the frame down on the second", () => {
    const guard = createLoadGuard();
    expect(guard.onLoad()).toBe("keep");
    expect(guard.onLoad()).toBe("teardown");
    expect(guard.onLoad()).toBe("teardown");
    const context = vm.createContext({ TextEncoder, URLSearchParams }) as {
      __sfCreateLoadGuard: () => { onLoad(): "keep" | "teardown" };
    };
    vm.runInContext(shellScript(["http://127.0.0.1:1"]), context);
    const shellGuard = context.__sfCreateLoadGuard();
    expect(shellGuard.onLoad()).toBe("keep");
    expect(shellGuard.onLoad()).toBe("teardown");

    const messages: unknown[] = [];
    const parent = { postMessage(data: unknown) { messages.push(data); } };
    const loadHandlers: Array<() => void> = [];
    const nested = {};
    const frame = {
      attrs: {} as Record<string, string>,
      style: {} as Record<string, string>,
      contentWindow: nested,
      removed: false,
      parentNode: {
        removeChild(node: { removed?: boolean }) { node.removed = true; },
      },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      addEventListener(type: string, fn: () => void) {
        if (type === "load") loadHandlers.push(fn);
      },
    };
    const listeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
    const run = vm.createContext({
      TextEncoder,
      URLSearchParams,
      location: { search: "?parent=http://127.0.0.1:3847" },
      document: { getElementById: () => frame },
      window: {
        parent,
        addEventListener: (_type: string, fn: (event: { source: unknown; origin: string; data: unknown }) => void) => {
          listeners.push(fn);
        },
      },
    });
    vm.runInContext(shellScript(["http://127.0.0.1:3847"]), run);
    const nonce = "ab".repeat(16);
    listeners[0]!({
      source: parent,
      origin: "http://127.0.0.1:3847",
      data: {
        jsonrpc: "2.0",
        method: "sf/sandbox-load",
        params: { html: "<p>hi</p>", csp: buildHtmlCsp({}), nonce },
      },
    });
    expect(loadHandlers).toHaveLength(1);
    expect(frame.attrs.srcdoc).toContain("frame-src 'none'");
    loadHandlers[0]!();
    expect(frame.removed).toBe(false);
    expect(messages.some((message) => (message as { params?: { reason?: string } }).params?.reason === "navigated")).toBe(false);
    loadHandlers[0]!();
    expect(frame.removed).toBe(true);
    expect(messages).toContainEqual({ jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "navigated" } });
    const before = messages.length;
    listeners[0]!({
      source: nested,
      origin: "null",
      data: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    listeners[0]!({
      source: parent,
      origin: "http://127.0.0.1:3847",
      data: {
        jsonrpc: "2.0",
        method: "sf/sandbox-relay",
        params: { nonce, message: { jsonrpc: "2.0", id: 2, method: "ping" } },
      },
    });
    expect(messages).toHaveLength(before);
  });
});

describe("sandbox host fixes", () => {
  it("resolves hash targets without touching the location", () => {
    expect(resolveHashScrollTarget("#")).toEqual({ kind: "top" });
    expect(resolveHashScrollTarget("#top")).toEqual({ kind: "top" });
    expect(resolveHashScrollTarget("#TOP")).toEqual({ kind: "top" });
    expect(resolveHashScrollTarget("#sec")).toEqual({ kind: "id", id: "sec" });
    expect(resolveHashScrollTarget("#a%20b")).toEqual({ kind: "id", id: "a b" });
    expect(resolveHashScrollTarget("#%")).toEqual({ kind: "id", id: "%" });
    expect(resolveHashScrollTarget("#weird id")).toEqual({ kind: "id", id: "weird id" });
    expect(resolveHashScrollTarget("https://example.com")).toBeNull();
    const none = { byId: () => false, byName: () => false };
    expect(planHashClick("#missing", none)).toBe("missing");
    expect(planHashClick("#", none)).toBe("top");
    expect(planHashClick("#sec", { byId: (id) => id === "sec", byName: () => false })).toBe("scroll");
    expect(planHashClick("#named", { byId: () => false, byName: (name) => name === "named" })).toBe("scroll");
    expect(planHashClick("https://example.com/#sec", { byId: () => true, byName: () => true })).toBe("blocked");
  });

  it("scrolls hash clicks in the bridge client and blocks every other link", async () => {
    const posts: Array<{ id?: number; method?: string; params?: { href?: string } }> = [];
    const scrolled: string[] = [];
    const clicks: Array<(event: { target: unknown; preventDefault: () => void }) => void> = [];
    const messages: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const sec = { id: "sec", scrollIntoView() { scrolled.push("sec"); } };
    const named = { name: "area", scrollIntoView() { scrolled.push("area"); } };
    const document = {
      documentElement: { style: { setProperty() {} }, scrollHeight: 10, scrollWidth: 10 },
      getElementById(id: string) { return id === "sec" ? sec : null; },
      getElementsByName(name: string) { return name === "area" ? [named] : []; },
      addEventListener(type: string, fn: (event: { target: unknown; preventDefault: () => void }) => void) {
        if (type === "click") clicks.push(fn);
      },
    };
    const anchor = (tag: string, href: string) => ({
      tagName: tag,
      nodeType: 1,
      parentNode: document,
      getAttribute(name: string) { return name === "href" ? href : null; },
    });
    const parent = { postMessage(data: { id?: number; method?: string; params?: { href?: string } }) { posts.push(data); } };
    const window = {
      parent,
      addEventListener(type: string, fn: (event: { source: unknown; data: unknown }) => void) {
        if (type === "message") messages.push(fn);
      },
      scrollTo() { scrolled.push("top"); },
      get document() { return document; },
      stageflow: undefined as {
        onBindingUpdated: (cb: (id: string) => void) => void;
        callBinding: (id: string) => Promise<unknown>;
      } | undefined,
    };
    vm.runInContext(
      BRIDGE_CLIENT_SOURCE,
      vm.createContext({ window, document, TextEncoder, setTimeout, clearTimeout }),
    );
    const click = (node: unknown) => {
      let prevented = false;
      clicks[0]!({ target: node, preventDefault() { prevented = true; } });
      return prevented;
    };
    expect(click(anchor("A", "#sec"))).toBe(true);
    expect(click(anchor("AREA", "#area"))).toBe(true);
    expect(click(anchor("A", "#"))).toBe(true);
    expect(click(anchor("A", "#top"))).toBe(true);
    expect(click(anchor("A", "#missing"))).toBe(true);
    expect(click(anchor("A", "https://example.com/out"))).toBe(true);
    expect(scrolled).toEqual(["sec", "area", "top", "top"]);
    expect(posts).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: "https://example.com/out" } },
    ]);
    const seen: string[] = [];
    window.stageflow!.onBindingUpdated((id) => seen.push(`a:${id}`));
    window.stageflow!.onBindingUpdated((id) => seen.push(`b:${id}`));
    messages[0]!({
      source: parent,
      data: { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "rows" } },
    });
    expect(seen).toEqual(["a:rows", "b:rows"]);
    const pending = window.stageflow!.callBinding("rows");
    const call = posts.at(-1)!;
    messages[0]!({
      source: parent,
      data: {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "later" }],
          _meta: { retryable: true },
        },
      },
    });
    await expect(pending).rejects.toMatchObject({ message: "later", retryable: true });
  });

  it("rejects a binding-updated notification that comes from the nested frame", () => {
    const messages: unknown[] = [];
    const nestedPosts: unknown[] = [];
    const parent = { postMessage(data: unknown) { messages.push(data); } };
    const nested = { postMessage(data: unknown) { nestedPosts.push(data); } };
    const frame = {
      attrs: {} as Record<string, string>,
      style: {} as Record<string, string>,
      contentWindow: nested,
      parentNode: { removeChild() {} },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      addEventListener() {},
    };
    const listeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
    const context = vm.createContext({
      TextEncoder,
      URLSearchParams,
      location: { search: "?parent=http://127.0.0.1:3847" },
      document: { getElementById: () => frame },
      window: {
        parent,
        addEventListener: (_type: string, fn: (event: { source: unknown; origin: string; data: unknown }) => void) => {
          listeners.push(fn);
        },
      },
    });
    vm.runInContext(shellScript(["http://127.0.0.1:3847", "http://[::1]:3847"]), context);
    expect(shellScript(["http://[::1]:3847"])).not.toContain("[::1]");
    const nonce = "ab".repeat(16);
    listeners[0]!({
      source: parent,
      origin: "http://127.0.0.1:3847",
      data: {
        jsonrpc: "2.0",
        method: "sf/sandbox-load",
        params: { html: "<p>hi</p>", csp: buildHtmlCsp({}), nonce },
      },
    });
    const notice = { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "rows" } };
    listeners[0]!({
      source: parent,
      origin: "http://127.0.0.1:3847",
      data: { jsonrpc: "2.0", method: "sf/sandbox-relay", params: { nonce, message: notice } },
    });
    expect(nestedPosts).toContainEqual(notice);
    const before = messages.length;
    listeners[0]!({ source: nested, origin: "null", data: notice });
    expect(messages).toHaveLength(before);
  });

  it("serves both loopback names and refuses an IPv6 console", async () => {
    expect(consoleHostIsIpv6("::1")).toBe(true);
    expect(consoleHostIsIpv6("::")).toBe(true);
    expect(consoleHostIsIpv6("127.0.0.1")).toBe(false);
    const ipv6 = await start({ STAGEFLOW_SANDBOX_PORT: "41234" }, "::1", 1);
    expect(ipv6.origin).toBeNull();
    expect(ipv6.origins).toEqual([]);
    expect(ipv6.reason).toBe("ipv6-console");
    const listener = await start({}, "127.0.0.1", 32000);
    expect(listener.origin).toBe(`http://localhost:${listener.port}`);
    expect(listener.origins).toEqual([`http://localhost:${listener.port}`, `http://127.0.0.1:${listener.port}`]);
    expect(await (await fetch(`http://127.0.0.1:${listener.port}/livez`)).text()).toBe("ok\n");
    expect(shellContentSecurityPolicy(["http://[::1]:3847", "http://127.0.0.1:3847", "http://localhost:3847"])).not.toContain("::1");
    expect(parseSandboxOrigin("http://localhost:41234")).toBe("http://localhost:41234");
    expect(parseSandboxOrigin("http://127.0.0.1:41234")).toBe("http://127.0.0.1:41234");
    expect(parseSandboxOrigin("http://localhost:41234/shell")).toBeNull();
    expect(parseSandboxOrigin("http://localhost:41234?x=1")).toBeNull();
    expect(parseSandboxOrigin("http://user:pw@127.0.0.1:41234")).toBeNull();
    expect(parseSandboxOrigin("https://localhost:41234")).toBeNull();
    expect(parseSandboxOrigin("http://[::1]:41234")).toBeNull();
    expect(parseSandboxOrigin("http://example.com:41234")).toBeNull();
  });

  it("returns a null origin when bind fails for a reason other than EADDRINUSE", async () => {
    const denied = await start({}, "127.0.0.1", 33000, ["http://127.0.0.1:1"], async () => {
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    expect(denied.origin).toBeNull();
    expect(denied.reason).toBe("listen-failed");
    const unexpected = await start({}, "127.0.0.1", 33100, ["http://127.0.0.1:1"], async () => {
      throw new Error("boom");
    });
    expect(unexpected.reason).toBe("listen-failed");
    const v6 = await start({}, "127.0.0.1", 33200, ["http://127.0.0.1:1"], (host, port, ipv6Only, handler) => {
      if (host === "::1") {
        const err = new Error("no-v6") as NodeJS.ErrnoException;
        err.code = "EAFNOSUPPORT";
        return Promise.reject(err);
      }
      return new Promise((resolve, reject) => {
        const server = createServer(handler);
        server.once("error", reject);
        server.listen({ port, host, ipv6Only }, () => resolve(server));
      });
    });
    expect(v6.reason).toBe("listening");
    expect(v6.addresses).toEqual(["127.0.0.1"]);
    await v6.close();
  });

  it("stops accepting sandbox connections when the console drain starts", async () => {
    const listener = await start({}, "127.0.0.1", 34000);
    const consoleServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(consoleServer);
    await new Promise<void>((resolve, reject) => {
      consoleServer.once("error", reject);
      consoleServer.listen(0, "127.0.0.1", () => resolve());
    });
    let drained = false;
    let release: (value: { forced: boolean }) => void = () => undefined;
    const gate = new Promise<{ forced: boolean }>((resolve) => {
      release = resolve;
    });
    attachSandboxShutdown(consoleServer, listener);
    const controller = new ShutdownController({
      server: consoleServer,
      host: {
        stopAcceptingWork() {},
        async drainActiveStages() {
          const result = await gate;
          drained = true;
          return result;
        },
        async closeStore() {},
      },
      graceMs: 8000,
      installSignals: false,
    });
    const drain = controller.beginDrain();
    let code = "";
    for (let attempt = 0; attempt < 40 && code !== "ECONNREFUSED"; attempt += 1) {
      code = await new Promise<string>((resolve) => {
        const socket = connectNet(listener.port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve("connected");
        });
        socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
      });
    }
    expect(code).toBe("ECONNREFUSED");
    expect(drained).toBe(false);
    release({ forced: false });
    await drain;
  });

  it("clamps size notifications before relay", () => {
    expect(clampSizeChangedParams({ width: 9000, height: 700 })).toEqual({ width: MAX_FRAME_WIDTH_PX, height: 700 });
    expect(clampSizeChangedParams({ width: -3, height: 2.2 })).toEqual({ width: 0, height: 2 });
    expect(clampSizeChangedParams({ width: "abc" })).toBeNull();
    expect(clampSizeChangedParams({ width: Number.NaN })).toBeNull();
    expect(prepareSizeChangedMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 9000, height: 700 },
    }).params).toEqual({ width: MAX_FRAME_WIDTH_PX, height: 700 });
    const clamped = prepareSizeChangedMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: 9000, height: 700 },
    });
    expect(parseBridgeMessage(clamped).ok).toBe(true);
    expect(parseBridgeMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: "abc" },
    }).ok).toBe(false);
  });

  it("replies to rejected nested requests and stays silent for bad notifications", () => {
    const messages: unknown[] = [];
    const nestedPosts: unknown[] = [];
    const parent = { postMessage(data: unknown) { messages.push(data); } };
    const nested = { postMessage(data: unknown) { nestedPosts.push(data); } };
    const frame = {
      attrs: {} as Record<string, string>,
      style: {} as Record<string, string>,
      contentWindow: nested,
      parentNode: { removeChild() {} },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      addEventListener() {},
    };
    const listeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
    const context = vm.createContext({
      TextEncoder,
      URLSearchParams,
      location: { search: "?parent=http://127.0.0.1:3847" },
      document: { getElementById: () => frame },
      window: {
        parent,
        addEventListener: (_type: string, fn: (event: { source: unknown; origin: string; data: unknown }) => void) => {
          listeners.push(fn);
        },
      },
    });
    vm.runInContext(shellScript(["http://127.0.0.1:3847"]), context);
    const nonce = "ab".repeat(16);
    listeners[0]!({
      source: parent,
      origin: "http://127.0.0.1:3847",
      data: {
        jsonrpc: "2.0",
        method: "sf/sandbox-load",
        params: { html: "<p>hi</p>", csp: buildHtmlCsp({}), nonce },
      },
    });
    const sendNested = (data: unknown) => {
      nestedPosts.length = 0;
      messages.length = 0;
      listeners[0]!({ source: nested, origin: "null", data });
    };
    sendNested({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "rows", arguments: { "img-element": 1 } } });
    expect(nestedPosts).toEqual([{
      jsonrpc: "2.0",
      id: 11,
      error: { code: BRIDGE_ERROR.INVALID_PARAMS, message: "Invalid params" },
    }]);
    expect(messages).toHaveLength(0);
    sendNested({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: "abc" } });
    expect(messages).toHaveLength(0);
    expect(nestedPosts).toHaveLength(0);
    sendNested({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 9000, height: 700 } });
    expect(messages).toHaveLength(1);
    expect((messages[0] as { params?: { message?: { params?: { width?: number } } } }).params?.message?.params?.width).toBe(MAX_FRAME_WIDTH_PX);
    expect(frame.style.height).toBe("700px");
    sendNested({ jsonrpc: "2.0", id: 12, method: "nope" });
    expect(nestedPosts[0]).toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: { code: BRIDGE_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
    });
    for (let index = 0; index < 101; index += 1) {
      nestedPosts.length = 0;
      listeners[0]!({
        source: nested,
        origin: "null",
        data: { jsonrpc: "2.0", id: `cap-${index}`, method: "ping" },
      });
    }
    sendNested({ jsonrpc: "2.0", id: "over", method: "ping" });
    expect(nestedPosts[0]).toEqual({
      jsonrpc: "2.0",
      id: "over",
      error: { code: -32000, message: "Request rejected" },
    });
  });

  it("validates callBinding arguments, times out, and bounds pending requests", async () => {
    vi.useFakeTimers();
    const timer = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
    const posts: unknown[] = [];
    const handlers: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const document = {
      documentElement: { style: { setProperty() {} }, scrollHeight: 10, scrollWidth: 10 },
      addEventListener() {},
      getElementById: () => null,
      getElementsByName: () => [],
    };
    const parent = { postMessage(data: unknown) { posts.push(data); } };
    const window = {
      parent,
      addEventListener(type: string, fn: (event: { source: unknown; data: unknown }) => void) {
        if (type === "message") handlers.push(fn);
      },
      scrollTo() {},
      get document() { return document; },
      stageflow: undefined as { callBinding: (id: string, args?: unknown) => Promise<unknown> } | undefined,
    };
    vm.runInContext(
      BRIDGE_CLIENT_SOURCE,
      vm.createContext({ window, document, TextEncoder, ...timer }),
    );
    await expect(window.stageflow!.callBinding("rows", { "img-element": 1 })).rejects.toMatchObject({
      code: "invalid_arguments",
      message: 'stageflow: invalid argument key "img-element"',
    });
    const slow = window.stageflow!.callBinding("rows", { wait: true });
    vi.advanceTimersByTime(30_001);
    await expect(slow).rejects.toMatchObject({ code: "timeout", message: "stageflow: request timed out" });
    const burst = window.stageflow!.callBinding("rows", { ok: true });
    const call = posts.at(-1) as { id?: number };
    handlers[0]!({
      source: parent,
      data: { jsonrpc: "2.0", id: call.id, result: { structuredContent: { ok: true } } },
    });
    await expect(burst).resolves.toEqual({ ok: true });
    const backlog: Promise<unknown>[] = [];
    for (let index = 0; index < 100; index += 1) backlog.push(window.stageflow!.callBinding("rows", { n: index }));
    await expect(window.stageflow!.callBinding("rows", { n: "overflow" })).rejects.toMatchObject({
      code: "invalid_arguments",
      message: "stageflow: too many pending requests",
    });
    vi.useRealTimers();
  });

  it("injects the same library tags as the shell and agrees on load params", () => {
    const origin = "http://127.0.0.1:4311";
    const libraries = [{ name: "chartjs", version: "4.6.2" }, { name: "leaflet", version: "1.9.4" }];
    const csp = buildHtmlCsp({}, libraryCspSources(origin, libraries));
    const fromHost = buildLiveDocument("<p>ok</p>", csp, "bridge", libraries, origin);
    const context = vm.createContext({
      TextEncoder,
      URLSearchParams,
      location: { origin },
    }) as { __sfBuildLiveDocument: (html: string, csp: string, libraries?: unknown) => string; __sfParseLoad: (value: unknown) => { ok: boolean } };
    vm.runInContext(shellScript(["http://127.0.0.1:1"]), context);
    const fromShell = context.__sfBuildLiveDocument("<p>ok</p>", csp, libraries).replace(/<script>[\s\S]*<\/script>/, "<script>bridge</script>");
    expect(fromShell).toBe(fromHost);
    expect(fromShell.indexOf("chart.umd.min.js")).toBeLessThan(fromShell.indexOf("leaflet.js"));
    expect(fromShell.indexOf("leaflet.js")).toBeLessThan(fromShell.indexOf("leaflet.css"));
    const samples = [
      { html: "<p>ok</p>", csp, nonce: "ab".repeat(16) },
      { html: "<p>ok</p>", csp, nonce: "ab".repeat(16), libraries, allowEval: false },
      { html: "<p>ok</p>", csp, nonce: "ab".repeat(16), libraries: [{ name: "chartjs", version: "4.6.2", path: "x" }] },
      { html: "<p>ok</p>", csp, nonce: "nope", libraries: [] },
      { html: "<p>ok</p>", csp, nonce: "ab".repeat(16), libraries: [{ name: "Chartjs", version: "4.6.2" }] },
      { html: 1, csp, nonce: "ab".repeat(16) },
    ];
    for (const sample of samples) {
      expect(context.__sfParseLoad(sample).ok).toBe(parseSandboxLoadParams(sample).ok);
    }
  });

  it("matches parseBridgeMessage on a shared fuzz corpus", () => {
    const context = vm.createContext({ TextEncoder, URLSearchParams }) as {
      __sfAcceptRelay: (value: unknown) => boolean;
    };
    vm.runInContext(shellScript(["http://127.0.0.1:1"]), context);
    let seed = 0x21b05;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const valid = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "ui/notifications/initialized" },
      { jsonrpc: "2.0", method: "ui/notifications/binding-updated", params: { binding_id: "rows" } },
      { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "rows" } },
      { jsonrpc: "2.0", id: 4, result: { ok: true } },
      { jsonrpc: "2.0", id: 5, error: { code: -32603, message: "failed" } },
    ];
    const count = 20_000;
    for (let index = 0; index < count; index += 1) {
      let value: unknown = structuredClone(pick(valid));
      const roll = next();
      if (roll < 0.15) value = null;
      else if (roll < 0.25) value = { ...(value as object), toString: 1 };
      else if (roll < 0.35) value = { ...(value as object), valueOf: 1 };
      else if (roll < 0.45) value = JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"ping","__proto__":{"admin":true}}`);
      else if (roll < 0.55) value = { ...(value as object), constructor: { bad: true } };
      else if (roll < 0.62) {
        let deep: unknown = { ok: true };
        for (let level = 0; level < 40; level += 1) deep = { child: deep };
        value = { jsonrpc: "2.0", id: 1, result: deep };
      } else if (roll < 0.7) value = { jsonrpc: "2.0", id: 1, error: { code: 1, message: "x", extra: true, data: { a: { b: { c: 1 } } } } };
      else if (roll < 0.78) value = { jsonrpc: "2.0", id: 1, method: "方法", params: {} };
      else if (roll < 0.86) value = { jsonrpc: "2.0", id: 1, method: "ping", params: { blob: "x".repeat(index % 7 === 0 ? 300_000 : 4) } };
      else if (roll < 0.92) value = ["ping"];
      const shellOk = context.__sfAcceptRelay(value);
      const parsedOk = parseBridgeMessage(value).ok;
      if (shellOk !== parsedOk) {
        throw new Error(`corpus mismatch at ${index}: shell=${shellOk} parser=${parsedOk}`);
      }
    }
  });
});
