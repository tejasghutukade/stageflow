import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvalDataset,
  fetchEvalAgentTargets,
  fetchEvalRunEstimate,
  fetchEvalRuns,
  fetchEvalSessionCandidates,
  fetchEvals,
  previewEvalDataset,
  startEvalRun,
  tryEvalCase,
} from "./evalsClient";

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eval api client for agent targets", () => {
  it("reads the agent picker", async () => {
    const calls = stubFetch(200, { items: [] });
    await fetchEvalAgentTargets("/p");
    expect(calls[0]!.url).toBe("/api/evals/agent-targets?project_root=%2Fp");
  });

  it("filters the eval list by target kind and agent", async () => {
    const calls = stubFetch(200, { items: [] });
    await fetchEvals({ target_kind: "agent", agent: "support" });
    expect(calls[0]!.url).toBe("/api/evals?target_kind=agent&agent=support");
  });

  it("sends the agent run overrides and the real-tools consent in the start body", async () => {
    const calls = stubFetch(202, { eval_run_id: "er_1", status: "queued", run_number: 1 });
    await startEvalRun("e1", { user_model: "a/b", tools: "mocked", approvals: "deny", allow_real_tools: true });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      user_model: "a/b",
      tools: "mocked",
      approvals: "deny",
      allow_real_tools: true,
    });
  });

  it("sends agent overrides as estimate query parameters", async () => {
    const calls = stubFetch(200, {});
    await fetchEvalRunEstimate("e1", { user_model: "a/b", tools: "mocked", approvals: "deny" });
    expect(calls[0]!.url).toBe("/api/evals/e1/runs/estimate?user_model=a%2Fb&tools=mocked&approvals=deny");
  });

  it("finds the run that owns a session", async () => {
    const calls = stubFetch(200, { items: [], next_cursor: null });
    await fetchEvalRuns({ subject_ref: "ses_1" });
    expect(calls[0]!.url).toBe("/api/eval-runs?subject_ref=ses_1");
  });

  it("tries an agent case with consent", async () => {
    const calls = stubFetch(200, {});
    await tryEvalCase({ eval_id: "e1", case_id: "c1", allow_real_tools: true });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ eval_id: "e1", case_id: "c1", allow_real_tools: true });
  });

  it("previews uploads for an agent target and builds datasets from sessions", async () => {
    const calls = stubFetch(200, {});
    await previewEvalDataset({ format: "csv", content: "a", target: { agent_id: "support" }, eval_id: "e1" });
    expect(JSON.parse(calls[0]!.init.body as string).target).toEqual({ agent_id: "support" });
    await createEvalDataset({ name: "n", source: "sessions", target: { agent_id: "support" }, session_ids: ["ses_1"] });
    expect(calls[1]!.url).toBe("/api/datasets");
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ source: "sessions", session_ids: ["ses_1"] });
  });

  it("lists session candidates for an agent", async () => {
    const calls = stubFetch(200, { items: [], next_cursor: null });
    await fetchEvalSessionCandidates("support", { limit: 5 });
    expect(calls[0]!.url).toBe("/api/datasets/candidates?agent=support&limit=5");
  });
});
