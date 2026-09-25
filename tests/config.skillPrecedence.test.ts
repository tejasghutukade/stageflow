import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSkillsWithOrigin,
  resolveSkillByName,
} from "../src/config/listSkills.js";

async function writeSkill(
  dir: string,
  name: string,
  description: string,
): Promise<string> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
  return filePath;
}

describe("skill precedence", () => {
  const previousHome = process.env.HOME;
  let home: string;
  let cwd: string;
  let agentDir: string;
  let checkoutRoot: string;
  let runSkills: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-prec-home-"));
    cwd = await mkdtemp(path.join(tmpdir(), "sf-prec-cwd-"));
    checkoutRoot = await mkdtemp(path.join(tmpdir(), "sf-prec-co-"));
    runSkills = await mkdtemp(path.join(tmpdir(), "sf-prec-run-"));
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

  it("resolves run > checkout > host and reports origin", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "shared",
      "Host copy.",
    );
    await writeSkill(
      path.join(checkoutRoot, ".pi", "skills"),
      "shared",
      "Checkout copy.",
    );
    const runPath = await writeSkill(runSkills, "shared", "Run copy.");

    const resolved = await resolveSkillByName("shared", {
      cwd,
      agentDir,
      runSkillsDir: runSkills,
      checkoutRoot,
    });
    expect(resolved).toMatchObject({
      origin: "run",
      filePath: runPath,
    });

    const withoutRun = await resolveSkillByName("shared", {
      cwd,
      agentDir,
      checkoutRoot,
    });
    expect(withoutRun).toMatchObject({ origin: "checkout" });

    const hostOnly = await resolveSkillByName("shared", {
      cwd,
      agentDir,
    });
    expect(hostOnly).toMatchObject({ origin: "host" });
  });

  it("listSkillsWithOrigin merges with run winning on name", async () => {
    await writeSkill(
      path.join(agentDir, "skills"),
      "shared",
      "Host copy.",
    );
    await writeSkill(
      path.join(checkoutRoot, ".pi", "skills"),
      "shared",
      "Checkout copy.",
    );
    await writeSkill(runSkills, "shared", "Run copy.");
    await writeSkill(
      path.join(agentDir, "skills"),
      "host-only",
      "Host only.",
    );

    const listed = await listSkillsWithOrigin({
      cwd,
      agentDir,
      runSkillsDir: runSkills,
      checkoutRoot,
    });
    const byName = Object.fromEntries(
      listed.skills.map((s) => [s.name, s]),
    );
    expect(byName.shared).toEqual({
      name: "shared",
      description: "Run copy.",
      origin: "run",
    });
    expect(byName["host-only"]).toMatchObject({
      origin: "host",
      description: "Host only.",
    });
  });
});
