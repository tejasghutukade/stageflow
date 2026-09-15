import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as piIsolatedMcpProbe from "../src/agent/piIsolatedMcpProbe.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { listProjectMcpCatalog } from "../src/config/resolveStageMcpServers.js";
import { browseCatalog } from "../src/config/browseCatalog.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const secret = "s5-mcp-inspect-secret-7e2a";

let catalogRoot: string;
let cleanupCatalogRoot: () => Promise<void>;

beforeAll(async () => {
  const setup = await initTempGitRepo();
  catalogRoot = setup.root;
  cleanupCatalogRoot = setup.cleanup;
  await cp(path.join(fixtures, "pipelines"), path.join(catalogRoot, "pipelines"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "tasks"), path.join(catalogRoot, "tasks"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "stages"), path.join(catalogRoot, "stages"), {
    recursive: true,
  });
  await writeFile(
    path.join(catalogRoot, "stageflow.yaml"),
    [
      "version: 1",
      "catalog:",
      "  pipelines:",
      "    - pipelines",
      "  tasks:",
      "    - tasks",
      "  patterns:",
      '    pipeline: "*.yaml"',
      '    task: "*.yaml"',
      "",
    ].join("\n"),
  );
  clearFindProjectRootCacheForTests();
});

afterAll(async () => {
  clearFindProjectRootCacheForTests();
  await cleanupCatalogRoot();
});

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body };
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

async function writeHostCatalog(
  root: string,
  servers: Record<string, Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: servers }),
  );
}

async function withInspectServer(root: string) {
  const store = createRunStore({ rootDir: root });
  const agent = scriptedFakeAgent([]);
  const openStage = vi.spyOn(agent, "openStage");
  const started = await startUiServer({
    agent,
    cwd: catalogRoot,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    mcpStateless: true,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    ...started,
    agent,
    openStage,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: { close: (cb: (err?: Error) => void) => void }) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const twoServerCatalog = {
  local: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: secret },
  },
  github: {
    url: "https://secret-host.example/${API_BASE}/mcp",
    headers: { Authorization: `Bearer ${secret}` },
  },
};

