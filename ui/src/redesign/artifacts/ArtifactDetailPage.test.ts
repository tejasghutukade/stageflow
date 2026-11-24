import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { ArtifactDetailView } from "./ArtifactDetailPage";
import { artifactDetailMeta } from "./artifactDetailModel";
import { expiredReasonText, previewFromContent } from "./renderers/previewModel";

function record(patch: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    key: "stage:sales:summarize/weekly",
    id: "weekly",
    title: "weekly.md",
    description: null,
    tags: [],
    kind: "static.markdown",
    origin: "indexed",
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    source: { run_id: "run_abcdef123456", stage_id: "summarize", attempt: 1, session_id: null },
    version: 1,
    size_bytes: 24,
    content_type: "text/markdown",
    created_at: "2026-11-24T12:00:00.000Z",
    updated_at: "2026-11-24T13:00:00.000Z",
    expires_at: null,
    status: "available",
    expired_at: null,
    expired_reason: null,
    project: { id: "examples", registered: true },
    content_hash: "abcdef1234567890",
    ...patch,
  };
}

describe("artifact detail", () => {
  it("shows metadata and links to the source run and stage", () => {
    const meta = artifactDetailMeta(record());
    expect(meta.runPath).toBe("/runs/run_abcdef123456");
    expect(meta.stagePath).toBe("/runs/run_abcdef123456/stages/summarize");
    expect(meta.hashLabel).toBe("abcdef123456…");
    expect(meta.ownerLabel).toBe("sales / summarize");
    expect(meta.sizeLabel).toBe("24 B");
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta,
      preview: { mode: "markdown", text: "# Hello" },
      onBack: () => undefined,
      onOpenRun: () => undefined,
      onOpenStage: () => undefined,
    }));
    expect(html).toContain("Artifacts");
    expect(html).toContain("weekly.md");
    expect(html).toContain("Markdown");
    expect(html).toContain("sales / summarize");
    expect(html).toContain("text/markdown");
    expect(html).toContain("2026-11-24 12:00:00 UTC");
    expect(html).toContain("2026-11-24 13:00:00 UTC");
    expect(html).toContain("run_abcdef123456");
    expect(html).toContain("summarize");
    expect(html).toContain("abcdef123456…");
    expect(html).toContain("Hello");
  });

  it("keeps the side panel when the file is expired", () => {
    const expired = record({
      status: "expired",
      expired_reason: "run_deleted",
      expired_at: "2026-11-01T00:00:00.000Z",
    });
    const preview = previewFromContent({ record: expired, text: "secret", binary: false });
    const meta = artifactDetailMeta(expired);
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta,
      preview,
      onBack: () => undefined,
      onOpenRun: () => undefined,
      onOpenStage: () => undefined,
    }));
    expect(html).toContain("artifact-unavailable");
    expect(html).toContain(expiredReasonText("run_deleted"));
    expect(html).not.toContain(">run_deleted<");
    expect(html).toContain("sales / summarize");
    expect(html).toContain("run_abcdef123456");
  });
});
