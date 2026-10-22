import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { agentEvalHarness, realEvalYaml, type AgentEvalHarness } from "./helpers/agentEvalHarness.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";

const open: AgentEvalHarness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup(opts: Parameters<typeof agentEvalHarness>[0] = {}): Promise<AgentEvalHarness> {
  const h = await agentEvalHarness(opts);
  open.push(h);
  return h;
}

const REAL = realEvalYaml("real-ok", "  mode: script\n  tools: real\n  allow_real_tools: true\n  approvals: deny\n");
const REAL_NO_CONSENT = realEvalYaml("real-bare", "  mode: script\n  tools: real\n");
const MOCKED = realEvalYaml("mocked-deny", "  mode: script\n  tools: mocked\n  approvals: deny\n");

describe("agent eval routes: a full run over HTTP", () => {
  it("starts, reads, lists, exports, finds by session and deletes an agent eval run", async () => {
    const h = await setup();
    const id = await h.run("script-basics", { label: "first" });

    const detail = await h.get(`/api/eval-runs/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("completed");
    expect(detail.body.config.target).toMatchObject({ agent_id: "support", model: "anthropic/claude-haiku-4-5" });
    expect(detail.body.config.settings.conversation).toMatchObject({ mode: "script", tools: "read_only", real_tools_confirmed: false });
    expect(detail.body.components).toHaveProperty("agent");
    expect(detail.body.stats.mean_turns).toBeGreaterThan(0);
    expect(detail.body.stats.mean_tool_calls).toBeGreaterThan(0);
    expect(detail.body.current).toMatchObject({ agent_revision: detail.body.config.target.revision });
    expect(detail.body.current.agent_definition_hash).toBe(detail.body.config.target.definition_hash);

    const rows = await h.get(`/api/eval-runs/${id}/results`);
    expect(rows.body.items).toHaveLength(2);
    expect(rows.body.items[0]).toHaveProperty("turns");
    expect(rows.body.items[0]).toHaveProperty("tool_calls");
    expect(rows.body.items[0].turns).toBeGreaterThan(0);

    const result = await h.get(`/api/eval-runs/${id}/results/t1`);
    const repeat = result.body.repeats[0];
    expect(repeat.stage_run_id).toBeNull();
    expect(repeat.output.kind).toBe("conversation");
    expect(repeat.agent).toEqual({ id: "support", session_id: repeat.subject_ref });
    expect(repeat.subject_ref).toMatch(/^ses_/);
    expect(repeat.turns).toBe(2);
    expect(repeat.tool_call_count).toBeGreaterThan(0);

    const byRef = await h.get(`/api/eval-runs?subject_ref=${repeat.subject_ref}`);
    expect(byRef.body.items).toHaveLength(1);
    expect(byRef.body.items[0]).toMatchObject({ eval_run_id: id, eval_id: "script-basics", run_number: 1 });
    expect(byRef.body.items[0].result.case_id).toBe("t1");
    expect((await h.get("/api/eval-runs?subject_ref=ses_nothing")).body.items).toEqual([]);

    const exported = await h.call("GET", `/api/eval-runs/${id}/export?what=results`);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('"kind":"conversation"');

    const refs = await h.store.listEvalSubjectRefs(id, "agent");
    expect(refs).toHaveLength(4);
    await expect(h.service.getSession(h.root, refs[0]!)).resolves.toBeDefined();
    const deleted = await h.call("DELETE", `/api/eval-runs/${id}`);
    expect(deleted.status).toBe(204);
    for (const ref of refs) await expect(h.service.getSession(h.root, ref)).rejects.toMatchObject({ code: "agent.session_not_found" });
    expect((await h.get(`/api/eval-runs/${id}`)).status).toBe(404);
  });

  it("compares two agent runs and reports the agent diff; refuses a stage and an agent run", async () => {
    const h = await setup();
    const a = await h.run("script-basics");
    const file = path.join(h.root, "agents", "support.agent.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("Help customers with billing questions.", "Be brief."));
    await h.service.list(h.root);
    const b = await h.run("script-basics");
    const compare = await h.get(`/api/eval-compare?a=${a}&b=${b}`);
    expect(compare.status).toBe(200);
    expect(compare.body.stage_diff).toBeNull();
    expect(compare.body.agent_diff.changed_keys).toContain("instructions");
    expect(compare.body.agent_diff.revision.a).toBeLessThan(compare.body.agent_diff.revision.b);
    expect(compare.body.deltas).toHaveProperty("mean_turns");
    expect(compare.body.same_config).toBe(false);

    const other = await h.run("support-basics", { user_model: "anthropic/claude-sonnet-4-5" });
    const mismatch = await h.get(`/api/eval-compare?a=${a}&b=${other}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("EVAL_COMPARE_MISMATCH");
  });

  it("records run overrides in the snapshot: model, user model, repeats and safer policies", async () => {
    const h = await setup();
    const id = await h.run("support-basics", {
      model: "anthropic/claude-sonnet-4-5",
      user_model: "anthropic/claude-haiku-4-5",
      tools: "mocked",
      approvals: "deny",
      repeats: 1,
    });
    const detail = (await h.get(`/api/eval-runs/${id}`)).body;
    expect(detail.config.target.model).toBe("anthropic/claude-sonnet-4-5");
    expect(detail.config.overrides).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      user_model: "anthropic/claude-haiku-4-5",
      tools: "mocked",
      approvals: "deny",
      repeats: 1,
    });
    expect(detail.config.settings.conversation).toMatchObject({
      tools: "mocked",
      approvals: "deny",
      user_model: "anthropic/claude-haiku-4-5",
    });
    expect(detail.config.eval.definition.conversation.tools).toBe("read_only");
  });

  it("leaves stage run responses without agent keys", async () => {
    const h = await setup();
    const list = await h.get("/api/eval-runs");
    expect(list.status).toBe(200);
    const est = await h.get(`/api/evals/review/runs/estimate?${h.q}`);
    expect(est.body).not.toHaveProperty("target_kind");
  });
});

