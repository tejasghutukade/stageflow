import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticArtifactBody } from "./StaticPreview";
import type { StaticPreview } from "./previewModel";

function html(preview: StaticPreview, imageUrl?: string) {
  return renderToStaticMarkup(createElement(StaticArtifactBody, {
    preview,
    imageAlt: "weekly.md",
    imageUrl,
  }));
}

describe("StaticArtifactBody", () => {
  it("renders markdown with the shared Markdown component", () => {
    const body = html({ mode: "markdown", text: "# Hello" });
    expect(body).toContain("artifact-markdown");
    expect(body).toContain("Hello");
  });

  it("renders an image from the fetched content url", () => {
    const body = html({ mode: "image" }, "blob:shot");
    expect(body).toContain('src="blob:shot"');
    expect(body).toContain('alt="weekly.md"');
  });

  it("renders a table and the row cap note", () => {
    const body = html({
      mode: "table",
      columns: ["n"],
      rows: [["2"], ["10"]],
      total: 501,
      note: "showing first 500 of 501",
    });
    expect(body).toContain("artifact-table");
    expect(body).toContain("showing first 500 of 501");
    expect(body).toContain(">2<");
    expect(body).toContain(">10<");
  });

  it("renders monospace text and HTML source with the placeholder", () => {
    const text = html({ mode: "text", text: "alpha", note: null });
    expect(text).toContain("sf-mono");
    expect(text).toContain("alpha");
    const source = html({ mode: "html", text: "<p>hi</p>" });
    expect(source).toContain("HTML preview comes with the next update; showing source");
    expect(source).toContain("&lt;p&gt;hi&lt;/p&gt;");
  });

  it("renders an explanation instead of crashing on binary or unknown content", () => {
    const body = html({ mode: "cannot-preview", title: "Cannot preview this file", body: "blob.bin" });
    expect(body).toContain("artifact-cannot-preview");
    expect(body).toContain("Cannot preview this file");
    expect(body).toContain("blob.bin");
  });

  it("renders the unavailable card", () => {
    const body = html({
      mode: "unavailable",
      title: "This artifact has expired",
      body: "retention window elapsed",
    });
    expect(body).toContain("artifact-unavailable");
    expect(body).toContain("retention window elapsed");
  });
});
