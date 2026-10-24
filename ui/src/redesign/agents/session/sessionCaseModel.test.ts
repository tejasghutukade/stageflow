import { describe, expect, it } from "vitest";
import type { AgentSessionDetail } from "../../../api/agents";
import type { EvalDatasetListItem } from "../../../api/evalTypes";
import {
  addAsCaseDisabledReason,
  canOfferAddAsCase,
  datasetChoices,
  datasetNameError,
  defaultDatasetName,
  scenarioFromSession,
  scenarioSummary,
  toolNames,
} from "./sessionCaseModel";

function detail(over: { source?: string; status?: string; title?: string | null; messages?: Array<[string, string]>; tools?: string[]; turnStatus?: string } = {}): AgentSessionDetail {
  return {
    session: { id: "ses_abcdef123456", agentId: "support", source: over.source ?? "console", status: over.status ?? "open", title: over.title === undefined ? "Refund help" : over.title },
    messages: (over.messages ?? [["user", "hi"], ["assistant", "hello"], ["user", "refund?"]]).map(([role, text], i) => ({ id: `m${i}`, role, text, seq: i })),
    turns: [{ id: "t1", status: over.turnStatus ?? "succeeded" }],
    spans: (over.tools ?? ["read_file", "read_file", "search"]).map((name, i) => ({ id: `s${i}`, kind: "tool", attributes: { "gen_ai.tool.name": name } })),
  } as unknown as AgentSessionDetail;
}

describe("scenarioFromSession", () => {
  it("builds a script scenario from user messages, tool names, tag and title", () => {
    const s = scenarioFromSession(detail())!;
    expect(s.input).toEqual({ mode: "script", script: ["hi", "refund?"], opening: "hi" });
    expect(s.expected).toEqual({ tools: ["read_file", "search"] });
    expect(s.tags).toEqual(["from-session"]);
    expect(s.title).toBe("Refund help");
    expect(s.metadata).toEqual({ source_session: "ses_abcdef123456" });
    expect(s.id).toBe("session-abcdef12");
  });

  it("falls back to a short-id title and ignores blank messages", () => {
    const s = scenarioFromSession(detail({ title: null, messages: [["user", "  "], ["user", "go"]] }))!;
    expect(s.title).toBe("Session abcdef12");
    expect((s.input as { script: string[] }).script).toEqual(["go"]);
  });

  it("returns null for a session without user messages", () => {
    expect(scenarioFromSession(detail({ messages: [["assistant", "hello"]] }))).toBeNull();
  });

  it("no tool spans -> empty expected tools", () => {
    expect(toolNames(detail({ tools: [] }))).toEqual([]);
  });
});

describe("entry rules", () => {
  it("is not offered for eval sessions", () => {
    expect(canOfferAddAsCase(detail({ source: "eval" }))).toBe(false);
    expect(canOfferAddAsCase(detail())).toBe(true);
    expect(canOfferAddAsCase(null)).toBe(false);
  });
  it("is disabled with a reason while running, waiting or empty", () => {
    expect(addAsCaseDisabledReason(detail({ status: "running" }))).toBe("Wait for the session to finish");
    expect(addAsCaseDisabledReason(detail({ turnStatus: "waiting" }))).toBe("Wait for the session to finish");
    expect(addAsCaseDisabledReason(detail({ messages: [] }))).toBe("This session has no messages");
    expect(addAsCaseDisabledReason(detail())).toBeNull();
  });
});

describe("datasets", () => {
  const ds = (id: string, extra: Partial<EvalDatasetListItem> = {}) =>
    ({ id, path: `${id}.jsonl`, format: "jsonl", cases: 1, hash: `h-${id}`, editable: true, used_by: [], findings_count: 0, ...extra }) as EvalDatasetListItem;

  it("lists editable datasets, the agent's first", () => {
    const out = datasetChoices([ds("a"), ds("b", { used_by: ["support"] }), ds("c", { editable: false })], ["support"]);
    expect(out.map((d) => d.id)).toEqual(["b", "a"]);
    expect(out[0]!.hash).toBe("h-b");
    expect(out[0]!.forAgent).toBe(true);
  });
  it("derives a unique default name and validates names", () => {
    expect(defaultDatasetName("Support", ["support-scenarios"])).toBe("support-scenarios-2");
    expect(datasetNameError("ok-name", [])).toBeNull();
    expect(datasetNameError("bad name", [])).not.toBeNull();
    expect(datasetNameError("x", ["x"])).toBe("A dataset with this name exists");
  });
  it("summarizes a scenario", () => {
    expect(scenarioSummary(scenarioFromSession(detail())!)).toBe("2 messages · 2 expected tools");
  });
});