describe("agent eval routes: tool safety", () => {
  it("needs both the file consent and the run flag for real tools", async () => {
    const h = await setup({ extraFiles: { "evals/real-ok.eval.yaml": REAL, "evals/real-bare.eval.yaml": REAL_NO_CONSENT } });

    const bare = await h.post("/api/evals/real-bare/runs", { project_root: h.root, allow_real_tools: true });
    expect(bare.status).toBe(422);
    expect(bare.body.code).toBe("EVAL_INVALID");
    expect(bare.body.findings.map((f: any) => f.code)).toContain("eval.real_tools_not_allowed");

    const refused = await h.post("/api/evals/real-ok/runs", { project_root: h.root });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("EVAL_REAL_TOOLS_NOT_CONFIRMED");
    expect(await h.store.listEvalRuns({ evalId: "real-ok", limit: 5 })).toMatchObject({ items: [] });

    const falseFlag = await h.post("/api/evals/real-ok/runs", { project_root: h.root, allow_real_tools: false });
    expect(falseFlag.body.code).toBe("EVAL_REAL_TOOLS_NOT_CONFIRMED");
    expect((await h.post("/api/evals/real-ok/runs", { project_root: h.root, allow_real_tools: "true" })).status).toBe(400);

    const id = await h.run("real-ok", { allow_real_tools: true });
    const detail = (await h.get(`/api/eval-runs/${id}`)).body;
    expect(detail.config.settings.conversation).toMatchObject({ tools: "real", real_tools_confirmed: true });

    const safer = await h.run("real-ok", { tools: "read_only" });
    const saferDetail = (await h.get(`/api/eval-runs/${safer}`)).body;
    expect(saferDetail.config.settings.conversation).toMatchObject({ tools: "read_only", real_tools_confirmed: false });
  });

  it("checks consent before the engine and ignores the flag for other policies", async () => {
    const h = await setup({ extraFiles: { "evals/real-ok.eval.yaml": REAL } });
    h.engine.installed = false;
    const unavailable = await h.post("/api/evals/real-ok/runs", { project_root: h.root });
    expect(unavailable.body.code).toBe("EVAL_REAL_TOOLS_NOT_CONFIRMED");
    const engineDown = await h.post("/api/evals/real-ok/runs", { project_root: h.root, allow_real_tools: true });
    expect(engineDown.status).toBe(503);
    h.engine.installed = true;
    const harmless = await h.run("script-basics", { allow_real_tools: true });
    const detail = (await h.get(`/api/eval-runs/${harmless}`)).body;
    expect(detail.config.settings.conversation.real_tools_confirmed).toBe(false);
  });

  it("rejects overrides that make the policy riskier", async () => {
    const h = await setup({ extraFiles: { "evals/mocked-deny.eval.yaml": MOCKED } });
    const tools = await h.post("/api/evals/mocked-deny/runs", { project_root: h.root, tools: "read_only" });
    expect(tools.status).toBe(422);
    expect(tools.body.code).toBe("EVAL_INVALID");
    expect(tools.body.findings.map((f: any) => f.message).join(" ")).toMatch(/less safe/);
    const approvals = await h.post("/api/evals/mocked-deny/runs", { project_root: h.root, approvals: "record_only" });
    expect(approvals.status).toBe(422);
    expect(approvals.body.code).toBe("EVAL_INVALID");
    const bad = await h.post("/api/evals/script-basics/runs", { project_root: h.root, tools: "real" });
    expect(bad.status).toBe(422);
    const badApprovals = await h.post("/api/evals/script-basics/runs", { project_root: h.root, approvals: "auto_approve_read" });
    expect(badApprovals.status).toBe(422);
    expect((await h.post("/api/evals/script-basics/runs", { project_root: h.root, tools: 3 })).status).toBe(400);
    expect(await h.store.listEvalRuns({ evalId: "mocked-deny", limit: 5 })).toMatchObject({ items: [] });
  });

  it("rejects agent-only overrides on a stage eval", async () => {
    const h = await setup();
    for (const body of [{ user_model: "a/b" }, { tools: "mocked" }, { approvals: "deny" }]) {
      const res = await h.post("/api/evals/review/runs", { project_root: h.root, ...body });
      expect(res.status).toBe(422);
      expect(res.body.findings.map((f: any) => f.code)).toContain("eval.conversation_not_applicable");
    }
  });
});

