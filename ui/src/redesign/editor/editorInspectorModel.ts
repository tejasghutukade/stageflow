import type {
  DraftPackagePayload,
  PipelineListing,
  ValidationFinding,
} from "../../api";
import {
  GATE_KINDS,
  getStageForm,
  normalizeStageFieldKey,
  setStageBodyValue,
  setStageRefValue,
  type GateKind,
} from "../workshop/inspector/stageFields";
import { stageBodyFor, stageRefFor } from "../workshop/stageMutators";

export const INSPECTOR_GATE_ORDER = [
  "confirm",
  "artifact_backed",
  "free_text",
  "multi_question",
] as const satisfies readonly GateKind[];

const STAGE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export type InspectorStageRef = {
  id: string;
  path: string | null;
  projectRoot?: string;
};

export type InspectorFocusTarget =
  | "id"
  | "model"
  | "system_prompt"
  | "gate_kinds"
  | "payload"
  | "header";

export type PayloadSchemaSource = {
  outputsRef: string | null;
  outputFields: readonly unknown[];
};

function normalizeCatalogPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameCatalogRoot(left?: string, right?: string): boolean {
  const a = left?.trim().replace(/\\/g, "/").replace(/\/$/, "") ?? "";
  const b = right?.trim().replace(/\\/g, "/").replace(/\/$/, "") ?? "";
  return a === b;
}

function sameStagePath(left: string, right: string): boolean {
  const a = normalizeCatalogPath(left);
  const b = normalizeCatalogPath(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function skillText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pipelineListsStage(pipeline: PipelineListing, stage: InspectorStageRef): boolean {
  if (!sameCatalogRoot(pipeline.project_root, stage.projectRoot)) return false;
  return pipeline.stages.some((row) => {
    if (row.id === stage.id) return true;
    return (
      stage.path != null &&
      row.uses_path != null &&
      sameStagePath(row.uses_path, stage.path)
    );
  });
}

export function formatPromptTokens(text: string): string {
  const tokens = Math.ceil(text.length / 4);
  return `${tokens.toLocaleString("en-US")} tok`;
}

export function otherPipelinesUsingStage(
  pipelines: readonly PipelineListing[] | null | undefined,
  stage: InspectorStageRef,
  currentPipelineId: string | undefined,
): string[] {
  if (!pipelines) return [];
  const ids: string[] = [];
  for (const pipeline of pipelines) {
    if (currentPipelineId !== undefined && pipeline.id === currentPipelineId) continue;
    if (!pipelineListsStage(pipeline, stage)) continue;
    if (!ids.includes(pipeline.id)) ids.push(pipeline.id);
  }
  return ids;
}

export function sharedStageNotice(pipelineIds: readonly string[]): string | null {
  if (pipelineIds.length === 0) return null;
  return `Edits here also change ${formatPipelineList(pipelineIds)}.`;
}

function formatPipelineList(ids: readonly string[]): string {
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 2) return `${ids[0]} and ${ids[1]}`;
  if (ids.length === 3) return `${ids[0]}, ${ids[1]} and ${ids[2]}`;
  const more = ids.length - 3;
  return `${ids[0]}, ${ids[1]}, ${ids[2]} and ${more} more`;
}

export function usedByPipelinesLabel(count: number): string {
  return `Used by ${count} ${count === 1 ? "pipeline" : "pipelines"}`;
}

export function toggleGateKind(current: readonly string[], kind: string): string[] {
  const selected = new Set(current.filter((entry) => entry.length > 0));
  if (selected.has(kind)) selected.delete(kind);
  else selected.add(kind);
  const ordered = INSPECTOR_GATE_ORDER.filter((entry) => selected.has(entry));
  const rest: string[] = [];
  for (const entry of current) {
    if (!entry || rest.includes(entry)) continue;
    if ((INSPECTOR_GATE_ORDER as readonly string[]).includes(entry)) continue;
    if (!selected.has(entry)) continue;
    rest.push(entry);
  }
  return [...ordered, ...rest];
}

export function applyGateKindToggle(
  draft: DraftPackagePayload,
  stageId: string,
  kind: string,
): DraftPackagePayload {
  const form = getStageForm(draft, stageId);
  if (!form) return draft;
  const next = toggleGateKind(form.gateKinds, kind);
  return setStageBodyValue(
    draft,
    stageId,
    ["gate_kinds"],
    next.length > 0 ? next : undefined,
  );
}

export function readStageSkill(draft: DraftPackagePayload, stageId: string): string {
  const ref = stageRefFor(draft, stageId);
  const fromEntry = skillText(ref?.skill);
  if (fromEntry) return fromEntry;
  const body = stageBodyFor(draft, stageId);
  if (!body || body === ref) return "";
  return skillText(body.skill) ?? "";
}

export function writeStageSkill(
  draft: DraftPackagePayload,
  stageId: string,
  skill: string,
): DraftPackagePayload {
  const value = skill.trim() ? skill.trim() : undefined;
  const withEntry = setStageRefValue(draft, stageId, ["skill"], value);
  if (value !== undefined) return withEntry;
  return setStageBodyValue(withEntry, stageId, ["skill"], undefined);
}

export function payloadSchemaLabel(source: PayloadSchemaSource): string {
  if (source.outputsRef) return source.outputsRef;
  const count = source.outputFields.length;
  if (count === 0) return "none";
  return `inline · ${count} ${count === 1 ? "field" : "fields"}`;
}

export function isStageIdValid(id: string): boolean {
  return STAGE_ID_PATTERN.test(id);
}

export function inspectorFocusTarget(field: string): InspectorFocusTarget {
  const raw = field.trim();
  if (raw === "payload" || raw === "payload_schema") return "payload";
  const key = normalizeStageFieldKey(raw);
  if (key === "id" || key === "model" || key === "system_prompt") return key;
  if (key === "ask_operator") return "gate_kinds";
  if (key === "io.inputs" || key === "io.outputs") return "payload";
  return "header";
}

export function warnedGateKinds(
  findings: readonly Pick<ValidationFinding, "message" | "stageId">[],
  stageId: string,
): GateKind[] {
  return INSPECTOR_GATE_ORDER.filter((kind) =>
    findings.some(
      (finding) => findingTargetsStage(finding, stageId) && finding.message.includes(kind),
    ),
  );
}

function findingTargetsStage(
  finding: Pick<ValidationFinding, "message" | "stageId">,
  stageId: string,
): boolean {
  if (finding.stageId) return finding.stageId === stageId;
  return finding.message.includes(`"${stageId}"`);
}

export function inspectorGateOrderCoversCatalog(): boolean {
  return (
    INSPECTOR_GATE_ORDER.length === GATE_KINDS.length &&
    GATE_KINDS.every((kind) =>
      (INSPECTOR_GATE_ORDER as readonly string[]).includes(kind),
    )
  );
}
