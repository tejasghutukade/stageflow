import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installProjectSkill,
  type InstallProjectSkillResult,
} from "../cli/skillsCommand.js";
import { runGit } from "../git/exec.js";

export type InstallSkillParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type ParsedInstallSkillRequest = {
  command: string;
};

export type ParsedSkillsAddCommand = {
  source: string;
  skillName?: string;
};

export type SkillCloneFn = (cloneUrl: string, destDir: string) => Promise<void>;

export type InstallSkillFromCommandResult =
  | {
      ok: true;
      skill_name: string;
      dest_path: string;
      project_root: string;
    }
  | { ok: false; error: string; doctorFailed?: boolean; status?: 400 | 422 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

export function parseSkillsAddCommand(
  command: string,
): ParsedSkillsAddCommand | InstallSkillParseError {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { ok: false, status: 400, error: "command must be a non-empty string" };
  }

  const tokens = tokenizeCommand(trimmed);
  let rest: string[];
  if (tokens[0] === "npx" && tokens[1] === "skills" && tokens[2] === "add") {
    rest = tokens.slice(3);
  } else if (tokens[0] === "skills" && tokens[1] === "add") {
    rest = tokens.slice(2);
  } else {
    return {
      ok: false,
      status: 400,
      error: "command must be 'npx skills add <source> [--skill <name>]' or 'skills add …'",
    };
  }

  let source: string | undefined;
  let skillName: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--skill") {
      const value = rest[++i];
      if (value === undefined || value.length === 0) {
        return { ok: false, status: 400, error: "missing value for --skill" };
      }
      if (value.startsWith("-")) {
        return { ok: false, status: 400, error: "missing value for --skill" };
      }
      skillName = value;
    } else if (arg.startsWith("-")) {
      return { ok: false, status: 400, error: `unknown flag: ${arg}` };
    } else if (source === undefined) {
      source = arg;
    } else {
      return { ok: false, status: 400, error: `unexpected argument: ${arg}` };
    }
  }

  if (source === undefined) {
    return { ok: false, status: 400, error: "missing skill source after 'add'" };
  }

  return {
    source,
    ...(skillName !== undefined ? { skillName } : {}),
  };
}

export function parseInstallSkillBody(
  body: unknown,
): ParsedInstallSkillRequest | InstallSkillParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  if (typeof body.command !== "string" || body.command.trim().length === 0) {
    return { ok: false, status: 400, error: "command must be a non-empty string" };
  }

  const parsed = parseSkillsAddCommand(body.command);
  if ("ok" in parsed) {
    return parsed;
  }

  return { command: body.command.trim() };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFrontmatterName(skillMdPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(skillMdPath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!match) return undefined;
    const nameLine = /^name:\s*(.+)\s*$/m.exec(match[1] ?? "");
    const value = nameLine?.[1]?.trim();
    if (value === undefined || value.length === 0) return undefined;
    return value.replace(/^['"]|['"]$/g, "");
  } catch {
    return undefined;
  }
}

export type LocatedSkill = {
  name: string;
  root: string;
};

export async function locateSkillDirectory(
  checkoutRoot: string,
  skillName?: string,
): Promise<LocatedSkill> {
  const candidates: LocatedSkill[] = [];
  const seen = new Set<string>();

  const pushCandidate = (name: string, root: string) => {
    const key = path.resolve(root);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ name, root: key });
  };

  const rootSkillMd = path.join(checkoutRoot, "SKILL.md");
  if (await pathExists(rootSkillMd)) {
    const name =
      (await readFrontmatterName(rootSkillMd)) ?? path.basename(path.resolve(checkoutRoot));
    pushCandidate(name, checkoutRoot);
  }

  let entries;
  try {
    entries = await readdir(checkoutRoot, { withFileTypes: true });
  } catch {
    throw new Error("skill source directory not found");
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "skills") {
      continue;
    }
    const skillMd = path.join(checkoutRoot, entry.name, "SKILL.md");
    if (await pathExists(skillMd)) {
      pushCandidate(entry.name, path.join(checkoutRoot, entry.name));
    }
  }

  const skillsDir = path.join(checkoutRoot, "skills");
  try {
    const skillsStat = await stat(skillsDir);
    if (skillsStat.isDirectory()) {
      const skillEntries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        if (await pathExists(skillMd)) {
          pushCandidate(entry.name, path.join(skillsDir, entry.name));
        }
      }
    }
  } catch {
    // no skills/ directory
  }

  if (skillName !== undefined) {
    const namedPaths = [
      path.join(checkoutRoot, skillName, "SKILL.md"),
      path.join(checkoutRoot, "skills", skillName, "SKILL.md"),
    ];
    for (const skillMd of namedPaths) {
      if (await pathExists(skillMd)) {
        return { name: skillName, root: path.dirname(skillMd) };
      }
    }
    const match = candidates.find((candidate) => candidate.name === skillName);
    if (match !== undefined) {
      return match;
    }
    throw new Error(`skill "${skillName}" not found in source`);
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }
  if (candidates.length === 0) {
    throw new Error("no SKILL.md found in source");
  }
  const names = candidates.map((candidate) => candidate.name).join(", ");
  throw new Error(`multiple skills found (${names}); pass --skill <name>`);
}

