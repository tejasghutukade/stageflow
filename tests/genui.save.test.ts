import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { createEvalGate, EvalGateRegistry } from "../src/agents/evalGate.js";
import { createPiAgentRuntime, type OpenSessionInput } from "../src/agents/runtime/piRuntime.js";
import { agentSessionCards } from "../src/agents/sessionCards.js";
import { classifyTool } from "../src/agents/toolRisk.js";
import { readStoredArtifactFile } from "../src/artifacts/store.js";
import { listArtifacts } from "../src/artifacts/query.js";
import { deletePublishedArtifact } from "../src/artifacts/publish.js";
import { resetSessionArtifactLimiterForTests } from "../src/artifacts/sessionScope.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_KIND_CARD, type UiPart } from "../src/artifacts/uiPart.js";
import { sessionArtifactVisible } from "../src/agents/webChat/visitorArtifacts.js";
import { grantedToolIds } from "../src/config/loadAgent.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";
import { resetCardLimiterForTests } from "../src/genui/budget.js";
import { AGENT_PRESENT_CARD_SENTENCE, SAVE_CARD_SENTENCE } from "../src/genui/prompt.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const previousHome = process.env.STAGEFLOW_HOME;
let fx: AgentsFixture;
const writeGrant = { tools: { stageflow: { groups: ["artifacts.read", "artifacts.write"] } } };
const cardsUi = { present: true, persistence: "conversation", kinds: ["live.declarative", "static.markdown"], functions: [] };

beforeAll(async () => {
  fx = await agentsFixture();
  process.env.STAGEFLOW_HOME = fx.home;
  resetGlobalStageflowHomeForTests();
  const agents: Record<string, Record<string, unknown>> = {
    saver: { ...writeGrant, ui: cardsUi },
    nogrant: { ui: cardsUi },
    arts: { ...writeGrant, ui: { ...cardsUi, persistence: "artifacts" } },
    visitor: { ...writeGrant, ui: cardsUi, web_chat: { enabled: true, access: "public", public_tools: true } },
    closed: { ...writeGrant, ui: cardsUi, web_chat: { enabled: true, access: "public", public_tools: false } },
  };
  for (const [id, overrides] of Object.entries(agents)) {
    await fx.service.create(fx.project, agentInput(id, overrides), { source: "console" });
    await fx.service.setEnabled(fx.project, id, true, { source: "console" });
  }
});

afterAll(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  await fx?.cleanup();
});

beforeEach(() => {
  resetCardLimiterForTests();
  resetSessionArtifactLimiterForTests();
});

function roots(): CatalogRoot[] {
  return [{ project_root: fx.project, path: fx.project, kind: "registered", read_only: false }];
}

const assistantEnd = {
  type: "message_end",
  message: { role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cost: { total: 0 } } },
};

/**
 * The Host's chat controller over the real Pi runtime with a fake Pi session. A message `draw <title>` draws a markdown
 * card; `save <json>` calls save_card with those arguments. Tool calls go through the session's gate and events, as Pi runs them.
 */
