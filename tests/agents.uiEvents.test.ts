import { afterEach, describe, expect, it, vi } from "vitest";
import { validateLiveManifest } from "../src/artifacts/manifest.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentError } from "../src/agents/errors.js";
import { formUiEventKey } from "../src/artifacts/uiPartForm.js";
import { createUiEventHandler, resetUiEventsForTests, type ChatArtifact } from "../src/agents/uiEvents.js";
import type { BindingQueryResult } from "../src/artifacts/bindingQuery.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  resetUiEventsForTests();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const artifact: ChatArtifact = {
  storageKey: "workspace::agent:helper/weekly",
  projectRoot: "workspace",
  projectId: "workspace",
  version: 3,
  bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
  actions: [
    { id: "ask", type: "message", template: "Show {{weeks}} weeks" },
    {
      id: "archive",
      type: "tool",
      tool: "web.fetch",
      template: "Archive the weekly report",
      input: { url: "https://example.com/{{weeks}}" },
      binding: "rows",
    },
  ],
};

function queryResult(weeks: number): BindingQueryResult {
  return {
    binding_id: "rows",
    args_hash: "hash",
    snapshot: {
      value: { weeks },
      fetched_at: "2026-11-25T00:00:00.000Z",
      duration_ms: 1,
      status: "ok",
      error_code: null,
      source: "executed",
    },
    errors: [],
  };
}

async function setup() {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  await fixture.service.create(
    fixture.project,
    agentInput("helper", {
      ui: { present: true, kinds: ["live.declarative"], functions: ["revenue_by_week"] },
      tools: { builtin: ["read"], mcp: { web: ["fetch"] } },
      approvals: { ask_first: ["web.fetch"] },
    }),
    { source: "console" },
  );
  await fixture.service.setEnabled(fixture.project, "helper", true, { source: "console" });
  const session = await fixture.service.openSession(fixture.project, "helper", { source: "console" });
  return { fixture, session };
}

