import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactReaderBody, isImageArtifactPath } from "./ArtifactReader";

describe("isImageArtifactPath", () => {
  it("matches png jpeg gif webp basenames", () => {
    expect(isImageArtifactPath("stages/screenshot/attempts/1/artifacts/page.png")).toBe(
      true,
    );
    expect(isImageArtifactPath("shot.JPEG")).toBe(true);
    expect(isImageArtifactPath("a.gif")).toBe(true);
    expect(isImageArtifactPath("b.webp")).toBe(true);
  });

  it("rejects markdown and extensionless names", () => {
    expect(isImageArtifactPath("screenshot.md")).toBe(false);
    expect(isImageArtifactPath("page")).toBe(false);
  });
});

describe("ArtifactReader HTML", () => {
  it("renders the sandbox component and the Rendered / Source toggle", () => {
    const body = renderToStaticMarkup(
      createElement(ArtifactReaderBody, {
        load: { status: "ready", content: "<h1>Report</h1><script>bad()</script>" },
        mode: "rendered",
        markdown: false,
        image: false,
        html: true,
        imageSrc: null,
        path: "stages/summarize/attempts/1/artifacts/page.html",
      }),
    );
    expect(body).toContain('data-testid="artifact-html-frame"');
    expect(body).toContain('sandbox=""');
    expect(body).not.toContain("allow-scripts");
    expect(body).not.toContain("allow-same-origin");
    expect(body).toContain('data-testid="artifact-html-toggle"');
    expect(body).toContain(">Rendered<");
    expect(body).toContain(">Source<");
    expect(body).toContain("Static preview: scripts and network access are disabled.");
  });

  it("leaves markdown and raw text on their existing views", () => {
    const markdown = renderToStaticMarkup(
      createElement(ArtifactReaderBody, {
        load: { status: "ready", content: "# Title" },
        mode: "rendered",
        markdown: true,
        image: false,
        html: false,
        imageSrc: null,
        path: "notes.md",
      }),
    );
    expect(markdown).not.toContain("artifact-html-frame");
    expect(markdown).toContain("Title");
    const raw = renderToStaticMarkup(
      createElement(ArtifactReaderBody, {
        load: { status: "ready", content: "plain" },
        mode: "raw",
        markdown: false,
        image: false,
        html: false,
        imageSrc: null,
        path: "notes.txt",
      }),
    );
    expect(raw).not.toContain("artifact-html-frame");
    expect(raw).toContain("plain");
  });
});
