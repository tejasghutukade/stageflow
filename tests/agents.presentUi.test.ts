import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { createEvalGate, EvalGateRegistry, type EvalGatePolicy } from "../src/agents/evalGate.js";
import { parseUiPartCard } from "../src/artifacts/uiPartCard.js";
import { agentPresentUiPrompt, createPresentUiTool, messageReplayText, presentArtifact, REPLAY_PROGRAM_MAX, presentCard, PRESENT_UI_TOOL_NAME, uiPartsFromToolOutput } from "../src/agents/presentUi.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_KIND_CARD, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import { grantedToolIds, parseAgentDefinition } from "../src/config/loadAgent.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const part = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_ARTIFACT_REF,
  key: "agent:helper/weekly",
  title: "Weekly",
  fallback: { text: "Weekly", url: "http://127.0.0.1:3847/#/artifacts/agent%3Ahelper/weekly?project_root=p" },
};

describe("present_ui prompt", () => {
  it("teaches the program syntax only for the kinds the agent may present", () => {
    const declarative = agentPresentUiPrompt({ ui: { present: true, kinds: ["live.declarative"], functions: [] } })!;
    expect(declarative).toContain("live.declarative");
    expect(declarative).toContain("Syntax: one statement per line");
    expect(declarative).toContain("CardHeader");
    expect(declarative).not.toContain("Live HTML artifacts");
    const markdown = agentPresentUiPrompt({ ui: { present: true, kinds: ["static.markdown"], functions: [] } })!;
    expect(markdown).not.toContain("Syntax: one statement per line");
    const html = agentPresentUiPrompt({ ui: { present: true, persistence: "artifacts", kinds: ["live.html"], functions: [] } })!;
    expect(html).toContain("Live HTML artifacts");
  });

  it("includes HTML card guidance only when a sandbox is available", () => {
    const without = agentPresentUiPrompt({ ui: { present: true, persistence: "conversation", kinds: ["live.html"], functions: [] } })!;
    expect(without).not.toContain("### HTML cards");
    const withSandbox = agentPresentUiPrompt({ ui: { present: true, persistence: "conversation", kinds: ["live.html"], functions: [] } }, { htmlCardsAvailable: true })!;
    expect(withSandbox).toContain("### HTML cards");
    expect(withSandbox).toContain("no network access");
  });

  it("teaches cards kept in the conversation: display only, redraw to change", () => {
    const prompt = agentPresentUiPrompt({ ui: { present: true, persistence: "conversation", kinds: ["live.declarative"], functions: [] } })!;
    expect(prompt).toContain("# Drawing cards in chat");
    expect(prompt).toContain("To change a card, call present_ui again with the complete updated program");
    expect(prompt).toContain("bindings must be []");
    expect(prompt).not.toContain("Pass its key");
    expect(prompt).toContain("PieChart");
    expect(prompt).toContain("closest chart");
    expect(prompt).toContain("do not reply that a component is unavailable");
  });
});

describe("ui grant", () => {
  it("is off by default and rejects a bad kind", () => {
    const parsed = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help." });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ui).toEqual({ present: false, persistence: "conversation", kinds: [], functions: [] });
    expect(grantedToolIds(parsed.value).has(PRESENT_UI_TOOL_NAME)).toBe(false);
    const bad = parseAgentDefinition({
      id: "helper",
      name: "Helper",
      instructions: "Help.",
      ui: { present: true, kinds: ["form"], functions: ["Weekly"] },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["agent.ui_kind_unknown", "agent.ui_function_invalid"]));
  });
});

