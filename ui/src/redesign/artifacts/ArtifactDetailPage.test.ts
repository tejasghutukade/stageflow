import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { ArtifactDetailView } from "./ArtifactDetailPage";
import { artifactDetailMeta, artifactVersionRows, deleteArtifactConfirm, formatLiveRefreshed, formatLiveSnapshotJson, liveExpiryPreview, LIVE_RENDERER_NOTE, LIVE_SNAPSHOT_DISPLAY_MAX_BYTES, LIVE_VERSION_SNAPSHOT_NOTE, recordForViewedVersion, viewingVersionBanner } from "./artifactDetailModel";
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
    expect(meta.ownerPath).toBeNull();
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

  it("links an agent owner to the agent page", () => {
    const meta = artifactDetailMeta(record({
      owner: { kind: "agent", agent: "helper" },
      source: { run_id: null, stage_id: null, attempt: null, session_id: "sess_1" },
    }));
    expect(meta.ownerLabel).toBe("agent · helper");
    expect(meta.ownerPath).toBe("/agents/helper");
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta,
      preview: { mode: "markdown", text: "# Hello" },
      onBack: () => undefined,
      onOpenOwner: () => undefined,
    }));
    expect(html).toContain("agent · helper");
    expect(artifactDetailMeta(record({ owner: { kind: "agent", agent: "helper" } }), null, new Set()).ownerPath).toBeNull();
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

  it("lists versions, a read-only banner, and a delete confirmation", () => {
    const meta = artifactDetailMeta(record({ origin: "published", title: "Weekly revenue" }));
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta,
      preview: { mode: "markdown", text: "# Hello" },
      onBack: () => undefined,
      versions: [
        {
          version: 2,
          createdLabel: "2026-11-24 13:00:00 UTC",
          sizeLabel: "4 B",
          hashLabel: "bbbbbbbbbbbb…",
          current: true,
          pinned: false,
        },
        {
          version: 1,
          createdLabel: "2026-11-24 12:00:00 UTC",
          sizeLabel: "3 B",
          hashLabel: "aaaaaaaaaaaa…",
          current: false,
          pinned: true,
        },
      ],
      viewing: { version: 1, latest: 2 },
      canDelete: true,
      confirmDelete: {
        title: "Delete Weekly revenue?",
        body: 'This removes the published artifact "Weekly revenue" and all of its versions (2 versions).',
      },
      onConfirmDelete: () => undefined,
      onCancelDelete: () => undefined,
    }));
    expect(html).toContain("Versions");
    expect(html).toContain("v2");
    expect(html).toContain("Current");
    expect(html).toContain("Pinned");
    expect(html).toContain("Viewing version 1 of 2");
    expect(html).toContain("View latest");
    expect(html).toContain("Delete Weekly revenue?");
    expect(html).toContain("Weekly revenue");
    expect(html).toContain("2 versions");
  });

  it("formats a version row and the delete confirmation", () => {
    expect(viewingVersionBanner(2, 4)).toBe("Viewing version 2 of 4");
    const copy = deleteArtifactConfirm("Weekly revenue", 3);
    expect(copy.title).toBe("Delete Weekly revenue?");
    expect(copy.body).toContain("Weekly revenue");
    expect(copy.body).toContain("3 versions");
    expect(copy.body).toContain("cannot be undone");
    const rows = artifactVersionRows([
      {
        version: 4,
        size_bytes: 12,
        content_hash: "abcdef1234567890",
        created_at: "2026-11-24T12:00:00.000Z",
        pinned: false,
        current: true,
      },
    ]);
    expect(rows[0]).toMatchObject({ version: 4, sizeLabel: "12 B", hashLabel: "abcdef123456…", current: true });
  });

  it("renders an older version with that version's kind", () => {
    const current = record({ kind: "static.text", title: "note", version: 2, origin: "published" });
    const versions = [
      {
        version: 2,
        size_bytes: 5,
        content_hash: "bbbbbbbbbbbbbbbb",
        created_at: "2026-11-24T13:00:00.000Z",
        pinned: false,
        current: true,
        kind: "static.text",
      },
      {
        version: 1,
        size_bytes: 8,
        content_hash: "aaaaaaaaaaaaaaaa",
        created_at: "2026-11-24T12:00:00.000Z",
        pinned: false,
        current: false,
        kind: "static.markdown",
      },
    ];
    const viewed = recordForViewedVersion(current, versions, 1);
    expect(viewed.kind).toBe("static.markdown");
    const preview = previewFromContent({ record: viewed, text: "# Hello\n", binary: false });
    expect(preview.mode).toBe("markdown");
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(viewed),
      preview,
      onBack: () => undefined,
      versions: artifactVersionRows(versions),
      viewing: { version: 1, latest: 2 },
    }));
    expect(html).toContain("artifact-markdown");
    expect(html).toContain("Markdown");
    expect(html).not.toContain("artifact-text");
  });

  it("shows a delete failure next to Delete", () => {
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(record({ origin: "published", title: "Weekly revenue" })),
      preview: { mode: "text", text: "hello", note: null },
      onBack: () => undefined,
      canDelete: true,
      onDelete: () => undefined,
      actionError: "Delete failed",
    }));
    expect(html).toContain("Delete");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Delete failed");
  });

  it("shows a live program, bindings, snapshots, and refresh", () => {
    const big = formatLiveSnapshotJson("x".repeat(LIVE_SNAPSHOT_DISPLAY_MAX_BYTES + 20));
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThan(LIVE_SNAPSHOT_DISPLAY_MAX_BYTES + 20);
    const live = record({
      kind: "live.declarative",
      title: "Weekly",
      live: {
        status: "fresh",
        last_refreshed_at: "2026-11-24T13:00:00.000Z",
        last_error_code: null,
        bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
        refresh: { on_view: true, ttl_seconds: 30 },
      },
    });
    const html = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(live),
      preview: null,
      program: "card",
      live: live.live,
      liveData: {
        status: "fresh",
        last_refreshed_at: "2026-11-24T13:00:00.000Z",
        last_error_code: null,
        errors: [],
        snapshots: [{
          binding_id: "rows",
          args_hash: "h",
          value: { weeks: 12 },
          fetched_at: "2026-11-24T13:00:00.000Z",
          duration_ms: 4,
          status: "ok",
          error_code: null,
        }],
      },
      refreshing: true,
      refreshError: "queue full",
      nowMs: Date.parse("2026-11-24T15:00:00.000Z"),
      updatedAgo: "Updated 4s ago",
      autoNote: "Checking every 60s · data refreshed at most every 300s",
      onRefresh: () => undefined,
      onBack: () => undefined,
    }));
    expect(html).toContain(LIVE_RENDERER_NOTE);
    expect(html).toContain("card");
    expect(html).toContain("rows");
    expect(html).toContain("revenue_by_week");
    expect(html).toContain("Read-only");
    expect(html).toContain("Fresh");
    expect(html).toContain("Refreshing…");
    expect(html).toContain("disabled");
    expect(html).toContain('role="alert"');
    expect(html).toContain("queue full");
    expect(formatLiveRefreshed("2026-11-24T13:00:00.000Z", Date.parse("2026-11-24T15:00:00.000Z"))).toEqual({
      label: "2h ago",
      title: "2026-11-24 13:00:00 UTC",
    });
    expect(formatLiveRefreshed(null, 0)).toEqual({ label: "—", title: null });
    expect(html).toContain("Last refreshed 2h ago");
    expect(html).toContain('title="2026-11-24 13:00:00 UTC"');
    expect(html).toContain("Updated 4s ago");
    expect(html).toContain("Checking every 60s · data refreshed at most every 300s");
    expect(html).toContain("weeks");
    const historical = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(live),
      preview: null,
      program: "old card",
      live: live.live,
      historicalSnapshots: true,
      onBack: () => undefined,
    }));
    expect(historical).toContain(LIVE_VERSION_SNAPSHOT_NOTE);
    expect(historical).toContain("old card");
    expect(historical).not.toContain("Refresh now");

    const expiredRecord = record({
      status: "expired",
      expired_reason: "run_deleted",
      kind: "live.declarative",
      title: "Weekly",
    });
    const expiredPreview = liveExpiryPreview(expiredRecord, false, null);
    expect(expiredPreview).toMatchObject({ mode: "unavailable", title: "This artifact has expired", body: expiredReasonText("run_deleted") });
    const expiredHtml = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(expiredRecord),
      preview: expiredPreview,
      program: "root = TextContent(\"card\")",
      live: expiredRecord.live,
      onRefresh: () => undefined,
      onBack: () => undefined,
    }));
    expect(expiredHtml).toContain("artifact-unavailable");
    expect(expiredHtml).toContain(expiredReasonText("run_deleted"));
    expect(expiredHtml).not.toContain(LIVE_RENDERER_NOTE);
    expect(expiredHtml).not.toContain("Refresh now");

    const unavailable = liveExpiryPreview(record({ kind: "live.declarative", title: "Weekly" }), true, "This artifact has expired");
    expect(unavailable).toMatchObject({ mode: "unavailable", title: "This file is no longer available" });
    const unavailableHtml = renderToStaticMarkup(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(record({ kind: "live.declarative", title: "Weekly" })),
      preview: unavailable,
      program: "card",
      live: record().live,
      onRefresh: () => undefined,
      onBack: () => undefined,
    }));
    expect(unavailableHtml).toContain("This artifact has expired");
    expect(unavailableHtml).not.toContain(LIVE_RENDERER_NOTE);
    expect(unavailableHtml).not.toContain("Refresh now");
  });
});
