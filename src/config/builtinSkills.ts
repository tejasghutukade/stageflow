import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_SKILL_NAME = "browser";

const BUILTIN_SKILL_NAMES = new Set([BROWSER_SKILL_NAME]);

export function isBuiltinSkillName(name: string): boolean {
  return BUILTIN_SKILL_NAMES.has(name);
}

/** Absolute SKILL.md of a skill shipped inside the package, if present on disk. */
export function resolveBuiltinSkillFile(
  name: string,
  fromUrl: string = import.meta.url,
): string | undefined {
  if (!isBuiltinSkillName(name)) return undefined;
  const here = path.dirname(fileURLToPath(fromUrl));
  for (const root of [
    path.resolve(here, "../../builtin-skills"),
    path.resolve(here, "../../../builtin-skills"),
  ]) {
    const file = path.join(root, name, "SKILL.md");
    if (existsSync(file)) return file;
  }
  return undefined;
}