describe("ui persistence", () => {
  const parse = (ui: Record<string, unknown>) => parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help.", ui });

  it("fills the kinds each mode allows when present is on and kinds are left out", () => {
    const conversation = parse({ present: true });
    expect(conversation.ok && conversation.value.ui).toEqual({
      present: true,
      persistence: "conversation",
      kinds: ["live.declarative", "static.markdown", "live.html"],
      functions: [],
    });
    const artifacts = parse({ present: true, persistence: "artifacts" });
    expect(artifacts.ok && artifacts.value.ui.kinds).toContain("live.html");
  });

  it("gives agents saved with the old default card pair HTML cards too, but keeps a narrower choice", () => {
    const legacy = parse({ present: true, kinds: ["static.markdown", "live.declarative"] });
    expect(legacy.ok && legacy.value.ui.kinds).toEqual(["live.declarative", "static.markdown", "live.html"]);
    const narrow = parse({ present: true, kinds: ["static.markdown"] });
    expect(narrow.ok && narrow.value.ui.kinds).toEqual(["static.markdown"]);
    const artifacts = parse({ present: true, persistence: "artifacts", kinds: ["live.declarative", "static.markdown"] });
    expect(artifacts.ok && artifacts.value.ui.kinds).toEqual(["live.declarative", "static.markdown"]);
  });

  it("allows live HTML as a conversation card and still needs artifacts for functions", () => {
    expect(parse({ present: true, kinds: ["live.html"] }).ok).toBe(true);
    const functions = parse({ present: true, functions: ["revenue_by_week"] });
    expect(functions.ok).toBe(false);
    if (!functions.ok) expect(functions.issues.map((issue) => issue.code)).toContain("agent.ui_functions_need_artifacts");
    expect(parse({ present: true, persistence: "artifacts", kinds: ["live.html"], functions: ["revenue_by_week"] }).ok).toBe(true);
  });
});

