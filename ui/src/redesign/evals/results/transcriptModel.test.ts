import { describe, expect, it } from "vitest";
import { fixtureResult } from "./fixtures";
import {
  asSubject,
  chipView,
  errorLabel,
  expectedChecklist,
  headerChips,
  isAgentResult,
  outcomeBadge,
  sessionLink,
  splitTruncation,
  stopReasonLabel,
  transcriptView,
  truncationNotes,
  turnViews,
  type ConversationSubject,
} from "./transcriptModel";

const subject: ConversationSubject = {
  kind: "conversation",
  status: "success",
  summary: "2 turns, 2 tool calls, ended resolved",
  messages: [
    { role: "user", text: "I was charged twice.", turn: 1 },
    { role: "assistant", text: "Let me look up the invoice.", turn: 1 },
    { role: "user", text: "INV-2093", turn: 2 },
    { role: "assistant", text: "I escalated this.…[truncated 120 chars]", turn: 2 },
  ],
  tool_calls: [
    { id: "call_1", turn: 2, name: "billing.lookup_invoice", args: { invoice_id: "INV-2093" }, result_summary: '{"status":"duplicate"}', status: "ok", policy_outcome: "mocked" },
    { id: "call_2", turn: 2, name: "billing.refund", args: { invoice_id: "INV-2093" }, result_summary: "billing.refund was not executed in this evaluation.", status: "not_run", policy_outcome: "stubbed" },
  ],
  final_reply: "I escalated this.",
  turns: 2,
  stop_reason: "resolved",
  truncated: { messages: 3, tool_results: 1 },
};

describe("stop reasons and badges", () => {
  it("uses the contract's labels", () => {
    expect(["resolved", "abandoned", "max_turns", "script_end", "no_progress", "empty_message", "error", "timeout"].map(stopReasonLabel)).toEqual([
      "Resolved",
      "Gave up",
      "Turn limit",
      "Script ended",
      "Repeated itself",
      "Empty message",
      "Agent failed",
      "Timed out",
    ]);
    expect(stopReasonLabel("")).toBe("Ended");
    expect(stopReasonLabel("novel")).toBe("novel");
  });

  it("names the five outcomes with their colours and tooltips", () => {
    expect(outcomeBadge("ran")).toMatchObject({ label: "Ran", tone: "ok" });
    expect(outcomeBadge("stubbed")).toMatchObject({ label: "Stubbed", tone: "neutral", tooltip: "Not executed in this evaluation" });
    expect(outcomeBadge("mocked")).toMatchObject({ label: "Mocked", tone: "running", tooltip: "Canned result from the scenario" });
    expect(outcomeBadge("would_ask_first")).toMatchObject({ label: "Would ask first", tone: "needs", tooltip: "The agent needed approval; it was recorded and denied" });
    expect(outcomeBadge("denied")).toMatchObject({ label: "Denied", tone: "fail", tooltip: "Not allowed by the agent's grants or the eval policy" });
    expect(outcomeBadge("new_one")).toMatchObject({ label: "new_one", tone: "neutral" });
  });
});

describe("reading the subject", () => {
  it("accepts the stored conversation and nothing else", () => {
    expect(asSubject(subject)?.turns).toBe(2);
    expect(asSubject(null)).toBeNull();
    expect(asSubject("text")).toBeNull();
    expect(asSubject({ status: "success", summary: "x", payload: {} })).toBeNull();
    expect(asSubject({ messages: [] })).toMatchObject({ kind: "conversation", turns: 0, tool_calls: [] });
  });

  it("tells agent results from stage results", () => {
    expect(isAgentResult(fixtureResult())).toBe(false);
    expect(isAgentResult(fixtureResult({ agent: { id: "support", session_id: "s1" } }))).toBe(true);
    expect(isAgentResult(fixtureResult({ output: subject }))).toBe(true);
  });
});

