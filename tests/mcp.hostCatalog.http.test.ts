import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    expect(res.body.secretsStored).toEqual(["GH_GITHUB_TOKEN"]);
    expect(res.body.errors).toHaveLength(1);
    expect(await readFile(hostMcpCatalogPath(home), "utf8")).not.toContain("ghp_");
    expect(await readFile(mcpSecretsPath(home), "utf8")).toContain("ghp_");
    const secrets = await call("GET", "/api/mcp-secrets");
    expect(JSON.stringify(secrets.body)).not.toContain("ghp_");
    expect(secrets.body.secrets).toEqual([{ name: "GH_GITHUB_TOKEN", usedBy: ["gh"] }]);
    expect(secrets.body.needed).toEqual([{ name: "GH_GITHUB_TOKEN", usedBy: ["gh"], set: true }]);
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

  it("returns 400 for malformed percent-encoding instead of 500", async () => {
    for (const [method, url] of [
      ["GET", "/api/project-mcp/%E0%A4%A"],
      ["PUT", "/api/mcp-secrets/%"],
      ["GET", "/api/project-mcp/%zz/oauth"],
      ["POST", "/api/project-mcp/%/probe"],
      ["GET", "/api/project-mcp/%/tools"],
    ] as const) {
      const res = await call(method, url, method === "PUT" ? { value: "v" } : undefined);
      expect(res.status, url).toBe(400);
    }
  });

  it("rejects OAuth status/delete/complete for unknown or invalid names and bad input", async () => {
    await call("PUT", "/api/project-mcp/docs", { config: { url: "https://docs.test/mcp" } });
    expect((await call("GET", "/api/project-mcp/nope/oauth")).status).toBe(404);
    expect((await call("DELETE", "/api/project-mcp/nope/oauth")).status).toBe(404);
    expect((await call("POST", "/api/project-mcp/nope/oauth/complete", { input: "https://x.test/cb?code=abc" })).status).toBe(404);
    expect((await call("GET", "/api/project-mcp/bad%20name/oauth")).status).toBe(400);
    const junk = await call("POST", "/api/project-mcp/docs/oauth/complete", { input: "not a url or code!!" });
    expect(junk.status).toBe(400);
    expect(junk.body.code).toBe("invalid_input");
    const huge = await call("POST", "/api/project-mcp/docs/oauth/complete", { input: `https://x.test/?${"a".repeat(5000)}` });
    expect(huge.status).toBe(400);
  });

  it("moves url-query and arg tokens to secrets and returns a masked read-back", async () => {
    const put = await call("PUT", "/api/project-mcp/q", {
      config: {
        url: "https://q.test/mcp?api_key=supersecretvalue123&mode=fast",
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.secretsStored).toEqual(["API_KEY"]);
    const stored = await readFile(hostMcpCatalogPath(home), "utf8");
    expect(stored).not.toContain("supersecretvalue123");
    expect(stored).toContain("mode=fast");
    const back = await call("GET", "/api/project-mcp/q");
    expect(JSON.stringify(back.body)).not.toContain("supersecretvalue123");
    expect(back.body.config.url).toMatch(/^https:\/\/q\.test\/mcp\?api_key=\$\{[A-Z_]+\}&mode=fast$/);

    await call("PUT", "/api/project-mcp/a", {
      config: { command: "npx", args: ["-y", "srv", "--token=abcdef123456", "--api-key", "zzzzzz999999"] },
    });
    const a = await call("GET", "/api/project-mcp/a");
    expect(JSON.stringify(a.body)).not.toContain("abcdef123456");
    expect(JSON.stringify(a.body)).not.toContain("zzzzzz999999");
    expect(await readFile(mcpSecretsPath(home), "utf8")).toContain("abcdef123456");
  });

  it("masks literal secrets already present in a hand-edited catalog on read-back", async () => {
    await mkdir(path.dirname(hostMcpCatalogPath(home)), { recursive: true });
    await writeFile(
      hostMcpCatalogPath(home),
      JSON.stringify({ mcpServers: { h: { url: "https://h.test/mcp", headers: { Authorization: "Bearer rawtokenvalue1" } } } }),
    );
    const back = await call("GET", "/api/project-mcp/h");
    expect(back.body.config.headers.Authorization).toBe("Bearer ••••");
  });

  it("rejects link-local and metadata URLs at save", async () => {
    for (const url of [
      "http://169.254.169.254/latest",
      "http://metadata.google.internal/x",
      "http://[fd00:ec2::254]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      const res = await call("PUT", "/api/project-mcp/m", { config: { url } });
      expect(res.status, url).toBe(400);
    }
    expect((await call("PUT", "/api/project-mcp/lan", { config: { url: "http://192.168.1.5:8080/mcp" } })).status).toBe(200);
    expect((await call("PUT", "/api/project-mcp/lo", { config: { url: "http://127.0.0.1:9000/mcp" } })).status).toBe(200);
  });

  it("answers 409 and leaves a corrupt state file untouched", async () => {
    await writeFile(mcpSecretsPath(home), "{ not json").catch(async () => {
      await mkdir(path.dirname(mcpSecretsPath(home)), { recursive: true });
      await writeFile(mcpSecretsPath(home), "{ not json");
    });
    const get = await call("GET", "/api/mcp-secrets");
    expect(get.status).toBe(409);
    expect((await call("PUT", "/api/mcp-secrets/A", { value: "v" })).status).toBe(409);
    expect((await call("PUT", "/api/project-mcp/x", { config: { command: "a", env: { API_KEY: "plainvalue123" } } })).status).toBe(409);
    expect(await readFile(mcpSecretsPath(home), "utf8")).toBe("{ not json");
  });

  it("reports needed.set from the console store and allow-list only, not arbitrary Host env", async () => {
    await call("PUT", "/api/project-mcp/api", { config: { url: "https://api.test", headers: { "X-Key": "${MY_HOST_VAR}" } } });
    process.env.MY_HOST_VAR = "present";
    try {
      expect((await call("GET", "/api/mcp-secrets")).body.needed[0].set).toBe(false);
      process.env.STAGEFLOW_MCP_ENV_ALLOW = "MY_HOST_VAR";
      expect((await call("GET", "/api/mcp-secrets")).body.needed[0].set).toBe(true);
    } finally {
      delete process.env.MY_HOST_VAR;
      delete process.env.STAGEFLOW_MCP_ENV_ALLOW;
    }
  });
});