export function resolveGitCloneUrl(source: string): string {
  const githubHttps =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/i.exec(
      source,
    );
  if (githubHttps) {
    return `https://github.com/${githubHttps[1]}/${githubHttps[2]}.git`;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    return `https://github.com/${source}.git`;
  }

  throw new Error(
    "source must be a GitHub HTTPS URL, owner/repo slug, or file: URL",
  );
}

export async function defaultCloneSkillRepo(
  cloneUrl: string,
  destDir: string,
): Promise<void> {
  await runGit({
    args: ["clone", "--depth", "1", "--single-branch", cloneUrl, destDir],
    timeoutMs: 120_000,
  });
}

function resolveFileSource(source: string): string {
  if (source.startsWith("file:")) {
    return fileURLToPath(source);
  }
  throw new Error("source must be a GitHub HTTPS URL, owner/repo slug, or file: URL");
}

export async function installSkillFromCommand(input: {
  projectRoot: string;
  command: string;
  cloneRepo?: SkillCloneFn;
}): Promise<InstallSkillFromCommandResult> {
  const parsed = parseSkillsAddCommand(input.command);
  if ("ok" in parsed) {
    return { ok: false, error: parsed.error, status: parsed.status };
  }

  let cleanup: (() => Promise<void>) | undefined;
  try {
    let checkoutRoot: string;
    if (parsed.source.startsWith("file:")) {
      checkoutRoot = resolveFileSource(parsed.source);
      try {
        const sourceStat = await stat(checkoutRoot);
        if (!sourceStat.isDirectory()) {
          return { ok: false, error: "skill source path not found", status: 400 };
        }
      } catch {
        return { ok: false, error: "skill source path not found", status: 400 };
      }
    } else {
      let cloneUrl: string;
      try {
        cloneUrl = resolveGitCloneUrl(parsed.source);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          status: 400,
        };
      }
      const tempRoot = await mkdtemp(path.join(tmpdir(), "sf-skill-clone-"));
      cleanup = async () => {
        await rm(tempRoot, { recursive: true, force: true });
      };
      const cloneDest = path.join(tempRoot, "repo");
      const cloneRepo = input.cloneRepo ?? defaultCloneSkillRepo;
      await cloneRepo(cloneUrl, cloneDest);
      checkoutRoot = cloneDest;
    }

    const located = await locateSkillDirectory(checkoutRoot, parsed.skillName);
    const result: InstallProjectSkillResult = await installProjectSkill({
      projectRoot: input.projectRoot,
      fromPath: located.root,
      skillName: located.name,
      io: {
        log: () => undefined,
        error: () => undefined,
      },
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        ...(result.doctorFailed ? { doctorFailed: true, status: 422 as const } : { status: 400 as const }),
      };
    }

    return {
      ok: true,
      skill_name: result.skillName,
      dest_path: result.destPath,
      project_root: input.projectRoot,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 400,
    };
  } finally {
    if (cleanup !== undefined) {
      await cleanup();
    }
  }
}

/** Test helper: build a file: command for a local skill tree. */
export function skillsAddFileCommand(
  fromPath: string,
  skillName?: string,
): string {
  const source = pathToFileURL(path.resolve(fromPath)).href;
  if (skillName === undefined) {
    return `npx skills add ${source}`;
  }
  return `npx skills add ${source} --skill ${skillName}`;
}