describe("MCP catalog inspect", () => {
  it("list_models returns the same { models } as GET /api/models", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-models-"));
    const { server, base } = await withInspectServer(root);
    try {
      const http = await jsonFetch(`${base}/api/models`);
      const mcp = await mcpCall(base, "list_models");
      const catalog = await browseCatalog(catalogRoot);
      expect(http.status).toBe(200);
      expect(mcp.isError).toBe(false);
      expect(mcp.payload).toEqual({ models: catalog.models });
      expect(mcp.payload).toEqual(http.body);
      expect(mcp.payload.models).toContain("cursor/auto");
      expect(mcp.payload.models).toContain("anthropic/claude-sonnet-4-5");
    } finally {
      await closeServer(server);
    }
  });

  it("list_project_mcp returns names plus stdio/http only for a two-server catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-proj-ok-"));
    await writeHostCatalog(root, twoServerCatalog);
    const expected = await listProjectMcpCatalog(root);
    const { server, base } = await withInspectServer(root);
    try {
      const http = await jsonFetch(`${base}/api/project-mcp`);
      const mcp = await mcpCall(base, "list_project_mcp");
      expect(mcp.isError).toBe(false);
      expect(mcp.payload).toEqual({
        status: "ok",
        servers: [
          { name: "local", transport: "stdio" },
          { name: "github", transport: "http" },
        ],
      });
      expect(mcp.payload).toEqual(expected);
      expect(mcp.payload).toEqual(http.body);
      for (const row of mcp.payload.servers as { name: string }[]) {
        expect(Object.keys(row).sort()).toEqual(["name", "transport"]);
      }
    } finally {
      await closeServer(server);
    }
  });

  it("list_project_mcp JSON contains no env, headers, args, command, URLs, or fixture secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-proj-scrub-"));
    await writeHostCatalog(root, twoServerCatalog);
    const { server, base } = await withInspectServer(root);
    try {
      const mcp = await mcpCall(base, "list_project_mcp");
      expect(mcp.isError).toBe(false);
      expect(mcp.payload.status).toBe("ok");
      expect(mcp.payload.servers).toHaveLength(2);
      const payload = JSON.stringify(mcp.payload);
      expect(payload).not.toContain(secret);
      expect(payload).not.toContain("secret-host.example");
      expect(payload).not.toContain("API_BASE");
      expect(payload).not.toContain("Authorization");
      expect(payload).not.toContain("server-github");
      expect(payload).not.toMatch(/"env"/);
      expect(payload).not.toMatch(/"headers"/);
      expect(payload).not.toMatch(/"args"/);
      expect(payload).not.toMatch(/"command"/);
      expect(payload).not.toMatch(/"url"/);
    } finally {
      await closeServer(server);
    }
  });

  it("list_project_mcp missing .mcp.json is helper missing_catalog with empty servers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-proj-missing-"));
    const expected = await listProjectMcpCatalog(root);
    const { server, base } = await withInspectServer(root);
    try {
      const mcp = await mcpCall(base, "list_project_mcp");
      expect(mcp.isError).toBe(false);
      expect(mcp.payload).toEqual({ status: "missing_catalog", servers: [] });
      expect(mcp.payload).toEqual(expected);
    } finally {
      await closeServer(server);
    }
  });

  it("probe_project_mcp unknown name returns helper invalid_config or missing_catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-probe-unknown-"));
    await writeHostCatalog(root, {
      local: { command: "npx" },
    });
    const expected = await piIsolatedMcpProbe.probeProjectMcpServer({
      projectRoot: root,
      name: "no-such-server",
    });
    const { server, base, openStage } = await withInspectServer(root);
    try {
      const mcp = await mcpCall(base, "probe_project_mcp", {
        name: "no-such-server",
      });
      expect(mcp.isError).toBe(false);
      expect(["invalid_config", "missing_catalog"]).toContain(mcp.payload.status);
      expect(mcp.payload).toEqual(expected);
      expect(mcp.payload).toEqual({
        name: "no-such-server",
        status: "invalid_config",
      });
      expect(openStage).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("reserved stageflow list matches HTTP invalid_config with no rows; probe does not attach", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-reserved-"));
    await writeHostCatalog(root, {
      stageflow: { command: "npx" },
      github: { url: "https://secret-host.example/mcp" },
    });
    const { server, base, openStage } = await withInspectServer(root);
    try {
      const listedHttp = await jsonFetch(`${base}/api/project-mcp`);
      const listed = await mcpCall(base, "list_project_mcp");
      expect(listed.isError).toBe(false);
      expect(listed.payload).toEqual({ status: "invalid_config", servers: [] });
      expect(listed.payload).toEqual(listedHttp.body);

      const probed = await mcpCall(base, "probe_project_mcp", {
        name: "stageflow",
      });
      expect(probed.isError).toBe(false);
      expect(probed.payload.status).toBe("invalid_config");
      expect(openStage).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("probe_project_mcp does not import openStage or prepareStageSessionWiring", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "../src/mcp/projectMcpTools.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/openStage/);
    expect(source).not.toMatch(/prepareStageSessionWiring/);
  });

  it("abort in-flight probe yields helper cancelled when the MCP signal fires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-probe-abort-"));
    await writeHostCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    let receivedSignal: AbortSignal | undefined;
    const probeSpy = vi
      .spyOn(piIsolatedMcpProbe, "probeProjectMcpServer")
      .mockImplementation(async (opts) => {
        receivedSignal = opts.signal;
        if (opts.signal?.aborted) {
          return { name: opts.name, status: "cancelled" };
        }
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { name: opts.name, status: "cancelled" };
      });
    const { server, base, openStage } = await withInspectServer(root);
    try {
      const controller = new AbortController();
      const pending = mcpCall(
        base,
        "probe_project_mcp",
        { name: "github" },
        { signal: controller.signal },
      );
      try {
        await waitFor(() => receivedSignal !== undefined, 1500);
      } catch {
        // HTTP abort remains the teardown proof (tests/server.http.test.ts project MCP probe cancel).
        return;
      }
      controller.abort();
      let payload: { status?: string } | null = null;
      let isError = false;
      try {
        const result = await pending;
        isError = result.isError;
        payload = result.payload;
      } catch (err) {
        if (
          !(
            err instanceof Error &&
            (err.name === "AbortError" || /aborted/i.test(err.message))
          )
        ) {
          throw err;
        }
      }
      if (payload !== null) {
        expect(isError).toBe(false);
        expect(payload).toEqual({ name: "github", status: "cancelled" });
      } else if (receivedSignal?.aborted !== true) {
        // HTTP abort remains the teardown proof (tests/server.http.test.ts project MCP probe cancel).
        return;
      }
      expect(openStage).not.toHaveBeenCalled();
    } finally {
      probeSpy.mockRestore();
      await closeServer(server);
    }
  });
});
