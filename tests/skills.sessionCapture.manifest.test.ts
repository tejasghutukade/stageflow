import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "stageflow-session-capture");
const skillMd = path.join(skillDir, "SKILL.md");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
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

  it("parses frontmatter with a matching kebab-case name", () => {
    expect(frontmatter.name).toBe("stageflow-session-capture");
    expect(frontmatter.name).toBe(path.basename(skillDir));
    expect(String(frontmatter.name)).toMatch(NAME_RE);
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter.compatibility).toBe(
      "Requires Node.js >= 20 and the sf CLI on PATH",
    );
  });

  it("describes session, transcript, pipeline, and rerun within 1024 chars", () => {
    expect(typeof frontmatter.description).toBe("string");
    const description = String(frontmatter.description);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description.toLowerCase()).toMatch(/session/);
    expect(description.toLowerCase()).toMatch(/transcript/);
    expect(description.toLowerCase()).toMatch(/pipeline/);
    expect(description.toLowerCase()).toMatch(/rerun/);
  });

  it("cites existing references, scripts, and assets", () => {
    const cited = [...body.matchAll(CITED_PATH_RE)].map((match) => match[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const rel of new Set(cited)) {
      expect(existsSync(path.resolve(skillDir, rel)), rel).toBe(true);
    }
    expect(body).toContain("../stageflow/references/control-surface.md");
  });

  it("does not instruct starting a run", () => {
    expect(body).not.toMatch(/\bsf run\b/);
    expect(body).not.toMatch(/\bstart_run\b/);
    expect(body).not.toMatch(/\bwait_run\b/);
  });
});
