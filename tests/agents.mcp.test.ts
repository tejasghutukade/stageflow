import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { closeServer } from "./helpers/closeServer.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent MCP tools", () => {
  it("creates, validates, enables, chats with and inspects an agent", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agents-mcp-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-agents-mcp-project-"));
    dirs.push(home, project);
    bindStageflowHomeForTests(home);
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: project,
      rootDir: home,
      store: createRunStore({ rootDir: home }),
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
      agentConversationBackend: scriptedBackend(() => "Hello back"),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("expected a port");
    const base = `http://127.0.0.1:${address.port}`;

    const invalid = await mcpCall(base, "create_agent", { definition: { id: "research", name: "Research" } });
    expect(invalid.isError).toBe(true);
    expect(invalid.payload).toMatchObject({ code: "agent.invalid", issues: [expect.objectContaining({ path: "instructions" })] });

    const created = await mcpCall(base, "create_agent", {
      definition: { id: "research", name: "Research", instructions: "Answer." },
    });
    expect(created.payload?.agent).toMatchObject({ id: "research", enabled: false });
    const listedRevision = (await mcpCall(base, "list_agent_revisions", { id: "research" })).payload?.revisions[0];
    expect(listedRevision).toMatchObject({
      source: "api",
      author: "mcp",
    });
    const revision = await mcpCall(base, "get_agent_revision", { id: "research", revision: listedRevision.revision });
    expect(revision.isError).toBe(false);
    expect(revision.payload).toMatchObject({
      revision: listedRevision.revision,
      source: "api",
      author: "mcp",
      definition: { id: "research", instructions: "Answer." },
    });
    expect(revision.payload.yaml).toContain("Answer.");
    const missingRevision = await mcpCall(base, "get_agent_revision", { id: "research", revision: 99 });
    expect(missingRevision).toMatchObject({ isError: true, payload: { code: "agent.revision_not_found" } });

    const disabledChat = await mcpCall(base, "agent_chat", { id: "research", message: "Hi" });
    expect(disabledChat).toMatchObject({ isError: true, payload: { code: "agent.disabled" } });

    await mcpCall(base, "enable_agent", { id: "research" });
    const diff = await mcpCall(base, "diff_agent_revisions", {
      id: "research",
      from: listedRevision.revision,
      to: listedRevision.revision + 1,
    });
    expect(diff.isError).toBe(false);
    expect(diff.payload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "removed", text: "enabled: false" }),
        expect.objectContaining({ kind: "added", text: "enabled: true" }),
      ]),
    );
    const missingDiff = await mcpCall(base, "diff_agent_revisions", { id: "research", from: 1, to: 99 });
    expect(missingDiff).toMatchObject({ isError: true, payload: { code: "agent.revision_not_found" } });
    const chat = await mcpCall(base, "agent_chat", { id: "research", message: "Hi" });
    expect(chat.isError).toBe(false);
    expect(chat.payload?.session).toMatchObject({ source: "mcp" });
    expect(chat.payload?.messages.map((message: { text: string }) => message.text)).toEqual(["Hi", "Hello back"]);

    const fetched = await mcpCall(base, "get_agent_session", { id: "research", sessionId: chat.payload?.session.id });
    expect(fetched.payload?.turns).toHaveLength(1);

    // A session id only opens under the agent it belongs to.
    const wrong = await mcpCall(base, "get_agent_session", { id: "other", sessionId: chat.payload?.session.id });
    expect(wrong).toMatchObject({ isError: true, payload: { code: "agent.session_not_found" } });
    for (const tool of ["approve_agent_action", "deny_agent_action", "stop_agent_session"]) {
      const refused = await mcpCall(base, tool, { id: "other", sessionId: chat.payload?.session.id });
      expect(refused).toMatchObject({ isError: true, payload: { code: "agent.session_not_found" } });
    }
  });
});
