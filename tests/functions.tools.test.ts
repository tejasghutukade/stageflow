import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAgentAdapter } from "../src/agent/claudeAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import { isConsumerSafeAgent } from "../src/agents/consumerSafety.js";
import { createEvalGate, EvalGateRegistry } from "../src/agents/evalGate.js";
import { requiresAskFirst } from "../src/agents/policy.js";
import { createPiAgentRuntime, type OpenSessionInput } from "../src/agents/runtime/piRuntime.js";
import { classifyTool } from "../src/agents/toolRisk.js";
import { AgentError } from "../src/agents/errors.js";
import { functionSourceHash } from "../src/config/loadFunction.js";
import { createFunctionInvoker } from "../src/functions/invoke.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { stageFunctionCallPlace } from "../src/functions/stageCall.js";
import {
  functionSnapshotPins,
  resolveFunctionTools,
  runAttachedFunctionTool,
  type FunctionToolInvoker,
} from "../src/functions/toolCall.js";
import type { FunctionCallInput } from "../src/functions/invoke.js";
import { buildComponents, buildSnapshot, computeFingerprint } from "../src/evals/snapshot.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const INVOICE_SOURCE = `export default function execute(context) {
  return { id: context.input.invoice.id, amount: context.input.invoice.amount, envelope: context.envelope };
}
`;

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    invoice: {
      type: "object",
      description: "Invoice the agent already has.",
      properties: {
        id: { type: "string", description: "Invoice id." },
        amount: { type: "integer", description: "Amount in cents." },
      },
      required: ["id", "amount"],
    },
  },
  required: ["invoice"],
  additionalProperties: false,
};

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(dirs.splice(0).map((dir) => rmSafe(dir)));
});

async function rmSafe(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}

async function openProject() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-fn-tool-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-fn-tool-project-"));
  dirs.push(home, project);
  const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
  closers.push(() => connection.close());
  const functions = new FunctionService({ store: new FunctionStore(connection) });
  const invoker = createFunctionInvoker({ db: connection, stageflowHome: home });
  return { home, project, connection, functions, invoker };
}

function toolBody(id: string, source: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Tool ${id}`,
    kind: "tool",
    source,
    tool_name: "total_invoice",
    tool_description: "Total an invoice object the agent supplies.",
    input_schema: INVOICE_SCHEMA,
    capabilities: [],
    bindings: [],
    ...overrides,
  };
}

const actor = { source: "api" as const, author: "test" };