describe("agent eval routes: failures leak nothing", () => {
  it("answers an unreadable agent and a failing model with codes only", async () => {
    const h = await setup({
      script: [
        { error: new Error("401 invalid x-api-key sk-ant-SECRET-KEY at https://api.example.com/v1/messages?key=abc") },
        { error: new Error("401 invalid x-api-key sk-ant-SECRET-KEY at https://api.example.com/v1/messages?key=abc") },
        { error: new Error("401 invalid x-api-key sk-ant-SECRET-KEY at https://api.example.com/v1/messages?key=abc") },
        { error: new Error("401 invalid x-api-key sk-ant-SECRET-KEY at https://api.example.com/v1/messages?key=abc") },
      ],
    });
    const id = await h.run("script-basics", { repeats: 1 });
    const texts = [
      (await h.get(`/api/eval-runs/${id}`)).text,
      (await h.get(`/api/eval-runs/${id}/results`)).text,
      (await h.get(`/api/eval-runs/${id}/results/t1`)).text,
      (await h.call("GET", `/api/eval-runs/${id}/export?what=results`)).text,
    ];
    for (const text of texts) {
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("api.example.com");
      expect(text).not.toContain("Error:");
    }
    const failed = (await h.get(`/api/eval-runs/${id}/results/t1`)).body.repeats[0];
    expect(failed.status).toBe("stage_failed");
    expect(failed.error_code).toMatch(/^EVAL_AGENT/);

    const tried = await h.post("/api/evals/try", { project_root: h.root, eval_id: "script-basics", case_id: "t1" });
    expect(tried.text).not.toContain("SECRET");
    expect(tried.text).not.toContain("api.example.com");

    const missing = await h.post("/api/evals/ghost/runs", { project_root: h.root });
    expect(missing.status).toBe(404);
    expect(missing.text).not.toMatch(/\bat \S+\.ts/);
  });
});

