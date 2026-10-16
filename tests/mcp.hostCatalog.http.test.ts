import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { hostMcpCatalogPath, mcpSecretsPath } from "../src/config/mcpHostCatalog.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

let catalogRoot: string;
let cleanup: () => Promise<void>;
let home: string;
let prevHome: string | undefined;
let server: Awaited<ReturnType<typeof startUiServer>>["server"];
let base: string;

beforeAll(async () => {
  const setup = await initTempGitRepo();
  catalogRoot = setup.root;
  cleanup = setup.cleanup;
});
afterAll(async () => {
  clearFindProjectRootCacheForTests();
  await cleanup();
});

beforeEach(async () => {
  prevHome = process.env.STAGEFLOW_HOME;
  home = await mkdtemp(path.join(tmpdir(), "sf-mcp-http-home-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-http-root-"));
  const store = createRunStore({ rootDir: root });
  await store.ensureProject(catalogRoot);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: catalogRoot,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    mcpStateless: true,
  });
  server = started.server;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = prevHome;
  resetGlobalStageflowHomeForTests();
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("project MCP write routes", () => {
  it("adds, lists, reads back and deletes a console server", async () => {
    const put = await call("PUT", "/api/project-mcp/docs", { config: { url: "https://docs.test/mcp" } });
    expect(put.status).toBe(200);
    const list = await call("GET", "/api/project-mcp");
    expect(list.body.status).toBe("ok");
    expect(list.body.servers).toEqual([{ name: "docs", transport: "http", origin: "console" }]);
    expect((await call("GET", "/api/project-mcp/docs")).body.config).toEqual({ url: "https://docs.test/mcp" });
    expect((await call("DELETE", "/api/project-mcp/docs")).status).toBe(200);
    expect((await call("DELETE", "/api/project-mcp/docs")).status).toBe(404);
  });

  it("rejects an invalid server with 400", async () => {
    const res = await call("PUT", "/api/project-mcp/x", { config: { command: "a", url: "https://a" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_server");
  });

  it("imports pasted JSON, moves tokens to secrets and never returns values", async () => {
    const res = await call("POST", "/api/project-mcp/import", {
      json: {
        mcpServers: {
          gh: { command: "npx", env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
          bad: { nothing: true },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.added).toEqual(["gh"]);
    expect(res.body.secretsStored).toEqual(["GITHUB_TOKEN"]);
    expect(res.body.errors).toHaveLength(1);
    expect(await readFile(hostMcpCatalogPath(home), "utf8")).not.toContain("ghp_");
    expect(await readFile(mcpSecretsPath(home), "utf8")).toContain("ghp_");
    const secrets = await call("GET", "/api/mcp-secrets");
    expect(JSON.stringify(secrets.body)).not.toContain("ghp_");
    expect(secrets.body.secrets).toEqual([{ name: "GITHUB_TOKEN", usedBy: ["gh"] }]);
    expect(secrets.body.needed).toEqual([{ name: "GITHUB_TOKEN", usedBy: ["gh"], set: true }]);
  });

  it("sets and deletes a secret, flagging unset placeholders as needed", async () => {
    await call("PUT", "/api/project-mcp/api", {
      config: { url: "https://api.test", headers: { "X-Key": "${API_KEY}" } },
    });
    expect((await call("GET", "/api/mcp-secrets")).body.needed).toEqual([
      { name: "API_KEY", usedBy: ["api"], set: false },
    ]);
    expect((await call("PUT", "/api/mcp-secrets/API_KEY", { value: "v" })).status).toBe(200);
    expect((await call("GET", "/api/mcp-secrets")).body.needed[0].set).toBe(true);
    expect((await call("PUT", "/api/mcp-secrets/bad-name", { value: "v" })).status).toBe(400);
    expect((await call("DELETE", "/api/mcp-secrets/API_KEY")).status).toBe(200);
    expect((await call("DELETE", "/api/mcp-secrets/API_KEY")).status).toBe(404);
  });

  it("reports OAuth state and rejects bad sign-in requests", async () => {
    await call("PUT", "/api/project-mcp/docs", { config: { url: "https://docs.test/mcp" } });
    await call("PUT", "/api/project-mcp/local", { config: { command: "npx" } });
    expect((await call("GET", "/api/project-mcp/docs/oauth")).body).toEqual({ name: "docs", status: "not_authenticated" });
    expect((await call("POST", "/api/project-mcp/local/oauth/start")).status).toBe(400);
    expect((await call("POST", "/api/project-mcp/nope/oauth/start")).status).toBe(404);
    expect((await call("POST", "/api/project-mcp/docs/oauth/complete", {})).status).toBe(400);
    expect((await call("DELETE", "/api/project-mcp/docs/oauth")).status).toBe(200);
  });
});
