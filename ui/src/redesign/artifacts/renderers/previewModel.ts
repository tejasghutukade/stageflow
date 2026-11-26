import type { ArtifactRecord } from "../../../api/artifacts";
import { capTableRows, tableFromCsv, tableFromJson, type BuiltTable } from "./tableModel";

export type StaticPreview =
  | { mode: "markdown"; text: string }
  | { mode: "image" }
  | { mode: "table"; columns: string[]; rows: string[][]; total: number; note: string | null }
  | { mode: "text"; text: string; note: string | null }
  | { mode: "html"; text: string }
  | { mode: "unavailable"; title: string; body: string }
  | { mode: "too-large"; title: string; body: string }
  | { mode: "cannot-preview"; title: string; body: string };

const KNOWN_KINDS = new Set([
  "static.markdown",
  "static.image",
  "static.table",
  "static.text",
  "static.html",
]);

export type PreviewInput = {
  record: Pick<ArtifactRecord, "kind" | "title" | "content_type" | "status" | "expired_reason">;
  text: string | null;
  binary: boolean;
  contentError?: { code?: string; message: string } | null;
};

function tableSource(title: string, contentType: string | null): "csv" | "json" | "text" {
  const type = (contentType ?? "").toLowerCase();
  const name = title.toLowerCase();
  if (type.includes("csv") || name.endsWith(".csv")) return "csv";
  if (type.includes("json") || name.endsWith(".json")) return "json";
  return "text";
}

function fromTable(built: BuiltTable): StaticPreview {
  const capped = capTableRows(built.rows);
  return {
    mode: "table",
    columns: built.columns,
    rows: capped.rows,
    total: capped.total,
    note: capped.note,
  };
}

function textFallback(text: string, note: string): StaticPreview {
  return { mode: "text", text, note };
}

const EXPIRED_REASON_TEXT: Record<string, string> = {
  run_slimmed:
    "The run that produced this file was cleaned up to save space (retention slimming dropped large files). The record is kept so you can see it existed.",
  run_purged:
    "The run that produced this file was removed by retention purge. The record is kept so you can see it existed.",
  run_deleted:
    "The run that produced this file was deleted. The record is kept so you can see it existed.",
  file_missing:
    "The file is no longer in the run workspace. The record is kept so you can see it existed.",
  session_expired: "This session artifact expired. The record is kept so you can see it existed.",
};

export function expiredReasonText(reason: string | null | undefined): string {
  const code = reason?.trim() ?? "";
  if (code.length === 0) {
    return "The run that produced this file is past its retention window, so the file is no longer available.";
  }
  return (
    EXPIRED_REASON_TEXT[code] ??
    `This artifact expired (${code}). The record is kept so you can see it existed.`
  );
}

export function previewFromContent(input: PreviewInput): StaticPreview {
  if (input.record.status === "expired") {
    return {
      mode: "unavailable",
      title: "This artifact has expired",
      body: expiredReasonText(input.record.expired_reason),
    };
  }
  const code = input.contentError?.code;
  if (code === "artifact.content_unavailable") {
    return {
      mode: "unavailable",
      title: "This file is no longer available",
      body: input.contentError?.message?.trim()
        ? input.contentError.message
        : "The indexed file is gone from the run workspace.",
    };
  }
  if (code === "artifact.too_large") {
    return {
      mode: "too-large",
      title: "This file is too large to preview",
      body: "The console loads artifact content up to 5 MiB. Images can be larger.",
    };
  }
  if (!KNOWN_KINDS.has(input.record.kind) || input.binary || input.text === null && input.record.kind !== "static.image") {
    return {
      mode: "cannot-preview",
      title: "Cannot preview this file",
      body: input.record.title,
    };
  }
  if (input.record.kind === "static.image") return { mode: "image" };
  const text = input.text ?? "";
  if (text.includes("\u0000")) {
    return { mode: "cannot-preview", title: "Cannot preview this file", body: input.record.title };
  }
  if (input.record.kind === "static.markdown") return { mode: "markdown", text };
  if (input.record.kind === "static.html") return { mode: "html", text };
  if (input.record.kind === "static.text") return { mode: "text", text, note: null };
  const source = tableSource(input.record.title, input.record.content_type);
  if (source === "text") return textFallback(text, "This file is not a CSV or a JSON array of objects. Showing source.");
  const built = source === "csv" ? tableFromCsv(text) : tableFromJson(text);
  if (!built.ok) {
    const note = built.reason === "empty"
      ? "This file is empty."
      : source === "csv"
        ? "This file is not valid CSV. Showing source."
        : "This JSON is not a table of objects. Showing source.";
    return textFallback(text, note);
  }
  return fromTable(built.table);
}
