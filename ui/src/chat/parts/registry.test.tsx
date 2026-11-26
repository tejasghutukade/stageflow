import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { registerBuiltinUiParts } from "./builtins";
import { renderUiPart } from "./registry";

describe("ui part registry", () => {
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