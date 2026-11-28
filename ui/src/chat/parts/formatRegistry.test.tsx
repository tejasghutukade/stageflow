// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { UI_PART_KIND_CARD, type UiPartCard } from "../../../../src/artifacts/uiPartCard.ts";
import { registerFormatRenderer } from "./formatRegistry";
import { formatRenderer, renderArtifactFormat, renderCardFormat } from "./formats";

function card(format: UiPartCard["format"], program: string): UiPartCard {
  return { v: UI_PART_SCHEMA_VERSION, kind: UI_PART_KIND_CARD, format, title: "T", program } as UiPartCard;
}

describe("format renderer registry", () => {
  it("has card and artifact renderers for every card-capable kind", () => {
    for (const kind of ["live.declarative", "live.html", "static.markdown"]) {
      expect(formatRenderer(kind)?.card).toBeTypeOf("function");
      expect(formatRenderer(kind)?.artifact).toBeTypeOf("function");
    }
  });

  it("renders a markdown card from the registry", () => {
    const html = renderToStaticMarkup(createElement("div", null, renderCardFormat({ card: card("static.markdown", "# Hello"), identity: "c" })));
    expect(html).toContain("Hello");
  });

  it("lets a new kind render on the artifact page by registering one entry", () => {
    registerFormatRenderer("test.kind", { artifact: ({ title }) => createElement("p", null, `custom ${title}`) });
    const html = renderToStaticMarkup(createElement("div", null, renderArtifactFormat("test.kind", { title: "X", preview: null, showSourceDetails: false })));
    expect(html).toContain("custom X");
    const fallback = renderToStaticMarkup(createElement("div", null, renderArtifactFormat("static.image", { title: "X", preview: null, showSourceDetails: false })));
    expect(fallback).toContain("Loading artifact");
  });
});