describe("agent eval routes: datasets", () => {
  it("fills scenario input fields and checks cases for an agent eval", async () => {
    const h = await setup();
    const res = await h.get(`/api/datasets/script-scenarios?${h.q}&eval_id=script-basics`);
    expect(res.status).toBe(200);
    expect(res.body.input_fields).toEqual([
      { name: "mode", required: false },
      { name: "opening", required: false },
      { name: "persona", required: false },
      { name: "goal", required: false },
      { name: "facts", required: false },
      { name: "script", required: true },
      { name: "tool_mocks", required: false },
    ]);
    expect(res.body.cases.every((c: any) => c.input_check.valid)).toBe(true);
    const simulated = await h.get(`/api/datasets/support-scenarios?${h.q}&eval_id=support-basics`);
    expect(simulated.body.input_fields.find((f: any) => f.name === "goal")).toEqual({ name: "goal", required: true });
    expect(simulated.body.input_fields.find((f: any) => f.name === "script")).toEqual({ name: "script", required: false });
    expect(simulated.body.invalid_total).toBe(0);
  });

  it("previews an upload against the scenario check and refuses script and tool_mocks mappings", async () => {
    const h = await setup();
    const csv = [
      "Opening,Who,Goal,Tags,Needs,Mode",
      "Hi there,Annoyed customer,Get a refund,billing;vip,invoice INV-1|paid,",
      "Hello,,Get help,,,",
      "Script me,,,,,script",
    ].join("\n");
    const mapping = {
      "input.opening": { column: "Opening" },
      "input.persona": { column: "Who" },
      "input.goal": { column: "Goal" },
      "input.facts": { column: "Needs", split: "|" },
      "input.mode": { column: "Mode" },
      title: { column: "Opening" },
      tags: { column: "Tags", split: ";" },
    };
    const res = await h.post("/api/datasets/preview", {
      project_root: h.root,
      format: "csv",
      content: csv,
      mapping,
      target: { agent_id: "support" },
    });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ ready: 1, skipped: 2 });
    expect(res.body.rows[0].case).toMatchObject({
      input: { opening: "Hi there", persona: "Annoyed customer", goal: "Get a refund", facts: ["invoice INV-1", "paid"] },
      title: "Hi there",
      tags: ["billing", "vip"],
    });
    expect(res.body.rows[1].reason).toMatch(/persona/);
    expect(res.body.rows[2].reason).toMatch(/script/);

    const scriptMode = await h.post("/api/datasets/preview", {
      project_root: h.root,
      format: "csv",
      content: "Opening\nHi",
      mapping: { "input.opening": { column: "Opening" } },
      target: { agent_id: "support" },
      eval_id: "script-basics",
    });
    expect(scriptMode.body.counts).toEqual({ ready: 0, skipped: 1 });

    for (const target of ["input.script", "input.tool_mocks"]) {
      const refused = await h.post("/api/datasets/preview", {
        project_root: h.root,
        format: "csv",
        content: "A\nx",
        mapping: { [target]: { column: "A" } },
        target: { agent_id: "support" },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("EVAL_INVALID");
      expect(refused.body.findings.map((f: any) => f.code)).toEqual(["dataset.mapping_unsupported_field"]);
    }

    const jsonl = await h.post("/api/datasets/preview", {
      project_root: h.root,
      format: "jsonl",
      content: `${JSON.stringify({ input: { mode: "script", script: ["hi"] } })}\n${JSON.stringify({ input: { mode: "script" } })}`,
      target: { agent_id: "support" },
      eval_id: "script-basics",
    });
    expect(jsonl.body.counts).toEqual({ ready: 1, skipped: 1 });

    expect((await h.post("/api/datasets/preview", { project_root: h.root, format: "csv", content: "A\nx", target: { agent_id: "Not Valid" } })).status).toBe(422);
    expect((await h.post("/api/datasets/preview", { project_root: h.root, format: "csv", content: "A\nx", target: { agent_id: "ghost" } })).status).toBe(422);
  });

  it("lists finished sessions as candidates and builds script scenarios from them", async () => {
    const h = await setup();
    const chat = new AgentChatController({ service: h.service, backend: scriptedBackend((m) => `echo ${m.length}`) });
    const first = await chat.send({ projectRoot: h.root, agentId: "support", text: "Where is invoice INV-7?" });
    await chat.send({ projectRoot: h.root, agentId: "support", sessionId: first.session.id, text: "Thanks" });
    await h.run("script-basics");

    const candidates = await h.get(`/api/datasets/candidates?${h.q}&agent=support`);
    expect(candidates.status).toBe(200);
    expect(candidates.body.items).toHaveLength(1);
    expect(candidates.body.items[0]).toMatchObject({
      session_id: first.session.id,
      preview: "Where is invoice INV-7?",
      turns: 2,
      tools: [],
    });
    expect((await h.get(`/api/datasets/candidates?${h.q}&agent=ghost`)).status).toBe(404);

    const created = await h.post("/api/datasets", {
      project_root: h.root,
      name: "from-sessions",
      source: "sessions",
      target: { agent_id: "support" },
      session_ids: [first.session.id],
    });
    expect(created.status).toBe(201);
    expect(created.body.cases[0]).toMatchObject({
      input: { mode: "script", script: ["Where is invoice INV-7?", "Thanks"], opening: "Where is invoice INV-7?" },
      expected: { tools: [] },
      tags: ["from-session"],
      metadata: { source_session: first.session.id },
    });
    const refs = await h.store.listEvalSubjectRefs((await h.store.listEvalRuns({ limit: 1 })).items[0]!.evalRunId, "agent");
    const evalSession = refs[0]!;
    const refused = await h.post("/api/datasets", {
      project_root: h.root,
      name: "bad",
      source: "sessions",
      target: { agent_id: "support" },
      session_ids: [evalSession],
    });
    expect(refused.status).toBe(400);
    expect((await h.post("/api/datasets", { project_root: h.root, name: "bad2", source: "sample", target: { agent_id: "support" } })).status).toBe(400);
  });
});

