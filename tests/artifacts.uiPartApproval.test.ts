import { describe, expect, it } from "vitest";
import { parseUiPart, UI_PART_KIND_APPROVAL, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import { approvalChannelFallback, approvalPartHeadline, parseUiPartApproval } from "../src/artifacts/uiPartApproval.js";

const valid = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_APPROVAL,
  approvalId: "ap_01",
  title: "Approval needed",
  tool: "web.fetch",
  summary: "Fetch https://example.com/report and archive the response.",
  risk: "external" as const,
  status: "pending" as const,
  fallback: { text: "Decide in the console", url: "https://example.com/#/agents" },
};

describe("ui part approval schema", () => {
  it("parses a valid approval part", () => {
    expect(parseUiPartApproval(valid)).toEqual({ ok: true, part: valid });
    expect(parseUiPart(valid)).toEqual({ ok: true, part: valid });
  });

  it("rejects an oversized summary", () => {
    const huge = "x".repeat(2_001);
    expect(parseUiPartApproval({ ...valid, summary: huge })).toEqual({ ok: false });
  });

  it("formats a headline and channel fallback", () => {
    expect(approvalPartHeadline(valid as never)).toBe("Approval needed: web.fetch");
    const text = approvalChannelFallback(valid as never, false);
    expect(text).toContain("Fetch https://example.com/report");
    expect(text).toContain("Waiting for a decision");
    expect(text).not.toContain("example.com/#/agents");
  });
});