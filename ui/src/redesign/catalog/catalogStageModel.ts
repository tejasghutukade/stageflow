import { parse as parseYaml } from "yaml";
import type {
  PipelineListing,
  RunSummary,
  SkillListing,
  SkillUsageIndex,
  StageGateKind,
} from "../../api";
import { summaryStageStats, type StageStats } from "../editor/editorStageStats";
import { formatDurationShort } from "../editor/editorGraphLayout";
import type { StageRowFromPipelines } from "./stagesFromPipelines";

export const STAGE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const GATE_KIND_OPTIONS: StageGateKind[] = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
];

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type GateChipSummary = { first: string | null; extra: number };

export function gateChipSummary(kinds?: readonly string[]): GateChipSummary {
  if (!kinds || kinds.length === 0) return { first: null, extra: 0 };
  return { first: kinds[0]!, extra: kinds.length - 1 };
}

export function passPercentLabel(passRate?: number): string {
  if (passRate === undefined || !Number.isFinite(passRate)) return "—";
  return `${Math.round(passRate * 100)}%`;
}

export function avgCellLabel(stats?: StageStats | null): string {
  if (!stats || stats.runs <= 0) return "no runs";
  const hasMs = stats.avgMs !== undefined && Number.isFinite(stats.avgMs);
  const hasCost =
    stats.avgCostUsd !== undefined && Number.isFinite(stats.avgCostUsd);
  const cost = hasCost ? `$${stats.avgCostUsd!.toFixed(2)}` : null;
  if (hasMs) {
    const duration = formatDurationShort(stats.avgMs!);
    return cost ? `${duration} · ${cost}` : duration;
  }
  return cost ?? "no runs";
}

export function stageMatchesQuery(
  row: StageRowFromPipelines,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [row.id, row.model, row.skill, ...row.used_by_pipeline_ids];
  return haystack.some(
    (value) => typeof value === "string" && value.toLowerCase().includes(q),
  );
}

export function filterStageRows(
  rows: readonly StageRowFromPipelines[],
  query: string,
): StageRowFromPipelines[] {
  return rows.filter((row) => stageMatchesQuery(row, query));
}

export type StageGroups = {
  inUse: StageRowFromPipelines[];
  unused: StageRowFromPipelines[];
};

export function groupStageRows(
  rows: readonly StageRowFromPipelines[],
): StageGroups {
  const inUse = rows
    .filter((row) => row.used_by_pipeline_ids.length > 0)
    .sort(
      (a, b) =>
        b.used_by_pipeline_ids.length - a.used_by_pipeline_ids.length ||
        a.id.localeCompare(b.id) ||
        (a.project_root ?? "").localeCompare(b.project_root ?? ""),
    );
  const unused = rows
    .filter((row) => row.used_by_pipeline_ids.length === 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { inUse, unused };
}

export function orderedRowKeys(groups: StageGroups): string[] {
  return [...groups.inUse, ...groups.unused].map((row) => row.rowKey);
}

export function stepSelection(
  keys: readonly string[],
  current: string | null,
  delta: number,
): string | null {
  if (keys.length === 0) return null;
  const index = current ? keys.indexOf(current) : -1;
  if (index < 0) return keys[0]!;
  const next = Math.min(keys.length - 1, Math.max(0, index + delta));
  return keys[next]!;
}

export function footerCountsLabel(rows: readonly StageRowFromPipelines[]): string {
  const inUse = rows.filter((row) => row.used_by_pipeline_ids.length > 0).length;
  const withSkill = rows.filter((row) => row.skill).length;
  return `${rows.length} stages · ${inUse} in use · ${rows.length - inUse} unused · ${withSkill} use a skill`;
}

export function pipelineForRow(
  row: StageRowFromPipelines,
  pipelines: readonly PipelineListing[],
): PipelineListing | null {
  for (const id of row.used_by_pipeline_ids) {
    const match = pipelines.find(
      (p) => p.id === id && (p.project_root ?? "") === (row.project_root ?? ""),
    );
    if (match) return match;
  }
  return null;
}

export function fileBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function pipelineDirectoryOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : ".";
}

export type PipelineDirectoryOption = {
  key: string;
  directory: string;
  project_root?: string;
};

export function directoryKeyFor(pipeline: Pick<PipelineListing, "path" | "project_root">): string {
  return `${pipeline.project_root ?? ""}\0${pipelineDirectoryOf(pipeline.path)}`;
}

export function pipelineDirectoryOptions(
  pipelines: readonly PipelineListing[],
): PipelineDirectoryOption[] {
  const seen = new Map<string, PipelineDirectoryOption>();
  for (const pipeline of pipelines) {
    const directory = pipelineDirectoryOf(pipeline.path);
    const key = directoryKeyFor(pipeline);
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        directory,
        ...(pipeline.project_root ? { project_root: pipeline.project_root } : {}),
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.directory.localeCompare(b.directory));
}

export type RunStatusPill = { label: string; color: string };

export function latestRunForPipeline(
  runs: readonly RunSummary[],
  pipelineId: string,
): RunSummary | null {
  let latest: RunSummary | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (run.pipeline_id !== pipelineId) continue;
    const at = Date.parse(run.created_at);
    const value = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (!latest || value > latestAt) {
      latest = run;
      latestAt = value;
    }
  }
  return latest;
}

