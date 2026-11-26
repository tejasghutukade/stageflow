import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { createEvalGate, EvalGateRegistry, type EvalGatePolicy } from "../src/agents/evalGate.js";
import { messageReplayText, presentArtifact, PRESENT_UI_TOOL_NAME, uiPartsFromToolOutput } from "../src/agents/presentUi.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
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

describe("ui grant", () => {
  it("is off by default and rejects a bad kind", () => {
    const parsed = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help." });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ui).toEqual({ present: false, kinds: [], functions: [] });
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
