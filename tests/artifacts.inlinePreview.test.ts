import { describe, expect, it } from "vitest";
import { extractJsonStringField, previewPresentArgs } from "../src/artifacts/inlinePreview.js";

describe("inline present preview", () => {
  it("keeps a skeleton until the program string closes", () => {
    expect(previewPresentArgs('{"program": "root = Text')).toEqual({ phase: "skeleton" });
    expect(extractJsonStringField('{"program": "root = Text', "program")?.closed).toBe(false);
  });

  it("shows an error card once a live program is closed and invalid", () => {
    const partial = JSON.stringify({
      program: 'root = NotAThing("x")',
      manifest: { kind: "live.declarative", program: 'root = NotAThing("x")' },
    });
    const preview = previewPresentArgs(partial);
    expect(preview.phase).toBe("error");
    if (preview.phase === "error") expect(preview.message.length).toBeGreaterThan(0);
  });

  it("stays a skeleton for a program that parses", () => {
    const partial = JSON.stringify({
      program: 'root = TextContent("card")',
      manifest: { kind: "live.declarative" },
    });
    expect(previewPresentArgs(partial)).toEqual({ phase: "skeleton" });
  });
});
