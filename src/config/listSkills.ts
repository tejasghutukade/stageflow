import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export type SkillScope = "user" | "project" | "temporary";

/** Skill resolution origin — separate from ConfigOriginKind. */
export type SkillOrigin = "run" | "checkout" | "host";

export type SkillListing = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: SkillScope;
  source: string;
  disableModelInvocation: boolean;
  origin?: SkillOrigin;
};

export type SkillDiagnostic = {
  message: string;
  path?: string;
};

export type SkillCatalog = {
  skills: SkillListing[];
  diagnostics: SkillDiagnostic[];
};

export type ListSkillsOptions = {
  cwd: string;
  agentDir: string;
  /** Materialized run skills root: `$STAGEFLOW_HOME/runs/<runId>/skills`. */
  runSkillsDir?: string;
  /** Checkout / worktree root whose `.pi/skills` is the checkout tier. */
  checkoutRoot?: string;
};

export type ResolvedSkill = {
  name: string;
  filePath: string;
  baseDir: string;
  scope: SkillScope;
  source: string;
  origin: SkillOrigin;
};

export type SkillOriginListing = {
  name: string;
  description: string;
  origin: SkillOrigin;
};

function toListing(skill: Skill, origin?: SkillOrigin): SkillListing {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    scope: skill.sourceInfo.scope,
    source: skill.sourceInfo.source,
    disableModelInvocation: skill.disableModelInvocation,
    ...(origin !== undefined ? { origin } : {}),
  };
}

function isUnderRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function descriptionFromSkillMd(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return undefined;
  const block = match[1]!;
  const descLine = /^description:\s*(.*)$/m.exec(block);
  if (!descLine) return undefined;
  let value = descLine[1]!.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

async function openSkillCatalogLoader(
  options: Pick<ListSkillsOptions, "cwd" | "agentDir">,
): Promise<DefaultResourceLoader> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: true,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });
  await loader.reload();
  return loader;
}

async function resolveRunSkill(
  name: string,
  runSkillsDir: string,
): Promise<ResolvedSkill | undefined> {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return undefined;
  }
  const baseDir = path.join(runSkillsDir, name);
  const filePath = path.join(baseDir, "SKILL.md");
  if (!(await pathExists(filePath))) return undefined;
  return {
    name,
    filePath,
    baseDir,
    scope: "temporary",
    source: "run",
    origin: "run",
  };
}

async function resolveCheckoutSkill(
  name: string,
  checkoutRoot: string,
): Promise<ResolvedSkill | undefined> {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return undefined;
  }
  const baseDir = path.join(checkoutRoot, ".pi", "skills", name);
  const filePath = path.join(baseDir, "SKILL.md");
  if (!(await pathExists(filePath))) return undefined;
  return {
    name,
    filePath,
    baseDir,
    scope: "project",
    source: "checkout",
    origin: "checkout",
  };
}

function originForLoaderSkill(
  skill: Skill,
  options: ListSkillsOptions,
): SkillOrigin {
  if (
    options.checkoutRoot !== undefined &&
    isUnderRoot(skill.filePath, path.join(options.checkoutRoot, ".pi", "skills"))
  ) {
    return "checkout";
  }
  if (isUnderRoot(skill.filePath, path.join(options.agentDir, "skills"))) {
    return "host";
  }
  if (skill.sourceInfo.scope === "project") {
    return "checkout";
  }
  return "host";
}

/**
 * Resolve a skill by name. Search order: run skills → checkout `.pi/skills` → host agentDir.
 */
export async function resolveSkillByName(
  name: string,
  options: ListSkillsOptions,
): Promise<ResolvedSkill | undefined> {
  if (options.runSkillsDir !== undefined) {
    const run = await resolveRunSkill(name, options.runSkillsDir);
    if (run) return run;
  }
  if (options.checkoutRoot !== undefined) {
    const checkout = await resolveCheckoutSkill(name, options.checkoutRoot);
    if (checkout) return checkout;
  }

  const loader = await openSkillCatalogLoader(options);
  const match = loader.getSkills().skills.find((skill) => skill.name === name);
  if (!match) return undefined;
  try {
    await access(match.filePath);
  } catch {
    return undefined;
  }
  if (
    options.checkoutRoot !== undefined &&
    isUnderRoot(match.filePath, path.join(options.checkoutRoot, ".pi", "skills"))
  ) {
    return {
      name: match.name,
      filePath: match.filePath,
      baseDir: match.baseDir,
      scope: match.sourceInfo.scope,
      source: match.sourceInfo.source,
      origin: "checkout",
    };
  }
  return {
    name: match.name,
    filePath: match.filePath,
    baseDir: match.baseDir,
    scope: match.sourceInfo.scope,
    source: match.sourceInfo.source,
    origin: originForLoaderSkill(match, options),
  };
}

export async function listSkills(
  options: ListSkillsOptions,
): Promise<SkillCatalog> {
  const loader = await openSkillCatalogLoader(options);
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: skills
      .map((skill) => toListing(skill, originForLoaderSkill(skill, options)))
      .sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics: diagnostics.map((d) => ({
      message: d.message,
      ...(d.path !== undefined ? { path: d.path } : {}),
    })),
  };
}

async function listRunSkillOrigins(
  runSkillsDir: string,
): Promise<SkillOriginListing[]> {
  let names: string[];
  try {
    names = await readdir(runSkillsDir);
  } catch {
    return [];
  }
  const out: SkillOriginListing[] = [];
  for (const name of names) {
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
      continue;
    }
    const filePath = path.join(runSkillsDir, name, "SKILL.md");
    try {
      const content = await readFile(filePath, "utf8");
      const description = descriptionFromSkillMd(content);
      if (description === undefined) continue;
      out.push({ name, description, origin: "run" });
    } catch {
      // skip unreadable / incomplete packs
    }
  }
  return out;
}

/**
 * List skills with SkillOrigin. When runSkillsDir is set, run-tier skills win on name.
 * Precedence for the merged view: run → checkout → host.
 */
export async function listSkillsWithOrigin(
  options: ListSkillsOptions,
): Promise<{ skills: SkillOriginListing[]; diagnostics: SkillDiagnostic[] }> {
  const byName = new Map<string, SkillOriginListing>();

  const hostCatalog = await listSkills({
    cwd: options.cwd,
    agentDir: options.agentDir,
    ...(options.checkoutRoot !== undefined
      ? { checkoutRoot: options.checkoutRoot }
      : {}),
  });

  for (const skill of hostCatalog.skills) {
    const origin =
      skill.origin ??
      (skill.scope === "project" ? ("checkout" as const) : ("host" as const));
    byName.set(skill.name, {
      name: skill.name,
      description: skill.description,
      origin,
    });
  }

  if (options.checkoutRoot !== undefined) {
    let checkoutNames: string[] = [];
    try {
      checkoutNames = await readdir(
        path.join(options.checkoutRoot, ".pi", "skills"),
      );
    } catch {
      checkoutNames = [];
    }
    for (const name of checkoutNames) {
      const filePath = path.join(
        options.checkoutRoot,
        ".pi",
        "skills",
        name,
        "SKILL.md",
      );
      try {
        const content = await readFile(filePath, "utf8");
        const description = descriptionFromSkillMd(content);
        if (description === undefined) continue;
        byName.set(name, { name, description, origin: "checkout" });
      } catch {
        // skip
      }
    }
  }

  if (options.runSkillsDir !== undefined) {
    for (const skill of await listRunSkillOrigins(options.runSkillsDir)) {
      byName.set(skill.name, skill);
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics: hostCatalog.diagnostics,
  };
}
