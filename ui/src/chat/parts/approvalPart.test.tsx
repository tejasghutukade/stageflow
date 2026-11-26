// @vitest-environment happy-dom
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { UI_PART_KIND_APPROVAL, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { registerBuiltinUiParts } from "./builtins";
import { renderPartMarkup } from "./renderPartMarkup";
import { renderUiPart } from "./registry";

vi.mock("../../api/agents", () => ({
  AgentApiError: class AgentApiError extends Error {},
  agentsApi: {
    session: vi.fn(async () => ({ approvals: [], messages: [], turns: [], spans: [], pendingApproval: null, evalScores: [], deliveries: [], session: { id: "s", agentId: "a", revision: 1, backend: "pi", status: "open", source: "console", sourceRef: null, threadKey: null, title: null, createdAt: "", updatedAt: "" } })),
    decide: vi.fn(),
  },
}));

const part = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_APPROVAL,
  approvalId: "ap_test",
  title: "Approve export",
  tool: "publish_artifact",
  summary: "Publish a CSV export to the artifacts index.",
  risk: "write" as const,
  fallback: { text: "Decide in the console", url: "https://example.com" },
};

describe("approval ui part renderer", () => {
  it("renders a summary and console fallback", () => {
    registerBuiltinUiParts();
    const html = renderPartMarkup(createElement("div", null, renderUiPart(part)));
    expect(html).toContain("Approve export");
    expect(html).toContain("Publish a CSV export");
    expect(html).toContain("Writes data");
    expect(html).toContain("Decide in the console");
  });
});