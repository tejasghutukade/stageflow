import type { EvalDefinition, EvalDetail, EvalValidateResult } from "../../../api/evalTypes";
import type { ValidationFinding } from "../../../api/types";
import { parseHash } from "../../../routes";
import { fromConversation, toConversation, userModelOf, type ConversationDraft } from "../newEval/conversationModel";
import { defaultsErrors, posixRelative, targetFromRow, targetRef, type DraftDefaults, type StageRow, type WizardTarget } from "../newEval/wizardModel";

export type EditMode = "form" | "yaml";
export type ConflictState = "none" | "dialog" | "blocked";

export type EditState = {
  mode: EditMode;
  fileHash: string;
  fileText: string;
  filePath: string;
  runsCount: number;
  loaded: EvalDefinition | null;
  draft: EvalDefinition | null;
  yamlText: string;
  yamlStart: string;
  conflict: ConflictState;
  externalChange: string | null;
};

export const FILE_CHANGED_TITLE = "The file changed on disk since you opened it";
export const EXTERNAL_BANNER_TITLE = "The file changed on disk";
export const OUTSIDE_NOTE = "File edited outside the console? It reloads here and asks before overwriting.";
export const BLOCKED_SAVE_REASON = "Reload from disk before saving";

// ---- loading ----------------------------------------------------------------------------------

export function loadState(detail: EvalDetail, mode?: EditMode): EditState {
  const definition = detail.definition;
  return {
    mode: definition === null ? "yaml" : (mode ?? "form"),
    fileHash: detail.file_hash,
    fileText: detail.yaml,
    filePath: detail.path,
    runsCount: detail.runs_count,
    loaded: definition,
    draft: definition === null ? null : structuredClone(definition),
    yamlText: detail.yaml,
    yamlStart: detail.yaml,
    conflict: "none",
    externalChange: null,
  };
}

// ---- unsaved count ----------------------------------------------------------------------------

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === "object" && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
}

function collectLeaves(v: unknown, path: string, out: Map<string, string>): void {
  if (v === undefined) return;
  if (isContainer(v)) {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    for (const [k, x] of entries) collectLeaves(x, `${path}/${k}`, out);
    return;
  }
  if (path === "") return;
  out.set(path, `${typeof v}:${typeof v === "number" ? String(v) : JSON.stringify(v)}`);
}

/** Number of leaf values that differ (changed, added or removed) between two definitions. Reordering a list changes the leaves at the moved positions. */
export function leafDiffCount(a: unknown, b: unknown): number {
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  collectLeaves(a ?? {}, "", left);
  collectLeaves(b ?? {}, "", right);
  let n = 0;
  for (const key of new Set([...left.keys(), ...right.keys()])) if (left.get(key) !== right.get(key)) n += 1;
  return n;
}

export function yamlEdited(state: EditState): boolean {
  return state.mode === "yaml" && state.yamlText !== state.yamlStart;
}

/** The definition whose differences from the file count as unsaved; `null` when the YAML cannot be read. */
export function effectiveDefinition(state: EditState, yamlDefinition: EvalDefinition | null): EvalDefinition | null {
  if (state.mode === "form" || !yamlEdited(state)) return state.draft;
  return yamlDefinition;
}

export function unsavedCount(state: EditState, yamlDefinition: EvalDefinition | null = null): number | null {
  const eff = effectiveDefinition(state, yamlDefinition);
  if (eff === null) return state.loaded === null && !yamlEdited(state) ? 0 : null;
  return leafDiffCount(state.loaded, eff);
}

export function isDirty(state: EditState, yamlDefinition: EvalDefinition | null = null): boolean {
  if (yamlEdited(state)) return true;
  const n = unsavedCount(state, yamlDefinition);
  return n === null || n > 0;
}

export function unsavedLabel(count: number | null): string | null {
  if (count === null) return "Unsaved changes";
  if (count <= 0) return null;
  return `${count} unsaved ${count === 1 ? "change" : "changes"}`;
}

// ---- mode switching ---------------------------------------------------------------------------

export function switchToYaml(state: EditState, derivedYaml: string): EditState {
  if (state.mode === "yaml") return state;
  const text = derivedYaml !== "" ? derivedYaml : state.fileText;
  return { ...state, mode: "yaml", yamlText: text, yamlStart: text };
}

export type FormSwitch = { ok: true; state: EditState } | { ok: false; findings: ValidationFinding[] };

export function errorsOf(findings: readonly ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.severity === "error");
}