function host(options: { evalGates?: EvalGateRegistry } = {}) {
  const opened: OpenSessionInput[] = [];
  const results: Array<{ tool: string; details: Record<string, unknown>; isError?: boolean; blocked?: string }> = [];
  let seq = 0;
  const runtime = createPiAgentRuntime({
    cwd: fx.project,
    agentDir: fx.home,
    idleReleaseMs: 0,
    artifactStore: async () => ({ db: fx.connection, roots: roots(), consoleUrl: (hashPath: string) => `http://console/#${hashPath}` }),
    sessionCards: ({ sessionId, projectRoot }) => agentSessionCards(async () => (await fx.service.getSession(projectRoot, sessionId)).messages),
    openSession: async (input) => {
      opened.push(input);
      const listeners = new Set<(event: unknown) => void>();
      const emit = (event: unknown) => listeners.forEach((listener) => listener(event));
      const call = async (toolName: string, args: Record<string, unknown>) => {
        const tool = toolName === "save_card" ? input.saveCardTool : input.presentUiTool;
        const toolCallId = `call_${seq++}`;
        const blocked = await input.gate({ toolCallId, toolName, input: args });
        if (blocked) {
          results.push({ tool: toolName, details: {}, blocked: blocked.reason });
          return;
        }
        if (!tool) throw new Error(`${toolName} was not offered`);
        emit({ type: "tool_execution_start", toolCallId, toolName, args });
        const result = await tool.execute(toolCallId, args);
        results.push({ tool: toolName, details: result.details, ...(result.isError ? { isError: true } : {}) });
        emit({ type: "tool_execution_end", toolCallId, result, isError: result.isError === true });
      };
      return {
        toolNames: input.toolNames,
        shutdown: async () => undefined,
        session: {
          subscribe: (listener: (event: unknown) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          prompt: async (text: string) => {
            const said = text.slice(text.lastIndexOf("user: ") >= 0 ? text.lastIndexOf("user: ") + 6 : 0).trim();
            if (said.startsWith("draw-secret")) {
              await call("present_ui", {
                title: "Secret card",
                program: "# Secret card\n\napi_key=sk-live-abcdefghijklmnopqrstuvwxyz\n",
                manifest: { kind: "static.markdown" },
              });
            } else if (said.startsWith("draw ")) {
              const title = said.slice(5);
              await call("present_ui", { title, program: `# ${title}\n\n- North 4`, manifest: { kind: "static.markdown" } });
            } else if (said.startsWith("save")) {
              const args = said.length > 4 ? (JSON.parse(said.slice(4)) as Record<string, unknown>) : {};
              await call("save_card", args);
            }
            emit(assistantEnd);
          },
          dispose: () => undefined,
          abort: async () => undefined,
        },
      } as never;
    },
  });
  const chat = new AgentChatController({ service: fx.service, backend: runtime, ...(options.evalGates ? { evalGates: options.evalGates } : {}) });
  return { chat, opened, results, lastSave: () => [...results].reverse().find((result) => result.tool === "save_card") };
}

function savedRef(result: { details: Record<string, unknown> } | undefined): { key: string; title: string; version: number } {
  const ui = (result?.details as { ui?: { kind: string; key: string; title: string; version: number } }).ui;
  expect(ui?.kind).toBe(UI_PART_KIND_ARTIFACT_REF);
  return ui!;
}

describe("agent save_card", () => {
  it("saves the latest card, a card by title, by id, and the same card again as one artifact", async () => {
    const { chat, results, lastSave, opened } = host();
    const send = (text: string, sessionId?: string) =>
      chat.send({ projectRoot: fx.project, agentId: "saver", text, source: "console", ...(sessionId ? { sessionId } : {}) });
    const first = await send("draw Older notes");
    const sessionId = first.session.id;
    await send("draw Latest notes", sessionId);
    expect(opened[0]!.toolNames).toContain("save_card");
    expect(opened[0]!.systemPrompt).toContain(`${SAVE_CARD_SENTENCE} A card can be saved once it has been shown, in a later message.`);

    const latest = await send("save", sessionId);
    const latestRef = savedRef(lastSave());
    expect(latestRef).toMatchObject({ title: "Latest notes", version: 1 });
    expect(latestRef.key).toMatch(/^agent:saver\/card_[0-9a-f]{16}$/);
    const reply = [...latest.messages].reverse().find((message) => message.role === "assistant");
    expect(reply?.parts).toEqual([expect.objectContaining({ kind: UI_PART_KIND_ARTIFACT_REF, key: latestRef.key })]);

    await send(`save ${JSON.stringify({ card_id: "LATEST NOTES" })}`, sessionId);
    expect(savedRef(lastSave()).key).toBe(latestRef.key);
    const stored = await fx.service.getSession(fx.project, sessionId);
    const latestMessage = stored.messages.find((message) => message.parts?.some((part: UiPart) => part.kind === UI_PART_KIND_CARD && part.title === "Latest notes"))!;
    const index = latestMessage.parts!.findIndex((part: UiPart) => part.kind === UI_PART_KIND_CARD);
    await send(`save ${JSON.stringify({ card_id: `${latestMessage.id}:${index}`, title: "Renamed" })}`, sessionId);
    expect(savedRef(lastSave())).toMatchObject({ key: latestRef.key, title: "Latest notes" });

    await send(`save ${JSON.stringify({ card_id: "older notes", title: "Kept older" })}`, sessionId);
    const olderRef = savedRef(lastSave());
    expect(olderRef.key).not.toBe(latestRef.key);
    expect(olderRef.title).toBe("Kept older");

    await send(`save ${JSON.stringify({ card_id: "nope" })}`, sessionId);
    expect(lastSave()).toMatchObject({ isError: true, details: { code: "ui.card_not_found" } });

    const listed = listArtifacts(fx.connection, { projectRoot: fx.project, limit: 20, owner: "agent:saver" }, roots());
    expect(listed.artifacts.map((record) => record.title).sort()).toEqual(["Kept older", "Latest notes"]);
    expect(listed.artifacts.every((record) => record.scope === "project")).toBe(true);
    expect(results.filter((result) => result.tool === "save_card" && result.blocked)).toEqual([]);
  });

  it("scrubs secrets out of the saved program the way publish_artifact does", async () => {
    const { chat, lastSave } = host();
    const first = await chat.send({ projectRoot: fx.project, agentId: "saver", text: "draw-secret", source: "console" });
    await chat.send({ projectRoot: fx.project, agentId: "saver", sessionId: first.session.id, text: "save", source: "console" });
    const saved = savedRef(lastSave());
    const id = saved.key.slice(saved.key.indexOf("/") + 1);
    const row = fx.connection.prepare(`SELECT key, current_version FROM artifacts WHERE owner_agent = 'saver' AND id = ?`).get(id) as {
      key: string;
      current_version: number;
    };
    const version = fx.connection.prepare(`SELECT relative_path FROM artifact_versions WHERE key = ? AND version = ?`).get(row.key, row.current_version) as {
      relative_path: string;
    };
    const bytes = await readStoredArtifactFile(row.key, row.current_version, version.relative_path);
    const text = bytes.toString("utf8");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz");
  });

  it("says a card drawn in the reply still running can be saved in a later message", async () => {
    const { chat, lastSave } = host();
    await chat.send({ projectRoot: fx.project, agentId: "saver", text: "save", source: "console" });
    expect(lastSave()).toMatchObject({ isError: true, details: { code: "ui.card_not_found" } });
    expect(String((lastSave()!.details as { message: string }).message)).toContain("in a later message");
  });

  it("saves a deleted card again", async () => {
    const { chat, lastSave } = host();
    const first = await chat.send({ projectRoot: fx.project, agentId: "saver", text: "draw Doomed", source: "console" });
    const sessionId = first.session.id;
    const save = async () => {
      await chat.send({ projectRoot: fx.project, agentId: "saver", sessionId, text: "save", source: "console" });
      return savedRef(lastSave());
    };
    const owned = () => listArtifacts(fx.connection, { projectRoot: fx.project, limit: 50, owner: "agent:saver" }, roots()).artifacts.filter((record) => record.title === "Doomed");
    const before = await save();
    const id = before.key.slice(before.key.indexOf("/") + 1);
    await deletePublishedArtifact(fx.connection, "agent:saver", id, fx.project, roots());
    expect(owned()).toEqual([]);
    expect((await save()).key).toBe(before.key);
    expect(owned()).toHaveLength(1);

    // A soft-deleted earlier save keeps its id reserved: the next save gets a fresh one, and saving again returns that.
    fx.connection.prepare(`UPDATE artifacts SET deleted_at = ? WHERE owner_kind = 'agent' AND owner_agent = 'saver' AND id = ?`).run(new Date().toISOString(), id);
    const fresh = await save();
    expect(fresh.key).not.toBe(before.key);
    expect((await save()).key).toBe(fresh.key);
    expect(owned()).toHaveLength(1);
  });

  it("is offered only with ui.present, persistence conversation and artifacts.write", async () => {
    const saver = (await fx.service.get(fx.project, "saver")).definition!;
    const nogrant = (await fx.service.get(fx.project, "nogrant")).definition!;
    const arts = (await fx.service.get(fx.project, "arts")).definition!;
    expect(grantedToolIds(saver).has("save_card")).toBe(true);
    expect(grantedToolIds(nogrant).has("save_card")).toBe(false);
    expect(grantedToolIds(arts).has("save_card")).toBe(false);
    for (const agentId of ["nogrant", "arts"]) {
      const { chat, opened } = host();
      await chat.send({ projectRoot: fx.project, agentId, text: "hello", source: "console" });
      expect(opened[0]!.toolNames).not.toContain("save_card");
      expect(opened[0]!.saveCardTool).toBeUndefined();
      expect(opened[0]!.systemPrompt).not.toContain("save_card");
    }
    const { chat, opened } = host();
    await chat.send({ projectRoot: fx.project, agentId: "nogrant", text: "hello", source: "console" });
    expect(opened[0]!.systemPrompt).toContain(AGENT_PRESENT_CARD_SENTENCE);
  });

  it("keeps a visitor's saved card in that visitor's conversation", async () => {
    const { chat, lastSave } = host();
    const send = (text: string, sessionId?: string) =>
      chat.send({ projectRoot: fx.project, agentId: "visitor", text, source: "web_public", ...(sessionId ? { sessionId } : {}) });
    const a = await send("draw Visitor A chart");
    await send("save", a.session.id);
    const saved = savedRef(lastSave());
    const b = await send("draw Visitor B chart");

    const part = { v: 1 as const, kind: UI_PART_KIND_ARTIFACT_REF, key: saved.key, version: saved.version, title: saved.title, fallback: { text: "", url: "" } };
    expect(sessionArtifactVisible(fx.connection, a.session.id, part)).toBe(true);
    expect(sessionArtifactVisible(fx.connection, b.session.id, part)).toBe(false);
    const project = listArtifacts(fx.connection, { projectRoot: fx.project, limit: 50, owner: "agent:visitor" }, roots());
    expect(project.artifacts).toEqual([]);
    const session = listArtifacts(fx.connection, { projectRoot: fx.project, limit: 50, owner: "agent:visitor", scope: "session" }, roots());
    expect(session.artifacts.map((record) => record.title)).toEqual(["Visitor A chart"]);

    const closed = host();
    const c = await closed.chat.send({ projectRoot: fx.project, agentId: "closed", text: "draw Closed chart", source: "web_public" });
    await closed.chat.send({ projectRoot: fx.project, agentId: "closed", sessionId: c.session.id, text: "save", source: "web_public" });
    expect(closed.opened[0]!.saveCardTool).toBeUndefined();
    expect(closed.lastSave()?.blocked).toBeDefined();
  });

  it("is stubbed in an eval session", async () => {
    expect(classifyTool(undefined, "save_card")).toEqual({ class: "write", readOnly: false });
    const definition = (await fx.service.get(fx.project, "saver")).definition!;
    const gate = createEvalGate({ definition, policy: { tools: "real", approvals: "auto_approve_read", mocks: {}, readOnlyTools: [] } });
    const decision = gate.decide({ id: "c1", tool: "save_card", input: {} });
    expect(decision.allow).toBe(false);
    expect(gate.recordOf("c1")).toMatchObject({ policyOutcome: "stubbed", status: "not_run" });

    const evalGates = new EvalGateRegistry();
    const { chat, lastSave } = host({ evalGates });
    const session = await fx.service.openSession(fx.project, "saver", { source: "eval", eval: {} });
    evalGates.set(session.id, createEvalGate({ definition, policy: { tools: "read_only", approvals: "auto_approve_read", mocks: {}, readOnlyTools: [] } }));
    await chat.send({ projectRoot: fx.project, agentId: "saver", sessionId: session.id, text: "save", source: "eval" });
    expect(lastSave()?.blocked).toBeDefined();
  });
});