describe("function tools", () => {
  it("lets a stage and a standalone agent pass an invoice without an envelope", async () => {
    const { project, connection, functions } = await openProject();
    await functions.create(project, toolBody("invoice_tool", INVOICE_SOURCE), actor);
    const args = { invoice: { id: "inv-9", amount: 42 } };
    const stage = await runAttachedFunctionTool({
      projectRoot: project,
      functionId: "invoice_tool",
      grants: [],
      args,
      db: connection,
      execution: { stage: "bill", attempt: 1 },
    });
    const agent = await runAttachedFunctionTool({
      projectRoot: project,
      functionId: "invoice_tool",
      grants: [],
      args,
      db: connection,
      execution: { agent: "clerk" },
    });
    expect(stage).toEqual({ ok: true, text: JSON.stringify({ id: "inv-9", amount: 42, envelope: null }) });
    expect(agent).toEqual(stage);
  });

  it("rejects a missing required argument before guest code and a bad output as a tool error", async () => {
    const { project, connection, functions, invoker } = await openProject();
    await functions.create(
      project,
      toolBody("invoice_tool", "export default function execute() { return { ran: true }; }\n", {
        output_schema: {
          type: "object",
          properties: { total: { type: "integer", description: "Total." } },
          required: ["total"],
          additionalProperties: false,
        },
      }),
      actor,
    );
    const missing = await runAttachedFunctionTool({
      projectRoot: project,
      functionId: "invoice_tool",
      grants: [],
      args: {},
      db: connection,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("invalid_input");
    expect(missing.text).not.toContain("ran");
    expect(invoker.list(project, "invoice_tool")).toEqual([]);

    await functions.save(
      project,
      "invoice_tool",
      {
        baseRevision: 1,
        definition: toolBody("invoice_tool", "export default function execute() { return { extra: true }; }\n", {
          output_schema: {
            type: "object",
            properties: { total: { type: "integer", description: "Total." } },
            required: ["total"],
            additionalProperties: false,
          },
        }),
      },
      actor,
    );
    const bad = await runAttachedFunctionTool({
      projectRoot: project,
      functionId: "invoice_tool",
      grants: [],
      args: { invoice: { id: "inv-1", amount: 1 } },
      db: connection,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_output");
  });

  it("reports an uncertain outcome once and does not call the tool again", async () => {
    let calls = 0;
    const invoker: FunctionToolInvoker = {
      async call() {
        calls += 1;
        return {
          ok: false,
          code: "uncertain_outcome",
          message: "function external outcome is uncertain",
          logs: "",
          durationMs: 1,
          sourceHash: "hash",
          revision: 1,
          kind: "tool",
          status: "uncertain",
        };
      },
    };
    const result = await runAttachedFunctionTool({
      projectRoot: "/tmp/unused",
      functionId: "invoice_tool",
      grants: [],
      args: { invoice: { id: "inv-1", amount: 1 } },
      invoker,
      definition: toolBody("invoice_tool", INVOICE_SOURCE) as never,
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("uncertain_outcome");
      expect(result.text.toLowerCase()).toContain("uncertain");
    }
  });

  it("sends a stage tool call to the attempt artifacts", async () => {
    const { project, functions } = await openProject();
    await functions.create(project, toolBody("invoice_tool", INVOICE_SOURCE), actor);
    const seen: FunctionCallInput[] = [];
    const invoker: FunctionToolInvoker = {
      async call(_projectRoot, input) {
        seen.push(input);
        return {
          ok: true,
          value: { id: "inv-1", amount: 1, envelope: null },
          logs: "",
          durationMs: 1,
          sourceHash: "hash",
          revision: 1,
          kind: "tool",
          status: "succeeded",
        };
      },
    };
    const place = stageFunctionCallPlace({
      runWorkspaceDir: "/data/runs/run-1",
      stageId: "write-note",
      attempt: 2,
      cwd: "/data/runs/run-1",
      checkoutRoot: "/checkout",
      containerName: "box",
      synced: false,
    });
    const resolved = await resolveFunctionTools({
      projectRoot: project,
      attachments: [{ id: "invoice_tool", grants: [] }],
      invoker,
      place,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await resolved.tools[0]!.run({ invoice: { id: "inv-1", amount: 1 } }, "call-1");
    expect(seen[0]?.roots).toEqual(place.roots);
    expect(seen[0]?.containerName).toBe("box");
    expect(place.roots.artifacts).toBe("/data/runs/run-1/stages/write-note/attempts/2/artifacts");
    expect(place.roots.workspace).toBe("/workspace/checkout");
    expect(place.roots.artifacts.includes("/artifacts")).toBe(true);
    expect(place.roots.artifacts.startsWith(project)).toBe(false);
  });

  it("cannot reach process or an ungranted host", async () => {
    const { project, connection, functions } = await openProject();
    const source = `export default async function execute(context) {
  let host = "absent";
  try {
    await context.http.request({ method: "GET", origin: "https://unrelated.example", path: "/" });
    host = "reached";
  } catch (error) {
    host = "denied";
  }
  return { process: typeof globalThis.process, host };
}
`;
    await functions.create(
      project,
      toolBody("invoice_tool", source, {
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      }),
      actor,
    );
    const result = await runAttachedFunctionTool({
      projectRoot: project,
      functionId: "invoice_tool",
      grants: [],
      args: {},
      db: connection,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.text)).toEqual({ process: "undefined", host: "denied" });
    }
  });
});

describe("function tool exposure", () => {
  it("keeps a consumer-safe agent unsafe once a function is attached", () => {
    const tools = {
      builtin: [],
      builtin_tools: [],
      mcp: {},
      skills: [],
      browser: false,
      stageflow: { groups: [], tools: [] },
    };
    const safe = { model: { backend: "pi" as const }, project_context: false, memories: [], tools };
    expect(isConsumerSafeAgent(safe)).toBe(true);
    expect(isConsumerSafeAgent({ ...safe, tools: { ...tools, functions: [{ id: "invoice_tool", grants: [] }] } })).toBe(false);
  });

  it("does not list a function tool on an external session", async () => {
    const { project, functions } = await openProject();
    await functions.create(project, toolBody("invoice_tool", INVOICE_SOURCE), actor);
    const parsed = (await import("../src/config/loadAgent.js")).parseAgentDefinition({
      id: "clerk",
      name: "Clerk",
      instructions: "Help.",
      enabled: true,
      tools: { functions: [{ id: "invoice_tool", grants: [] }] },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const opened: OpenSessionInput[] = [];
    const runtime = createPiAgentRuntime({
      cwd: project,
      agentDir: project,
      openSession: async (input) => {
        opened.push(input);
        return {
          toolNames: input.toolNames,
          shutdown: async () => undefined,
          session: {
            subscribe: () => () => undefined,
            prompt: async () => undefined,
            dispose: () => undefined,
          },
        };
      },
    });
    const complete = {
      sessionId: "s",
      projectRoot: project,
      definition: parsed.value,
      messages: [{ role: "user" as const, text: "go" }],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      hooks: {
        gate: async () => ({ allow: true as const }),
        toolStarted: () => undefined,
        toolFinished: () => undefined,
        modelFinished: () => undefined,
        delegate: async () => "",
      },
    };
    await runtime.complete(complete);
    expect(opened[0]?.toolNames).toContain("total_invoice");
    opened.length = 0;
    await runtime.release?.("s");
    await runtime.complete({ ...complete, sessionId: "ext", consumerTools: [] });
    expect(opened[0]?.toolNames ?? []).not.toContain("total_invoice");
  });

  it("fails a Claude stage and a Cursor stage before the session opens", async () => {
    const { project, functions } = await openProject();
    await functions.create(project, toolBody("invoice_tool", INVOICE_SOURCE), actor);
    const stage = {
      id: "bill",
      system_prompt: "Bill the invoice.",
      tools: { functions: [{ id: "invoice_tool", grants: [] }] },
    };
    const roots = buildStageRoots(project, "bill");
    const base: StageRunInput = {
      roots: { ...roots, cwd: project },
      stage: { ...stage, model: "anthropic/claude-sonnet-4-5" },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
    };
    const claude = await new ClaudeAgentAdapter().runStage(base);
    expect(claude.ok).toBe(false);
    if (!claude.ok) expect(claude.reason).toContain("mcp__stageflow__total_invoice");

    const { PiAgentAdapter } = await import("../src/agent/piAdapter.js");
    const cursor = await new PiAgentAdapter().runStage({
      ...base,
      stage: { ...stage, model: "cursor/auto" },
    });
    expect(cursor.ok).toBe(false);
    if (!cursor.ok) expect(cursor.reason).toContain("pi__total_invoice");
  });

  it("keeps Claude and Cursor project agents on backend_unavailable", async () => {
    const { project } = await openProject();
    const runtime = createPiAgentRuntime({ cwd: project, agentDir: project });
    const base = {
      sessionId: "s",
      projectRoot: project,
      messages: [{ role: "user" as const, text: "go" }],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      hooks: {
        gate: async () => ({ allow: true as const }),
        toolStarted: () => undefined,
        toolFinished: () => undefined,
        modelFinished: () => undefined,
        delegate: async () => "",
      },
    };
    const { parseAgentDefinition } = await import("../src/config/loadAgent.js");
    const claude = parseAgentDefinition({
      id: "clerk",
      name: "Clerk",
      instructions: "Help.",
      model: { backend: "claude" },
      tools: { functions: [{ id: "invoice_tool", grants: [] }] },
    });
    const cursor = parseAgentDefinition({
      id: "clerk",
      name: "Clerk",
      instructions: "Help.",
      model: { id: "cursor/auto" },
      tools: { functions: [{ id: "invoice_tool", grants: [] }] },
    });
    if (!claude.ok || !cursor.ok) throw new Error("definition");
    await expect(runtime.complete({ ...base, definition: claude.value })).rejects.toMatchObject({
      code: "agent.backend_unavailable",
    });
    await expect(runtime.complete({ ...base, sessionId: "c", definition: cursor.value })).rejects.toMatchObject({
      code: "agent.backend_unavailable",
    });
  });
});

describe("function tool names on save", () => {
  it("fails a tool_name rename while ask_first or read_only_tools still cites the old name", async () => {
    const fixture = await agentsFixture();
    const functions = new FunctionService({ store: new FunctionStore(fixture.connection) });
    await functions.create(fixture.project, toolBody("invoice_tool", INVOICE_SOURCE), actor);
    const saved = await fixture.service.create(
      fixture.project,
      agentInput("clerk", {
        tools: { functions: [{ id: "invoice_tool", grants: [] }] },
        approvals: { ask_first: ["total_invoice"] },
      }),
      { source: "console" },
    );
    expect(saved.definition?.approvals.ask_first).toEqual(["total_invoice"]);
    await functions.save(
      fixture.project,
      "invoice_tool",
      { baseRevision: 1, definition: toolBody("invoice_tool", INVOICE_SOURCE, { tool_name: "sum_invoice" }) },
      actor,
    );
    await expect(
      fixture.service.save(
        fixture.project,
        "clerk",
        {
          baseRevision: saved.agent.revision,
          definition: agentInput("clerk", {
            tools: { functions: [{ id: "invoice_tool", grants: [] }] },
            approvals: { ask_first: ["total_invoice"] },
          }),
        },
        { source: "console" },
      ),
    ).rejects.toMatchObject({
      code: "agent.invalid",
      issues: [expect.objectContaining({ code: "agent.function_tool_renamed", path: "approvals.ask_first.0" })],
    });

    await mkdir(path.join(fixture.project, "evals"), { recursive: true });
    await writeFile(
      path.join(fixture.project, "evals", "clerk.eval.yaml"),
      "conversation:\n  read_only_tools:\n    - total_invoice\n",
    );
    try {
      await fixture.service.save(
        fixture.project,
        "clerk",
        {
          baseRevision: saved.agent.revision,
          definition: agentInput("clerk", {
            tools: { functions: [{ id: "invoice_tool", grants: [] }] },
            approvals: { ask_first: ["sum_invoice"] },
          }),
        },
        { source: "console" },
      );
      throw new Error("expected read_only_tools to reject the old tool name");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).issues.some((issue) => issue.code === "agent.function_tool_renamed")).toBe(true);
    }
    await fixture.cleanup();
  });
});

describe("function fingerprints", () => {
  it("differs when only the function source hash changes and matches when only the cost cap changes", async () => {
    const { project, functions } = await openProject();
    await functions.create(project, toolBody("invoice_tool", INVOICE_SOURCE), actor);
    const first = await functionSnapshotPins(project, [{ id: "invoice_tool", grants: [] }]);
    await functions.save(
      project,
      "invoice_tool",
      {
        baseRevision: 1,
        definition: toolBody("invoice_tool", `${INVOICE_SOURCE}\n`),
      },
      actor,
    );
    const second = await functionSnapshotPins(project, [{ id: "invoice_tool", grants: [] }]);
    expect(first[0]?.source_hash).toBe(functionSourceHash(INVOICE_SOURCE));
    expect(second[0]?.source_hash).not.toBe(first[0]?.source_hash);
    const input = {
      stageVersionHash: "stagehash",
      model: "anthropic/claude-sonnet-4-5",
      datasetHash: "datasethash",
      caseIds: null,
      graders: [],
      judge: "anthropic/claude-sonnet-4-5",
      repeats: 1,
      passThreshold: 0.8,
      engine: { name: "promptfoo", version: "1.0.0" },
    };
    const fingerprint = (pins: typeof first) => computeFingerprint(buildComponents({ ...input, functions: pins }));
    expect(fingerprint(first)).not.toBe(fingerprint(second));
    expect(fingerprint(first)).toBe(fingerprint(first));
    const priced = (maxCostUsd: number) =>
      buildSnapshot({
        evalId: "e",
        evalPath: "e.eval.yaml",
        evalHash: "eh",
        evalDefinition: { id: "e" },
        overrides: { repeats: null, judge: null, model: null, max_cost_usd: maxCostUsd, case_ids: null, tags: null, only_failed_from: null },
        target: {
          pipeline_path: null,
          stage_id: "bill",
          file: null,
          stage_version_hash: "stagehash",
          stage_definition: { id: "bill" },
          model: "m",
          model_tier: "t",
          input_schema_hash: null,
          output_schema_hash: null,
        },
        dataset: { path: "d.jsonl", hash: "dh", format: "jsonl", case_count: 1, cases_run: 1, cases_skipped: 0, skipped_case_ids: [] },
        graders: [],
        settings: { repeats: 1, pass_threshold: 0.8, judge: "j", judge_same_as_stage: false, max_cost_usd: maxCostUsd, concurrency: 1, suite_type: "capability" },
        engine: { name: "promptfoo", version: "1.0.0", nodeVersion: "22.0.0" },
        stageflowVersion: "0.0.0",
        functions: first,
      });
    expect(priced(1).settings.max_cost_usd).not.toBe(priced(50).settings.max_cost_usd);
    expect(priced(1).functions).toEqual(priced(50).functions);
    expect(fingerprint(first)).toBe(computeFingerprint(buildComponents({ ...input, functions: first })));
  });
});

describe("eval policy for function tools", () => {
  const fixtures: AgentsFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  it("denies a missing gate, stubs an external tool, runs a consented real tool, and writes no approval", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const functions = new FunctionService({ store: new FunctionStore(fixture.connection) });
    const api = {
      id: "lookup",
      type: "api" as const,
      origin: "https://billing.example",
      methods: ["GET"],
      path_prefix: "/v1",
      effect: "read" as const,
    };
    const action = { ...api, id: "charge", effect: "action" as const, methods: ["POST"] };
    await projectTools(fixture, functions, "lookup_invoice", "lookup_invoice", [api]);
    await projectTools(fixture, functions, "charge_invoice", "charge_invoice", [action]);
    await fixture.service.create(
      fixture.project,
      agentInput("support", {
        tools: {
          functions: [
            { id: "lookup_invoice", grants: [{ id: "lookup", origin: api.origin, methods: api.methods, path_prefix: api.path_prefix }] },
            { id: "charge_invoice", grants: [{ id: "charge", origin: action.origin, methods: action.methods, path_prefix: action.path_prefix }] },
          ],
        },
      }),
      { source: "console" },
    );
    await fixture.service.setEnabled(fixture.project, "support", true, { source: "console" });
    const definition = (await fixture.service.get(fixture.project, "support")).definition!;
    expect(classifyTool(definition, "function.lookup_invoice", ["function.lookup_invoice"], fixture.project)).toEqual({
      class: "external",
      readOnly: false,
    });
    expect(classifyTool(definition, "function.charge_invoice", [], fixture.project).class).toBe("external");
    expect(requiresAskFirst(definition, "function.charge_invoice", fixture.project)).toBe(true);
    expect(requiresAskFirst(definition, "function.lookup_invoice", fixture.project)).toBe(false);
    await projectTools(fixture, functions, "write_invoice", "write_invoice", [
      { id: "out", type: "file", root: "workspace", path: "out.txt", access: "write" },
    ]);
    const writeDefinition = {
      ...definition,
      tools: {
        ...definition.tools,
        functions: [
          ...(definition.tools.functions ?? []),
          { id: "write_invoice", grants: [{ id: "out", root: "workspace" as const, path: "out.txt" }] },
        ],
      },
    };
    expect(classifyTool(writeDefinition, "function.write_invoice", ["function.write_invoice"], fixture.project)).toEqual({
      class: "write",
      readOnly: false,
    });
    expect(definition.approvals.ask_first).not.toContain("write_invoice");
    expect(requiresAskFirst(writeDefinition, "function.write_invoice", fixture.project)).toBe(true);

    const run = async (policy: { tools: "read_only" | "real" }, register: boolean, tool: string) => {
      const evalGates = new EvalGateRegistry();
      const gate = createEvalGate({
        policy: { tools: policy.tools, approvals: "record_only", readOnlyTools: [], mocks: {} },
        definition,
        projectRoot: fixture.project,
        stageflowHome: fixture.home,
      });
      const bodies: string[] = [];
      const backend = scriptedBackend(async (_messages, ctx) => {
        await ctx.tool(tool, {}, () => (bodies.push(tool), `ran ${tool}`));
        return "done";
      });
      const chat = new (await import("../src/agents/chatTurn.js")).AgentChatController({
        service: fixture.service,
        backend,
        evalGates,
      });
      const session = await fixture.service.openSession(fixture.project, "support", { source: "eval", eval: {} });
      if (register) evalGates.set(session.id, gate);
      await chat.send({ projectRoot: fixture.project, agentId: "support", sessionId: session.id, text: "go", source: "eval" });
      const approvalRows = fixture.connection.prepare("SELECT COUNT(*) AS n FROM agent_approvals").get() as { n: number };
      return { gate, bodies, approvalRows: approvalRows.n };
    };

    const missing = await run({ tools: "read_only" }, false, "function.lookup_invoice");
    expect(missing.bodies).toEqual([]);
    expect(missing.approvalRows).toBe(0);

    const stubbed = await run({ tools: "read_only" }, true, "function.lookup_invoice");
    expect(stubbed.bodies).toEqual([]);
    expect(stubbed.gate.records()[0]?.policyOutcome).toBe("stubbed");
    expect(stubbed.approvalRows).toBe(0);

    const real = await run({ tools: "real" }, true, "function.lookup_invoice");
    expect(real.bodies).toEqual(["function.lookup_invoice"]);
    expect(real.gate.records()[0]?.policyOutcome).toBe("ran");
    expect(real.approvalRows).toBe(0);

    const asked = await run({ tools: "real" }, true, "function.charge_invoice");
    expect(asked.bodies).toEqual([]);
    expect(asked.gate.records()[0]?.policyOutcome).toBe("would_ask_first");
    expect(asked.approvalRows).toBe(0);
  });
});

function projectTools(
  fixture: { project: string },
  functions: FunctionService,
  id: string,
  toolName: string,
  capabilities: unknown[],
): ReturnType<FunctionService["create"]> {
  return functions.create(
    fixture.project,
    toolBody(id, "export default function execute() { return { ok: true }; }\n", {
      tool_name: toolName,
      tool_description: `Call ${toolName}`,
      input_schema: { type: "object", properties: {}, additionalProperties: true },
      capabilities,
    }),
    actor,
  );
}
