import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../../api/artifacts";
import { expiredReasonText, previewFromContent } from "./previewModel";
import { TABLE_ROW_CAP } from "./tableModel";

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
    source: { run_id: "run_1", stage_id: "summarize", attempt: 1, session_id: null },
    version: 1,
    size_bytes: 12,
    content_type: "text/markdown",
    created_at: "2026-11-24T12:00:00.000Z",
    updated_at: "2026-11-24T12:00:00.000Z",
    expires_at: null,
    status: "available",
    expired_at: null,
    expired_reason: null,
    project: { id: "examples", registered: true },
    ...patch,
  };
}

describe("previewFromContent", () => {
  it("renders each static kind", () => {
    expect(previewFromContent({ record: record(), text: "# Hello", binary: false }).mode).toBe("markdown");
    expect(previewFromContent({
      record: record({ kind: "static.image", title: "shot.png", content_type: "image/png" }),
      text: null,
      binary: false,
    }).mode).toBe("image");
    const table = previewFromContent({
      record: record({ kind: "static.table", title: "numbers.csv", content_type: "text/csv" }),
      text: "a,b\n1,2\n",
      binary: false,
    });
    expect(table).toMatchObject({ mode: "table", columns: ["a", "b"], rows: [["1", "2"]] });
    expect(previewFromContent({
      record: record({ kind: "static.text", title: "notes.txt", content_type: "text/plain; charset=utf-8" }),
      text: "plain",
      binary: false,
    })).toMatchObject({ mode: "text", text: "plain", note: null });
    expect(previewFromContent({
      record: record({ kind: "static.html", title: "page.html", content_type: "text/html; charset=utf-8" }),
      text: "<p>hi</p>",
      binary: false,
    })).toMatchObject({ mode: "html", text: "<p>hi</p>" });
  });

  it("falls unknown extensions back to text and refuses binary", () => {
    expect(previewFromContent({
      record: record({ kind: "static.text", title: "notes.yaml", content_type: "text/plain; charset=utf-8" }),
      text: "key: 1",
      binary: false,
    })).toMatchObject({ mode: "text", text: "key: 1" });
    expect(previewFromContent({
      record: record({ kind: "static.text", title: "blob.bin" }),
      text: null,
      binary: true,
    })).toMatchObject({ mode: "cannot-preview", title: "Cannot preview this file" });
    expect(previewFromContent({
      record: record({ kind: "live.widget", title: "widget.json" }),
      text: "{}",
      binary: false,
    }).mode).toBe("cannot-preview");
  });

  it("falls invalid CSV and JSON back to source text", () => {
    const csv = previewFromContent({
      record: record({ kind: "static.table", title: "bad.csv", content_type: "text/csv" }),
      text: '"oops',
      binary: false,
    });
    expect(csv).toMatchObject({ mode: "text", text: '"oops', note: "This file is not valid CSV. Showing source." });
    const json = previewFromContent({
      record: record({ kind: "static.table", title: "bad.json", content_type: "application/json" }),
      text: '{"a":1}',
      binary: false,
    });
    expect(json).toMatchObject({
      mode: "text",
      note: "This JSON is not a table of objects. Showing source.",
    });
  });

  it("notes the 500-row display cap", () => {
    const lines = ["n", ...Array.from({ length: TABLE_ROW_CAP + 1 }, (_, index) => String(index))].join("\n");
    const preview = previewFromContent({
      record: record({ kind: "static.table", title: "wide.csv", content_type: "text/csv" }),
      text: lines,
      binary: false,
    });
    expect(preview).toMatchObject({
      mode: "table",
      note: `showing first ${TABLE_ROW_CAP} of ${TABLE_ROW_CAP + 1}`,
    });
  });

  it("explains an expired record and a missing file without rendering the body", () => {
    expect(previewFromContent({
      record: record({ status: "expired", expired_reason: "run_slimmed", expired_at: "2026-11-01T00:00:00.000Z" }),
      text: "# secret",
      binary: false,
    })).toEqual({
      mode: "unavailable",
      title: "This artifact has expired",
      body: expiredReasonText("run_slimmed"),
    });
    expect(previewFromContent({
      record: record(),
      text: null,
      binary: false,
      contentError: { code: "artifact.content_unavailable", message: "The artifact file is no longer in the run workspace" },
    })).toMatchObject({
      mode: "unavailable",
      body: "The artifact file is no longer in the run workspace",
    });
  });

  it("explains run_slimmed in a sentence", () => {
    expect(expiredReasonText("run_slimmed")).toBe(
      "The run that produced this file was cleaned up to save space (retention slimming dropped large files). The record is kept so you can see it existed.",
    );
    expect(previewFromContent({
      record: record({ status: "expired", expired_reason: "run_slimmed", expired_at: "2026-11-01T00:00:00.000Z" }),
      text: "secret",
      binary: false,
    })).toMatchObject({ mode: "unavailable", body: expiredReasonText("run_slimmed") });
  });

  it("explains run_purged in a sentence", () => {
    expect(expiredReasonText("run_purged")).toBe(
      "The run that produced this file was removed by retention purge. The record is kept so you can see it existed.",
    );
  });

  it("explains run_deleted in a sentence", () => {
    expect(expiredReasonText("run_deleted")).toBe(
      "The run that produced this file was deleted. The record is kept so you can see it existed.",
    );
  });

  it("explains file_missing in a sentence", () => {
    expect(expiredReasonText("file_missing")).toBe(
      "The file is no longer in the run workspace. The record is kept so you can see it existed.",
    );
  });

  it("names an unknown expiry code in the fallback sentence", () => {
    expect(expiredReasonText("retention window elapsed")).toBe(
      "This artifact expired (retention window elapsed). The record is kept so you can see it existed.",
    );
  });
});
