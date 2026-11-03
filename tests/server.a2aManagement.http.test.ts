import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { resolveAllowedHosts } from "../src/server/allowedHosts.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { createHttpHost } from "../src/server/createHttpHost.js";
import { createOperatorRoutes } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";
import { withEnv } from "./helpers/withEnv.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);
const manifestCatalog = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/manifest-catalog");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearFindProjectRootCacheForTests();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHost(options: { withoutManagement?: boolean } = {}) {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-a2a-http-"));
  cleanups.push(() => rm(storeRoot, { recursive: true, force: true }));
  const { root: repoRoot, cleanup } = await initTempGitRepo();
  cleanups.push(cleanup);
  await cp(manifestCatalog, repoRoot, { recursive: true });
  await mkdir(path.join(repoRoot, "contracts"), { recursive: true });
  await writeFile(path.join(repoRoot, "contracts/in.schema.json"), "{}");
  clearFindProjectRootCacheForTests();
  bindStageflowHomeForTests(storeRoot);
  const store = createRunStore({ rootDir: storeRoot });
  await store.ensureProject(repoRoot);
  const controlTokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE, STAGEFLOW_READ_TOKEN: READ });
  const allowedHosts = resolveAllowedHosts();
  const boot = await bootstrapStageflowHost({
    agent: scriptedFakeAgent([]),
    cwd: repoRoot,
    rootDir: storeRoot,
    store,
    port: 0,
    mcpStateless: true,
  });
  const routes = createOperatorRoutes({
    manager: boot.manager!,
    store: boot.store!,
    cwd: boot.cwd,
    agentDir: boot.agentDir,
    rootDir: boot.rootDir,
    providerAuthContext: boot.providerAuthContext,
    allowedHosts,
    controlTokens,
  });
  const envelope = await createHttpHost({
    boot: options.withoutManagement ? { ...boot, a2aManagement: undefined } : boot,
    host: "127.0.0.1",
    port: 0,
    allowedHosts,
    controlTokens,
    routes,
  });
  cleanups.push(() => closeServer(envelope.server));
  cleanups.push(async () => {
    boot.a2a?.close();
  });
  return { base: envelope.url, port: envelope.port };
}

async function call(
  base: string,
  method: string,
  route: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function rawGet(port: number, route: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: route, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const run = <T>(fn: () => Promise<T>) =>
  withEnv({ STAGEFLOW_PUBLIC_URL: "https://ws.stage-flow.dev", STAGEFLOW_A2A_CONFIG: undefined }, fn);

describe("A2A management over the real HTTP chain", () => {
  it("lets the read token GET, refuses it on changes, and refuses requests without a token", async () => {
    await run(async () => {
      const { base } = await startHost();
      const reads = ["/api/a2a/status", "/api/a2a/callers", "/api/a2a/publications", "/api/catalog/files?ext=.json"];
      for (const route of reads) {
        expect((await call(base, "GET", route)).status, `${route} without a token`).toBe(401);
        expect((await call(base, "GET", route, READ)).status, `${route} with the read token`).toBe(200);
        expect((await call(base, "GET", route, DRIVE)).status, `${route} with the drive token`).toBe(200);
      }
      expect((await call(base, "GET", "/api/catalog/files?ext=.json", READ)).body.files).toContain("contracts/in.schema.json");

      const changes: Array<[string, string, unknown?]> = [
        ["POST", "/api/a2a/enable", {}],
        ["POST", "/api/a2a/disable"],
        ["POST", "/api/a2a/reload"],
        ["POST", "/api/a2a/callers", { id: "acme" }],
        ["DELETE", "/api/a2a/callers/acme"],
        ["POST", "/api/a2a/publications", {}],
        ["POST", "/api/a2a/publications/preview", {}],
        ["PATCH", "/api/a2a/publications/p", {}],
        ["DELETE", "/api/a2a/publications/p"],
      ];
      for (const [method, route, body] of changes) {
        expect((await call(base, method, route, READ, body)).status, `${method} ${route} with the read token`).toBe(403);
        expect((await call(base, method, route, undefined, body)).status, `${method} ${route} without a token`).toBe(401);
      }
      expect((await call(base, "GET", "/api/a2a/status", READ)).body.state).toBe("disabled");
    });
  });

  it("refuses a bad Host or Origin before looking at the token", async () => {
    await run(async () => {
      const { port } = await startHost();
      const auth = { Authorization: `Bearer ${DRIVE}` };
      const host = await rawGet(port, "/api/a2a/callers", { ...auth, Host: "evil.example" });
      expect(host.status).toBe(403);
      expect(host.body.error).toBe("Forbidden host");
      const origin = await rawGet(port, "/api/a2a/callers", { ...auth, Origin: "http://evil.example" });
      expect(origin.status).toBe(403);
      expect(origin.body.error).toBe("Forbidden origin");
      const status = await rawGet(port, "/api/a2a/status", { ...auth, Host: "evil.example" });
      expect(status.status).toBe(403);
    });
  });

  it("answers 503 a2a_unavailable when the Host has no management service", async () => {
    await run(async () => {
      const { base } = await startHost({ withoutManagement: true });
      const read = await call(base, "GET", "/api/a2a/callers", READ);
      expect(read.status).toBe(503);
      expect(read.body.code).toBe("a2a_unavailable");
      const drive = await call(base, "POST", "/api/a2a/enable", DRIVE, {});
      expect(drive.status).toBe(503);
      expect(drive.body.code).toBe("a2a_unavailable");
    });
  });

  it("reports /api/a2a/status after enable, reload and disable", async () => {
    await run(async () => {
      const { base } = await startHost();
      const on = await call(base, "POST", "/api/a2a/enable", DRIVE, {});
      expect(on.status).toBe(200);
      expect((await call(base, "GET", "/api/a2a/status", READ)).body).toMatchObject({ state: "enabled", callers: 0, publications: 0 });

      expect((await call(base, "POST", "/api/a2a/reload", DRIVE)).status).toBe(200);
      const reloaded = await call(base, "GET", "/api/a2a/status", READ);
      expect(reloaded.body.state).toBe("enabled");
      expect(reloaded.body.lastReload).toMatchObject({ ok: true });

      expect((await call(base, "POST", "/api/a2a/disable", DRIVE)).status).toBe(200);
      const off = await call(base, "GET", "/api/a2a/status", READ);
      expect(off.body.state).toBe("disabled");
      expect(off.body.configPath).toBe(on.body.configPath);
    });
  });

  it("routes POST /publications/preview to the preview, not to the publication with id preview", async () => {
    await run(async () => {
      const { base } = await startHost();
      expect((await call(base, "POST", "/api/a2a/enable", DRIVE, {})).status).toBe(200);
      const preview = await call(base, "POST", "/api/a2a/publications/preview", DRIVE, {});
      expect(preview.status).toBe(400);
      expect(preview.body.code).not.toBe("a2a_publication_not_found");
      const byId = await call(base, "GET", "/api/a2a/publications/preview", READ);
      expect(byId.status).toBe(404);
      expect(byId.body.code).toBe("a2a_publication_not_found");
    });
  });
});
