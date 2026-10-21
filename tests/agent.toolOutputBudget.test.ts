import { describe, expect, it } from "vitest";
import {
  buildPreview,
  decideToolOutput,
  describeJsonShape,
  RESERVE_MIN_TOKENS,
  truncateUtf8,
  UNKNOWN_USAGE_INLINE_MAX_BYTES,
} from "../src/agent/toolOutputBudget.js";

const WINDOW = 200_000;

describe("decideToolOutput", () => {
  it("keeps a small result inline", () => {
    expect(
      decideToolOutput({
        resultBytes: 3_000,
        contextWindow: WINDOW,
        knownTokens: 10_000,
        turnLedgerTokens: 0,
      }),
    ).toEqual({ kind: "inline", estTokens: 1_000 });
  });

  it("spills a result larger than the per-result cap even when context is empty", () => {
    // 0.3 × 200k = 60k tokens ≈ 180 KB at 3 bytes/token.
    expect(
      decideToolOutput({
        resultBytes: 200_000,
        contextWindow: WINDOW,
        knownTokens: 0,
        turnLedgerTokens: 0,
      }),
    ).toMatchObject({ kind: "spill", reason: "exceeds_per_result_cap" });
  });

  it("spills a result that does not fit after the reserve", () => {
    // remaining = 200k − 130k − 50k reserve = 20k tokens; 140 KB ≈ 46.7k tokens.
    expect(
      decideToolOutput({
        resultBytes: 140_000,
        contextWindow: WINDOW,
        knownTokens: 130_000,
        turnLedgerTokens: 0,
      }),
    ).toMatchObject({ kind: "spill", reason: "exceeds_remaining" });
  });

  it("keeps a 140 KB result inline when the window has room", () => {
    expect(
      decideToolOutput({
        resultBytes: 140_000,
        contextWindow: WINDOW,
        knownTokens: 20_000,
        turnLedgerTokens: 0,
      }).kind,
    ).toBe("inline");
  });

  it("counts results already returned this turn", () => {
    const base = {
      resultBytes: 90_000,
      contextWindow: WINDOW,
      knownTokens: 60_000,
    };
    expect(decideToolOutput({ ...base, turnLedgerTokens: 0 }).kind).toBe("inline");
    expect(decideToolOutput({ ...base, turnLedgerTokens: 70_000 })).toMatchObject({
      kind: "spill",
      reason: "exceeds_remaining",
    });
  });

  it("uses at least the minimum reserve on small windows", () => {
    // 32k window: reserve = max(16k, 8k) = 16k; remaining = 32k − 10k − 16k = 6k.
    expect(
      decideToolOutput({
        resultBytes: 21_000,
        contextWindow: 32_000,
        knownTokens: 10_000,
        turnLedgerTokens: 0,
      }),
    ).toMatchObject({ kind: "spill", reason: "exceeds_remaining" });
    expect(RESERVE_MIN_TOKENS).toBe(16_000);
  });

  it("falls back to a fixed byte cap when usage is unknown", () => {
    const unknown = { contextWindow: WINDOW, knownTokens: null, turnLedgerTokens: 0 };
    expect(
      decideToolOutput({ ...unknown, resultBytes: UNKNOWN_USAGE_INLINE_MAX_BYTES }).kind,
    ).toBe("inline");
    expect(
      decideToolOutput({ ...unknown, resultBytes: UNKNOWN_USAGE_INLINE_MAX_BYTES + 1 }),
    ).toMatchObject({ kind: "spill", reason: "unknown_usage_fallback" });
  });

  it("treats a missing context window like unknown usage", () => {
    expect(
      decideToolOutput({
        resultBytes: 60_000,
        contextWindow: 0,
        knownTokens: 0,
        turnLedgerTokens: 0,
      }),
    ).toMatchObject({ kind: "spill", reason: "unknown_usage_fallback" });
  });
});

describe("preview helpers", () => {
  it("truncates on a UTF-8 boundary", () => {
    const text = "aé€😀";
    expect(truncateUtf8(text, 1)).toBe("a");
    expect(truncateUtf8(text, 2)).toBe("a");
    expect(truncateUtf8(text, 3)).toBe("aé");
    expect(truncateUtf8(text, 6)).toBe("aé€");
    expect(truncateUtf8(text, 9)).toBe("aé€");
    expect(truncateUtf8(text, 100)).toBe(text);
  });

  it("describes JSON shape", () => {
    expect(describeJsonShape({ results: [1, 2, 3], title: "x", meta: { a: 1 } })).toBe(
      "JSON object { results: array(3), title: string(1 chars), meta: object(1 keys) }",
    );
    expect(describeJsonShape([{ a: 1 }, { a: 2 }])).toBe(
      "JSON array with 2 items; first item: object(1 keys)",
    );
  });

  it("caps the preview size and marks the cut", () => {
    const body = "line\n".repeat(2_000);
    const preview = buildPreview(body, { maxBytes: 200 });
    expect(Buffer.byteLength(preview)).toBeLessThan(260);
    expect(preview.startsWith("Preview:\n")).toBe(true);
    expect(preview.endsWith("\n…")).toBe(true);
  });

  it("leads the preview with the JSON shape", () => {
    const json = { items: [1, 2] };
    const preview = buildPreview(JSON.stringify(json, null, 2), { json });
    expect(preview.split("\n")[0]).toBe("Shape: JSON object { items: array(2) }");
  });
});
