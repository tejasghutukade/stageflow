import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(root, "skills");

const JOB_SKILLS = [
  "stageflow-setup",
  "stageflow-session-capture",
  "stageflow-author",
  "stageflow-run",
  "stageflow-delegate",
] as const;

const ALL_SKILLS = ["stageflow", ...JOB_SKILLS] as const;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONTROL_SURFACE_CITE = "../stageflow/references/control-surface.md";

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

function readSkill(name: string): { raw: string; frontmatter: Record<string, unknown> } {
  const raw = readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  return { raw, frontmatter: parseFrontmatter(raw) };
}

function skillDirsWithSkillMd(): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

describe("harness skills suite packaging", () => {
  it("ships exactly six skill directories with SKILL.md plus the shared reference and probe", () => {
    expect(skillDirsWithSkillMd()).toEqual([...ALL_SKILLS].sort());
    expect(existsSync(path.join(skillsRoot, "stageflow", "references", "control-surface.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(skillsRoot, "stageflow", "scripts", "detect-host.mjs"))).toBe(true);
  });

  it("parses the router as auto-loading stageflow with a description", () => {
    const { frontmatter } = readSkill("stageflow");
    expect(frontmatter.name).toBe("stageflow");
    expect(typeof frontmatter.description).toBe("string");
    expect(String(frontmatter.description).length).toBeGreaterThan(0);
    expect(frontmatter["disable-model-invocation"]).toBeFalsy();
  });

  it("parses each job stub as user-invoked with a matching name", () => {
    for (const name of JOB_SKILLS) {
      const { frontmatter } = readSkill(name);
      expect(frontmatter.name, name).toBe(name);
      expect(frontmatter["disable-model-invocation"], name).toBe(true);
    }
  });

  it("keeps every skill name inside the Agent Skills constraint", () => {
    for (const name of ALL_SKILLS) {
      expect(name).toMatch(NAME_RE);
      expect(readSkill(name).frontmatter.name).toBe(name);
      expect(String(readSkill(name).frontmatter.name)).toMatch(NAME_RE);
    }
  });

  it("cites the shared control-surface reference from every job stub", () => {
    for (const name of JOB_SKILLS) {
      expect(readSkill(name).raw).toContain(CONTROL_SURFACE_CITE);
    }
  });
});
