import type {
  EvalAgentTarget,
  EvalCaseInput,
  EvalRunEstimate,
  EvalDefinition,
  EvalListItem,
} from "../../../api/evalTypes";
import type { PipelineListing, ValidationFinding } from "../../../api/types";
import { GRADER_ID_PATTERN, MAX_GRADERS, graderProblems, graderTypesFor, hasRubricWithoutJudge, newGrader, type GraderConfig, type GraderType } from "./graderForms";
import {
  AGENT_DEFAULT_CONCURRENCY,
  AGENT_DEFAULT_MAX_COST_USD,
  conversationErrors,
  initialConversation,
  toConversation,
  userModelOf,
  type ConversationDraft,
} from "./conversationModel";
import { countValidScenarios, scenarioProblem } from "../datasets/scenarioModel";
import { formatCost, formatDuration } from "../format";
import type { StageInputField } from "./stageInput";

export const WIZARD_STEPS = ["setup", "graders", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const STEP_LABELS: Record<WizardStep, string> = { setup: "Setup", graders: "Graders", review: "Review and run" };

export const EVAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DEFAULT_EVALS_DIR = "evals";
export const DEFAULT_DATASETS_DIR = "datasets";
export const DEFAULT_REPEATS = 3;
export const DEFAULT_PASS_THRESHOLD = 0.8;
export const DEFAULT_MAX_COST_USD = 2;
export const SAMPLE_CASE_COUNT = 8;
export const SAMPLE_DATASET_NAME = "critique-sample";
export const SAMPLE_INPUT_FIELDS = ["draft"];
export const NO_COST_HISTORY = "No cost history yet";
export const SETUP_FOOTER_NOTE = (path: string) => `Nothing is written until you create the eval. It will be saved as ${path}.`;
export const RUN_UNAVAILABLE_TOOLTIP = "Available after the run dialog ships";

export const DATASET_PENDING_CODES = new Set(["eval.dataset_unresolved", "eval.no_valid_cases", "eval.dataset_invalid", "eval.cases_skipped"]);

export type WriteDirs = { evals: string; datasets: string };
export const DEFAULT_DIRS: WriteDirs = { evals: DEFAULT_EVALS_DIR, datasets: DEFAULT_DATASETS_DIR };

export type WizardTarget = {
  kind: "pipeline" | "file" | "agent";
  /** For an agent target this is the agent id. */
  stageId: string;
  agentId?: string;
  revision?: number;
  enabled?: boolean;
  pipelinePath?: string;
  pipelineId?: string;
  file?: string;
  projectRoot?: string;
  model?: string;
  label: string;
};

export type DatasetSource = "upload" | "paste" | "runs" | "sessions" | "sample";

export type DraftDataset = {
  source: DatasetSource;
  fileName: string;
  name: string;
  cases: EvalCaseInput[] | null;
  runIds: string[];
  runPreviews: string[];
  ready: number;
  skipped: number;
  /** Agent datasets: rows the import already dropped; the rest is counted again when the conversation mode changes. */
  importSkipped?: number;
};

export type DraftDefaults = {
  repeats: number;
  passThreshold: number;
  maxCostUsd: number;
  judge: string | null;
};

export type TargetKind = "stage" | "agent";

export type WizardDraft = {
  step: WizardStep;
  targetKind: TargetKind;
  target: WizardTarget | null;
  conversation: ConversationDraft;
  targetFields: StageInputField[] | null;
  dataset: DraftDataset | null;
  defaults: DraftDefaults;
  type: "capability" | "regression";
  graders: GraderConfig[];
  budget: { latency_ms?: number; cost_usd?: number };
  id: string;
  idEdited: boolean;
  name: string;
  description: string;
};

export function initialDraft(): WizardDraft {
  return {
    step: "setup",
    targetKind: "stage",
    conversation: initialConversation(),
    target: null,
    targetFields: null,
    dataset: null,
    defaults: { repeats: DEFAULT_REPEATS, passThreshold: DEFAULT_PASS_THRESHOLD, maxCostUsd: DEFAULT_MAX_COST_USD, judge: null },
    type: "capability",
    graders: [],
    budget: {},
    id: "",
    idEdited: false,
    name: "",
    description: "",
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(base: string, taken: readonly string[]): string {
  const root = base === "" ? "eval" : base;
  const fits = (candidate: string) => !taken.includes(candidate);
  const trim = (s: string, suffix: string) => `${s.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
  const first = trim(root, "");
  if (fits(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = trim(root, `-${n}`);
    if (fits(candidate)) return candidate;
  }
}

/** `review` -> `review-eval`, then `review-eval-2`, `review-eval-3` when taken. */
export function deriveEvalId(stageId: string, takenIds: readonly string[]): string {
  return uniqueSlug(`${slugify(stageId) || "stage"}-eval`, takenIds);
}

export function deriveDatasetName(source: DatasetSource, stageId: string, fileName: string, takenNames: readonly string[]): string {
  if (source === "sample") return uniqueSlug(SAMPLE_DATASET_NAME, takenNames);
  if (source === "upload") {
    const stem = slugify(fileName.replace(/\.(dataset\.)?(jsonl|json|csv)$/i, ""));
    if (stem !== "") return uniqueSlug(stem, takenNames);
  }
  return uniqueSlug(`${slugify(stageId) || "stage"}-cases`, takenNames);
}

export function posixRelative(fromDir: string, toPath: string): string {
  const from = fromDir.split("/").filter((p) => p !== "" && p !== ".");
  const to = toPath.split("/").filter((p) => p !== "" && p !== ".");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i += 1;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/^\.\/?/, "").replace(/\/+$/, "");
  return d === "" ? name : `${d}/${name}`;
}

export function evalFilePath(dirs: WriteDirs, id: string): string {
  return joinPath(dirs.evals, `${id === "" ? "<id>" : id}.eval.yaml`);
}

export function datasetFilePath(dirs: WriteDirs, name: string): string {
  return joinPath(dirs.datasets, `${name}.dataset.jsonl`);
}

export type WriteRootsInfo = { project_root: string; evals_dir: string; datasets_dir: string };

/** The server's write roots apply when the draft targets the same project root (or names none). */
export function writeRootsFor(roots: WriteRootsInfo | null | undefined, target: WizardTarget | null): WriteRootsInfo | null {
  if (!roots) return null;
  const wanted = target?.projectRoot;
  return wanted === undefined || wanted === roots.project_root ? roots : null;
}

/** The datasets directory sits next to the evals directory when no dataset shows where datasets live. */
export function inferDirs(evalDir: string | null, datasetPaths: readonly string[], writeRoots?: WriteRootsInfo | null): WriteDirs {
  if (writeRoots) return { evals: writeRoots.evals_dir, datasets: writeRoots.datasets_dir };
  const evals = evalDir ?? DEFAULT_EVALS_DIR;
  const known = datasetPaths.find((p) => p.includes("/"));
  if (known) return { evals, datasets: known.slice(0, known.lastIndexOf("/")) };
  if (datasetPaths.length > 0) return { evals, datasets: "." };
  const parent = evals.includes("/") ? evals.slice(0, evals.lastIndexOf("/")) : "";
  return { evals, datasets: joinPath(parent, DEFAULT_DATASETS_DIR) };
}

export function evalDirFromFindings(findings: readonly ValidationFinding[]): string | null {
  for (const f of findings) {
    if (typeof f.path === "string" && /\.eval\.ya?ml$/.test(f.path)) {
      const i = f.path.lastIndexOf("/");
      return i < 0 ? "." : f.path.slice(0, i);
    }
  }
  return null;
}

export function validateEvalId(id: string, takenIds: readonly string[]): string | null {
  if (id === "") return "Name is required";
  if (!EVAL_ID_PATTERN.test(id)) return "Use lowercase letters, digits and dashes (max 63)";
  if (takenIds.includes(id)) return "An eval with this name already exists";
  return null;
}

export function isAgentTarget(target: WizardTarget | null | undefined): boolean {
  return target?.kind === "agent";
}

export function isAgentDraft(draft: Pick<WizardDraft, "targetKind">): boolean {
  return draft.targetKind === "agent";
}

export function targetRef(target: WizardTarget, dirs: WriteDirs): NonNullable<EvalDefinition["target"]> {
  if (target.kind === "agent") return { kind: "agent", agent: target.agentId ?? target.stageId };
  if (target.kind === "file" && target.file !== undefined) {
    return { kind: "stage", file: posixRelative(dirs.evals, target.file) };
  }
  return { kind: "stage", pipeline: posixRelative(dirs.evals, target.pipelinePath ?? ""), stage: target.stageId };
}

/** The draft as the `definition` JSON the API takes, in the file's key order. */
export function buildDefinition(draft: WizardDraft, dirs: WriteDirs = DEFAULT_DIRS): EvalDefinition | null {
  if (!draft.target || !draft.dataset) return null;
  const d = draft.defaults;
  const hasBudget = draft.budget.latency_ms !== undefined || draft.budget.cost_usd !== undefined;
  const agent = isAgentTarget(draft.target);
  const userModel = agent ? userModelOf(draft.conversation) : undefined;
  return {
    version: 1,
    id: draft.id,
    ...(draft.name.trim() !== "" ? { name: draft.name.trim() } : {}),
    ...(draft.description.trim() !== "" ? { description: draft.description.trim() } : {}),
    type: draft.type,
    target: targetRef(draft.target, dirs),
    dataset: posixRelative(dirs.evals, datasetFilePath(dirs, draft.dataset.name)),
    defaults: {
      repeats: d.repeats,
      ...(d.judge ? { judge: d.judge } : {}),
      ...(userModel ? { user_model: userModel } : {}),
      pass_threshold: d.passThreshold,
      max_cost_usd: d.maxCostUsd,
      ...(agent ? { concurrency: AGENT_DEFAULT_CONCURRENCY } : {}),
    },
    ...(agent ? { conversation: toConversation(draft.conversation) } : {}),
    graders: draft.graders.map((g) => ({ ...g })),
    ...(hasBudget ? { budget: { ...draft.budget } } : {}),
  };
}

export function defaultsErrors(d: DraftDefaults): { repeats?: string; passThreshold?: string; maxCostUsd?: string } {
  const out: { repeats?: string; passThreshold?: string; maxCostUsd?: string } = {};
  if (!Number.isInteger(d.repeats) || d.repeats < 1 || d.repeats > 10) out.repeats = "Repeats must be a whole number from 1 to 10";
  if (!(d.passThreshold > 0 && d.passThreshold <= 1)) out.passThreshold = "Pass threshold must be above 0% and at most 100%";
  if (!(d.maxCostUsd > 0)) out.maxCostUsd = "Cost limit must be above $0";
  return out;
}

export function parsePercent(text: string): number | null {
  const n = Number(text.trim().replace(/%$/, ""));
  if (text.trim() === "" || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 1000;
}

export function percentText(fraction: number): string {
  return String(Math.round(fraction * 1000) / 10);
}

export function setupProblems(draft: WizardDraft): string[] {
  const out: string[] = [];
  const agent = isAgentDraft(draft);
  if (!draft.target) out.push(agent ? "Pick an agent to evaluate" : "Pick a stage to evaluate");
  if (!draft.dataset || draft.dataset.ready < 1) {
    out.push(agent ? "Add a dataset with at least one valid scenario" : "Add a dataset with at least one case that matches the stage");
  }
  out.push(...Object.values(defaultsErrors(draft.defaults)));
  if (agent) out.push(...Object.values(conversationErrors(draft.conversation)));
  return out;
}

export function canContinueFromSetup(draft: WizardDraft): boolean {
  return setupProblems(draft).length === 0;
}

export function gradersProblems(draft: WizardDraft): string[] {
  const out: string[] = [];
  if (draft.graders.length < 1) out.push("Add at least one grader");
  const ids = draft.graders.map((g) => g.id);
  if (ids.some((id, i) => !GRADER_ID_PATTERN.test(id) || ids.indexOf(id) !== i)) out.push("Grader ids must be unique");
  for (const g of draft.graders) out.push(...graderProblems(g).map((p) => `${g.id}: ${p}`));
  const allowed = new Set<string>(graderTypesFor(isAgentDraft(draft) ? "agent" : "stage").map((t) => t.type));
  for (const g of draft.graders) {
    if (!allowed.has(g.type)) out.push(`${g.id}: ${g.type} graders do not apply to ${isAgentDraft(draft) ? "agents" : "stages"}`);
  }
  if (hasRubricWithoutJudge(draft.graders) && !draft.defaults.judge) out.push("Pick a judge model for the rubric graders");
  return out;
}

export function canContinueFromGraders(draft: WizardDraft): boolean {
  return gradersProblems(draft).length === 0;
}

export function canEnterStep(draft: WizardDraft, step: WizardStep): boolean {
  if (step === "setup") return true;
  if (step === "graders") return canContinueFromSetup(draft);
  return canContinueFromSetup(draft) && canContinueFromGraders(draft);
}

export function goNext(draft: WizardDraft): WizardDraft {
  const next = WIZARD_STEPS[WIZARD_STEPS.indexOf(draft.step) + 1];
  return next && canEnterStep(draft, next) ? { ...draft, step: next } : draft;
}

export function goBack(draft: WizardDraft): WizardDraft {
  const prev = WIZARD_STEPS[WIZARD_STEPS.indexOf(draft.step) - 1];
  return prev ? { ...draft, step: prev } : draft;
}

export function withTarget(draft: WizardDraft, target: WizardTarget | null, fields: StageInputField[] | null, takenEvalIds: readonly string[]): WizardDraft {
  const changed = JSON.stringify(draft.target) !== JSON.stringify(target);
  const kind: TargetKind = target ? (isAgentTarget(target) ? "agent" : "stage") : draft.targetKind;
  const base = kind === draft.targetKind ? draft : withTargetKind(draft, kind);
  return {
    ...base,
    target,
    targetFields: fields,
    dataset: changed ? null : base.dataset,
    id: base.idEdited || !target ? base.id : deriveEvalId(target.stageId, takenEvalIds),
  };
}

/** Switching Stage / Agent drops the other kind's target, dataset and inapplicable graders and resets the cost limit default. */
export function withTargetKind(draft: WizardDraft, kind: TargetKind): WizardDraft {
  if (kind === draft.targetKind) return draft;
  const allowed = new Set<string>(graderTypesFor(kind).map((t) => t.type));
  const wasDefault = draft.defaults.maxCostUsd === (draft.targetKind === "agent" ? AGENT_DEFAULT_MAX_COST_USD : DEFAULT_MAX_COST_USD);
  return {
    ...draft,
    targetKind: kind,
    target: null,
    targetFields: null,
    dataset: null,
    graders: draft.graders.filter((g) => allowed.has(g.type)),
    defaults: wasDefault ? { ...draft.defaults, maxCostUsd: kind === "agent" ? AGENT_DEFAULT_MAX_COST_USD : DEFAULT_MAX_COST_USD } : draft.defaults,
    id: draft.idEdited ? draft.id : "",
  };
}

/** Held scenarios are valid or not per the conversation mode, so a mode change counts them again. */
export function recountDataset(ds: DraftDataset, mode: ConversationDraft["mode"]): DraftDataset {
  if (!ds.cases) return ds;
  const counts = countValidScenarios(ds.cases, mode);
  return { ...ds, ready: counts.ready, skipped: (ds.importSkipped ?? 0) + counts.skipped };
}

export function withConversation(draft: WizardDraft, patch: Partial<ConversationDraft>): WizardDraft {
  const conversation = { ...draft.conversation, ...patch };
  const dataset = draft.dataset && isAgentDraft(draft) && conversation.mode !== draft.conversation.mode ? recountDataset(draft.dataset, conversation.mode) : draft.dataset;
  return { ...draft, conversation, dataset };
}

/** An agent upload: rows valid for the draft's mode are held, the others count as skipped. */
export function datasetFromAgentConfirm(
  req: { candidates?: EvalCaseInput[]; cases: EvalCaseInput[]; fileName: string },
  source: "upload" | "paste",
  agentId: string,
  takenNames: readonly string[],
  mode: ConversationDraft["mode"],
): DraftDataset {
  const all = req.candidates ?? req.cases;
  const valid = all.filter((c) => scenarioProblem(c, mode) === null);
  return {
    source,
    fileName: req.fileName,
    name: deriveDatasetName(source, agentId, req.fileName, takenNames),
    cases: valid,
    runIds: [],
    runPreviews: [],
    ready: valid.length,
    skipped: all.length - valid.length,
    importSkipped: all.length - valid.length,
  };
}

/** Add, replace or remove held scenarios (editor, wizard preview). */
export function datasetWithCases(
  ds: DraftDataset | null,
  cases: EvalCaseInput[],
  mode: ConversationDraft["mode"],
  agentId: string,
  takenNames: readonly string[],
): DraftDataset | null {
  if (cases.length === 0 && ds === null) return null;
  const base = ds ?? datasetFromScenarios([], mode, agentId, takenNames);
  return recountDataset({ ...base, cases }, mode);
}

export function agentTargetOf(agent: Pick<EvalAgentTarget, "id" | "name" | "model" | "revision" | "enabled">, projectRoot?: string): WizardTarget {
  return {
    kind: "agent",
    stageId: agent.id,
    agentId: agent.id,
    revision: agent.revision,
    enabled: agent.enabled,
    ...(agent.model ? { model: agent.model } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    label: agent.name,
  };
}

export function sameAgent(agent: Pick<EvalAgentTarget, "id">, target: WizardTarget | null): boolean {
  return target?.kind === "agent" && target.agentId === agent.id;
}

export function withId(draft: WizardDraft, id: string): WizardDraft {
  return { ...draft, id, idEdited: true };
}

export type GradersDraft = { graders: GraderConfig[]; budget?: { latency_ms?: number; cost_usd?: number } | undefined };

export function addGrader<T extends GradersDraft>(draft: T, type: GraderType): T {
  if (draft.graders.length >= MAX_GRADERS) return draft;
  return { ...draft, graders: [...draft.graders, newGrader(type, draft.graders.map((g) => g.id))] };
}

export function removeGrader<T extends GradersDraft>(draft: T, index: number): T {
  return { ...draft, graders: draft.graders.filter((_, i) => i !== index) };
}

export function moveGrader<T extends GradersDraft>(draft: T, from: number, to: number): T {
  if (from === to || from < 0 || to < 0 || from >= draft.graders.length || to >= draft.graders.length) return draft;
  const next = [...draft.graders];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as GraderConfig);
  return { ...draft, graders: next };
}

export function replaceGrader<T extends GradersDraft>(draft: T, index: number, grader: GraderConfig): T {
  return { ...draft, graders: draft.graders.map((g, i) => (i === index ? grader : g)) };
}

export function renameGrader<T extends GradersDraft>(draft: T, index: number, id: string): T {
  const current = draft.graders[index];
  return current ? replaceGrader(draft, index, { ...current, id }) : draft;
}

export function setBudget<T extends GradersDraft>(draft: T, key: "latency_ms" | "cost_usd", value: number | null): T {
  const { [key]: _drop, ...rest } = draft.budget ?? {};
  void _drop;
  return { ...draft, budget: value === null ? rest : { ...rest, [key]: value } };
}

export function parseBudgetInput(text: string, key: "latency_ms" | "cost_usd"): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Must be a number above 0" };
  return { ok: true, value: key === "latency_ms" ? Math.round(n * 1000) : n };
}

export function budgetLabel(key: "latency_ms" | "cost_usd", value: number | undefined): string {
  if (value === undefined) return key === "latency_ms" ? "Latency: no limit" : "Cost: no limit";
  return key === "latency_ms" ? `Latency: ${value / 1000} s` : `Cost: $${value}`;
}

// ---- dataset handling -------------------------------------------------------------------------

export type DatasetPreviewRow = { id: string; title: string; cells: string[] };

export function datasetSummary(ds: DraftDataset, agent = false): { title: string; match: string } {
  const noun = agent ? ["scenario", "scenarios"] : ["case", "cases"];
  const cases = `${ds.ready} ${ds.ready === 1 ? noun[0] : noun[1]}`;
  return { title: cases, match: ds.skipped > 0 ? `${ds.skipped} skipped` : agent ? "all valid" : "all match io.input" };
}

export function datasetSummaryLine(ds: DraftDataset): string {
  const s = datasetSummary(ds);
  return ds.skipped > 0 ? `${s.title} · ${s.match}` : `${s.title} · ${s.match}`;
}

function cellText(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

export function previewRowsOf(ds: DraftDataset, fieldNames: readonly string[], limit = 3): DatasetPreviewRow[] {
  if (ds.cases) {
    return ds.cases.slice(0, limit).map((c, i) => ({
      id: c.id ?? `c${String(i + 1).padStart(3, "0")}`,
      title: c.title ?? "",
      cells: fieldNames.map((f) => cellText((c.input as Record<string, unknown> | undefined)?.[f])),
    }));
  }
  return ds.runPreviews.slice(0, limit).map((text, i) => ({ id: `run-${i + 1}`, title: "", cells: [text] }));
}

export function datasetFromConfirm(
  req: { cases: EvalCaseInput[]; ready: number; skipped: number; fileName: string },
  source: "upload" | "paste",
  stageId: string,
  takenNames: readonly string[],
): DraftDataset {
  return {
    source,
    fileName: req.fileName,
    name: deriveDatasetName(source, stageId, req.fileName, takenNames),
    cases: req.cases,
    runIds: [],
    runPreviews: [],
    ready: req.ready,
    skipped: req.skipped,
  };
}

export function datasetFromRuns(runIds: string[], previews: string[], stageId: string, takenNames: readonly string[]): DraftDataset {
  return {
    source: "runs",
    fileName: "Past runs",
    name: deriveDatasetName("runs", stageId, "", takenNames),
    cases: null,
    runIds,
    runPreviews: previews,
    ready: runIds.length,
    skipped: 0,
  };
}

export function datasetFromSessions(sessionIds: string[], previews: string[], agentId: string, takenNames: readonly string[]): DraftDataset {
  return {
    source: "sessions",
    fileName: "Past sessions",
    name: deriveDatasetName("runs", agentId, "", takenNames),
    cases: null,
    runIds: sessionIds,
    runPreviews: previews,
    ready: sessionIds.length,
    skipped: 0,
  };
}

/** Scenarios written in the editor travel with the draft like pasted cases do. */
export function datasetFromScenarios(
  cases: EvalCaseInput[],
  defaultMode: ConversationDraft["mode"],
  agentId: string,
  takenNames: readonly string[],
): DraftDataset {
  const counts = countValidScenarios(cases, defaultMode);
  return {
    source: "paste",
    fileName: "Typed scenarios",
    name: deriveDatasetName("paste", agentId, "", takenNames),
    cases,
    runIds: [],
    runPreviews: [],
    ready: counts.ready,
    skipped: counts.skipped,
  };
}

export const AGENT_SAMPLE_ID = "support-sample";

/** The agent sample installs a whole sample agent and eval, so the server decides whether it fits. */
export function agentSampleAvailability(): { ok: true } | { ok: false; reason: string } {
  return { ok: true };
}

/** Clear text for the codes `POST /api/evals/sample` returns for the agent sample. */
export function agentSampleError(code: string, fallback: string): string {
  if (code === "SAMPLE_NO_DEFAULT_MODEL") {
    return "The sample agent needs a default model. Set `model` in stageflow.yaml, then try again.";
  }
  if (code === "SAMPLE_AGENTS_UNAVAILABLE") {
    return "This host cannot create agents, so the sample agent cannot be installed.";
  }
  if (code === "SAMPLE_EXISTS") return "The sample agent eval is already installed. Opening it.";
  return fallback;
}

export function datasetFromSample(stageId: string, takenNames: readonly string[]): DraftDataset {
  return {
    source: "sample",
    fileName: "Sample data",
    name: deriveDatasetName("sample", stageId, "", takenNames),
    cases: null,
    runIds: [],
    runPreviews: [],
    ready: SAMPLE_CASE_COUNT,
    skipped: 0,
  };
}

export function sampleCompatibility(fields: readonly StageInputField[] | null): { ok: true } | { ok: false; reason: string } {
  if (fields === null) return { ok: false, reason: "The stage's input fields could not be read, so the sample cannot be checked." };
  const names = fields.map((f) => f.name);
  const missing = SAMPLE_INPUT_FIELDS.filter((f) => !names.includes(f));
  if (missing.length > 0) return { ok: false, reason: `The sample cases have a ${SAMPLE_INPUT_FIELDS.join(", ")} field; this stage takes ${names.join(", ") || "no named fields"}.` };
  const extra = fields.filter((f) => f.required && !SAMPLE_INPUT_FIELDS.includes(f.name));
  if (extra.length > 0) return { ok: false, reason: `This stage also requires ${extra.map((f) => f.name).join(", ")}, which the sample cases do not have.` };
  const wrong = fields.find((f) => SAMPLE_INPUT_FIELDS.includes(f.name) && f.type !== undefined && f.type !== "string");
  if (wrong) return { ok: false, reason: `The sample's ${wrong.name} is text; this stage expects ${wrong.type}.` };
  return { ok: true };
}

export function datasetTarget(target: WizardTarget) {
  if (target.kind === "agent") return { agent_id: target.agentId ?? target.stageId };
  return target.kind === "file" && target.file !== undefined
    ? { file: target.file }
    : { pipeline_path: target.pipelinePath, stage_id: target.stageId };
}

/** A case for `POST /api/evals/try`: the held case, with an id so the result can be matched. */
export function tryCaseOf(c: EvalCaseInput, index: number): EvalCaseInput {
  return { ...c, id: c.id ?? `c${String(index + 1).padStart(3, "0")}` };
}

export function tryCaseLabel(c: EvalCaseInput, index: number): string {
  const id = c.id ?? `c${String(index + 1).padStart(3, "0")}`;
  return c.title ? `${id} · ${c.title}` : id;
}

// ---- targets ----------------------------------------------------------------------------------

export type StageRow = {
  key: string;
  stageId: string;
  model?: string;
  usesPath?: string;
  projectRoot?: string;
  readOnly: boolean;
  pipelines: Array<{ id: string; path: string }>;
};

export function buildStageRows(pipelines: readonly PipelineListing[], readOnlyRoots: ReadonlySet<string>): StageRow[] {
  const map = new Map<string, StageRow>();
  for (const p of pipelines) {
    for (const s of p.stages) {
      const key = `${p.project_root ?? ""}:${s.uses_path ?? `${p.path}#${s.id}`}`;
      const existing = map.get(key);
      if (existing) {
        if (!existing.pipelines.some((x) => x.path === p.path)) existing.pipelines.push({ id: p.id, path: p.path });
        if (!existing.model && s.model) existing.model = s.model;
      } else {
        map.set(key, {
          key,
          stageId: s.id,
          ...(s.model ? { model: s.model } : {}),
          ...(s.uses_path ? { usesPath: s.uses_path } : {}),
          ...(p.project_root ? { projectRoot: p.project_root } : {}),
          readOnly: p.project_root !== undefined && readOnlyRoots.has(p.project_root),
          pipelines: [{ id: p.id, path: p.path }],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.stageId.localeCompare(b.stageId) || a.key.localeCompare(b.key));
}

export function filterStageRows(rows: readonly StageRow[], query: string): StageRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) => `${r.stageId} ${r.model ?? ""} ${r.pipelines.map((p) => p.id).join(" ")}`.toLowerCase().includes(q));
}

export function targetFromRow(row: StageRow, opts: { pipelinePath?: string; useFile?: boolean } = {}): WizardTarget {
  const pipeline = row.pipelines.find((p) => p.path === opts.pipelinePath) ?? (row.pipelines[0] as { id: string; path: string });
  const base = { stageId: row.stageId, ...(row.projectRoot ? { projectRoot: row.projectRoot } : {}), ...(row.model ? { model: row.model } : {}) };
  if (opts.useFile && row.usesPath) {
    return { ...base, kind: "file", file: row.usesPath, label: row.usesPath };
  }
  return { ...base, kind: "pipeline", pipelinePath: pipeline.path, pipelineId: pipeline.id, label: `${pipeline.id} · ${row.stageId}` };
}

export function sameTarget(row: StageRow, target: WizardTarget | null): boolean {
  if (!target || target.stageId !== row.stageId || target.projectRoot !== row.projectRoot) return false;
  if (target.kind === "file") return target.file === row.usesPath;
  return row.pipelines.some((p) => p.path === target.pipelinePath);
}

export function evalCountFor(row: StageRow, evals: readonly EvalListItem[]): number {
  return evals.filter((e) => {
    if (e.project_root !== undefined && row.projectRoot !== undefined && e.project_root !== row.projectRoot) return false;
    const t = e.target;
    if (t.kind !== "stage") return false;
    if (t.file !== undefined) return row.usesPath !== undefined && t.file === row.usesPath;
    return t.stage_id === row.stageId && row.pipelines.some((p) => p.path === t.pipeline_path);
  }).length;
}

export type Preselect = { pipeline?: string; stage?: string; file?: string; agent?: string };

export function preselectRow(rows: readonly StageRow[], q: Preselect): { row: StageRow; target: WizardTarget } | null {
  if (q.file) {
    const row = rows.find((r) => r.usesPath === q.file);
    if (row) return { row, target: targetFromRow(row, { useFile: true }) };
  }
  if (q.stage) {
    const hits = rows.filter((r) => r.stageId === q.stage);
    const row = q.pipeline ? (hits.find((r) => r.pipelines.some((p) => p.path === q.pipeline || p.id === q.pipeline)) ?? hits[0]) : hits[0];
    if (row) {
      const path = row.pipelines.find((p) => p.path === q.pipeline || p.id === q.pipeline)?.path;
      return { row, target: targetFromRow(row, path !== undefined ? { pipelinePath: path } : {}) };
    }
  }
  return null;
}

// ---- checks -----------------------------------------------------------------------------------

export type CheckLine = { tone: "ok" | "error" | "warning" | "muted"; text: string };

export function holdsCases(draft: Pick<WizardDraft, "dataset">): boolean {
  return (draft.dataset?.cases?.length ?? 0) > 0;
}

/** Cases the wizard holds travel with validate, try and estimate, so the dataset file is not read. */
export function draftDatasetCases(draft: Pick<WizardDraft, "dataset">): EvalCaseInput[] | undefined {
  return holdsCases(draft) ? (draft.dataset?.cases ?? undefined) : undefined;
}

/** Dataset findings are real when the file is on disk or the wizard sent its cases; otherwise they only mean "not written yet". */
export function visibleFindings(findings: readonly ValidationFinding[], datasetKnown: boolean): ValidationFinding[] {
  return datasetKnown ? [...findings] : findings.filter((f) => !DATASET_PENDING_CODES.has(f.code) && !f.code.startsWith("dataset."));
}

/** "No cost history yet" only when the estimate has no dollar figure. */
export function estimateText(estimate: Pick<EvalRunEstimate, "estimate_usd" | "estimate_seconds" | "judge_included"> | null): { title: string; hasEstimate: boolean } {
  if (!estimate || estimate.estimate_usd === null) return { title: NO_COST_HISTORY, hasEstimate: false };
  const time = estimate.estimate_seconds !== null ? ` · about ${formatDuration(estimate.estimate_seconds * 1000)}` : "";
  return { title: `About ${formatCost(estimate.estimate_usd)}${time}`, hasEstimate: true };
}

export function blockingFindings(findings: readonly ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.severity === "error");
}

export function setupChecks(draft: WizardDraft, findings: readonly ValidationFinding[]): CheckLine[] {
  const lines: CheckLine[] = [];
  const t = draft.target;
  const agent = isAgentTarget(t);
  if (t && agent) {
    const unresolved = findings.some((f) => f.code === "eval.agent_not_found");
    if (!unresolved) lines.push({ tone: "ok", text: `Agent ${t.agentId ?? t.stageId} found${t.revision !== undefined ? ` (r${t.revision})` : ""}` });
  } else if (t) {
    const unresolved = findings.some((f) => f.code === "eval.target_unresolved");
    if (!unresolved) lines.push({ tone: "ok", text: `Stage ${t.stageId} found in ${t.kind === "file" ? t.file : t.pipelinePath}` });
  }
  const ds = draft.dataset;
  if (ds) {
    const total = ds.ready + ds.skipped;
    lines.push(
      agent
        ? { tone: ds.skipped > 0 ? "warning" : "ok", text: `${ds.ready} of ${total} scenarios valid` }
        : { tone: ds.skipped > 0 ? "warning" : "ok", text: `${ds.ready} of ${total} cases match the stage's io.input` },
    );
  }
  const gradersPending = draft.graders.length === 0;
  for (const f of findings) {
    if (gradersPending && f.message.includes(`"graders"`)) continue;
    lines.push({ tone: f.severity === "error" ? "error" : "warning", text: f.message });
  }
  if (draft.graders.length === 0) lines.push({ tone: "muted", text: "No graders yet. Add at least one next." });
  return lines;
}

export function judgeSameAsStage(draft: WizardDraft, judge: string | null = draft.defaults.judge): boolean {
  return !!judge && !!draft.target?.model && judge === draft.target.model;
}

export const JUDGE_SAME_HINT = "Same model as the stage. Pick another to avoid self-preference.";
export const JUDGE_SAME_AGENT_HINT = "Same model as the agent. Pick another to avoid self-preference.";

// ---- try on one case --------------------------------------------------------------------------

export function caseVerdictText(score: number | null, threshold: number): string {
  const pct = `${Math.round(threshold * 1000) / 10}%`;
  if (score === null) return "No score";
  if (score >= threshold) return `Meets the ${pct} threshold`;
  return threshold - score <= 0.05 + 1e-9 ? `Just under the ${pct} threshold` : `Below the ${pct} threshold`;
}

export const TRY_REAL_PENDING = "Tick I understand on the Conversation card to try with real tools.";

export function tryDisabledReason(draft: WizardDraft, findings: readonly ValidationFinding[]): string | null {
  if (!draft.dataset?.cases || draft.dataset.cases.length === 0) {
    return draft.dataset ? "Try needs cases in hand. Upload or paste the cases to try one." : "Add a dataset first.";
  }
  if (draft.graders.length === 0) return "Add a grader first.";
  if (isAgentDraft(draft) && draft.conversation.tools === "real" && !draft.conversation.allowReal) return TRY_REAL_PENDING;
  if (findings.some((f) => f.severity === "error")) return "Fix the errors in the draft first.";
  return null;
}
