import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { START_PAYLOAD_MAX_BYTES } from "./startPayload.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";

export const SKILLS_INVALID_NAME = "skills_invalid_name" as const;
export const SKILLS_INVALID_PATH = "skills_invalid_path" as const;
export const SKILLS_MISSING_SKILL_MD = "skills_missing_skill_md" as const;
export const SKILLS_PAYLOAD_TOO_LARGE = "skills_payload_too_large" as const;

export type SkillsPayloadErrorCode =
  | typeof SKILLS_INVALID_NAME
  | typeof SKILLS_INVALID_PATH
  | typeof SKILLS_MISSING_SKILL_MD
  | typeof SKILLS_PAYLOAD_TOO_LARGE;

/** name → relativePath → utf-8 file contents */
export type SkillsPayload = Record<string, Record<string, string>>;

export type SkillsValidationOk = {
  ok: true;
  skills: SkillsPayload;
  bytes: number;
};

export type SkillsValidationErr = {
  ok: false;
  code: SkillsPayloadErrorCode;
  reason: string;
  bytes?: number;
  maxBytes?: number;
};

export type SkillsValidationResult = SkillsValidationOk | SkillsValidationErr;

const SKILL_MD = "SKILL.md";

export function runSkillsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "skills");
}

export function skillPackDir(workspaceDir: string, skillName: string): string {
  return path.join(runSkillsDir(workspaceDir), skillName);
}

function hasForbiddenNameChars(name: string): boolean {
  return (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes("\u0000")
  );
}

function hasDotDotSegment(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  return normalized.split("/").some((segment) => segment === "..");
}

export function assertValidSkillName(
  name: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, reason: "Skill name must be a non-empty string" };
  }
  if (hasForbiddenNameChars(name)) {
    return {
      ok: false,
      reason: `Skill name "${name}" must not contain "/", "\\\\", or NUL`,
    };
  }
  if (path.isAbsolute(name) || hasDotDotSegment(name) || name === "..") {
    return {
      ok: false,
      reason: `Skill name "${name}" must not be absolute or contain ".."`,
    };
  }
  return { ok: true };
}

export function assertValidSkillRelativePath(
  relPath: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, reason: "Skill file path must be a non-empty string" };
  }
  if (path.isAbsolute(relPath) || hasDotDotSegment(relPath)) {
    return {
      ok: false,
      reason: `Skill file path "${relPath}" must be relative and must not contain ".."`,
    };
  }
  return { ok: true };
}

export function measureSkillsPayloadBytes(skills: SkillsPayload): number {
  let bytes = 0;
  for (const files of Object.values(skills)) {
    for (const content of Object.values(files)) {
      bytes += Buffer.byteLength(content, "utf8");
    }
  }
  return bytes;
}

export function validateSkillsPayload(
  skills: unknown,
  options?: { pipelineBytes?: number; maxBytes?: number },
): SkillsValidationResult {
  if (skills === undefined || skills === null) {
    return { ok: true, skills: {}, bytes: 0 };
  }
  if (typeof skills !== "object" || Array.isArray(skills)) {
    return {
      ok: false,
      code: SKILLS_INVALID_NAME,
      reason: "skills must be a map of name → { relativePath: contents }",
    };
  }

  const maxBytes = options?.maxBytes ?? START_PAYLOAD_MAX_BYTES;
  const pipelineBytes = options?.pipelineBytes ?? 0;
  const out: SkillsPayload = {};

  for (const [name, files] of Object.entries(skills as Record<string, unknown>)) {
    const nameCheck = assertValidSkillName(name);
    if (!nameCheck.ok) {
      return { ok: false, code: SKILLS_INVALID_NAME, reason: nameCheck.reason };
    }
    if (files === null || typeof files !== "object" || Array.isArray(files)) {
      return {
        ok: false,
        code: SKILLS_MISSING_SKILL_MD,
        reason: `Skill "${name}" must map to a files object including ${SKILL_MD}`,
      };
    }
    const fileMap: Record<string, string> = {};
    let hasSkillMd = false;
    for (const [relPath, content] of Object.entries(
      files as Record<string, unknown>,
    )) {
      const pathCheck = assertValidSkillRelativePath(relPath);
      if (!pathCheck.ok) {
        return {
          ok: false,
          code: SKILLS_INVALID_PATH,
          reason: pathCheck.reason,
        };
      }
      if (typeof content !== "string") {
        return {
          ok: false,
          code: SKILLS_INVALID_PATH,
          reason: `Skill "${name}" file "${relPath}" content must be a UTF-8 string`,
        };
      }
      if (relPath === SKILL_MD || relPath.replace(/\\/g, "/") === SKILL_MD) {
        hasSkillMd = true;
      }
      fileMap[relPath] = content;
    }
    if (!hasSkillMd) {
      return {
        ok: false,
        code: SKILLS_MISSING_SKILL_MD,
        reason: `Skill "${name}" requires ${SKILL_MD}`,
      };
    }
    out[name] = fileMap;
  }

  const bytes = measureSkillsPayloadBytes(out);
  if (pipelineBytes + bytes > maxBytes) {
    return {
      ok: false,
      code: SKILLS_PAYLOAD_TOO_LARGE,
      reason: `Start payload (pipeline + skills) is ${pipelineBytes + bytes} bytes; max is ${maxBytes}`,
      bytes: pipelineBytes + bytes,
      maxBytes,
    };
  }
  return { ok: true, skills: out, bytes };
}

export async function materializeRunSkills(
  workspaceDir: string,
  skills: SkillsPayload,
): Promise<void> {
  if (Object.keys(skills).length === 0) return;

  const skillsRoot = runSkillsDir(workspaceDir);
  await mkdir(skillsRoot, { recursive: true });
  const skillsRootReal = await realpath(skillsRoot);

  for (const [name, files] of Object.entries(skills)) {
    const nameCheck = assertValidSkillName(name);
    if (!nameCheck.ok) {
      throw new Error(nameCheck.reason);
    }
    const destDir = skillPackDir(workspaceDir, name);
    await mkdir(destDir, { recursive: true });
    const destDirResolved = path.resolve(destDir);
    if (!isInsideDir(destDirResolved, path.resolve(skillsRoot))) {
      throw new Error(
        `Skill "${name}" destination escapes run skills directory`,
      );
    }
    const destDirReal = await realpath(destDir);
    if (!isInsideDir(destDirReal, skillsRootReal)) {
      throw new Error(
        `Skill "${name}" destination realpath escapes run skills directory`,
      );
    }

    for (const [relPath, content] of Object.entries(files)) {
      const pathCheck = assertValidSkillRelativePath(relPath);
      if (!pathCheck.ok) {
        throw new Error(pathCheck.reason);
      }
      const dest = path.resolve(destDir, relPath);
      if (!isInsideDir(dest, destDirResolved)) {
        throw new Error(
          `Skill "${name}" file "${relPath}" escapes skill pack directory`,
        );
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
      const fileReal = await realpath(dest);
      if (!isInsideDir(fileReal, destDirReal)) {
        throw new Error(
          `Skill "${name}" file "${relPath}" realpath escapes skill pack directory`,
        );
      }
    }
  }
}
