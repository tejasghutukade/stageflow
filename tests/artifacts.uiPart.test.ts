import { describe, expect, it } from "vitest";
import {
  UI_PART_FALLBACK_TEXT_MAX_CHARS,
  UI_PART_KIND_ARTIFACT_REF,
  UI_PART_SCHEMA_VERSION,
  parseUiPart,
  parseUiPartEnvelope,
} from "../src/artifacts/uiPart.js";

const valid = {
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_ARTIFACT_REF,
  key: "stage:sales:summarize/weekly",
  title: "Weekly",
  fallback: { text: "Open the weekly report", url: "https://example.com/artifacts/weekly" },
};

describe("ui part schema", () => {
  it("parses a valid artifact-ref part", () => {
    expect(parseUiPart(valid)).toEqual({ ok: true, part: valid });
    expect(parseUiPartEnvelope({ type: "ui", ui: valid })).toEqual({ ok: true, part: valid });
  });

  it("accepts an optional pinned version", () => {
    const withVersion = { ...valid, version: 2 };
    expect(parseUiPart(withVersion)).toEqual({ ok: true, part: withVersion });
  });

  it("returns unsupported for an unknown version", () => {
    expect(parseUiPart({ ...valid, v: 2 })).toEqual({ ok: false, kind: "unsupported" });
  });

  it("returns unsupported for an unknown kind", () => {
    expect(parseUiPart({ ...valid, kind: "form" })).toEqual({ ok: false, kind: "unsupported" });
  });

  it("caps oversized fallback text without failing", () => {
    const huge = "x".repeat(UI_PART_FALLBACK_TEXT_MAX_CHARS + 500);
    const parsed = parseUiPart({ ...valid, fallback: { ...valid.fallback, text: huge } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.part.fallback.text.length).toBe(UI_PART_FALLBACK_TEXT_MAX_CHARS);
    expect(parsed.part.fallback.text).toBe(huge.slice(0, UI_PART_FALLBACK_TEXT_MAX_CHARS));
  });

  it("never throws on garbage input", () => {
    expect(parseUiPart(null)).toEqual({ ok: false, kind: "unsupported" });
    expect(parseUiPart("nope")).toEqual({ ok: false, kind: "unsupported" });
    expect(parseUiPart({ v: 1 })).toEqual({ ok: false, kind: "unsupported" });
    expect(parseUiPartEnvelope({ type: "text" })).toEqual({ ok: false, kind: "unsupported" });
  });
});