describe("agent eval routes: contract table", () => {
  it("serves every documented route for agents", async () => {
    const h = await setup();
    const id = await h.run("script-basics");
    const table: Array<[string, string, unknown?]> = [
      ["GET", `/api/evals/agent-targets?${h.q}`],
      ["GET", `/api/evals?${h.q}&target_kind=agent&agent=support`],
      ["GET", `/api/evals/script-basics?${h.q}`],
      ["POST", "/api/evals/validate", { project_root: h.root, yaml: "version: 1\n" }],
      ["GET", `/api/evals/script-basics/runs/estimate?${h.q}&user_model=a%2Fb&tools=mocked&approvals=deny`],
      ["GET", `/api/evals/script-basics/runs/1?${h.q}`],
      ["GET", `/api/eval-runs?subject_ref=x`],
      ["GET", `/api/eval-runs/${id}/results`],
      ["GET", `/api/eval-runs/${id}/results/t1`],
      ["GET", `/api/eval-runs/${id}/export`],
      ["GET", `/api/datasets/candidates?${h.q}&agent=support`],
      ["GET", `/api/datasets/script-scenarios?${h.q}&eval_id=script-basics`],
    ];
    for (const [method, url, body] of table) {
      const res = await h.call(method, url, body);
      expect(res.status, `${method} ${url}`).toBeLessThan(400);
    }
  });
});
