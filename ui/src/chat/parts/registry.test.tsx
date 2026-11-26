// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/agents", () => ({
  AgentApiError: class AgentApiError extends Error {},
  agentsApi: {
    session: vi.fn(async () => ({ approvals: [], messages: [], turns: [], spans: [], pendingApproval: null, evalScores: [], deliveries: [], session: { id: "s", agentId: "a", revision: 1, backend: "pi", status: "open", source: "console", sourceRef: null, threadKey: null, title: null, createdAt: "", updatedAt: "" } })),
    decide: vi.fn(),
  },
}));
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_KIND_APPROVAL, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { registerBuiltinUiParts } from "./builtins";
import { renderPartMarkup } from "./renderPartMarkup";
import { renderUiPart } from "./registry";

describe("ui part registry", () => {
  it("registers the approval renderer", () => {
    registerBuiltinUiParts();
    const html = renderPartMarkup(
      createElement("div", null, renderUiPart({
        v: UI_PART_SCHEMA_VERSION,
        kind: UI_PART_KIND_APPROVAL,
        approvalId: "ap",
        title: "Approve",
        tool: "bash",
        summary: "Run a script.",
        fallback: { text: "Open", url: "https://example.com" },
      })),
    );
    expect(html).toContain("Approve");
  });

  it("falls back to open-in-console for unknown kinds", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, renderUiPart({ kind: "future-form", title: "Approve", fallback: { text: "Open", url: "/#/artifacts" } })),
    );
    expect(html).toContain("Open in console");
    expect(html).toContain("Approve");
  });

  it("renders a hand-written artifact-ref ui part", () => {
    registerBuiltinUiParts();
    const part = {
      v: UI_PART_SCHEMA_VERSION,
      kind: UI_PART_KIND_ARTIFACT_REF,
      key: "stage:sales:summarize/weekly",
      title: "Weekly revenue",
      fallback: { text: "View in Artifacts", url: "https://example.com/#/artifacts/x" },
    };
    const html = renderToStaticMarkup(createElement("div", null, renderUiPart(part)));
    expect(html).toContain("Weekly revenue");
    expect(html).toContain("View in Artifacts");
    expect(html).toContain("Loading artifact…");
  });
});