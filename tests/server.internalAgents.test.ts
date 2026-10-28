import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createWorkshopOperatorHost } from "../src/operatorAgent/index.js";
import { describeInternalAgents, internalAgentsVisible } from "../src/operatorAgent/internalAgents.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "f".repeat(32);
const servers: Array<{ close: (cb?: () => void) => void }> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

async function startHost(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-internal-agents-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-internal-agents-project-"));
  bindStageflowHomeForTests(home);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: project,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    workshopOperatorHost: createWorkshopOperatorHost([{ type: "echo" }]),
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  return `http://127.0.0.1:${address.port}`;
}

async function getInternalAgents(base: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/internal-agents`, { headers: { Authorization: `Bearer ${DRIVE}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("internal agents", () => {
  it("are visible only when the variable is exactly 1", () => {
    expect(internalAgentsVisible({})).toBe(false);
    expect(internalAgentsVisible({ STAGEFLOW_SHOW_INTERNAL_AGENTS: "true" })).toBe(false);
    expect(internalAgentsVisible({ STAGEFLOW_SHOW_INTERNAL_AGENTS: "1" })).toBe(true);
  });

  it("describes every operator profile with its tool names", () => {
    const agents = describeInternalAgents(createWorkshopOperatorHost([{ type: "echo" }]));
    expect(agents.map((agent) => agent.id).sort()).toEqual(["agent-author", "stageflow-guide", "workshop-author"]);
    for (const agent of agents) {
      expect(Object.keys(agent).every((key) => ["id", "title", "greeting", "playbook", "tools"].includes(key))).toBe(true);
      expect(agent.playbook.length).toBeGreaterThan(0);
      expect(agent.tools.every((tool) => typeof tool === "string")).toBe(true);
    }
  });

  it("GET /api/internal-agents is empty when hidden", async () => {
    vi.stubEnv("STAGEFLOW_SHOW_INTERNAL_AGENTS", "");
    const base = await startHost();
    expect(await getInternalAgents(base)).toEqual({ status: 200, body: { visible: false, agents: [] } });
  });

  it("GET /api/internal-agents lists the operator profiles when visible", async () => {
    vi.stubEnv("STAGEFLOW_SHOW_INTERNAL_AGENTS", "1");
    const base = await startHost();
    const { status, body } = await getInternalAgents(base);
    expect(status).toBe(200);
    expect(body.visible).toBe(true);
    const agents = body.agents as Array<{ id: string; title: string; playbook: string; tools: string[] }>;
    expect(agents.map((agent) => agent.id).sort()).toEqual(["agent-author", "stageflow-guide", "workshop-author"]);
    const guide = agents.find((agent) => agent.id === "stageflow-guide")!;
    expect(guide.title.length).toBeGreaterThan(0);
    expect(Array.isArray(guide.tools)).toBe(true);
  });
});
