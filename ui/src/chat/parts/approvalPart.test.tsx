// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { UI_PART_KIND_APPROVAL, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { registerBuiltinUiParts } from "./builtins";
import { agentsApi } from "../../api/agents";
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

  it("fetches the session once for a matching pending approval", async () => {
    registerBuiltinUiParts();
    vi.mocked(agentsApi.session).mockClear();
    vi.mocked(agentsApi.session).mockImplementation(
      async () =>
        ({
          approvals: [{ id: "ap_test", status: "pending", tool: "publish_artifact" }],
          messages: [],
          turns: [],
          spans: [],
          pendingApproval: null,
          evalScores: [],
          deliveries: [],
          session: { id: "s" },
        }) as never,
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement("div", null, renderUiPart(part, { chat: { agentId: "a", sessionId: "s" } })));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(agentsApi.session).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
  });
});
