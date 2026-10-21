import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../api";
import { agentApprovalKey, approvalPreview, mergeNeedsQueue, type AgentApprovalItem } from "./needsQueue";

function run(id: string, at: string): RunSummary {
  return { run_id: id, created_at: at, updated_at: at } as RunSummary;
}

function approval(id: string, at: string): AgentApprovalItem {
  return {
    id,
    sessionId: "ses_1",
    turnId: null,
    tool: "bash",
    payload: { command: "ls" },
    payloadHash: "h",
    status: "pending",
    createdAt: at,
    expiresAt: at,
    decidedAt: null,
    actor: null,
    agentId: "helper",
  };
}

describe("needs queue", () => {
  it("orders gates and agent approvals by how long they have waited", () => {
    const items = mergeNeedsQueue(
      [run("r2", "2026-10-16T10:30:00Z"), run("r1", "2026-10-16T09:00:00Z")],
      [approval("a1", "2026-10-16T10:00:00Z")],
    );
    expect(items.map((item) => item.key)).toEqual(["r1", agentApprovalKey("a1"), "r2"]);
    expect(items.map((item) => item.kind)).toEqual(["run", "agent", "run"]);
  });

  it("puts a gate before an approval that started waiting at the same moment", () => {
    const items = mergeNeedsQueue([run("r1", "2026-10-16T10:00:00Z")], [approval("a1", "2026-10-16T10:00:00Z")]);
    expect(items.map((item) => item.kind)).toEqual(["run", "agent"]);
  });

  it("is empty when nothing waits", () => {
    expect(mergeNeedsQueue([], [])).toEqual([]);
  });

  it("previews the payload and cuts long ones", () => {
    expect(approvalPreview({ command: "ls" })).toBe('{"command":"ls"}');
    expect(approvalPreview({})).toBe("");
    expect(approvalPreview({ text: "x".repeat(300) }, 20)).toHaveLength(20);
  });
});
