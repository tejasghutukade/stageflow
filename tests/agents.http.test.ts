import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "d".repeat(32);
const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startHost(backend: ReturnType<typeof scriptedBackend> = scriptedBackend()) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-agents-http-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-agents-project-"));
  dirs.push(home, project);
  await mkdir(path.join(project, "agents"));
  bindStageflowHomeForTests(home);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: project,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    agentConversationBackend: backend,
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${DRIVE}`, "Content-Type": "application/json" };
  const call = async (method: string, urlPath: string, body?: unknown) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  return { base, project, headers, call };
}

const definition = (overrides: Record<string, unknown> = {}) => ({
  id: "research_assistant",
  name: "Research assistant",
  instructions: "Find sources.",
  ...overrides,
});

describe("agents HTTP API", () => {
  it("requires a drive token for writes", async () => {
    const { base } = await startHost();
    const response = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: definition() }),
    });
    expect(response.status).toBe(401);
  });

  it("creates, validates, saves, enables and lists with full definitions", async () => {
    const { call } = await startHost();
    const invalid = await call("POST", "/api/agents", { definition: definition({ name: "" }) });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ code: "agent.invalid", issues: [expect.objectContaining({ path: "name" })] });

    const created = await call("POST", "/api/agents", { definition: definition() });
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ id: "research_assistant", revision: 1, enabled: false });
    expect(created.body.definition.model).toEqual({ backend: "pi", thinking: "medium" });

    const validated = await call("POST", "/api/agents/validate", {
      definition: definition({ tools: { mcp: { slack: ["post_message"] } } }),
    });
    expect(validated.body).toMatchObject({
      issues: [],
      warnings: [expect.objectContaining({ code: "agent.mcp_server_unknown" })],
    });

    const saved = await call("POST", "/api/agents/research_assistant/save", {
      baseRevision: 1,
      definition: definition({ model: { thinking: "high" }, limits: { max_turns: 12 } }),
      summary: "Think harder",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.definition).toMatchObject({ model: { thinking: "high" }, limits: { max_turns: 12 } });

    const stale = await call("POST", "/api/agents/research_assistant/save", { baseRevision: 1, definition: definition() });
    expect(stale).toMatchObject({ status: 409, body: { code: "agent.conflict" } });

    const enabled = await call("POST", "/api/agents/research_assistant/enable");
    expect(enabled.body.agent).toMatchObject({ enabled: true, revision: 3 });

    const listed = await call("GET", "/api/agents");
    expect(listed.body.agents).toEqual([
      expect.objectContaining({ id: "research_assistant", model: { backend: "pi", thinking: "high" }, pendingApprovals: 0 }),
    ]);
  });

  it("serves revision history, diffs and restore", async () => {
    const { call } = await startHost();
    await call("POST", "/api/agents", { definition: definition() });
    await call("POST", "/api/agents/research_assistant/save", {
      baseRevision: 1,
      definition: definition({ instructions: "Find primary sources." }),
    });
    const history = await call("GET", "/api/agents/research_assistant/revisions");
    expect(history.body.revisions.map((row: { revision: number }) => row.revision)).toEqual([2, 1]);
    const diff = await call("GET", "/api/agents/research_assistant/revisions/1/diff/2");
    expect(diff.body.lines.filter((line: { kind: string }) => line.kind !== "same")).toHaveLength(2);
    const restored = await call("POST", "/api/agents/research_assistant/revisions/1/restore", { baseRevision: 2 });
    expect(restored.body).toMatchObject({ agent: { revision: 3 }, definition: { instructions: "Find sources." } });
    expect((await call("GET", "/api/agents/research_assistant/revisions/9")).status).toBe(404);
  });

  it("streams a chat turn, then serves the session and its list", async () => {
    const { base, headers, call } = await startHost();
    await call("POST", "/api/agents", { definition: definition() });
    const disabled = await call("POST", "/api/agents/research_assistant/chat", { message: "hi" });
    expect(disabled).toMatchObject({ status: 409, body: { code: "agent.disabled" } });
    await call("POST", "/api/agents/research_assistant/enable");

    const response = await fetch(`${base}/api/agents/research_assistant/chat`, {
      method: "POST",
      headers: { ...headers, Accept: "application/x-ndjson" },
      body: JSON.stringify({ message: "hello" }),
    });
    const frames = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(frames.map((frame) => frame.type)).toEqual(["session", "delta", "delta", "done"]);
    const sessionId = frames[0]!.sessionId as string;
    expect(frames.at(-1)!.session.messages.map((message: { text: string }) => message.text)).toEqual([
      "hello",
      "echo: hello",
    ]);

    const session = await call("GET", `/api/agents/research_assistant/sessions/${sessionId}`);
    expect(session.body.turns).toHaveLength(1);
    const listed = await call("GET", "/api/agents/research_assistant/sessions?limit=10");
    expect(listed.body).toMatchObject({ sessions: [{ id: sessionId, title: "hello" }], stats: { total: 1 } });
    expect((await call("GET", "/api/agents/research_assistant/sessions?status=bogus")).status).toBe(422);
    expect((await call("GET", "/api/agents/other_agent/sessions/" + sessionId)).status).toBe(404);
  });

  it("archives and rejects unknown project roots", async () => {
    const { call } = await startHost();
    await call("POST", "/api/agents", { definition: definition() });
    expect((await call("POST", "/api/agents/research_assistant/archive")).status).toBe(200);
    expect((await call("GET", "/api/agents")).body.agents).toEqual([]);
    const foreign = await call("GET", `/api/agents?project_root=${encodeURIComponent(path.join(tmpdir(), "not-registered"))}`);
    expect(foreign.status).toBe(400);
    expect((await call("DELETE", "/api/agents/research_assistant")).status).toBe(405);
  });

  it.each([
    ["approve", true],
    ["deny", false],
  ] as const)("pauses at an ask-first tool until the console decides (%s)", async (decision, ran) => {
    const backend = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool("web.fetch", { url: "https://example.test" });
      return result.ran ? "fetched" : `blocked: ${result.output}`;
    });
    const { base, headers, call } = await startHost(backend);
    await call("POST", "/api/agents", {
      definition: definition({ tools: { mcp: { web: ["fetch"] } }, approvals: { ask_first: ["web.fetch"] } }),
    });
    await call("POST", "/api/agents/research_assistant/enable");
    const pending = fetch(`${base}/api/agents/research_assistant/chat`, {
      method: "POST",
      headers: { ...headers, Accept: "application/x-ndjson" },
      body: JSON.stringify({ message: "go" }),
    }).then((response) => response.text());

    let approvals: Array<{ sessionId: string }> = [];
    for (let attempt = 0; attempt < 50 && approvals.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      approvals = (await call("GET", "/api/agents/approvals")).body.approvals ?? [];
    }
    expect(approvals).toHaveLength(1);
    const sessionId = approvals[0]!.sessionId;
    expect((await call("GET", `/api/agents/research_assistant/sessions/${sessionId}`)).body.session.status).toBe("waiting");

    const decided = await call("POST", `/api/agents/research_assistant/sessions/${sessionId}/approval/${decision}`);
    expect(decided.status).toBe(200);
    const stream = await pending;
    expect(stream).toContain(ran ? "fetched" : "blocked");
    const detail = (await call("GET", `/api/agents/research_assistant/sessions/${sessionId}`)).body;
    expect(detail.session.status).toBe("open");
    expect(detail.spans.some((span: { kind: string }) => span.kind === "gate")).toBe(true);
    expect((await call("GET", "/api/agents/approvals")).body.approvals).toHaveLength(0);
  });
});
