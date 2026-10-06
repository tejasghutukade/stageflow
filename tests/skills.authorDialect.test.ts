import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AUTHORING_MARKDOWN = [
  "skills/stageflow-author/SKILL.md",
  "skills/stageflow-author/references/catalog-mapping.md",
  "skills/stageflow-author/references/catalog-write-conventions.md",
  "skills/stageflow-author/references/stage-prompt-template.md",
  "skills/stageflow-session-capture/SKILL.md",
  "skills/stageflow-session-capture/references/catalog-authoring.md",
] as const;

const STALE_CATALOG_KEY = /^\s*needs:|^\s*fork:|fork:\s*\{|needs:\s*\[/m;

function readAuthoringMarkdown(rel: (typeof AUTHORING_MARKDOWN)[number]): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function withoutNegatedForkChoiceMentions(text: string): string {
  return text
    .replace(/\bdo(?:es)? not emit [`']?fork_choice[`']?/gi, "")
    .replace(/\bdon't emit [`']?fork_choice[`']?/gi, "");
}

describe("published authoring skills dialect", () => {
  it("teaches route in every authoring markdown file", () => {
    for (const rel of AUTHORING_MARKDOWN) {
      expect(readAuthoringMarkdown(rel), rel).toContain("route");
    }
  });

  it("maps catalog wiring with entry: true, if, and type: loop", () => {
    const mapping = readAuthoringMarkdown(
      "skills/stageflow-author/references/catalog-mapping.md",
    );
    expect(mapping).toContain("entry: true");
    expect(mapping).toContain("if:");
    expect(mapping.includes("{ type: loop }") || mapping.includes("type: loop")).toBe(
      true,
    );
  });

  it("does not instruct catalog YAML needs or fork keys", () => {
    for (const rel of AUTHORING_MARKDOWN) {
      expect(readAuthoringMarkdown(rel), rel).not.toMatch(STALE_CATALOG_KEY);
    }
  });

  it("does not instruct emitting fork_choice from stage prompts", () => {
    const template = withoutNegatedForkChoiceMentions(
      readAuthoringMarkdown("skills/stageflow-author/references/stage-prompt-template.md"),
    );
    expect(template).not.toMatch(/\binclude\s+fork_choice\b/i);
    expect(template).not.toMatch(/\bemit(?:ting)?\s+[`']?fork_choice[`']?/i);
    expect(template).not.toMatch(/names? immediate successors in [`']?fork_choice/i);
  });
});