/** Form is refused while the YAML does not validate; the findings say why. */
export function switchToForm(state: EditState, result: Pick<EvalValidateResult, "findings" | "definition">): FormSwitch {
  const errors = errorsOf(result.findings);
  if (errors.length > 0) return { ok: false, findings: errors };
  if (result.definition === null) {
    return {
      ok: false,
      findings: [{ severity: "error", code: "eval.yaml_unreadable", path: "", message: "The YAML could not be read.", category: "eval" }],
    };
  }
  return { ok: true, state: { ...state, mode: "form", draft: structuredClone(result.definition) } };
}

export function setYamlText(state: EditState, text: string): EditState {
  return { ...state, yamlText: text };
}

// ---- save -------------------------------------------------------------------------------------

export type SaveBody = { definition: EvalDefinition; base_hash: string } | { yaml: string; base_hash: string };

export function saveBlockReason(
  state: EditState,
  opts: { dirty: boolean; errors: number; localProblems: number; saving: boolean; validating: boolean },
): string | null {
  if (opts.saving) return "Saving…";
  if (state.conflict !== "none") return BLOCKED_SAVE_REASON;
  if (!opts.dirty) return "No changes to save";
  if (opts.validating) return "Checking the draft…";
  if (opts.localProblems > 0 || opts.errors > 0) return "Fix the errors first";
  if (state.mode === "form" && state.draft === null) return "Fix the YAML first";
  return null;
}

export function buildSaveBody(state: EditState): SaveBody | null {
  if (state.mode === "yaml") return { yaml: state.yamlText, base_hash: state.fileHash };
  return state.draft === null ? null : { definition: state.draft, base_hash: state.fileHash };
}

/** After a successful save: the response is the new loaded file; the mode stays. */
export function afterSave(state: EditState, detail: EvalDetail): EditState {
  return loadState(detail, state.mode);
}

export function onFileChanged(state: EditState): EditState {
  return { ...state, conflict: "dialog" };
}

export function keepEditing(state: EditState): EditState {
  return { ...state, conflict: "blocked", externalChange: null };
}

export function reloadFromDisk(state: EditState, detail: EvalDetail): EditState {
  return loadState(detail, state.mode);
}

export function isFileChangedError(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "FILE_CHANGED";
}

// ---- focus handling ---------------------------------------------------------------------------

export type FocusOutcome = { state: EditState; reloaded: boolean };

/** Page gained focus and the file was fetched again: reload silently when clean, warn when dirty. */
export function onFocusFetched(state: EditState, detail: EvalDetail, dirty: boolean): FocusOutcome {
  if (detail.file_hash === state.fileHash) return { state, reloaded: false };
  if (!dirty) return { state: loadState(detail, state.mode), reloaded: true };
  if (state.conflict === "blocked" || state.externalChange === detail.file_hash) return { state, reloaded: false };
  return { state: { ...state, externalChange: detail.file_hash }, reloaded: false };
}

// ---- discard and leave ------------------------------------------------------------------------

export function discardNeedsConfirm(dirty: boolean): boolean {
  return dirty;
}

export function discard(state: EditState): EditState {
  return {
    ...state,
    draft: state.loaded === null ? null : structuredClone(state.loaded),
    yamlText: state.fileText,
    yamlStart: state.fileText,
    conflict: "none",
    externalChange: null,
  };
}

/** True when the hash change leaves this eval's edit page while there are unsaved changes. */
export function shouldBlockLeave(dirty: boolean, evalId: string, nextHash: string): boolean {
  if (!dirty) return false;
  const route = parseHash(nextHash);
  return !(route.name === "evalEdit" && route.evalId === evalId);
}

// ---- form edits -------------------------------------------------------------------------------

function withDraft(state: EditState, change: (d: EvalDefinition) => EvalDefinition): EditState {
  return state.draft === null ? state : { ...state, draft: change(state.draft) };
}

export function setDraft(state: EditState, next: EvalDefinition | ((d: EvalDefinition) => EvalDefinition)): EditState {
  return withDraft(state, (d) => (typeof next === "function" ? next(d) : next));
}

export function withText(def: EvalDefinition, key: "name" | "description", text: string): EvalDefinition {
  const { [key]: _drop, ...rest } = def;
  void _drop;
  return text.trim() === "" ? (rest as EvalDefinition) : ({ ...rest, [key]: text } as EvalDefinition);
}

export function withType(def: EvalDefinition, type: "capability" | "regression"): EvalDefinition {
  return { ...def, type };
}

export type DefaultsKey = "repeats" | "pass_threshold" | "max_cost_usd";

export function withDefault(def: EvalDefinition, key: DefaultsKey, value: number): EvalDefinition {
  return { ...def, defaults: { ...def.defaults, [key]: value } };
}