describe("conversation cards", () => {
  const program = 'root = Card([CardHeader("Regional sales", "This week"), TextContent("North leads.")])';
  const manifest = { kind: "live.declarative", format: "openui-lang", library: { name: "stageflow", version: "1.0.0" }, bindings: [] };
  const base = { projectRoot: tmpdir(), program, manifest, presentedInMessage: 1, allowedKinds: ["live.declarative", "static.markdown", "live.html"] };
  let n = 0;
  const session = () => `ses_card_${n++}`;

  it("returns the checked program as a card part and writes nothing", async () => {
    const result = await presentCard({ ...base, sessionId: session(), title: "Regional sales" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.ui).toEqual({
      v: UI_PART_SCHEMA_VERSION,
      kind: UI_PART_KIND_CARD,
      title: "Regional sales",
      format: "live.declarative",
      program,
      library: { name: "stageflow", version: "1.0.0" },
      fallback: { text: "Regional sales", url: "" },
    });
    expect(uiPartsFromToolOutput(PRESENT_UI_TOOL_NAME, JSON.stringify(result.envelope))).toEqual([result.envelope.ui]);
    expect(messageReplayText({ text: "Here", parts: [result.envelope.ui] })).toContain(program.slice(0, 20));
  });

  it("uses the markdown itself as the channel fallback", async () => {
    const result = await presentCard({ ...base, sessionId: session(), program: "# Notes\n\n- one", manifest: { kind: "static.markdown" } });
    expect(result.ok && result.envelope.ui.kind === UI_PART_KIND_CARD && result.envelope.ui.fallback.text).toBe("# Notes\n\n- one");
  });

  it("refuses live data, actions, a bad program, a kind outside the grant and a fifth card", async () => {
    const codes = async (overrides: Partial<Parameters<typeof presentCard>[0]>) => {
      const result = await presentCard({ ...base, sessionId: session(), ...overrides });
      return result.ok ? "ok" : result.code;
    };
    expect(await codes({ manifest: { ...manifest, bindings: [{ id: "rows", function: "weekly", args: {} }] } })).toBe("ui.card_display_only");
    expect(await codes({ manifest: { ...manifest, actions: [{ id: "go", type: "message", label: "Go", template: "go" }] } })).toBe("ui.card_display_only");
    expect(await codes({ program: "root = Card([" })).toBe("artifact.program_invalid");
    expect(await codes({ allowedKinds: ["static.markdown"] })).toBe("ui.kind_not_granted");
    expect(await codes({ presentedInMessage: 5 })).toBe("ui.message_cap");
  });

  it("accepts an HTML card with a vendored library and refuses display-only violations", async () => {
    const htmlProgram = "<p>North 120, South 95</p>";
    const chartVersion = "4.6.2";
    const accepted = await presentCard({
      ...base,
      sessionId: session(),
      title: "Regional chart",
      program: htmlProgram,
      manifest: { kind: "live.html", format: "html", libraries: [{ name: "chartjs", version: chartVersion }] },
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.envelope.ui).toMatchObject({
      format: "live.html",
      libraries: [{ name: "chartjs", version: chartVersion }],
    });
    const codes = async (overrides: Partial<Parameters<typeof presentCard>[0]>) => {
      const result = await presentCard({ ...base, sessionId: session(), ...overrides });
      return result.ok ? "ok" : result.code;
    };
    expect(
      await codes({
        program: htmlProgram,
        manifest: { kind: "live.html", format: "html", libraries: [{ name: "chartjs", version: "0.0.1" }] },
      }),
    ).toBe("ui.unknown_library");
    expect(
      await codes({
        program: '<script src="https://cdn.example/app.js"></script>',
        manifest: { kind: "live.html", format: "html" },
      }),
    ).toBe("artifact.html_csp_violation");
    expect(
      await codes({
        program: htmlProgram,
        manifest: { kind: "live.html", format: "html", csp: { connectDomains: ["https://api.example.com"] } },
      }),
    ).toBe("ui.card_display_only");
    expect(
      await codes({
        program: htmlProgram,
        manifest: { kind: "live.html", format: "html", bindings: [{ id: "rows", function: "weekly", args: {} }] },
      }),
    ).toBe("ui.card_display_only");
  });

  it("refuses a saved artifact key when cards stay in the conversation", async () => {
    const tool = createPresentUiTool({ kinds: ["live.declarative"], projectRoot: tmpdir(), persistence: "conversation", present: async () => ({ ok: false, code: "x", message: "x" }) });
    const result = await tool.execute("call", { key: "agent:helper/weekly" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ code: "ui.key_needs_artifacts" });
  });
});

describe("present_ui transcript", () => {
  it("refuses the tool when the grant is off", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    await fixture.service.create(fixture.project, agentInput("helper"), { source: "console" });
    await fixture.service.setEnabled(fixture.project, "helper", true, { source: "console" });
    const backend = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool(PRESENT_UI_TOOL_NAME, { key: "agent:helper/weekly" });
      return result.output;
    });
    const chat = new AgentChatController({ service: fixture.service, backend });
    const detail = await chat.send({ projectRoot: fixture.project, agentId: "helper", text: "show it", source: "console" });
    const reply = detail.messages.find((message) => message.role === "assistant");
    expect(reply?.text).toContain("not granted");
    expect(reply?.parts).toBeUndefined();
  });

  it("stores the ui part and replays it as a reference", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    await fixture.service.create(
      fixture.project,
      agentInput("helper", { ui: { present: true, kinds: ["static.markdown"], functions: [] } }),
      { source: "console" },
    );
    await fixture.service.setEnabled(fixture.project, "helper", true, { source: "console" });
    const envelope = { type: "ui", ui: part };
    const seen: Array<Array<{ role: string; parts?: unknown[] }>> = [];
    const backend = scriptedBackend(async (messages, ctx) => {
      seen.push(messages);
      if (messages.some((message) => message.role === "assistant")) return "still here";
      await ctx.tool(PRESENT_UI_TOOL_NAME, { key: part.key }, () => JSON.stringify(envelope));
      return "Shown";
    });
    const chat = new AgentChatController({ service: fixture.service, backend });
    const first = await chat.send({ projectRoot: fixture.project, agentId: "helper", text: "show it", source: "console" });
    const reply = [...first.messages].reverse().find((message) => message.role === "assistant");
    expect(reply?.parts).toEqual([part]);
    expect(reply?.text).toBe("Shown");
    const reloaded = await fixture.service.getSession(fixture.project, first.session.id);
    expect(reloaded.messages.find((message) => message.role === "assistant")?.parts).toEqual([part]);
    await chat.send({ projectRoot: fixture.project, agentId: "helper", sessionId: first.session.id, text: "again", source: "console" });
    expect(seen.at(-1)?.some((message) => message.parts?.[0] && (message.parts[0] as { key: string }).key === part.key)).toBe(true);
    expect(messageReplayText({ text: "Shown", parts: [part] })).toContain(JSON.stringify({ type: "ui", ui: part }));
    expect(uiPartsFromToolOutput(PRESENT_UI_TOOL_NAME, JSON.stringify(envelope))).toEqual([part]);
  });

  it("keeps an HTML card whole on replay, and marks a very long one as incomplete", () => {
    const base = { v: 1 as const, kind: "card" as const, title: "Map", format: "live.html" as const, fallback: { text: "Map", url: "" } };
    const short = { ...base, program: "<p>é</p>".repeat(100) };
    expect(messageReplayText({ text: "Here", parts: [short] })).toContain(JSON.stringify(short.program));
    const long = { ...base, program: `<p>${"é".repeat(REPLAY_PROGRAM_MAX + 50)}</p>` };
    const replay = messageReplayText({ text: "Here", parts: [long] });
    expect(replay).toContain(`first ${REPLAY_PROGRAM_MAX} of ${long.program.length} characters`);
    expect(replay).toContain("write the whole card again");
    expect(replay).not.toContain("é".repeat(REPLAY_PROGRAM_MAX + 1));
    expect(parseUiPartCard({ ...base, program: "<p>x</p>", libraries: [{ name: "chartjs", version: "4.6.2" }] }).ok).toBe(true);
    expect(parseUiPartCard({ ...base, program: "<p>x</p>" }).ok).toBe(true);
  });

  it("stubs the tool in an eval session", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    await fixture.service.create(
      fixture.project,
      agentInput("helper", { ui: { present: true, kinds: ["static.markdown"], functions: [] } }),
      { source: "console" },
    );
    await fixture.service.setEnabled(fixture.project, "helper", true, { source: "console" });
    const definition = (await fixture.service.get(fixture.project, "helper")).definition!;
    const policy: EvalGatePolicy = { tools: "real", approvals: "record_only", readOnlyTools: [], mocks: {} };
    const evalGates = new EvalGateRegistry();
    const gate = createEvalGate({ policy, definition, projectRoot: fixture.project, stageflowHome: fixture.home });
    const ran: string[] = [];
    const backend = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool(PRESENT_UI_TOOL_NAME, { key: part.key }, () => {
        ran.push(PRESENT_UI_TOOL_NAME);
        return "ran";
      });
      return result.output;
    });
    const chat = new AgentChatController({ service: fixture.service, backend, evalGates });
    const session = await fixture.service.openSession(fixture.project, "helper", { source: "eval", eval: {} });
    evalGates.set(session.id, gate);
    const detail = await chat.send({ projectRoot: fixture.project, agentId: "helper", sessionId: session.id, text: "show", source: "eval" });
    expect(ran).toEqual([]);
    expect(detail.messages.find((message) => message.role === "assistant")?.text).toContain("was not executed");
    expect(detail.messages.find((message) => message.role === "assistant")?.parts).toBeUndefined();
  });
});