describe("turns", () => {
  it("groups messages and tool calls by turn", () => {
    const turns = turnViews(subject);
    expect(turns.map((t) => [t.turn, t.bubbles.length, t.chips.length])).toEqual([
      [1, 2, 0],
      [2, 2, 2],
    ]);
    expect(turns[1]?.bubbles[1]).toEqual({ role: "assistant", text: "I escalated this.", note: "…[truncated 120 chars]" });
  });

  it("turns tool calls into chips with args and result", () => {
    const chip = chipView(subject.tool_calls[0]!);
    expect(chip).toMatchObject({ name: "billing.lookup_invoice", statusText: "ok", resultText: '{"status":"duplicate"}' });
    expect(chip.badge.label).toBe("Mocked");
    expect(JSON.parse(chip.argsText)).toEqual({ invoice_id: "INV-2093" });
    expect(chipView(subject.tool_calls[1]!)).toMatchObject({ statusText: "not run", badge: { label: "Stubbed" } });
    expect(chipView({ ...subject.tool_calls[0]!, result_summary: "" }).resultText).toBe("(no result)");
    expect(chipView({ ...subject.tool_calls[0]!, result_summary: "abc…[truncated 9 chars]" })).toMatchObject({ resultText: "abc", resultNote: "…[truncated 9 chars]" });
    expect(chipView({ ...subject.tool_calls[0]!, session_id: "child" }).subSession).toBe("child");
  });

  it("splits the truncation marker from the text", () => {
    expect(splitTruncation("ends here…[truncated 40 chars]")).toEqual({ body: "ends here", note: "…[truncated 40 chars]" });
    expect(splitTruncation("plain")).toEqual({ body: "plain", note: null });
  });

  it("explains what was cut", () => {
    expect(truncationNotes(subject)).toEqual(["3 messages left out of the middle of the conversation", "1 tool result shortened"]);
    expect(truncationNotes({ ...subject, truncated: undefined })).toEqual([]);
    expect(truncationNotes({ ...subject, truncated: { tool_calls_dropped: 1, tool_args: 2 } })).toEqual(["1 tool call not shown", "2 sets of arguments shortened"]);
  });
});

describe("header chips", () => {
  it("shows stop reason, turns, tool calls, time and cost", () => {
    expect(headerChips({ latency_ms: 12400, cost_usd: 0.041 }, subject)).toEqual({ stop: "Resolved", turns: "2 turns", calls: "2 tool calls", time: "12.4 s", cost: "$0.04" });
    expect(headerChips({ latency_ms: null, cost_usd: null }, { ...subject, turns: 1, tool_calls: [subject.tool_calls[0]!] })).toMatchObject({ turns: "1 turn", calls: "1 tool call", time: "—", cost: "—" });
  });
});

describe("expected tools checklist", () => {
  it("marks expected tools found or missing and forbidden tools called or clean", () => {
    const rows = expectedChecklist({ tools: ["billing.lookup_invoice", "orders.get"], forbidden_tools: ["billing.refund", "bash"] }, subject);
    expect(rows).toEqual([
      { text: "billing.lookup_invoice", kind: "expected", ok: true, note: "called" },
      { text: "orders.get", kind: "expected", ok: false, note: "not called" },
      { text: "billing.refund", kind: "forbidden", ok: false, note: "called" },
      { text: "bash", kind: "forbidden", ok: true, note: "not called" },
    ]);
  });

  it("matches a server prefix and counts a stubbed call as called", () => {
    expect(expectedChecklist({ tools: ["billing.*"] }, subject)).toEqual([{ text: "billing.*", kind: "expected", ok: true, note: "called" }]);
  });

  it("shows nothing when the scenario expects no tools", () => {
    expect(expectedChecklist(undefined, subject)).toBeNull();
    expect(expectedChecklist({ outcome: "x" }, subject)).toBeNull();
    expect(expectedChecklist("text", subject)).toBeNull();
  });
});

describe("failed results and links", () => {
  it("keeps the partial transcript of a failed result", () => {
    const failed = fixtureResult({ status: "stage_failed", error_code: "EVAL_AGENT_FAILED", output: { ...subject, status: "failure", stop_reason: "error" } });
    const view = transcriptView(failed);
    expect(view?.failed).toBe(true);
    expect(view?.chips.stop).toBe("Agent failed");
    expect(view?.turns).toHaveLength(2);
    expect(transcriptView(fixtureResult({ output: null }))).toBeNull();
  });

  it("labels the agent error codes", () => {
    expect(errorLabel("EVAL_AGENT_FAILED")).toBe("Agent failed");
    expect(errorLabel("EVAL_AGENT_TIMEOUT")).toBe("Timed out");
    expect(errorLabel("EVAL_SIMULATOR_ERROR")).toBe("Simulator error");
    expect(errorLabel("EVAL_SOMETHING")).toBeNull();
    expect(errorLabel(null)).toBeNull();
  });

  it("links to the agent session by id", () => {
    expect(sessionLink({ agent: { id: "support", session_id: "s1" }, subject_ref: "s1" })).toEqual({ agentId: "support", sessionId: "s1" });
    expect(sessionLink({ agent: { id: "support", session_id: null }, subject_ref: "s2" })).toEqual({ agentId: "support", sessionId: "s2" });
    expect(sessionLink({ agent: null, subject_ref: "s1" })).toBeNull();
    expect(sessionLink({ agent: { id: "support", session_id: null }, subject_ref: null })).toBeNull();
  });
});
