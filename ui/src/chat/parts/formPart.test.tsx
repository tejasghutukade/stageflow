// @vitest-environment happy-dom
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { UI_PART_KIND_FORM, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { registerBuiltinUiParts } from "./builtins";
import { renderPartMarkup } from "./renderPartMarkup";
import { renderUiPart } from "./registry";

vi.mock("./chatActions", () => ({
  postChatAction: vi.fn(async () => ({})),
}));

const part = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_FORM,
  id: "details",
  title: "Project details",
  fields: [
    { id: "name", label: "Name", type: "string", required: true },
    { id: "tier", label: "Tier", type: "select", required: true, options: [{ value: "free", label: "Free" }] },
  ],
  submit: { template: "Project {{name}} on {{tier}}" },
  fallback: { text: "Open in console", url: "https://example.com" },
};

describe("form ui part renderer", () => {
  it("renders fields and a submit control in operator chat", () => {
    registerBuiltinUiParts();
    const html = renderPartMarkup(
      createElement("div", null, renderUiPart(part, { chat: { agentId: "helper", sessionId: "sess" } })),
    );
    expect(html).toContain("Project details");
    expect(html).toContain("Name");
    expect(html).toContain("Submit");
  });

  it("shows fallback copy without an operator session", () => {
    registerBuiltinUiParts();
    const html = renderPartMarkup(createElement("div", null, renderUiPart(part)));
    expect(html).toContain("Open in console");
  });
});