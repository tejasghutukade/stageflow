import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { artifactDetailMeta } from "./artifactDetailModel";
import { ArtifactViewContent, ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX } from "./ArtifactView";
import { previewFromContent } from "./renderers/previewModel";

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
    source: { run_id: null, stage_id: null, attempt: null, session_id: null },
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

describe("ArtifactViewContent", () => {
  it("renders static markdown in page density", () => {
    const meta = artifactDetailMeta(record());
    const preview = previewFromContent({ record: record(), text: "# Hello\n", binary: false });
    const html = renderToStaticMarkup(
      createElement(ArtifactViewContent, {
        density: "page",
        meta,
        preview,
      }),
    );
    expect(html).toContain("artifact-markdown");
    expect(html).toContain("Hello");
  });

  it("renders a live declarative program shell", () => {
    const live = record({
      kind: "live.declarative",
      title: "Weekly",
      live: {
        status: "fresh",
        last_refreshed_at: "2026-11-24T13:00:00.000Z",
        last_error_code: null,
        bindings: [],
        refresh: { on_view: true, ttl_seconds: 30 },
      },
    });
    const html = renderToStaticMarkup(
      createElement(ArtifactViewContent, {
        density: "page",
        meta: artifactDetailMeta(live),
        preview: previewFromContent({ record: live, text: "card", binary: false }),
        program: "card",
        livePreview: {
          program: "card",
          bindings: [],
          snapshots: [],
          status: "fresh",
          lastRefreshedAt: null,
          lastErrorCode: null,
          settled: true,
          refreshing: false,
          historical: false,
          ownerKey: "stage:sales:summarize",
          artifactId: "weekly",
        },
      }),
    );
    expect(html).toContain("Loading live preview…");
    expect(html).toContain("Program source");
  });

  it("renders live html loading state and inline expand chrome", () => {
    const live = record({ kind: "live.html", title: "Dash" });
    const html = renderToStaticMarkup(
      createElement(ArtifactViewContent, {
        density: "inline",
        meta: artifactDetailMeta(live),
        preview: previewFromContent({ record: live, text: "<p>x</p>", binary: false }),
        liveHtml: {
          record: live,
          version: 1,
          html: "<p>x</p>",
          htmlError: null,
          historical: false,
          snapshots: [],
          settled: false,
          ownerKey: "stage:sales:summarize",
          artifactId: "weekly",
        },
        showSourceDetails: false,
      }),
    );
    expect(html).toContain("Loading live HTML…");
    expect(html).toContain("Expand");
    expect(html).toContain(String(ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX));
  });
});