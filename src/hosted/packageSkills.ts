import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertValidSkillName,
  assertValidSkillRelativePath,
  validateSkillsPayload,
  type SkillsPayload,
} from "../runtime/runSkills.js";
import { isContained } from "./containment.js";

/** Skills shipped with a hosted package live at `<packageRoot>/.pi/skills/<name>/`. */
export async function loadPackageSkills(
  packageRoot: string,
): Promise<SkillsPayload | undefined> {
  const skillsRoot = path.join(packageRoot, ".pi", "skills");
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const skillsRootReal = await realpath(skillsRoot);
  if (!isContained(packageRoot, skillsRootReal)) {
    throw new Error("package skills directory escapes the package root");
  }

  const skills: SkillsPayload = {};
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const nameCheck = assertValidSkillName(entry.name);
    if (!nameCheck.ok) throw new Error(nameCheck.reason);
    const skillDir = path.join(skillsRoot, entry.name);
    let info;
    try {
      info = await stat(skillDir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const skillReal = await realpath(skillDir);
    if (!isContained(skillsRootReal, skillReal)) {
      throw new Error(`package skill "${entry.name}" escapes the package root`);
    }
    const files = await readSkillFiles(skillDir, skillReal);
    if (files["SKILL.md"] === undefined) continue;
    skills[entry.name] = files;
  }

  if (Object.keys(skills).length === 0) return undefined;
  const validated = validateSkillsPayload(skills);
  if (!validated.ok) throw new Error(validated.reason);
  return validated.skills;
}

async function readSkillFiles(
  skillDir: string,
  skillReal: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await walk(skillDir);
  return files;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(skillDir, abs);
      const real = await realpath(abs);
      if (!isContained(skillReal, real)) {
        throw new Error(`package skill file "${rel}" escapes the package root`);
      }
      const target = await stat(real);
      if (target.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!target.isFile()) continue;
      const pathCheck = assertValidSkillRelativePath(rel);
      if (!pathCheck.ok) throw new Error(pathCheck.reason);
      files[rel] = await readFile(real, "utf8");
    }
  }
}
