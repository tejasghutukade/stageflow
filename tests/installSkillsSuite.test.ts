import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "skills", "install-suite.sh");
const skillsRoot = path.join(root, "skills");

const SKILLS = [
  "stageflow",
  "stageflow-pipelines",
  "stageflow-agents",
  "stageflow-operate",
  "stageflow-evals",
] as const;

const TARGETS = [".cursor/skills", ".claude/skills", ".agents/skills"] as const;

function runInstall(args: string[], cwd = root) {
  return spawnSync("bash", [installer, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function installedSkillPaths(destRoot: string): string[] {
  const paths: string[] = [];
  for (const target of TARGETS) {
    for (const skill of SKILLS) {
      paths.push(path.join(destRoot, target, skill, "SKILL.md"));
    }
  }
  return paths;
}

describe("install-suite.sh", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies all five skills into the three harness targets", () => {
    const dest = mkdtempSync(path.join(tmpdir(), "sf-skills-install-"));
    temps.push(dest);

    const result = runInstall(["--source-dir", skillsRoot, "--dest-cwd", dest]);
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const installed = installedSkillPaths(dest);
    expect(installed).toHaveLength(15);
    for (const skillMd of installed) {
      const skill = path.basename(path.dirname(skillMd));
      const source = readFileSync(path.join(skillsRoot, skill, "SKILL.md"));
      expect(readFileSync(skillMd).equals(source), skillMd).toBe(true);
    }

    expect(result.stdout).toContain(path.join(dest, ".cursor/skills"));
    expect(result.stdout).toContain(path.join(dest, ".claude/skills"));
    expect(result.stdout).toContain(path.join(dest, ".agents/skills"));
  });

  it("is idempotent when run twice against the same dest", () => {
    const dest = mkdtempSync(path.join(tmpdir(), "sf-skills-install-"));
    temps.push(dest);

    const first = runInstall(["--source-dir", skillsRoot, "--dest-cwd", dest]);
    const second = runInstall(["--source-dir", skillsRoot, "--dest-cwd", dest]);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(installedSkillPaths(dest).every((p) => readFileSync(p).length > 0)).toBe(true);
  });

  it("removes legacy skill dirs only when SKILL.md name matches", () => {
    const dest = mkdtempSync(path.join(tmpdir(), "sf-skills-install-"));
    temps.push(dest);

    const matching = path.join(dest, ".cursor/skills/stageflow-setup");
    mkdirSync(matching, { recursive: true });
    writeFileSync(
      path.join(matching, "SKILL.md"),
      "---\nname: stageflow-setup\ndescription: old\n---\n\n# Old\n",
    );
    writeFileSync(path.join(matching, "note.txt"), "gone\n");

    const quoted = path.join(dest, ".claude/skills/stageflow-author");
    mkdirSync(quoted, { recursive: true });
    writeFileSync(
      path.join(quoted, "SKILL.md"),
      '---\nname: "stageflow-author"\ndescription: old\n---\n\n# Old\n',
    );

    const alsoMatching = [
      path.join(dest, ".cursor/skills/stageflow-session-capture"),
      path.join(dest, ".claude/skills/stageflow-delegate"),
      path.join(dest, ".agents/skills/stageflow-setup"),
    ];
    for (const dir of alsoMatching) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${path.basename(dir)}\ndescription: old\n---\n\n# Old\n`,
      );
    }

    const singleQuoted = path.join(dest, ".agents/skills/stageflow-run");
    mkdirSync(singleQuoted, { recursive: true });
    writeFileSync(
      path.join(singleQuoted, "SKILL.md"),
      "---\nname: 'stageflow-run'\ndescription: old\n---\n\n# Old\n",
    );

    const wrongName = path.join(dest, ".cursor/skills/stageflow-delegate");
    mkdirSync(wrongName, { recursive: true });
    writeFileSync(
      path.join(wrongName, "SKILL.md"),
      "---\nname: custom-delegate\ndescription: keep\n---\n\n# Keep\n",
    );

    const bodyOnly = path.join(dest, ".claude/skills/stageflow-session-capture");
    mkdirSync(bodyOnly, { recursive: true });
    writeFileSync(
      path.join(bodyOnly, "SKILL.md"),
      "---\nname: notes\ndescription: keep\n---\n\nname: stageflow-session-capture\n",
    );

    const noSkillMd = path.join(dest, ".agents/skills/stageflow-delegate");
    mkdirSync(noSkillMd, { recursive: true });
    writeFileSync(path.join(noSkillMd, "README.md"), "not a skill\n");

    const result = runInstall(["--source-dir", skillsRoot, "--dest-cwd", dest]);
    expect(result.status, result.stderr || result.stdout).toBe(0);

    expect(existsSync(matching)).toBe(false);
    expect(existsSync(quoted)).toBe(false);
    expect(existsSync(singleQuoted)).toBe(false);
    for (const dir of alsoMatching) {
      expect(existsSync(dir), dir).toBe(false);
    }
    expect(readFileSync(path.join(wrongName, "SKILL.md"), "utf8")).toContain("name: custom-delegate");
    expect(readFileSync(path.join(bodyOnly, "SKILL.md"), "utf8")).toContain("name: notes");
    expect(readFileSync(path.join(noSkillMd, "README.md"), "utf8")).toBe("not a skill\n");

    for (const skillMd of installedSkillPaths(dest)) {
      expect(existsSync(skillMd), skillMd).toBe(true);
    }
  });

  it("exits non-zero when --source-dir is missing stageflow/SKILL.md", () => {
    const source = mkdtempSync(path.join(tmpdir(), "sf-skills-empty-"));
    temps.push(source);

    const result = runInstall(["--source-dir", source, "--dest-cwd", source]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      path.join(source, "stageflow", "SKILL.md"),
    );
  });
});