describe("chat ui events", () => {
  it("accepts declared manifest actions and rejects a bad one", () => {
    const program = "root = TextContent(\"hi\")\n";
    const manifest = validateLiveManifest(
      {
        format: "openui-lang",
        library: { name: "stageflow", version: "1.0.0" },
        bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
        actions: [{ id: "archive", type: "tool", tool: "web.fetch", template: "Archive the weekly report" }],
      },
      program,
    );
    expect(manifest.actions?.[0]).toMatchObject({ id: "archive", type: "tool", tool: "web.fetch" });
    expect(() =>
      validateLiveManifest(
        {
          format: "openui-lang",
          library: { name: "stageflow", version: "1.0.0" },
          bindings: [],
          actions: [{ id: "nope", type: "navigate", template: "Go" }],
        },
        program,
      ),
    ).toThrow(/message or tool/);
  });

  it("re-queries a declared binding and refuses one the agent is not granted", async () => {
    const { fixture, session } = await setup();
    const calls: Array<{ bindingId: string; args?: Record<string, unknown> }> = [];
    const events = createUiEventHandler({
      service: fixture.service,
      chat: new AgentChatController({ service: fixture.service, backend: scriptedBackend() }),
      loadArtifact: async () => artifact,
      query: async (_artifact, request) => {
        calls.push({ bindingId: request.bindingId, ...(request.args ? { args: request.args } : {}) });
        return queryResult(Number(request.args?.weeks ?? 12));
      },
      validateArgs: async (_project, _fn, args) => {
        if (typeof args.weeks !== "number") throw new AgentError("agent.ui_args_invalid", "weeks must be a number");
      },
    });
    const result = await events({
      projectRoot: fixture.project,
      agentId: "helper",
      sessionId: session.id,
      body: { id: "sel-1", key: "agent:helper/weekly", kind: "query", action: "rows", args: { weeks: 4 } },
    });
    expect(calls).toEqual([{ bindingId: "rows", args: { weeks: 4 } }]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: "sel-1", kind: "query", duplicate: false, binding_id: "rows" });
    const again = await events({
      projectRoot: fixture.project,
      agentId: "helper",
      sessionId: session.id,
      body: { id: "sel-1", key: "agent:helper/weekly", kind: "query", action: "rows", args: { weeks: 4 } },
    });
    expect(again.body.duplicate).toBe(true);
    expect(calls).toHaveLength(1);

    await expect(
      events({
        projectRoot: fixture.project,
        agentId: "helper",
        sessionId: session.id,
        body: { id: "bad-1", key: "agent:helper/weekly", kind: "query", action: "rows", args: { weeks: "nope" } },
      }),
    ).rejects.toMatchObject({ code: "agent.ui_args_invalid" });
    expect(calls).toHaveLength(1);

    const narrow = await agentsFixture();
    fixtures.push(narrow);
    await narrow.service.create(
      narrow.project,
      agentInput("helper", { ui: { present: true, kinds: ["live.declarative"], functions: ["other_fn"] } }),
      { source: "console" },
    );
    await narrow.service.setEnabled(narrow.project, "helper", true, { source: "console" });
    const other = await narrow.service.openSession(narrow.project, "helper", { source: "console" });
    const refused = createUiEventHandler({
      service: narrow.service,
      chat: new AgentChatController({ service: narrow.service, backend: scriptedBackend() }),
      loadArtifact: async () => artifact,
      query: async () => {
        throw new Error("query should not run");
      },
    });
    await expect(
      refused({
        projectRoot: narrow.project,
        agentId: "helper",
        sessionId: other.id,
        body: { id: "grant-1", key: "agent:helper/weekly", kind: "query", action: "rows", args: { weeks: 4 } },
      }),
    ).rejects.toMatchObject({ code: "agent.ui_function_not_granted" });
  });

  it("forgets a failed event so the same id can be retried", async () => {
    const { fixture, session } = await setup();
    let attempts = 0;
    const events = createUiEventHandler({
      service: fixture.service,
      chat: new AgentChatController({ service: fixture.service, backend: scriptedBackend() }),
      loadArtifact: async () => artifact,
      query: async (_artifact, request) => {
        attempts += 1;
        if (attempts === 1) throw new AgentError("agent.session_busy", "busy");
        return queryResult(Number(request.args?.weeks ?? 12));
      },
      validateArgs: async () => undefined,
    });
    const input = {
      projectRoot: fixture.project,
      agentId: "helper",
      sessionId: session.id,
      body: { id: "retry-1", key: "agent:helper/weekly", kind: "query", action: "rows", args: { weeks: 4 } },
    };
    await expect(events(input)).rejects.toMatchObject({ code: "agent.session_busy" });
    const retried = await events(input);
    expect(retried.body.duplicate).toBe(false);
    expect(attempts).toBe(2);
    const again = await events(input);
    expect(again.body.duplicate).toBe(true);
    expect(attempts).toBe(2);
  });

  it("sends a declared message once and blocks eval sessions", async () => {
    const { fixture, session } = await setup();
    const backend = scriptedBackend(async (messages) => `echo ${messages.at(-1)!.text}`);
    const events = createUiEventHandler({
      service: fixture.service,
      chat: new AgentChatController({ service: fixture.service, backend }),
      loadArtifact: async () => artifact,
      query: async () => queryResult(1),
    });
    const [first, second] = await Promise.all([
      events({
        projectRoot: fixture.project,
        agentId: "helper",
        sessionId: session.id,
        body: { id: "msg-1", key: "agent:helper/weekly", kind: "message", action: "ask", args: { weeks: 4 } },
      }),
      events({
        projectRoot: fixture.project,
        agentId: "helper",
        sessionId: session.id,
        body: { id: "msg-1", key: "agent:helper/weekly", kind: "message", action: "ask", args: { weeks: 4 } },
      }),
    ]);
    expect(backend.calls).toBe(1);
    expect([first.body.duplicate, second.body.duplicate].sort()).toEqual([false, true]);
    const detail = await fixture.service.getSession(fixture.project, session.id);
    expect(detail.messages.some((message) => message.role === "user" && message.text === "Show 4 weeks")).toBe(true);

    await expect(
      events({
        projectRoot: fixture.project,
        agentId: "helper",
        sessionId: session.id,
        body: { id: "msg-2", key: "agent:helper/weekly", kind: "message", action: "missing", args: { weeks: 4 } },
      }),
    ).rejects.toMatchObject({ code: "agent.ui_action_unknown" });

    const evalSession = await fixture.service.openSession(fixture.project, "helper", { source: "eval", eval: {} });
    await expect(
      events({
        projectRoot: fixture.project,
        agentId: "helper",
        sessionId: evalSession.id,
        body: { id: "msg-3", key: "agent:helper/weekly", kind: "message", action: "ask", args: { weeks: 4 } },
      }),
    ).rejects.toMatchObject({ code: "agent.session_eval_readonly" });
    expect(backend.calls).toBe(1);
  });

  it("accepts a structured form submit as a user message", async () => {
    const { fixture, session } = await setup();
    const backend = scriptedBackend(async (messages) => `echo ${messages.at(-1)!.text}`);
    const events = createUiEventHandler({
      service: fixture.service,
      chat: new AgentChatController({ service: fixture.service, backend }),
      loadArtifact: async () => {
        throw new Error("artifact loader should not run");
      },
      query: async () => queryResult(1),
    });
    const result = await events({
      projectRoot: fixture.project,
      agentId: "helper",
      sessionId: session.id,
      body: {
        id: "form-1",
        key: formUiEventKey("weekly_input"),
        kind: "message",
        action: "submit",
        args: { text: "Revenue this week: 4200" },
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: "message", text: "Revenue this week: 4200" });
    const detail = await fixture.service.getSession(fixture.project, session.id);
    expect(detail.messages.some((message) => message.role === "user" && message.text === "Revenue this week: 4200")).toBe(true);
    await expect(
      events({
        projectRoot: fixture.project,
        agentId: "helper",
        sessionId: session.id,
        body: { id: "form-2", key: formUiEventKey("weekly_input"), kind: "message", action: "submit", args: {} },
      }),
    ).rejects.toMatchObject({ code: "agent.ui_args_invalid" });
  });

  it("asks for a write through the approval gate and runs nothing before approval", async () => {
    const { fixture, session } = await setup();
    const backend = scriptedBackend(async () => "archived");
    const events = createUiEventHandler({
      service: fixture.service,
      chat: new AgentChatController({ service: fixture.service, backend }),
      loadArtifact: async () => artifact,
      query: async () => queryResult(1),
      validateArgs: async () => undefined,
    });
    const turn = events({
      projectRoot: fixture.project,
      agentId: "helper",
      sessionId: session.id,
      body: { id: "write-1", key: "agent:helper/weekly", kind: "tool", action: "archive", args: { weeks: 4 } },
    });
    await vi.waitFor(async () => expect((await fixture.service.pendingApprovals(fixture.project)).length).toBe(1));
    const pending = (await fixture.service.pendingApprovals(fixture.project))[0]!;
    expect(pending).toMatchObject({ tool: "web.fetch", status: "pending", payload: { url: "https://example.com/4" } });
    expect(backend.requestedToolRuns).toBe(0);
    const waiting = await fixture.service.getSession(fixture.project, session.id);
    expect(waiting.session.status).toBe("waiting");
    expect(waiting.messages.some((message) => message.role === "user" && message.text === "Archive the weekly report")).toBe(true);
    await fixture.service.decideApproval(fixture.project, session.id, "approve", { kind: "operator" });
    const done = await turn;
    expect(backend.requestedToolRuns).toBe(1);
    expect(done.body).toMatchObject({ kind: "tool", text: "Archive the weekly report" });
    expect((await fixture.service.getSession(fixture.project, session.id)).pendingApproval).toBeNull();
  });
});
