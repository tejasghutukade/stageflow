import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalPlan } from "../src/evals/plan.js";
import { filterEvalListItems, type EvalListItem } from "../src/evals/read/list.js";
import { buildResultRows } from "../src/evals/read/results.js";
import { conversationView, currentHashes, resultToWire } from "../src/evals/read/runs.js";
import type { EvalCaseRow, EvalResultWithGrades, EvalRunRow } from "../src/evals/storeTypes.js";
import { agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/evals/agent/project");

function result(over: Partial<EvalResultWithGrades>): EvalResultWithGrades {
  return {
    evalRunId: "er",
    caseId: "c1",
    repeatIndex: 0,
    status: "completed",
    errorCode: null,
    errorMessage: null,
    stageRunId: null,
    subjectRef: null,
    turns: null,
    toolCallCount: null,
    output: null,
    latencyMs: 10,
    costUsd: 0.1,
    tokensIn: 1,
    tokensOut: 1,
    score: 1,
    passed: true,
    hasGraderErrors: false,
    budgetWarnings: null,
    startedAt: null,
    finishedAt: null,
    grades: [],
    ...over,
  };
}

const subject = {
  kind: "conversation",
  status: "success",
  messages: [{ role: "user", text: "hi", turn: 1 }],
  tool_calls: [{ id: "call_1", name: "read" }],
  final_reply: "hello",
  turns: 1,
  stop_reason: "resolved",
};

describe("conversationView", () => {
  it("reads a valid subject", () => {
    expect(conversationView(subject)).toEqual({
      messages: subject.messages,
      tool_calls: subject.tool_calls,
      final_reply: "hello",
      stop_reason: "resolved",
    });
  });

  it("tolerates a truncated subject", () => {
    expect(conversationView({ kind: "conversation", messages: [], tool_calls: [] })).toEqual({
      messages: [],
      tool_calls: [],
      final_reply: "",
      stop_reason: "",
    });
  });

  it("returns null for foreign shapes", () => {
    expect(conversationView(null)).toBeNull();
    expect(conversationView("text")).toBeNull();
    expect(conversationView({ status: "success", payload: {} })).toBeNull();
    expect(conversationView({ kind: "conversation", messages: "x", tool_calls: [] })).toBeNull();
    expect(conversationView([subject])).toBeNull();
  });
});

describe("agent result detail", () => {
  it("returns the stored subject, subject_ref, turns, tool_call_count and agent link", () => {
    const wire = resultToWire(result({ subjectRef: "ses_1", turns: 3, toolCallCount: 2, output: subject }), undefined, "support");
    expect(wire).toMatchObject({
      stage_run_id: null,
      subject_ref: "ses_1",
      turns: 3,
      tool_call_count: 2,
      agent: { id: "support", session_id: "ses_1" },
      output: subject,
    });
  });

  it("a result that never started has no agent link but still renders", () => {
    const wire = resultToWire(result({ status: "error", output: subject }), undefined, "support");
    expect(wire.agent).toBeNull();
    expect(wire.output).toEqual(subject);
  });

  it("stage results carry no agent key", () => {
    const wire = resultToWire(result({ stageRunId: "run_1", subjectRef: "run_1" }), undefined);
    expect("agent" in wire).toBe(false);
    expect(wire.turns).toBeNull();
  });
});

describe("result rows", () => {
  const cases: EvalCaseRow[] = [{ evalRunId: "er", caseId: "c1", position: 0, case: { id: "c1" } } as EvalCaseRow];

  it("turns and tool_calls are the mean over executed repeats with a value", () => {
    const { rows } = buildResultRows({
      targetKind: "agent",
      cases,
      reviews: [],
      results: [
        result({ repeatIndex: 0, turns: 2, toolCallCount: 1 }),
        result({ repeatIndex: 1, turns: 5, toolCallCount: 4 }),
        result({ repeatIndex: 2, status: "error", turns: null, toolCallCount: null, passed: false }),
      ],
    });
    expect(rows[0].turns).toBe(3.5);
    expect(rows[0].tool_calls).toBe(2.5);
  });

  it("stage rows have no turns keys", () => {
    const { rows } = buildResultRows({ cases, reviews: [], results: [result({})] });
    expect("turns" in rows[0]).toBe(false);
    expect("tool_calls" in rows[0]).toBe(false);
  });
});

describe("eval list filters", () => {
  const item = (id: string, target: EvalListItem["target"]) => ({ id, target }) as EvalListItem;
  const items = [
    item("a", { kind: "stage", label: "x" }),
    item("b", { kind: "agent", agent_id: "support", agent_name: "Support", model: null, revision: null, label: "Support" }),
    item("c", { kind: "agent", agent_id: "other", agent_name: "Other", model: null, revision: null, label: "Other" }),
  ];

  it("filters by target_kind and agent", () => {
    expect(filterEvalListItems(items, { target_kind: "agent" }).map((i) => i.id)).toEqual(["b", "c"]);
    expect(filterEvalListItems(items, { target_kind: "stage" }).map((i) => i.id)).toEqual(["a"]);
    expect(filterEvalListItems(items, { agent: "support" }).map((i) => i.id)).toEqual(["b"]);
    expect(filterEvalListItems(items, {}).length).toBe(3);
  });
});

describe("stale agent signal", () => {
  it("current block reflects an edited agent", async () => {
    const fx = await agentsFixture();
    fixtures.push(fx);
    await cp(SRC, fx.project, { recursive: true, force: true });
    const built = await buildEvalPlan({
      projectRoot: fx.project,
      evalPath: "evals/support-basics.eval.yaml",
      evalRunId: "er_1",
      engine: { name: "fake", version: "1", nodeVersion: "22" },
      agents: fx.service,
    });
    if (!built.ok) throw new Error(JSON.stringify(built.findings));
    const target = built.snapshot.target;
    if (target.kind !== "agent") throw new Error("expected agent snapshot");
    const row = {
      projectRoot: fx.project,
      evalPath: "evals/support-basics.eval.yaml",
      targetKind: "agent",
      targetRef: { agent_id: "support" },
      config: built.snapshot,
    } as unknown as EvalRunRow;

    const fresh = await currentHashes(row, fx.service);
    expect(fresh.agent_definition_hash).toBe(target.definition_hash);
    expect(fresh.agent_revision).toBe(target.revision);
    expect(fresh.stage_version_hash).toBeNull();

    const detail = await fx.service.get(fx.project, "support");
    await fx.service.save(
      fx.project,
      "support",
      { baseRevision: detail.agent.revision, definition: { ...detail.definition!, instructions: "changed" } },
      { source: "console" },
    );
    const stale = await currentHashes(row, fx.service);
    expect(stale.agent_definition_hash).not.toBe(target.definition_hash);
    expect(stale.agent_revision).toBe(target.revision + 1);

    const offline = await currentHashes(row);
    expect(offline.agent_revision).toBeNull();
    expect(offline.agent_definition_hash).toBeNull();
  });
});
