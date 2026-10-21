import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "stageflow-session-capture");
const skillMd = path.join(skillDir, "SKILL.md");
const CITED_PATH_RE =
  /(?:\.\.\/stageflow\/references\/[\w.-]+|references\/[\w./-]+|scripts\/[\w./-]+|assets\/[\w./-]+)/g;

function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("missing YAML frontmatter");
  }
  const parsed = parseYaml(match[1]);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter is not a mapping");
  }
  return parsed as Record<string, unknown>;
}

describe("stageflow-session-capture SKILL.md", () => {
  const raw = readFileSync(skillMd, "utf8");
  const frontmatter = parseFrontmatter(raw);
  const body = raw.slice(raw.indexOf("\n---", 3) + 4);

  it("keeps description within 1024 chars", () => {
    const description = String(frontmatter.description);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("cites existing references, scripts, and assets", () => {
    const cited = [...body.matchAll(CITED_PATH_RE)].map((match) => match[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const rel of new Set(cited)) {
      expect(existsSync(path.resolve(skillDir, rel)), rel).toBe(true);
    }
  });
});
