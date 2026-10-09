import { describe, expect, it } from "vitest";
import { highlightYaml, highlightYamlLine } from "./yamlHighlight";

describe("highlightYamlLine", () => {
  it("tints a mapping key", () => {
    expect(highlightYamlLine("id: feature-loop")).toEqual([
      { kind: "key", text: "id" },
      { kind: "plain", text: ": feature-loop" },
    ]);
  });

  it("tints a double-quoted string and leaves the key separate", () => {
    expect(highlightYamlLine('model: "pi"')).toEqual([
      { kind: "key", text: "model" },
      { kind: "plain", text: ": " },
      { kind: "string", text: '"pi"' },
    ]);
  });

  it("tints a single-quoted string", () => {
    expect(highlightYamlLine("skill: 'review'")).toEqual([
      { kind: "key", text: "skill" },
      { kind: "plain", text: ": " },
      { kind: "string", text: "'review'" },
    ]);
  });

  it("tints a full-line comment after indent", () => {
    expect(highlightYamlLine("  # keep the gate")).toEqual([
      { kind: "plain", text: "  " },
      { kind: "comment", text: "# keep the gate" },
    ]);
  });

  it("tints an inline comment outside quotes", () => {
    expect(highlightYamlLine("id: foo # keep")).toEqual([
      { kind: "key", text: "id" },
      { kind: "plain", text: ": foo " },
      { kind: "comment", text: "# keep" },
    ]);
  });

  it("keeps a hash inside a quoted string", () => {
    const tokens = highlightYamlLine('name: "a # b"');
    expect(tokens.some((token) => token.kind === "comment")).toBe(false);
    expect(tokens.find((token) => token.kind === "string")?.text).toBe('"a # b"');
  });

  it("tints a key on a list item", () => {
    expect(highlightYamlLine("  - id: decide")).toEqual([
      { kind: "plain", text: "  - " },
      { kind: "key", text: "id" },
      { kind: "plain", text: ": decide" },
    ]);
  });
});

describe("highlightYaml", () => {
  it("splits lines and tints a block scalar body as strings", () => {
    const lines = highlightYaml("system_prompt: |\n  hello\n  world\nid: next\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]?.[0]).toEqual({ kind: "key", text: "system_prompt" });
    expect(lines[1]).toEqual([{ kind: "string", text: "  hello" }]);
    expect(lines[2]).toEqual([{ kind: "string", text: "  world" }]);
    expect(lines[3]?.some((token) => token.kind === "key" && token.text === "id")).toBe(
      true,
    );
  });
});