export function withJudge(def: EvalDefinition, judge: string | null): EvalDefinition {
  const { judge: _drop, ...rest } = def.defaults ?? {};
  void _drop;
  const defaults = judge === null ? rest : { ...rest, judge };
  return { ...def, defaults };
}

export function draftDefaults(def: EvalDefinition, fallback: { repeats: number; passThreshold: number; maxCostUsd: number }): DraftDefaults {
  const d = def.defaults ?? {};
  return {
    repeats: d.repeats ?? fallback.repeats,
    passThreshold: d.pass_threshold ?? fallback.passThreshold,
    maxCostUsd: d.max_cost_usd ?? fallback.maxCostUsd,
    judge: d.judge ?? null,
  };
}

export function definitionProblems(def: EvalDefinition, fallback: { repeats: number; passThreshold: number; maxCostUsd: number }): string[] {
  return Object.values(defaultsErrors(draftDefaults(def, fallback)));
}

export function withDataset(def: EvalDefinition, relativePath: string): EvalDefinition {
  return { ...def, dataset: relativePath };
}

export function withTarget(def: EvalDefinition, target: WizardTarget, evalDir: string): EvalDefinition {
  return { ...def, target: targetRef(target, { evals: evalDir, datasets: "" }) };
}

export function isAgentDefinition(def: EvalDefinition | null | undefined): boolean {
  return def?.target.kind === "agent";
}

export function withAgentTarget(def: EvalDefinition, agentId: string): EvalDefinition {
  return { ...def, target: { kind: "agent", agent: agentId } };
}

/** The Conversation card's draft for an agent definition. */
export function conversationDraftOf(def: EvalDefinition): ConversationDraft {
  return fromConversation(def.conversation, def.defaults?.user_model);
}

/** Writes the Conversation card back: `conversation` and `defaults.user_model`. */
export function withConversationDraft(def: EvalDefinition, draft: ConversationDraft): EvalDefinition {
  const { user_model: _drop, ...rest } = def.defaults ?? {};
  void _drop;
  const userModel = userModelOf(draft);
  const defaults = { ...rest, ...(userModel ? { user_model: userModel } : {}) };
  const { defaults: _d, ...others } = def;
  void _d;
  return {
    ...others,
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    conversation: toConversation(draft),
  };
}

export function evalDirOf(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i < 0 ? "." : filePath.slice(0, i);
}

export function targetSummary(def: EvalDefinition, agent?: { name: string; revision: number } | null): string {
  const t = def.target;
  if (t.kind === "agent") return agent ? `Agent ${agent.name} · r${agent.revision}` : `Agent ${t.agent}`;
  if (t.kind === "internal_agent") return `Internal agent ${t.profile}`;
  if (t.file !== undefined) return t.file;
  return `${t.pipeline ?? ""}${t.stage ? ` · ${t.stage}` : ""}`;
}

export function footerNote(filePath: string, runsCount: number): string {
  const base = `Saving rewrites ${filePath}.`;
  if (runsCount <= 0) return base;
  return `${base} The ${runsCount} past ${runsCount === 1 ? "run keeps" : "runs keep"} the version ${runsCount === 1 ? "it" : "they"} used.`;
}

export const NO_RUNS_BANNER = "No runs yet. Run the eval to see how it scores.";

/** `dir` + a path relative to it, normalised (`..` and `.` resolved). */
export function resolveRelative(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function sameFile(a: string, b: string): boolean {
  return resolveRelative("", a) === resolveRelative("", b);
}

/** The catalog stage a definition points at, as a wizard target, when it is in the stage list. */
export function targetFromDefinition(rows: readonly StageRow[], def: EvalDefinition, evalDir: string): WizardTarget | null {
  const t = def.target;
  if (t.kind === "agent" || t.kind === "internal_agent") return null;
  if (t.file !== undefined) {
    const file = resolveRelative(evalDir, t.file);
    const row = rows.find((r) => r.usesPath !== undefined && sameFile(r.usesPath, file));
    return row ? targetFromRow(row, { useFile: true }) : null;
  }
  const pipeline = resolveRelative(evalDir, t.pipeline ?? "");
  const row = rows.find((r) => r.stageId === t.stage && r.pipelines.some((p) => sameFile(p.path, pipeline)));
  const hit = row?.pipelines.find((p) => sameFile(p.path, pipeline));
  return row && hit ? targetFromRow(row, { pipelinePath: hit.path }) : null;
}

export function withDatasetFile(def: EvalDefinition, evalDir: string, datasetPath: string): EvalDefinition {
  return withDataset(def, posixRelative(evalDir, datasetPath));
}
