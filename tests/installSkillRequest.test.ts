import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  installSkillFromCommand,
  locateSkillDirectory,
  parseInstallSkillBody,
  parseSkillsAddCommand,
  resolveGitCloneUrl,
} from "../src/config/installSkillRequest.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = path.join(root, "tests", "fixtures", "skills", "test-skill-source");
const mdOnlySkill = path.join(root, "tests", "fixtures", "skills", "md-only-skill");

describe("parseSkillsAddCommand", () => {
  it("parses npx skills add with URL and --skill", () => {
    const parsed = parseSkillsAddCommand(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );
    expect(parsed).toEqual({
      source: "https://github.com/vercel-labs/skills",
      skillName: "find-skills",
    });
  });

  it("parses owner/repo slug and bare skills add", () => {
    const parsed = parseSkillsAddCommand(
      "skills add tejasghutukade/stageflow --skill stageflow-run",
    );
    expect(parsed).toEqual({
      source: "tejasghutukade/stageflow",
      skillName: "stageflow-run",
    });
  });

  it("allows omitting --skill", () => {
    expect(parseSkillsAddCommand("npx skills add owner/repo")).toEqual({
      source: "owner/repo",
    });
  });

  it("rejects empty command, unknown flags, and missing source", () => {
    expect(parseSkillsAddCommand("")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/non-empty/),
    });
    expect(parseSkillsAddCommand("npx skills add owner/repo --foo x")).toMatchObject({
      ok: false,
      error: "unknown flag: --foo",
    });
    expect(parseSkillsAddCommand("npx skills add --skill only")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/missing skill source/),
    });
    expect(parseSkillsAddCommand("npm skills add owner/repo")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/npx skills add/),
    });
  });
});

describe("parseInstallSkillBody", () => {
  it("requires command string", () => {
    expect(parseInstallSkillBody({})).toMatchObject({
      ok: false,
      error: "command must be a non-empty string",
    });
    expect(parseInstallSkillBody({ command: "npx skills add owner/repo" })).toEqual({
      command: "npx skills add owner/repo",
    });
  });
});

describe("resolveGitCloneUrl", () => {
  it("normalizes GitHub HTTPS and owner/repo", () => {
    expect(resolveGitCloneUrl("https://github.com/vercel-labs/skills")).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(resolveGitCloneUrl("https://github.com/vercel-labs/skills.git")).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(resolveGitCloneUrl("tejasghutukade/stageflow")).toBe(
      "https://github.com/tejasghutukade/stageflow.git",
    );
  });
});

describe("locateSkillDirectory", () => {
  it("finds nested skills/name and requires --skill when multiple", async () => {
    const locateRoot = await mkdtemp(path.join(tmpdir(), "sf-skill-locate-"));
    await mkdir(path.join(locateRoot, "skills", "alpha"), { recursive: true });
    await mkdir(path.join(locateRoot, "skills", "beta"), { recursive: true });
    await writeFile(path.join(locateRoot, "skills", "alpha", "SKILL.md"), "# a\n", "utf8");
    await writeFile(path.join(locateRoot, "skills", "beta", "SKILL.md"), "# b\n", "utf8");

    await expect(locateSkillDirectory(locateRoot)).rejects.toThrow(/multiple skills/);
    const located = await locateSkillDirectory(locateRoot, "beta");
    expect(located).toEqual({
      name: "beta",
      root: path.join(locateRoot, "skills", "beta"),
    });
  });

  it("uses the sole root SKILL.md when --skill omitted", async () => {
    const locateRoot = await mkdtemp(path.join(tmpdir(), "sf-skill-locate-one-"));
    await writeFile(
      path.join(locateRoot, "SKILL.md"),
      "---\nname: solo\ndescription: x\n---\n",
      "utf8",
    );
    await expect(locateSkillDirectory(locateRoot)).resolves.toEqual({
      name: "solo",
      root: path.resolve(locateRoot),
    });
  });
});

describe("installSkillFromCommand", () => {
  it("installs from file: URL via local tree", async () => {
    const repo = await initTempGitRepo();
    try {
      const result = await installSkillFromCommand({
        projectRoot: repo.root,
        command: `npx skills add ${pathToFileURL(skillSource).href} --skill test-skill`,
      });
      expect(result).toMatchObject({
        ok: true,
        skill_name: "test-skill",
        project_root: repo.root,
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.dest_path).toBe(path.join(repo.root, ".pi", "skills", "test-skill"));
    } finally {
      await repo.cleanup();
    }
  });

  it("clones via injectable cloneRepo then installs SKILL.md-only skill", async () => {
    const repo = await initTempGitRepo();
    const skillMd = await readFile(path.join(mdOnlySkill, "SKILL.md"), "utf8");
    try {
      const result = await installSkillFromCommand({
        projectRoot: repo.root,
        command: "npx skills add owner/md-only --skill md-only-skill",
        cloneRepo: async (_url, destDir) => {
          await mkdir(destDir, { recursive: true });
          await writeFile(path.join(destDir, "SKILL.md"), skillMd, "utf8");
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.skill_name).toBe("md-only-skill");
      await access(path.join(repo.root, ".pi", "skills", "md-only-skill", "SKILL.md"));
    } finally {
      await repo.cleanup();
    }
  });
});