export function runStatusPill(run: RunSummary | null): RunStatusPill | null {
  if (!run) return null;
  if (run.waiting_stage_id) return { label: "Needs you", color: "#f5b544" };
  switch (run.status) {
    case "succeeded":
      return { label: "Succeeded", color: "#4cc38a" };
    case "failed":
      return { label: "Failed", color: "#f2645a" };
    case "running":
    case "created":
    case "queued":
      return { label: "Running", color: "#6ca6ff" };
    case "cancelled":
      return { label: "Cancelled", color: "#8b8f98" };
    default:
      return null;
  }
}

export type RecentStageStats = { runs: number; stats: StageStats | null };

export function recentStageStats(
  runs: readonly RunSummary[],
  stageId: string,
  pipelineIds: readonly string[],
  now: number,
  windowMs = THIRTY_DAYS_MS,
): RecentStageStats {
  const ids = new Set(pipelineIds);
  const recent = runs.filter((run) => {
    if (!ids.has(run.pipeline_id)) return false;
    const at = Date.parse(run.created_at);
    if (!Number.isFinite(at) || now - at > windowMs) return false;
    return run.stages.some((stage) => stage.id === stageId);
  });
  return {
    runs: recent.length,
    stats: summaryStageStats(recent).get(stageId) ?? null,
  };
}

export type StageYamlInfo = {
  systemPrompt: string | null;
  payloadSchema: string;
};

function schemaLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = (value as Record<string, unknown>).$ref;
    if (typeof ref === "string" && ref.trim() !== "") return ref;
    return "inline";
  }
  return null;
}

export function readStageYaml(content: string): StageYamlInfo {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return { systemPrompt: null, payloadSchema: "none" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { systemPrompt: null, payloadSchema: "none" };
  }
  const record = doc as Record<string, unknown>;
  const prompt =
    typeof record.system_prompt === "string" && record.system_prompt.trim() !== ""
      ? record.system_prompt
      : null;
  const io = record.io as Record<string, unknown> | undefined;
  const output =
    io && typeof io === "object"
      ? (io.output as Record<string, unknown> | undefined)
      : undefined;
  const fromIo =
    output && typeof output === "object" ? schemaLabel(output.schema) : null;
  const payloadSchema = fromIo ?? schemaLabel(record.payload_schema) ?? "none";
  return { systemPrompt: prompt, payloadSchema };
}

export function promptPreviewLines(prompt: string, max = 4): string[] {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, max);
}

export function promptTokenHint(prompt: string): string {
  return `${Math.ceil(prompt.length / 4).toLocaleString("en-US")} tok`;
}

export type SkillStripEntry = { name: string; stageId: string };

export function skillStripEntries(
  skills: readonly SkillListing[],
  usage: SkillUsageIndex | null,
  visibleRows: readonly StageRowFromPipelines[],
  limit = 6,
): SkillStripEntry[] {
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  const entries: SkillStripEntry[] = [];
  for (const skill of skills) {
    const fromUsage = usage?.usages[skill.name]?.stage_ids.find((id) =>
      visibleIds.has(id),
    );
    const fromRow = visibleRows.find((row) => row.skill === skill.name)?.id;
    const stageId = fromUsage ?? fromRow;
    if (stageId) entries.push({ name: skill.name, stageId });
    if (entries.length >= limit) break;
  }
  return entries;
}

export type NewStageForm = {
  directoryKey: string;
  id: string;
  filename: string;
  filenameTouched: boolean;
  systemPrompt: string;
  model: string;
  gateKinds: StageGateKind[];
};

export type NewStageInitial = {
  id?: string;
  systemPrompt?: string;
  model?: string;
  gateKinds?: StageGateKind[];
  directoryKey?: string;
};

export type NewStageErrors = Partial<
  Record<"directory" | "id" | "filename" | "systemPrompt", string>
>;

export function newStageFormFrom(initial?: NewStageInitial | null): NewStageForm {
  const id = initial?.id ?? "";
  return {
    directoryKey: initial?.directoryKey ?? "",
    id,
    filename: id ? `${id}.yaml` : "",
    filenameTouched: false,
    systemPrompt: initial?.systemPrompt ?? "",
    model: initial?.model ?? "",
    gateKinds: initial?.gateKinds ? [...initial.gateKinds] : [],
  };
}

export function validateNewStage(form: NewStageForm): NewStageErrors {
  const errors: NewStageErrors = {};
  const id = form.id.trim();
  if (!form.directoryKey) errors.directory = "Pick a pipeline directory";
  if (!id) errors.id = "Stage id is required";
  else if (id.length > 64) errors.id = "id must be 1-64 characters";
  else if (!STAGE_ID_PATTERN.test(id)) errors.id = "id must be lowercase kebab-case";
  const filename = form.filename.trim();
  if (!filename) errors.filename = "Filename is required";
  else if (!/\.ya?ml$/.test(filename) || filename.includes("/"))
    errors.filename = "Filename must be a .yaml file name";
  if (!form.systemPrompt.trim()) errors.systemPrompt = "System prompt is required";
  return errors;
}