describe("presentArtifact", () => {
  async function openProjects() {
    const home = await mkdtemp(path.join(tmpdir(), "sf-present-home-"));
    const dirA = await mkdtemp(path.join(tmpdir(), "sf-present-a-"));
    const dirB = await mkdtemp(path.join(tmpdir(), "sf-present-b-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const store = createRunStore({ rootDir: home });
    const projectA = await store.ensureProject(dirA);
    const projectB = await store.ensureProject(dirB);
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    });
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    return { db, roots, projectA, projectB };
  }

  it("returns a ui part for this project and refuses another project's key", async () => {
    const { db, roots, projectA, projectB } = await openProjects();
    const published = await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: projectA,
      id: "weekly",
      kind: "static.markdown",
      title: "Weekly",
      bytes: Buffer.from("# hi"),
      publishSource: "api",
      source: { kind: "stage", runId: "run-1", stageId: "summarize", attempt: 1 },
      roots,
    });
    const deps = { cwd: projectA } as McpToolDeps;
    const shown = presentArtifact({
      db,
      roots,
      projectRoot: projectA,
      key: published.key,
      allowedKinds: ["static.markdown"],
      consoleDeps: deps,
    });
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.envelope.ui.key).toBe(published.key);
    expect(shown.envelope.ui.title).toBe("Weekly");
    expect(shown.envelope.ui.fallback.text).toBe("Weekly");
    expect(shown.envelope.ui.fallback.url).toContain("/#/artifacts/");
    expect(shown.envelope.ui.version).toBeUndefined();
    const other = presentArtifact({
      db,
      roots,
      projectRoot: projectB,
      key: published.key,
      allowedKinds: ["static.markdown"],
      consoleDeps: deps,
    });
    expect(other).toMatchObject({ ok: false, code: "ui.cross_project" });
    const kind = presentArtifact({
      db,
      roots,
      projectRoot: projectA,
      key: published.key,
      allowedKinds: ["static.table"],
      consoleDeps: deps,
    });
    expect(kind).toMatchObject({ ok: false, code: "ui.kind_not_granted" });
    const missing = presentArtifact({
      db,
      roots,
      projectRoot: projectA,
      key: "agent:helper/missing",
      allowedKinds: ["static.markdown"],
      consoleDeps: deps,
    });
    expect(missing).toMatchObject({ ok: false, code: "artifact.not_found" });
  });
});
