import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentEvalHarness, realEvalYaml, type AgentEvalHarness } from "./helpers/agentEvalHarness.js";

const open: AgentEvalHarness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup(opts: Parameters<typeof agentEvalHarness>[0] = {}): Promise<AgentEvalHarness> {
  const h = await agentEvalHarness(opts);
  open.push(h);
  return h;
}

describe("agent eval routes: reading", () => {
  it("lists agent targets with tools, risks, ask-first and eval counts, hides eval sessions", async () => {
    const h = await setup();
    await h.run("script-basics");
    const res = await h.get(`/api/evals/agent-targets?${h.q}`);
    expect(res.status).toBe(200);
    const support = res.body.items.find((i: any) => i.id === "support");
    expect(support).toMatchObject({
      name: "Support",
      model: "anthropic/claude-haiku-4-5",
      enabled: true,
      ask_first: ["billing.refund"],
      evals_count: 2,
      issues: [],
      unavailable_reason: null,
    });
    expect(support.revision).toBeGreaterThan(0);
    expect(support.tools).toEqual(
      expect.arrayContaining([
        { id: "read", risk: "read", class: "read" },
        { id: "billing.refund", risk: "mcp_unknown", class: "mcp_unknown" },
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain("ses_");
    expect((await h.service.listAllSessions(h.root, { limit: 50 })).sessions).toHaveLength(0);
  });

  it("greys out an archived agent that an eval still names", async () => {
    const h = await setup();
    await h.service.list(h.root);
    await h.service.archive(h.root, "support");
    const res = await h.get(`/api/evals/agent-targets?${h.q}`);
    const support = res.body.items.find((i: any) => i.id === "support");
    expect(support).toMatchObject({ unavailable_reason: "archived", evals_count: 2 });
  });

  it("returns agent items in the eval list with filters, and an agent block on the detail", async () => {
    const h = await setup();
    const all = await h.get(`/api/evals?${h.q}`);
    const agentItem = all.body.items.find((i: any) => i.id === "script-basics");
    expect(agentItem.target).toMatchObject({ kind: "agent", agent_id: "support", agent_name: "Support", model: "anthropic/claude-haiku-4-5" });
    expect(agentItem.target.revision).toBeGreaterThan(0);
    expect(agentItem.conversation).toEqual({ mode: "script", max_turns: 4, tools: "read_only", approvals: "record_only" });
    const stageItem = all.body.items.find((i: any) => i.id === "review");
    expect(stageItem.target.kind).toBe("stage");
    expect(stageItem).not.toHaveProperty("conversation");

    const onlyAgents = await h.get(`/api/evals?${h.q}&target_kind=agent`);
    expect(onlyAgents.body.items.map((i: any) => i.id).sort()).toEqual(["script-basics", "support-basics"]);
    const forAgent = await h.get(`/api/evals?${h.q}&agent=support`);
    expect(forAgent.body.items.map((i: any) => i.id).sort()).toEqual(["script-basics", "support-basics"]);
    expect((await h.get(`/api/evals?${h.q}&agent=nobody`)).body.items).toEqual([]);
    expect((await h.get(`/api/evals?${h.q}&q=support`)).body.items.length).toBeGreaterThan(0);

    const detail = await h.get(`/api/evals/script-basics?${h.q}`);
    expect(detail.body.agent).toMatchObject({
      id: "support",
      name: "Support",
      enabled: true,
      archived: false,
      ask_first: ["billing.refund"],
      issues: [],
    });
    expect(detail.body.target_model).toBe("anthropic/claude-haiku-4-5");
    const stageDetail = await h.get(`/api/evals/review?${h.q}`);
    expect(stageDetail.body).not.toHaveProperty("agent");
  });
});

describe("agent eval routes: writing", () => {
  const definition = (id: string, extra: Record<string, unknown> = {}) => ({
    version: 1,
    id,
    name: "Created",
    type: "capability",
    target: { kind: "agent", agent: "support" },
    dataset: "../datasets/script-scenarios.dataset.jsonl",
    conversation: { mode: "script", max_turns: 3, tools: "read_only", approvals: "deny" },
    graders: [
      { id: "calls", type: "tool_calls", must_call: ["billing.lookup_invoice"], args: [{ tool: "billing.lookup_invoice", path: "invoice_id", op: "matches", value: "^INV" }] },
      { id: "reply", type: "conversation_check", final_reply: [{ op: "not_empty" }] },
    ],
    ...extra,
  });

  it("validates a draft, creates it with identical YAML, and updates with FILE_CHANGED protection", async () => {
    const h = await setup();
    const validated = await h.post("/api/evals/validate", { project_root: h.root, definition: definition("made") });
    expect(validated.status).toBe(200);
    expect(validated.body.findings.filter((f: any) => f.severity === "error")).toEqual([]);
    const derived = validated.body.derived_yaml as string;
    expect(derived).toContain("conversation:\n  mode: script\n  max_turns: 3\n  turn_timeout_ms: 120000\n  tools: read_only\n  approvals: deny");
    expect(derived).toContain("concurrency: 2");
    expect(derived).toContain("max_cost_usd: 1");
    expect(derived).toContain("{ tool: billing.lookup_invoice, path: invoice_id, op: matches, value: ^INV }");
    expect(derived).toContain("{ op: not_empty }");
    expect(derived.indexOf("defaults:")).toBeLessThan(derived.indexOf("conversation:"));
    expect(derived.indexOf("conversation:")).toBeLessThan(derived.indexOf("graders:"));

    const created = await h.post("/api/evals", { project_root: h.root, definition: definition("made") });
    expect(created.status).toBe(201);
    expect(created.body.yaml).toBe(derived);
    expect(created.body.agent).toMatchObject({ id: "support" });
    expect(await readFile(path.join(h.root, "evals", "made.eval.yaml"), "utf8")).toBe(derived);

    const dup = await h.post("/api/evals", { project_root: h.root, definition: definition("made") });
    expect(dup.status).toBe(409);

    const edited = { ...definition("made"), conversation: { mode: "script", max_turns: 5, tools: "mocked", approvals: "deny" } };
    const updated = await h.call("PUT", "/api/evals/made", {
      project_root: h.root,
      definition: edited,
      base_hash: created.body.file_hash,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.yaml).toContain("max_turns: 5");
    expect(updated.body.yaml).toContain("tools: mocked");
    expect(updated.body.yaml).toContain("{ tool: billing.lookup_invoice, path: invoice_id, op: matches, value: ^INV }");

    const stale = await h.call("PUT", "/api/evals/made", {
      project_root: h.root,
      definition: edited,
      base_hash: created.body.file_hash,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "FILE_CHANGED", current_hash: updated.body.file_hash });
  });

  it("reports release 2 findings on validate and refuses to create an invalid agent eval", async () => {
    const h = await setup();
    const unknown = await h.post("/api/evals/validate", {
      project_root: h.root,
      definition: definition("bad", { target: { kind: "agent", agent: "ghost" } }),
    });
    expect(unknown.body.findings.map((f: any) => f.code)).toContain("eval.agent_not_found");
    const create = await h.post("/api/evals", {
      project_root: h.root,
      definition: definition("bad", { target: { kind: "agent", agent: "ghost" } }),
    });
    expect(create.status).toBe(422);
    expect(create.body.code).toBe("EVAL_INVALID");

    const real = await h.post("/api/evals/validate", {
      project_root: h.root,
      definition: definition("real", { conversation: { mode: "script", tools: "real" } }),
    });
    expect(real.body.findings.map((f: any) => f.code)).toContain("eval.real_tools_not_allowed");

    const schemaGrader = await h.post("/api/evals/validate", {
      project_root: h.root,
      definition: definition("sg", { graders: [{ id: "s", type: "schema" }] }),
    });
    expect(schemaGrader.body.findings.map((f: any) => f.code)).toContain("eval.grader_not_applicable");
  });

  it("keeps the stage write path byte-identical", async () => {
    const h = await setup();
    const stage = {
      version: 1,
      id: "stage-made",
      target: { kind: "stage", pipeline: "../pipelines/feature-ship.pipeline.yaml", stage: "review" },
      dataset: "../datasets/review.dataset.jsonl",
      task: { goal: "Review." },
      defaults: { judge: "anthropic/claude-sonnet-4-5" },
      graders: [{ id: "v", type: "reference", mode: "equals", expected: "expected.x" }],
    };
    const res = await h.post("/api/evals/validate", { project_root: h.root, definition: stage });
    expect(res.body.derived_yaml).toBe(
      [
        "version: 1",
        "id: stage-made",
        "target:",
        "  kind: stage",
        "  pipeline: ../pipelines/feature-ship.pipeline.yaml",
        "  stage: review",
        "dataset: ../datasets/review.dataset.jsonl",
        "task:",
        "  goal: Review.",
        "defaults:",
        "  repeats: 3",
        "  judge: anthropic/claude-sonnet-4-5",
        "  pass_threshold: 0.8",
        "  max_cost_usd: 2",
        "graders:",
        "  - id: v",
        "    type: reference",
        "    mode: equals",
        "    expected: expected.x",
        "",
      ].join("\n"),
    );
  });
});

describe("agent eval routes: try and estimate", () => {
  it("tries one inline scenario: conversation output, no stage run, no session left behind", async () => {
    const h = await setup();
    const res = await h.post("/api/evals/try", {
      project_root: h.root,
      eval_id: "script-basics",
      case: { input: { mode: "script", script: ["Where is INV-9?"] }, expected: { tools: ["billing.lookup_invoice"] } },
    });
    expect(res.status).toBe(200);
    expect(res.body.stage_run_id).toBeNull();
    expect(res.body.result.stage_run_id).toBeNull();
    expect(res.body.result.subject_ref).toBeNull();
    expect(res.body.result.output.kind).toBe("conversation");
    expect(res.body.result.output.tool_calls.map((c: any) => [c.name, c.policy_outcome])).toEqual([
      ["billing.lookup_invoice", "ran"],
      ["billing.refund", "would_ask_first"],
    ]);
    expect(res.body.result.grades.map((g: any) => [g.grader_id, g.passed])).toEqual([
      ["looks-up-the-invoice", false],
      ["short-chat", true],
    ]);
    expect(res.body.cost_usd).toBeGreaterThan(0);
    expect((await h.service.listAllSessions(h.root, { limit: 50, includeEval: true })).sessions).toHaveLength(0);
    expect(h.backend.released.length).toBeGreaterThan(0);
  });

  it("tries a draft definition with a case id and a dataset override", async () => {
    const h = await setup();
    const res = await h.post("/api/evals/try", {
      project_root: h.root,
      definition: {
        version: 1,
        id: "draft",
        target: { kind: "agent", agent: "support" },
        dataset: "../datasets/script-scenarios.dataset.jsonl",
        conversation: { mode: "script", max_turns: 2, read_only_tools: ["billing.lookup_invoice"] },
        graders: [{ id: "chat", type: "conversation_check", max_turns: 2 }],
      },
      case_id: "t2",
    });
    expect(res.status).toBe(200);
    expect(res.body.result.case_id).toBe("t2");
    expect(res.body.result.passed).toBe(true);
  });

  it("answers 422 EVAL_REAL_TOOLS_NOT_CONFIRMED for a real-tools try without the flag", async () => {
    const h = await setup({
      extraFiles: { "evals/real-ok.eval.yaml": realEvalYaml("real-ok", "  mode: script\n  tools: real\n  allow_real_tools: true\n") },
    });
    const body = { project_root: h.root, eval_id: "real-ok", case_id: "t2" };
    const refused = await h.post("/api/evals/try", body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("EVAL_REAL_TOOLS_NOT_CONFIRMED");
    const allowed = await h.post("/api/evals/try", { ...body, allow_real_tools: true });
    expect(allowed.status).toBe(200);
    expect((await h.post("/api/evals/try", { ...body, allow_real_tools: "yes" })).status).toBe(400);
  });

  it("estimates an agent eval from assumptions with prices, then from the previous run", async () => {
    const h = await setup();
    const first = await h.get(`/api/evals/script-basics/runs/estimate?${h.q}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      target_kind: "agent",
      results_total: 4,
      stage_calls: 4,
      simulator_calls: 0,
      judge_calls: 0,
      estimate_basis: "assumptions",
      based_on_run_number: null,
    });
    expect(first.body.estimate_usd).toBeGreaterThan(0);

    const simulated = await h.get(`/api/evals/support-basics/runs/estimate?${h.q}&user_model=anthropic%2Fclaude-sonnet-4-5`);
    expect(simulated.status).toBe(200);
    expect(simulated.body.simulator_calls).toBeGreaterThan(0);
    expect(simulated.body.judge_calls).toBeGreaterThan(0);
    expect(simulated.body.judge_included).toBe(true);

    await h.run("script-basics");
    const second = await h.get(`/api/evals/script-basics/runs/estimate?${h.q}`);
    expect(second.body).toMatchObject({ estimate_basis: "previous_run", based_on_run_number: 1 });
  });

  it("estimates a draft and gives an unknown-price estimate of null", async () => {
    const h = await setup({ prices: new Map() });
    const res = await h.post("/api/evals/runs/estimate", {
      project_root: h.root,
      definition: {
        version: 1,
        id: "d",
        target: { kind: "agent", agent: "support" },
        dataset: "../datasets/script-scenarios.dataset.jsonl",
        conversation: { mode: "script" },
        graders: [{ id: "chat", type: "conversation_check", max_turns: 2 }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ target_kind: "agent", estimate_usd: null, estimate_basis: null });
  });

  it("leaves the stage estimate shape untouched", async () => {
    const h = await setup();
    const res = await h.get(`/api/evals/review/runs/estimate?${h.q}`);
    expect(Object.keys(res.body).sort()).toEqual(
      ["based_on_run_number", "estimate_seconds", "estimate_usd", "judge_calls", "judge_included", "results_total", "stage_calls"].sort(),
    );
  });
});
