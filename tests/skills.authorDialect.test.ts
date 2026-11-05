import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AUTHORING_MARKDOWN = [
  "skills/stageflow-pipelines/SKILL.md",
  "skills/stageflow-pipelines/references/catalog-mapping.md",
  "skills/stageflow-pipelines/references/stage-prompt-template.md",
  "skills/stageflow-pipelines/references/yaml-reference.md",
  "skills/stageflow-pipelines/references/design-playbook.md",
] as const;

const STALE_CATALOG_KEY = /^\s*needs:|^\s*fork:|fork:\s*\{|needs:\s*\[/m;

function readAuthoringMarkdown(rel: (typeof AUTHORING_MARKDOWN)[number]): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("published authoring skills dialect", () => {
  it("does not instruct catalog YAML needs or fork keys", () => {
    for (const rel of AUTHORING_MARKDOWN) {
      expect(readAuthoringMarkdown(rel), rel).not.toMatch(STALE_CATALOG_KEY);
    }
  });
});
