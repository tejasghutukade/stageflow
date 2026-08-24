import { access } from "node:fs/promises";
import {
  DefaultResourceLoader,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export type SkillScope = "user" | "project" | "temporary";

export type SkillListing = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: SkillScope;
  source: string;
  disableModelInvocation: boolean;
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
};

export type ResolvedSkill = {
  name: string;
  filePath: string;
  baseDir: string;
};

function toListing(skill: Skill): SkillListing {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    scope: skill.sourceInfo.scope,
    source: skill.sourceInfo.source,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

async function openSkillCatalogLoader(
  options: ListSkillsOptions,
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

export async function resolveSkillByName(
  name: string,
  options: ListSkillsOptions,
): Promise<ResolvedSkill | undefined> {
  const loader = await openSkillCatalogLoader(options);
  const match = loader.getSkills().skills.find((skill) => skill.name === name);
  if (!match) return undefined;
  try {
    await access(match.filePath);
  } catch {
    return undefined;
  }
  return {
    name: match.name,
    filePath: match.filePath,
    baseDir: match.baseDir,
  };
}

export async function listSkills(
  options: ListSkillsOptions,
): Promise<SkillCatalog> {
  const loader = await openSkillCatalogLoader(options);
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: skills
      .map(toListing)
      .sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics: diagnostics.map((d) => ({
      message: d.message,
      ...(d.path !== undefined ? { path: d.path } : {}),
    })),
  };
}
