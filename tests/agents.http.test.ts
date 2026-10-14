import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "d".repeat(32);
const servers: Array<{ close: (cb?: () => void) => void }> = [];

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("agent HTTP", () => {
  it("requires a drive token and rejects a stale save", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agents-http-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-agents-project-"));
    bindStageflowHomeForTests(home);
    const store = createRunStore({ rootDir: home });
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: project,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("expected a port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${DRIVE}`,
      "Content-Type": "application/json",
    };

    const denied = await jsonFetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "research_assistant",
        name: "Research assistant",
        instructions: "Find sources.",
      }),
    });
    expect(denied.status).toBe(401);

    const created = await jsonFetch(`${base}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "research_assistant",
        name: "Research assistant",
        instructions: "Find sources.",
      }),
    });
    expect(created.status).toBe(201);
    const revision = (created.body as { revision: number }).revision;
    const file = path.join(project, "agents", "research_assistant.agent.yaml");
    const saved = await jsonFetch(`${base}/api/agents/research_assistant/save`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        baseRevision: revision,
        name: "Research assistant",
        instructions: "Cite sources.",
      }),
    });
    expect(saved.status).toBe(200);
    const before = await readFile(file, "utf8");
    const conflict = await jsonFetch(`${base}/api/agents/research_assistant/save`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        baseRevision: revision,
        name: "Research assistant",
        instructions: "Overwrite.",
      }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ code: "agent.conflict" });
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
