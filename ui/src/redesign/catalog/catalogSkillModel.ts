import type { PipelineListing, SkillListing, SkillUsageEntry } from "../../api";

export type SkillFilter =
  | "all"
  | "used"
  | "project"
  | "user"
  | "temporary"
  | "built-in";

export type SkillScopeLabel = "project" | "user" | "temporary" | "built-in";

export type SkillInvocationLabel = "model" | "command-only";

export type SkillUsages = Record<string, SkillUsageEntry>;

export type SkillGroupId = "used" | "available";

export type SkillGroup = {
  id: SkillGroupId;
  label: string;
  hint: string;
  skills: SkillListing[];
};

export const SKILL_FILTERS: { id: SkillFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "used", label: "Used by stages" },
  { id: "project", label: "Project" },
  { id: "user", label: "User" },
  { id: "temporary", label: "Temporary" },
  { id: "built-in", label: "Built-in" },
];

const EMPTY_USAGE: SkillUsageEntry = { stage_ids: [], pipeline_ids: [] };

export function isBuiltInSkill(skill: SkillListing): boolean {
  return /built-in/i.test(skill.source) || /built-in/i.test(skill.filePath);
}

export function skillScopeLabel(skill: SkillListing): SkillScopeLabel {
  return isBuiltInSkill(skill) ? "built-in" : skill.scope;
}

export function skillInvocationLabel(skill: SkillListing): SkillInvocationLabel {
  return skill.disableModelInvocation ? "command-only" : "model";
}

export function scopeHint(scope: SkillScopeLabel): string {
  switch (scope) {
    case "project":
      return "from this checkout";
    case "user":
      return "from this machine";
    case "temporary":
      return "from a run checkout";
    case "built-in":
      return "ships with Stageflow";
  }
}

export function invocationHint(invocation: SkillInvocationLabel): string {
  return invocation === "model"
    ? "agents may invoke it"
    : "only when the operator runs it";
}

export function skillUsage(usages: SkillUsages, name: string): SkillUsageEntry {
  return usages[name] ?? EMPTY_USAGE;
}

export function isUsedByStages(usages: SkillUsages, name: string): boolean {
  return skillUsage(usages, name).stage_ids.length > 0;
}

export function skillSourceLabel(skill: SkillListing): string {
  return skill.source ? skill.source : skill.filePath;
}

export function matchesSkillQuery(skill: SkillListing, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q) ||
    skill.source.toLowerCase().includes(q)
  );
}

export function matchesSkillFilter(
  skill: SkillListing,
  filter: SkillFilter,
  usages: SkillUsages,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "used":
      return isUsedByStages(usages, skill.name);
    case "built-in":
      return isBuiltInSkill(skill);
    default:
      return skill.scope === filter;
  }
}

export function skillFilterCounts(
  skills: SkillListing[],
  usages: SkillUsages,
): Record<SkillFilter, number> {
  const counts = {} as Record<SkillFilter, number>;
  for (const f of SKILL_FILTERS) {
    counts[f.id] = skills.filter((s) => matchesSkillFilter(s, f.id, usages))
      .length;
  }
  return counts;
}

export function visibleSkills(
  skills: SkillListing[],
  filter: SkillFilter,
  query: string,
  usages: SkillUsages,
): SkillListing[] {
  return skills.filter(
    (s) => matchesSkillQuery(s, query) && matchesSkillFilter(s, filter, usages),
  );
}

export function groupSkills(
  skills: SkillListing[],
  usages: SkillUsages,
): SkillGroup[] {
  const used: SkillListing[] = [];
  const available: SkillListing[] = [];
  for (const s of skills) {
    if (isUsedByStages(usages, s.name)) used.push(s);
    else available.push(s);
  }
  used.sort((a, b) => {
    const diff =
      skillUsage(usages, b.name).pipeline_ids.length -
      skillUsage(usages, a.name).pipeline_ids.length;
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
  available.sort((a, b) => a.name.localeCompare(b.name));
  const groups: SkillGroup[] = [];
  if (used.length > 0) {
    groups.push({
      id: "used",
      label: "Used by stages",
      hint: "A stage YAML sets skill: to these",
      skills: used,
    });
  }
  if (available.length > 0) {
    groups.push({
      id: "available",
      label: "Available",
      hint: "Loaded by Pi, no stage references them yet",
      skills: available,
    });
  }
  return groups;
}

export function flattenGroups(groups: SkillGroup[]): SkillListing[] {
  return groups.flatMap((g) => g.skills);
}

export function stepSelection(
  names: string[],
  current: string | null,
  delta: number,
): string | null {
  if (names.length === 0) return null;
  const idx = current ? names.indexOf(current) : -1;
  if (idx < 0) return names[0]!;
  const next = Math.min(names.length - 1, Math.max(0, idx + delta));
  return names[next]!;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i > 0 ? trimmed.slice(0, i) : trimmed;
}

export function skillsFolderLabel(skills: SkillListing[]): string {
  const dirs = new Set(skills.map((s) => parentDir(s.baseDir)));
  if (dirs.size === 1) return [...dirs][0]!;
  return ".pi/skills";
}

export function findSkillPipeline(
  pipelines: PipelineListing[],
  pipelineId: string,
  skillName: string,
): PipelineListing | null {
  return (
    pipelines.find(
      (p) =>
        p.id === pipelineId &&
        p.stages.some((s) => s.skill === skillName),
    ) ?? null
  );
}

export type SkillUsedByRow = {
  pipelineId: string | null;
  stageId: string;
};

export const USED_BY_CAP = 8;

export function usedByRows(entry: SkillUsageEntry): SkillUsedByRow[] {
  const stageId = entry.stage_ids[0] ?? "stage";
  if (entry.pipeline_ids.length > 0) {
    return entry.pipeline_ids
      .slice(0, USED_BY_CAP)
      .map((pipelineId) => ({ pipelineId, stageId }));
  }
  return entry.stage_ids
    .slice(0, USED_BY_CAP)
    .map((id) => ({ pipelineId: null, stageId: id }));
}
