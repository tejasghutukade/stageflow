import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { resetAgentAuthorSessionsForTests } from "../src/agents/authorChat.js";
import { readAuthorSession } from "../src/agents/authorSessionStore.js";
import { createWorkshopOperatorHost } from "../src/operatorAgent/index.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "e".repeat(32);
const servers: Array<{ close: (cb?: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  resetAgentAuthorSessionsForTests();
});

describe("POST /api/agent-author/chat", () => {
  it("drafts through the agent author profile and undoes the turn", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-http-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-agent-author-project-"));
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
      workshopOperatorHost: createWorkshopOperatorHost([
        {
          type: "call_tool",
          name: "update_agent_draft",
          args: {
            summary: "Drafted the research assistant",
            patch: {
              name: "Research assistant",
              description: "Finds sources",
              instructions: "1. Search.\n2. Check.",
              model: { thinking: "high" },
              tools: { builtin: ["read"], mcp: { slack: ["post_message"] } },
              approvals: { ask_first: ["slack.post_message"] },
            },
          },
          message: "I drafted the agent. It starts sealed.",
        },
      ]),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("expected a port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${DRIVE}`,
      "Content-Type": "application/json",
    };
    const chat = await fetch(`${base}/api/agent-author/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: "A research assistant for Slack.",
        draft: { greeting: "What should I look into?" },
      }),
    });
    const body = (await chat.json()) as {
      sessionId: string;
      text: string;
      draft: Record<string, unknown>;
      summaryLines: { label: string; value: string }[];
    };
    expect(chat.status).toBe(200);
    expect(body.text).toContain("sealed");
    expect(body.draft).toMatchObject({
      id: "research_assistant",
      name: "Research assistant",
      greeting: "What should I look into?",
      tools: { builtin: ["read"], mcp: { slack: ["post_message"] } },
    });
    expect(body.summaryLines).toEqual([
      { label: "Identity", value: "Research assistant · research_assistant" },
      { label: "Instructions", value: "2 lines" },
      { label: "Model", value: "project default · Pi · high thinking" },
      { label: "Tools", value: "read, slack (post_message)" },
      { label: "Approvals", value: "asks before slack.post_message" },
    ]);

    const stored = await fetch(`${base}/api/agent-author/sessions/${body.sessionId}`, { headers });
    const record = (await stored.json()) as { draft: { name?: string }; transcript: unknown[] };
    expect(stored.status).toBe(200);
    expect(record.draft.name).toBe("Research assistant");
    expect(record.transcript).toHaveLength(2);

    const undo = await fetch(`${base}/api/agent-author/undo`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: body.sessionId }),
    });
    const undone = (await undo.json()) as { draft: Record<string, unknown> };
    expect(undo.status).toBe(200);
    expect(undone.draft).toEqual({ greeting: "What should I look into?" });
  });

  it("replaces the draft and keeps the transcript already on disk", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-put-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-agent-author-put-project-"));
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
      workshopOperatorHost: createWorkshopOperatorHost({
        model: {
          async complete() {
            return { events: [{ type: "message", role: "assistant", text: "Who is it for?" }] };
          },
        },
      }),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("expected a port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${DRIVE}`,
      "Content-Type": "application/json",
    };
    const first = await fetch(`${base}/api/agent-author/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: "A scout.",
        draft: { name: "Scout", instructions: "Search." },
      }),
    });
    const opened = (await first.json()) as { sessionId: string };
    expect(first.status).toBe(200);
    expect(readAuthorSession(opened.sessionId)?.transcript).toHaveLength(2);

    const second = await fetch(`${base}/api/agent-author/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: "For operators.",
        sessionId: opened.sessionId,
        draft: { name: "Scout", instructions: "Search." },
      }),
    });
    expect(second.status).toBe(200);
    expect(readAuthorSession(opened.sessionId)?.transcript).toHaveLength(4);

    const formDraft = { name: "From the form", instructions: "Saved from the form." };
    const put = await fetch(`${base}/api/agent-author/sessions/${opened.sessionId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ draft: formDraft }),
    });
    const saved = (await put.json()) as { draft: Record<string, unknown>; transcript: unknown[] };
    expect(put.status).toBe(200);
    expect(saved.draft).toEqual(formDraft);
    expect(saved.transcript).toHaveLength(4);
    const onDisk = readAuthorSession(opened.sessionId);
    expect(onDisk?.draft).toEqual(formDraft);
    expect(onDisk?.transcript).toHaveLength(4);
    expect(onDisk?.transcript.map((entry) => entry.text)).toEqual([
      "A scout.",
      "Who is it for?",
      "For operators.",
      "Who is it for?",
    ]);
  });

  it("DELETE removes an author session and 404s when missing", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-delete-http-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-agent-author-delete-project-"));
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
      workshopOperatorHost: createWorkshopOperatorHost({
        model: {
          async complete() {
            return { events: [{ type: "message", role: "assistant", text: "Who is it for?" }] };
          },
        },
      }),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("expected a port");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${DRIVE}`,
      "Content-Type": "application/json",
    };
    const chat = await fetch(`${base}/api/agent-author/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "A scout.", draft: { name: "Scout" } }),
    });
    const opened = (await chat.json()) as { sessionId: string };
    expect(chat.status).toBe(200);

    const removed = await fetch(`${base}/api/agent-author/sessions/${opened.sessionId}`, {
      method: "DELETE",
      headers,
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(readAuthorSession(opened.sessionId)).toBeNull();

    const listed = await fetch(`${base}/api/agent-author/sessions`, { headers });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ drafts: [] });

    const missing = await fetch(`${base}/api/agent-author/sessions/${opened.sessionId}`, {
      method: "DELETE",
      headers,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "agent.session_not_found" });
  });
});
