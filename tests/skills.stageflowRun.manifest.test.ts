import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "stageflow-run");
const skillMd = path.join(skillDir, "SKILL.md");
const nativeQuestionUi = path.join(skillDir, "references", "native-question-ui.md");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CITED_PATH_RE =
  /(?:\.\.\/stageflow\/(?:references|scripts)\/[\w.-]+|references\/[\w./-]+|scripts\/[\w./-]+)/g;

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

describe("stageflow-run SKILL.md", () => {
  const raw = readFileSync(skillMd, "utf8");
  const frontmatter = parseFrontmatter(raw);
  const body = raw.slice(raw.indexOf("\n---", 3) + 4);
  const gateSection = body.slice(body.indexOf("### Gate"), body.indexOf("## CLI path"));

  it("parses frontmatter with a matching kebab-case name", () => {
    expect(frontmatter.name).toBe("stageflow-run");
    expect(frontmatter.name).toBe(path.basename(skillDir));
    expect(String(frontmatter.name)).toMatch(NAME_RE);
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter.compatibility).toBe(
      "Requires the sf CLI on PATH. An MCP host (sf ui or sf mcp) is optional.",
    );
  });

  it("describes run, HITL, and native-or-chat presentation within 1024 chars", () => {
    expect(typeof frontmatter.description).toBe("string");
    const description = String(frontmatter.description);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description.toLowerCase()).toMatch(/run/);
    expect(description.toLowerCase()).toMatch(/hitl/);
    expect(description.toLowerCase()).toMatch(/native|picker|question ui/);
    expect(description.toLowerCase()).not.toMatch(/every hitl gate in this chat/);
  });

  it("cites existing references including native-question-ui", () => {
    const cited = [...body.matchAll(CITED_PATH_RE)].map((match) => match[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const rel of new Set(cited)) {
      expect(existsSync(path.resolve(skillDir, rel)), rel).toBe(true);
    }
    expect(body).toContain("../stageflow/references/control-surface.md");
    expect(body).toContain("references/native-question-ui.md");
    expect(existsSync(nativeQuestionUi)).toBe(true);
  });

  it("keeps the MCP submit path and does not mandate chat-only gates", () => {
    expect(gateSection).toMatch(/list_waiting/);
    expect(gateSection).toMatch(/answer_gate/);
    expect(gateSection).toContain("references/native-question-ui.md");
    expect(gateSection).not.toMatch(/Collect the human's reply in this chat/);
    expect(gateSection).not.toMatch(/Ask once/);
    expect(body).not.toMatch(/do not open another surface/);
    expect(body).toMatch(/AskQuestion/);
  });

  it("locks picker routing, harvest, and confirm submit shape in the reference", () => {
    const reference = readFileSync(nativeQuestionUi, "utf8");
    expect(reference).toMatch(/AskQuestion/);
    expect(reference).toMatch(/AskUserQuestion/);
    expect(reference).toMatch(/ask_user/);
    expect(reference).toMatch(/reply with exactly one of/);
    expect(reference).toMatch(/choose one of/);
    expect(reference).toMatch(/exactly one of/);
    expect(reference).toMatch(/whole[\s\S]*gate in chat/i);
    expect(reference).toMatch(/kind": "confirm"/);
    expect(reference).toMatch(/Never submit a `confirm` item as `free_text`/);
  });
});
