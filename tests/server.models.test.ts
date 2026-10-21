import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { ModelCatalog, resetModelCatalogsForTests, setModelCatalogForTests, type CatalogRuntime } from "../src/models/catalog.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "d".repeat(32);
const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  resetModelCatalogsForTests();
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runtime(forced: boolean[]): CatalogRuntime {
  return {
    getProviders: () => [{ id: "openrouter", name: "OpenRouter" }],
    getProviderAuthStatus: () => ({ configured: true }),
    listCredentials: async () => [],
    getModels: () => [
      { id: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter", name: "Nemotron" },
      { id: "openai/gpt-oss", provider: "openrouter" },
    ],
    refresh: async (options) => {
      if (options?.allowNetwork) forced.push(options.force === true);
    },
  };
}

async function startHost() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-models-http-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-models-project-"));
  dirs.push(home, project);
  await mkdir(path.join(project, "agents"));
  bindStageflowHomeForTests(home);
  const forced: boolean[] = [];
  setModelCatalogForTests(
    project,
    new ModelCatalog({ cwd: project, createRuntime: async () => runtime(forced), cursor: () => ({ connected: false, modelIds: [] }) }),
  );
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: project,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, urlPath: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${urlPath}`, { method, headers: { Authorization: `Bearer ${DRIVE}`, ...headers } });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  return { base, call, forced };
}

describe("GET /api/models", () => {
  it("returns the connected providers' models, grouped, with the default", async () => {
    const { call } = await startHost();
    const { status, body } = await call("GET", "/api/models");
    expect(status).toBe(200);
    expect(body.models).toEqual(expect.arrayContaining(["openrouter/nvidia/nemotron-3.5-lightning:free", "openrouter/openai/gpt-oss"]));
    expect(body.providers[0].models.map((model: { id: string }) => model.id)).toEqual(["openrouter/nvidia/nemotron-3.5-lightning:free", "openrouter/openai/gpt-oss"]);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({ id: "openrouter", name: "OpenRouter", source: "live" });
    expect(body.default).toBe("openrouter/nvidia/nemotron-3.5-lightning:free");
    expect(body.unlisted).not.toContain("openrouter/openai/gpt-oss");
    expect(typeof body.fetchedAt).toBe("string");
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("refreshes through Pi on POST /api/models/refresh and needs a same-origin header", async () => {
    const { base, call, forced } = await startHost();
    await call("GET", "/api/models");
    expect(forced).toEqual([false]);
    const blocked = await call("POST", "/api/models/refresh");
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    const refreshed = await call("POST", "/api/models/refresh", { Origin: base });
    expect(refreshed.status).toBe(200);
    expect(forced).toEqual([false, true]);
    expect(refreshed.body.providers[0].id).toBe("openrouter");
  });
});
