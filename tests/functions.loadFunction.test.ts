import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  functionCatalogConflictIssues,
  functionSourceHash,
  groupFunctionDefinitionFiles,
  listFunctionDefinitionFileEntries,
  parseFunctionJs,
  parseFunctionYaml,
  serializeFunctionDefinition,
  serializeFunctionJsFile,
} from "../src/config/loadFunction.js";

const BODY = [
  "export const access = {",
  '  artifacts: "read",',
  '  env: ["MIN_SCORE"],',
  "  network: [],",
  "};",
  "",
  "export default async function execute(context) {",
  '  const report = await context.artifacts.readJson("report.json");',
  "  const threshold = Number(context.env.MIN_SCORE);",
  '  if (!Number.isFinite(threshold) || typeof report.score !== "number") {',
  '    throw new Error("Expected a numeric report score and configured threshold");',
  "  }",
  "  const passed = report.score >= threshold;",
  "  return {",
  "    passed,",
  '    message: passed ? "Score accepted" : "Score below threshold",',
  "  };",
  "}",
  "",
].join("\n");

const JS_FILE = [
  "---",
  "id: score_check",
  "name: Score check",
  "description: Accepts a report when its score meets the bound threshold.",
  "kind: verification",
  "timeout_ms: 5000",
  "---",
  BODY,
].join("\n");

const YAML_FILE = [
  "id: score_check",
  "name: Score check",
  "description: Accepts a report when its score meets the bound threshold.",
  "kind: verification",
  "timeout_ms: 5000",
  "source: |",
  ...BODY.split("\n").map((line) => `  ${line}`),
].join("\n");

describe("function.js load and serialize", () => {
  it("parses frontmatter JS to the same definition fields as the YAML fixture body", () => {
    const js = parseFunctionJs(JS_FILE);
    const yaml = parseFunctionYaml(YAML_FILE);
    expect(js.ok).toBe(true);
    expect(yaml.ok).toBe(true);
    if (!js.ok || !yaml.ok) return;
    expect(js.value.id).toBe(yaml.value.id);
    expect(js.value.name).toBe(yaml.value.name);
    expect(js.value.kind).toBe(yaml.value.kind);
    expect(js.value.source).toBe(yaml.value.source);
    expect(js.value.capabilities).toEqual(yaml.value.capabilities);
    expect(js.value.bindings).toEqual(yaml.value.bindings);
    expect(functionSourceHash(js.value.source)).toBe(functionSourceHash(yaml.value.source));
    expect(functionSourceHash(js.value.source)).toBe(createHash("sha256").update(BODY).digest("hex"));
  });

  it("round-trips JS metadata and body", () => {
    const parsed = parseFunctionJs(JS_FILE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = serializeFunctionJsFile(parsed.value);
    const again = parseFunctionJs(serialized);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual(parsed.value);
    expect(serialized).toContain("export default async function execute");
    expect(serialized).not.toMatch(/^source:/m);
  });

  it("rejects missing frontmatter and invalid execute export", () => {
    const missing = parseFunctionJs(BODY);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.issues[0]?.code).toBe("function.invalid");

    const badBody = BODY.replace("export default async function execute", "export default function run");
    const bad = parseFunctionJs(`---\nid: bad\nname: Bad\nkind: verification\n---\n${badBody}`);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.some((issue) => issue.code === "function.invalid_source")).toBe(true);
  });

  it("derives access from the body and omits capabilities in serialized JS", () => {
    const parsed = parseFunctionJs(JS_FILE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = serializeFunctionJsFile(parsed.value);
    expect(text).not.toContain("capabilities:");
    expect(text).not.toContain("bindings:");
    const yaml = serializeFunctionDefinition(parsed.value);
    expect(yaml).not.toContain("capabilities:");
  });

  it("groups definition files and reports catalog conflicts", () => {
    const entries = listFunctionDefinitionFileEntries([
      "score.function.js",
      "score.function.yaml",
      "other.function.yml",
      "helper.js",
    ]);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["other.function.yml", "score.function.js", "score.function.yaml"]);
    const groups = groupFunctionDefinitionFiles(["score.function.js", "score.function.yaml", "other.function.yml"]);
    expect([...groups.keys()].sort()).toEqual(["other", "score"]);
    expect(functionCatalogConflictIssues("score", groups.get("score")!)[0]?.code).toBe("function.format_conflict");
    expect(functionCatalogConflictIssues("other", [{ name: "a.function.yaml", functionId: "other", format: "yaml", family: "yaml" }, { name: "b.function.yml", functionId: "other", format: "yml", family: "yaml" }])[0]?.code).toBe(
      "function.id_conflict",
    );
  });
});
