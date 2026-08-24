import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { listSkills, resolveSkillByName } from "../src/config/listSkills.js";

async function writeSkill(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  await writeFile(filePath, body, "utf8");
  return filePath;
}

describe("listSkills", () => {
  const previousHome = process.env.HOME;
  let cwd: string;
  let agentDir: string;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-skills-home-"));
    cwd = await mkdtemp(path.join(tmpdir(), "sf-skills-cwd-"));
    agentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("lists user and project skills from injected dirs", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "fixture-user-skill",
      "---\nname: fixture-user-skill\ndescription: User-scope fixture skill.\n---\n# User\n",
    );
    await writeSkill(
      path.join(cwd, ".pi", "skills"),
      "fixture-project-skill",
      "---\nname: fixture-project-skill\ndescription: Project-scope fixture skill.\n---\n# Project\n",
    );

    const catalog = await listSkills({ cwd, agentDir });
    const byName = Object.fromEntries(
      catalog.skills.map((skill) => [skill.name, skill]),
    );

    expect(byName["fixture-user-skill"]).toMatchObject({
      name: "fixture-user-skill",
      description: "User-scope fixture skill.",
      scope: "user",
      disableModelInvocation: false,
    });
    expect(byName["fixture-project-skill"]).toMatchObject({
      name: "fixture-project-skill",
      description: "Project-scope fixture skill.",
      scope: "project",
      disableModelInvocation: false,
    });
    expect(catalog.skills.map((s) => s.name)).toEqual(
      [...catalog.skills.map((s) => s.name)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("omits a skill missing description and records a diagnostic", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "fixture-valid-skill",
      "---\nname: fixture-valid-skill\ndescription: Has a description.\n---\n# Valid\n",
    );
    const invalidPath = await writeSkill(
      path.join(agentDir, "skills"),
      "fixture-no-desc",
      "---\nname: fixture-no-desc\n---\n# Missing description\n",
    );

    const catalog = await listSkills({ cwd, agentDir });
    expect(catalog.skills.map((s) => s.name)).toContain("fixture-valid-skill");
    expect(catalog.skills.map((s) => s.name)).not.toContain("fixture-no-desc");
    expect(
      catalog.diagnostics.some(
        (d) =>
          d.path === invalidPath && /description/i.test(d.message),
      ),
    ).toBe(true);
  });
});

describe("resolveSkillByName", () => {
  const previousHome = process.env.HOME;
  let cwd: string;
  let agentDir: string;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-resolve-home-"));
    cwd = await mkdtemp(path.join(tmpdir(), "sf-resolve-cwd-"));
    agentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  async function unsortedSkills() {
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
    });
    await loader.reload();
    return loader.getSkills().skills;
  }

  it("resolves user-scope and project-scope skills by name", async () => {
    const userPath = await writeSkill(
      path.join(agentDir, "skills"),
      "fixture-user-skill",
      "---\nname: fixture-user-skill\ndescription: User-scope fixture skill.\n---\n# User\n",
    );
    const projectPath = await writeSkill(
      path.join(cwd, ".pi", "skills"),
      "fixture-project-skill",
      "---\nname: fixture-project-skill\ndescription: Project-scope fixture skill.\n---\n# Project\n",
    );

    const user = await resolveSkillByName("fixture-user-skill", { cwd, agentDir });
    expect(user).toMatchObject({
      name: "fixture-user-skill",
      filePath: userPath,
      baseDir: path.join(agentDir, "skills", "fixture-user-skill"),
    });

    const project = await resolveSkillByName("fixture-project-skill", {
      cwd,
      agentDir,
    });
    expect(project).toMatchObject({
      name: "fixture-project-skill",
      filePath: projectPath,
      baseDir: path.join(cwd, ".pi", "skills", "fixture-project-skill"),
    });
  });

  it("returns the first unsorted catalog match for a duplicate name", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "shared-skill",
      "---\nname: shared-skill\ndescription: User copy.\n---\n# User\n",
    );
    await writeSkill(
      path.join(cwd, ".pi", "skills"),
      "shared-skill",
      "---\nname: shared-skill\ndescription: Project copy.\n---\n# Project\n",
    );

    const first = (await unsortedSkills()).find(
      (skill) => skill.name === "shared-skill",
    );
    expect(first).toBeDefined();
    const resolved = await resolveSkillByName("shared-skill", { cwd, agentDir });
    expect(resolved).toEqual({
      name: first!.name,
      filePath: first!.filePath,
      baseDir: first!.baseDir,
    });
  });

  it("returns undefined for an unknown name", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "fixture-user-skill",
      "---\nname: fixture-user-skill\ndescription: User-scope fixture skill.\n---\n# User\n",
    );
    expect(
      await resolveSkillByName("missing-skill", { cwd, agentDir }),
    ).toBeUndefined();
  });

  it("returns undefined for a diagnostic-only name", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "fixture-no-desc",
      "---\nname: fixture-no-desc\n---\n# Missing description\n",
    );
    expect(
      await resolveSkillByName("fixture-no-desc", { cwd, agentDir }),
    ).toBeUndefined();
  });

  it("returns undefined when the matched SKILL.md is unreadable", async () => {
    const filePath = await writeSkill(
      path.join(agentDir, "skills"),
      "locked-skill",
      "---\nname: locked-skill\ndescription: Locked fixture skill.\n---\n# Locked\n",
    );
    await chmod(filePath, 0);
    try {
      expect(
        await resolveSkillByName("locked-skill", { cwd, agentDir }),
      ).toBeUndefined();
    } finally {
      await chmod(filePath, 0o644);
    }
  });
});
