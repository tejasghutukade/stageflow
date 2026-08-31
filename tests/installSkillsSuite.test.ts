import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "skills", "install-suite.sh");
const skillsRoot = path.join(root, "skills");
const verifyScript = path.join(root, "scripts", "verify-pack.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const SKILLS = [
  "stageflow",
  "stageflow-setup",
  "stageflow-session-capture",
  "stageflow-author",
  "stageflow-run",
  "stageflow-delegate",
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

  it("copies all six skills into the three harness targets", () => {
    const dest = mkdtempSync(path.join(tmpdir(), "sf-skills-install-"));
    temps.push(dest);

    const result = runInstall(["--source-dir", skillsRoot, "--dest-cwd", dest]);
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const installed = installedSkillPaths(dest);
    expect(installed).toHaveLength(18);
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

describe("skills suite packaging", () => {
  it("lists skills in package.json files and verify-pack REQUIRED", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("skills");
    expect(readFileSync(verifyScript, "utf8")).toContain('"skills/stageflow/SKILL.md"');
  });

  it("fails verify-pack when skills is removed from package.json files", () => {
    const pkgPath = path.join(root, "package.json");
    const original = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(original) as { files: string[] };
    if (!pkg.files.includes("skills")) {
      expect(pkg.files).toContain("skills");
      return;
    }

    try {
      writeFileSync(
        pkgPath,
        `${JSON.stringify({ ...pkg, files: pkg.files.filter((f) => f !== "skills") }, null, 2)}\n`,
      );
      const result = spawnSync(process.execPath, [tsxCli, verifyScript], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/skills\/stageflow\/SKILL\.md/);
    } finally {
      writeFileSync(pkgPath, original);
    }
  });
});
