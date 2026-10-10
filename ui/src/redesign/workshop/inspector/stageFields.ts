import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import { cloneDraft, stageIdFromRef } from "../../editor/draftMutators";

export const GATE_KINDS = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
] as const;

export type GateKind = (typeof GATE_KINDS)[number];

export type OnVerifyFailMode = "fail" | "retry" | "ask_operator";

export type RetrySafety = "idempotent" | "side_effecting";

export const DEFAULT_MAX_ATTEMPTS = 2;

export const STAGE_FIELD_KEYS = [
  "id",
  "model",
  "system_prompt",
  "io.inputs",
  "io.outputs",
  "verify.command",
  "on_verify_fail",
  "ask_operator",
  "general",
] as const;

export type StageFieldKey = (typeof STAGE_FIELD_KEYS)[number];

export type PipelineFieldKey = "id" | "model" | "stages" | "general";

export type StageEnvelopeForm = {
  artifacts: string[];
  payload: string[];
  status: string;
};

export const IO_FIELD_TYPES = ["string", "number", "boolean", "string[]", "object"] as const;

export type IoFieldType = (typeof IO_FIELD_TYPES)[number];

export type IoField = {
  name: string;
  type: IoFieldType | "other";
  required: boolean;
};

export type StageForm = {
  id: string;
  index: number;
  path: string | null;
  inline: boolean;
  model: string | null;
  systemPrompt: string;
  inputs: string[];
  outputs: string[];
  inputFields: IoField[];
  outputFields: IoField[];
  inputsRef: string | null;
  outputsRef: string | null;
  verifyCommand: string;
  onVerifyFail: OnVerifyFailMode | null;
  maxAttempts: number | null;
  retrySafety: RetrySafety | null;
  hitl: boolean;
  gateKind: GateKind | null;
  gateKinds: string[];
  envelope: StageEnvelopeForm;
};

export type PipelineStageRow = {
  id: string;
  index: number;
  path: string | null;
  entry: boolean;
  needs: string[];
};

export type PipelineForm = {
  id: string;
  model: string | null;
  stages: PipelineStageRow[];
};

export type StageChangeKind = "new" | "edited" | "unchanged";

type Obj = Record<string, unknown>;

type StageLocation = {
  index: number;
  ref: Obj;
  fileIndex: number;
};

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function usesPath(ref: Obj): string | null {
  return typeof ref.uses === "string" && ref.uses.trim()
    ? normalizePath(ref.uses)
    : null;
}

function locateStage(
  draft: DraftPackagePayload,
  stageId: string,
): StageLocation | null {
  const index = draft.pipeline.stages.findIndex(
    (stage, i) => stageIdFromRef(stage, i) === stageId,
  );
  if (index < 0) return null;
  const ref = draft.pipeline.stages[index]!;
  const uses = usesPath(ref);
  const files = draft.stages ?? [];
  let fileIndex = -1;
  if (uses) {
    fileIndex = files.findIndex((file) => normalizePath(file.path) === uses);
    if (fileIndex < 0) {
      fileIndex = files.findIndex((file) => {
        const path = normalizePath(file.path);
        return path.endsWith(`/${uses}`) || uses.endsWith(`/${path}`);
      });
    }
    if (fileIndex < 0) {
      fileIndex = files.findIndex((file) => file.body.id === stageId);
    }
  }
  return { index, ref, fileIndex };
}

function bodyAt(draft: DraftPackagePayload, loc: StageLocation): Obj {
  if (loc.fileIndex >= 0) return draft.stages![loc.fileIndex]!.body;
  return loc.ref;
}

export function getIn(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const key of path) {
    if (!isObj(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function setIn(target: Obj, path: readonly string[], value: unknown): void {
  if (path.length === 0) return;
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isObj(next)) current[key] = {};
    current = current[key] as Obj;
  }
  current[path[path.length - 1]!] = value;
}

export function deleteIn(target: Obj, path: readonly string[]): void {
  if (path.length === 0) return;
  const parents: Obj[] = [target];
  let current: unknown = target;
  for (const key of path.slice(0, -1)) {
    if (!isObj(current)) return;
    current = current[key];
    if (!isObj(current)) return;
    parents.push(current);
  }
  delete parents[parents.length - 1]![path[path.length - 1]!];
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]!).length > 0) break;
    delete parents[i - 1]![path[i - 1]!];
  }
}

function editBody(
  draft: DraftPackagePayload,
  stageId: string,
  edit: (body: Obj, ref: Obj) => void,
): DraftPackagePayload {
  const next = cloneDraft(draft);
  const loc = locateStage(next, stageId);
  if (!loc) return draft;
  edit(bodyAt(next, loc), loc.ref);
  return next;
}

function editRef(
  draft: DraftPackagePayload,
  stageId: string,
  edit: (ref: Obj) => void,
): DraftPackagePayload {
  const next = cloneDraft(draft);
  const loc = locateStage(next, stageId);
  if (!loc) return draft;
  edit(loc.ref);
  return next;
}

export function setStageBodyValue(
  draft: DraftPackagePayload,
  stageId: string,
  path: readonly string[],
  value: unknown,
): DraftPackagePayload {
  return editBody(draft, stageId, (body) => {
    if (value === undefined) deleteIn(body, path);
    else setIn(body, path, value);
  });
}

export function setStageRefValue(
  draft: DraftPackagePayload,
  stageId: string,
  path: readonly string[],
  value: unknown,
): DraftPackagePayload {
  return editRef(draft, stageId, (ref) => {
    if (value === undefined) deleteIn(ref, path);
    else setIn(ref, path, value);
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function schemaRefName(schema: unknown): string | null {
  if (!isObj(schema) || typeof schema.$ref !== "string") return null;
  return schema.$ref.replace(/^#\/schemas\//, "");
}

function schemaFieldNames(schema: unknown): string[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  return Object.keys(schema.properties);
}

function propertyType(prop: unknown): IoField["type"] {
  if (!isObj(prop)) return "other";
  if (prop.type === "array" && isObj(prop.items) && prop.items.type === "string") return "string[]";
  if (prop.type === "integer" || prop.type === "number") return "number";
  if (prop.type === "string" || prop.type === "boolean" || prop.type === "object") return prop.type;
  return "other";
}

export function ioFieldsFromSchema(schema: unknown): IoField[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  const required = new Set(stringList(schema.required));
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: propertyType(prop),
    required: required.has(name),
  }));
}

export function ioFieldChipLabel(field: Pick<IoField, "name" | "type">): string {
  return field.type === "string[]" ? `${field.name}[]` : field.name;
}

function ioSchema(body: Obj, side: "input" | "output"): Obj | null {
  const schema = getIn(body, ["io", side, "schema"]);
  if (!isObj(schema) || schemaRefName(schema) || !isObj(schema.properties)) return null;
  return schema;
}

function payloadSummary(schema: unknown): string[] {
  const ref = schemaRefName(schema);
  if (ref) return [`$ref ${ref}`];
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  return Object.entries(schema.properties).map(([name, prop]) =>
    isObj(prop) && prop.type === "array" ? `${name}[]` : name,
  );
}

function verifyChecks(body: Obj): Obj[] {
  return Array.isArray(body.verify) ? body.verify.filter(isObj) : [];
}

function checkWhen(check: Obj): string[] {
  const when = stringList(check.when);
  if (when.length > 0) return when;
  return check.type === "gate" ? ["emit"] : ["after"];
}

function emitArtifacts(body: Obj): string[] {
  const out: string[] = [];
  for (const check of verifyChecks(body)) {
    if (check.type !== "artifact") continue;
    const name =
      typeof check.basename === "string"
        ? check.basename
        : typeof check.path === "string"
          ? check.path
          : null;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function firstCommand(body: Obj): string {
  const check = verifyChecks(body).find((c) => c.type === "command");
  return check && typeof check.run === "string" ? check.run : "";
}

function isGateKind(value: unknown): value is GateKind {
  return (GATE_KINDS as readonly unknown[]).includes(value);
}

function readOnVerifyFail(ref: Obj): {
  mode: OnVerifyFailMode | null;
  maxAttempts: number | null;
  retrySafety: RetrySafety | null;
} {
  const raw = isObj(ref.on_verify_fail) ? ref.on_verify_fail : null;
  if (!raw) return { mode: null, maxAttempts: null, retrySafety: null };
  const safety =
    raw.retry_safety === "idempotent" || raw.retry_safety === "side_effecting"
      ? raw.retry_safety
      : null;
  if (raw.mode === "repair") {
    return {
      mode: "retry",
      maxAttempts: typeof raw.max_attempts === "number" ? raw.max_attempts : null,
      retrySafety: safety,
    };
  }
  if (raw.mode === "manual") {
    return { mode: "ask_operator", maxAttempts: null, retrySafety: safety };
  }
  return { mode: null, maxAttempts: null, retrySafety: safety };
}

export function stagePathLabel(draft: DraftPackagePayload, stageId: string): string | null {
  const loc = locateStage(draft, stageId);
  if (!loc) return null;
  if (loc.fileIndex >= 0) return normalizePath(draft.stages![loc.fileIndex]!.path);
  return usesPath(loc.ref);
}

export function getStageForm(
  draft: DraftPackagePayload,
  stageId: string,
): StageForm | null {
  const loc = locateStage(draft, stageId);
  if (!loc) return null;
  const body = bodyAt(draft, loc);
  const inputSchema = getIn(body, ["io", "input", "schema"]);
  const outputSchema = getIn(body, ["io", "output", "schema"]);
  const gateKinds = stringList(body.gate_kinds);
  const firstKind = gateKinds.find(isGateKind) ?? null;
  const recovery = readOnVerifyFail(loc.ref);
  return {
    id: stageId,
    index: loc.index,
    path: stagePathLabel(draft, stageId),
    inline: usesPath(loc.ref) === null,
    model: typeof body.model === "string" && body.model.trim() ? body.model : null,
    systemPrompt: typeof body.system_prompt === "string" ? body.system_prompt : "",
    inputs: schemaFieldNames(inputSchema),
    outputs: schemaFieldNames(outputSchema),
    inputFields: ioFieldsFromSchema(inputSchema),
    outputFields: ioFieldsFromSchema(outputSchema),
    inputsRef: schemaRefName(inputSchema),
    outputsRef: schemaRefName(outputSchema),
    verifyCommand: firstCommand(body),
    onVerifyFail: recovery.mode,
    maxAttempts: recovery.maxAttempts,
    retrySafety: recovery.retrySafety,
    hitl: gateKinds.length > 0,
    gateKind: firstKind,
    gateKinds,
    envelope: {
      artifacts: emitArtifacts(body),
      payload: payloadSummary(outputSchema),
      status: "success | failure",
    },
  };
}

export function resolvedStageModel(
  draft: DraftPackagePayload,
  form: Pick<StageForm, "model">,
  defaultModel: string | null,
): string | null {
  if (form.model) return form.model;
  const pipelineModel = draft.pipeline.model;
  if (typeof pipelineModel === "string" && pipelineModel.trim()) return pipelineModel;
  return defaultModel && defaultModel.trim() ? defaultModel : null;
}

export function setStageModel(
  draft: DraftPackagePayload,
  stageId: string,
  model: string | null,
): DraftPackagePayload {
  const value = model && model.trim() ? model.trim() : undefined;
  return setStageBodyValue(draft, stageId, ["model"], value);
}

export function setStageSystemPrompt(
  draft: DraftPackagePayload,
  stageId: string,
  prompt: string,
): DraftPackagePayload {
  return setStageBodyValue(draft, stageId, ["system_prompt"], prompt);
}

function ensureIoSchema(body: Obj, side: "input" | "output"): Obj {
  const existing = getIn(body, ["io", side, "schema"]);
  if (isObj(existing)) return existing;
  const schema: Obj = { type: "object" };
  setIn(body, ["io", side, "schema"], schema);
  return schema;
}

export function setStageIoFields(
  draft: DraftPackagePayload,
  stageId: string,
  side: "input" | "output",
  names: string[],
): DraftPackagePayload {
  const wanted: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name && !wanted.includes(name)) wanted.push(name);
  }
  return editBody(draft, stageId, (body) => {
    if (schemaRefName(getIn(body, ["io", side, "schema"]))) return;
    ensureIoSchema(body, side === "input" ? "output" : "input");
    const schema = ensureIoSchema(body, side);
    if (schema.type === undefined) schema.type = "object";
    const props = isObj(schema.properties) ? schema.properties : {};
    const required = stringList(schema.required);
    const nextProps: Obj = {};
    for (const name of wanted) nextProps[name] = props[name] ?? { type: "string" };
    const nextRequired = [
      ...required.filter((name) => wanted.includes(name)),
      ...wanted.filter((name) => !(name in props)),
    ];
    if (wanted.length === 0) {
      delete schema.properties;
      delete schema.required;
      return;
    }
    schema.properties = nextProps;
    if (nextRequired.length > 0) schema.required = nextRequired;
    else delete schema.required;
  });
}

export function addStageIoField(
  draft: DraftPackagePayload,
  stageId: string,
  side: "input" | "output",
  name: string,
): DraftPackagePayload {
  const form = getStageForm(draft, stageId);
  if (!form) return draft;
  const current = side === "input" ? form.inputs : form.outputs;
  return setStageIoFields(draft, stageId, side, [...current, name]);
}

export function renameStageIoField(
  draft: DraftPackagePayload,
  stageId: string,
  side: "input" | "output",
  from: string,
  to: string,
): DraftPackagePayload {
  const nextName = to.trim();
  if (!nextName || nextName === from) return draft;
  return editBody(draft, stageId, (body) => {
    const schema = ioSchema(body, side);
    if (!schema) return;
    const props = schema.properties as Obj;
    if (!(from in props) || nextName in props) return;
    const next: Obj = {};
    for (const key of Object.keys(props)) next[key === from ? nextName : key] = props[key];
    schema.properties = next;
    if (Array.isArray(schema.required)) {
      schema.required = stringList(schema.required).map((item) => (item === from ? nextName : item));
    }
  });
}

export function setStageIoFieldType(
  draft: DraftPackagePayload,
  stageId: string,
  side: "input" | "output",
  name: string,
  type: IoFieldType,
): DraftPackagePayload {
  return editBody(draft, stageId, (body) => {
    const schema = ioSchema(body, side);
    if (!schema) return;
    const props = schema.properties as Obj;
    if (!(name in props) || propertyType(props[name]) === type) return;
    props[name] =
      type === "string[]" ? { type: "array", items: { type: "string" } } : { type };
  });
}

export function setStageIoFieldRequired(
  draft: DraftPackagePayload,
  stageId: string,
  side: "input" | "output",
  name: string,
  required: boolean,
): DraftPackagePayload {
  return editBody(draft, stageId, (body) => {
    const schema = ioSchema(body, side);
    if (!schema || !((schema.properties as Obj)[name])) return;
    const next = stringList(schema.required).filter((item) => item !== name);
    if (required) next.push(name);
    if (next.length > 0) schema.required = next;
    else delete schema.required;
  });
}

export function removeStageIoField(
  draft: DraftPackagePayload,
  stageId: string,
  side: "input" | "output",
  name: string,
): DraftPackagePayload {
  const form = getStageForm(draft, stageId);
  if (!form) return draft;
  const current = side === "input" ? form.inputs : form.outputs;
  return setStageIoFields(
    draft,
    stageId,
    side,
    current.filter((n) => n !== name),
  );
}

function uniqueCheckId(checks: Obj[], base: string): string {
  const ids = new Set(checks.map((c) => c.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function setStageVerifyCommand(
  draft: DraftPackagePayload,
  stageId: string,
  command: string,
): DraftPackagePayload {
  const run = command.trim();
  return editBody(draft, stageId, (body) => {
    const list = Array.isArray(body.verify) ? [...body.verify] : [];
    const at = list.findIndex((c) => isObj(c) && c.type === "command");
    if (!run) {
      if (at < 0) return;
      list.splice(at, 1);
    } else if (at >= 0) {
      list[at] = { ...(list[at] as Obj), run };
    } else {
      list.push({ id: uniqueCheckId(list.filter(isObj), "command"), type: "command", run });
    }
    if (list.length > 0) body.verify = list;
    else delete body.verify;
  });
}

export function stageHasAfterVerify(draft: DraftPackagePayload, stageId: string): boolean {
  const loc = locateStage(draft, stageId);
  if (!loc) return false;
  return verifyChecks(bodyAt(draft, loc)).some((c) => checkWhen(c).includes("after"));
}

export function setStageOnVerifyFail(
  draft: DraftPackagePayload,
  stageId: string,
  mode: OnVerifyFailMode | null,
  options: { maxAttempts?: number; retrySafety?: RetrySafety } = {},
): DraftPackagePayload {
  return editRef(draft, stageId, (ref) => {
    const prev = isObj(ref.on_verify_fail) ? ref.on_verify_fail : {};
    if (mode === null || mode === "fail") {
      delete ref.on_verify_fail;
      return;
    }
    if (mode === "retry") {
      const prevMax =
        prev.mode === "repair" && typeof prev.max_attempts === "number"
          ? prev.max_attempts
          : DEFAULT_MAX_ATTEMPTS;
      ref.on_verify_fail = {
        mode: "repair",
        max_attempts: Math.max(1, Math.floor(options.maxAttempts ?? prevMax)),
        retry_safety: "idempotent",
        include_failed_checks:
          typeof prev.include_failed_checks === "boolean" ? prev.include_failed_checks : true,
      };
      return;
    }
    const prevSafety =
      prev.mode === "manual" &&
      (prev.retry_safety === "idempotent" || prev.retry_safety === "side_effecting")
        ? prev.retry_safety
        : "side_effecting";
    ref.on_verify_fail = {
      mode: "manual",
      retry_safety: options.retrySafety ?? prevSafety,
    };
  });
}

export function setStageMaxAttempts(
  draft: DraftPackagePayload,
  stageId: string,
  maxAttempts: number,
): DraftPackagePayload {
  if (!Number.isFinite(maxAttempts)) return draft;
  return setStageOnVerifyFail(draft, stageId, "retry", { maxAttempts });
}

export function setStageRetrySafety(
  draft: DraftPackagePayload,
  stageId: string,
  retrySafety: RetrySafety,
): DraftPackagePayload {
  return setStageOnVerifyFail(draft, stageId, "ask_operator", { retrySafety });
}

function retargetGateChecks(body: Obj, kinds: string[]): void {
  if (!Array.isArray(body.verify)) return;
  const fallback = kinds[0];
  body.verify = body.verify.map((check) => {
    if (!isObj(check) || check.type !== "gate") return check;
    if (typeof check.kind === "string" && kinds.includes(check.kind)) return check;
    return fallback ? { ...check, kind: fallback } : check;
  });
}

export function setStageHitl(
  draft: DraftPackagePayload,
  stageId: string,
  on: boolean,
  kind: GateKind = "confirm",
): DraftPackagePayload {
  return editBody(draft, stageId, (body) => {
    if (!on) {
      delete body.gate_kinds;
      return;
    }
    const existing = stringList(body.gate_kinds);
    if (existing.length > 0) return;
    body.gate_kinds = [kind];
    retargetGateChecks(body, [kind]);
  });
}

export function setStageGateKinds(
  draft: DraftPackagePayload,
  stageId: string,
  kinds: string[],
): DraftPackagePayload {
  const unique = kinds.filter((k, i) => k && kinds.indexOf(k) === i);
  return editBody(draft, stageId, (body) => {
    if (unique.length === 0) {
      delete body.gate_kinds;
      return;
    }
    body.gate_kinds = unique;
    retargetGateChecks(body, unique);
  });
}

export function setStageGateKind(
  draft: DraftPackagePayload,
  stageId: string,
  kind: GateKind,
): DraftPackagePayload {
  return setStageGateKinds(draft, stageId, [kind]);
}

export function promptStats(text: string): { lines: number; chars: number } {
  if (!text) return { lines: 0, chars: 0 };
  return { lines: text.replace(/\n$/, "").split("\n").length, chars: text.length };
}

function legacyNeeds(ref: Obj): string[] {
  const raw = ref.needs;
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) ids.push(item.trim());
    else if (isObj(item) && typeof item.id === "string" && item.id.trim()) {
      ids.push(item.id.trim());
    }
  }
  return ids;
}

function forwardTargets(ref: Obj): string[] {
  if (!Array.isArray(ref.route)) return [];
  const out: string[] = [];
  for (const entry of ref.route) {
    if (!isObj(entry) || entry.type === "loop") continue;
    if (typeof entry.to === "string" && entry.to.trim()) out.push(entry.to.trim());
  }
  return out;
}

function pipelineIds(draft: DraftPackagePayload): string[] {
  return draft.pipeline.stages.map((stage, i) => stageIdFromRef(stage, i));
}

export function stageNeeds(draft: DraftPackagePayload, stageId: string): string[] {
  const ids = pipelineIds(draft);
  const out: string[] = [];
  draft.pipeline.stages.forEach((ref, i) => {
    if (ids[i] !== stageId && forwardTargets(ref).includes(stageId)) out.push(ids[i]!);
  });
  const own = draft.pipeline.stages[ids.indexOf(stageId)];
  if (own) for (const need of legacyNeeds(own)) if (!out.includes(need)) out.push(need);
  return out;
}

export function getPipelineForm(draft: DraftPackagePayload): PipelineForm {
  const ids = pipelineIds(draft);
  return {
    id: draft.pipeline.id,
    model:
      typeof draft.pipeline.model === "string" && draft.pipeline.model.trim()
        ? draft.pipeline.model
        : null,
    stages: draft.pipeline.stages.map((ref, index) => ({
      id: ids[index]!,
      index,
      path: stagePathLabel(draft, ids[index]!),
      entry: ref.entry === true,
      needs: stageNeeds(draft, ids[index]!),
    })),
  };
}

export function setPipelineId(draft: DraftPackagePayload, id: string): DraftPackagePayload {
  return { ...draft, pipeline: { ...draft.pipeline, id } };
}

export function setPipelineModel(
  draft: DraftPackagePayload,
  model: string | null,
): DraftPackagePayload {
  const pipeline = { ...draft.pipeline };
  if (model && model.trim()) pipeline.model = model.trim();
  else delete pipeline.model;
  return { ...draft, pipeline };
}

function normalizeEntries(stages: Obj[], ids: string[]): void {
  const usesRoute = stages.some((ref) => forwardTargets(ref).length > 0);
  if (!usesRoute) return;
  const inbound = new Set(stages.flatMap((ref) => forwardTargets(ref)));
  stages.forEach((ref, i) => {
    if (inbound.has(ids[i]!)) delete ref.entry;
    else ref.entry = true;
  });
}

export function setPipelineStageNeeds(
  draft: DraftPackagePayload,
  stageId: string,
  needs: string[],
): DraftPackagePayload {
  const next = cloneDraft(draft);
  const ids = pipelineIds(next);
  if (!ids.includes(stageId)) return draft;
  const wanted = new Set(needs.filter((n) => n !== stageId && ids.includes(n)));
  const stages = next.pipeline.stages as Obj[];
  stages.forEach((ref, i) => {
    const id = ids[i]!;
    if (id === stageId) {
      delete ref.needs;
      return;
    }
    const route = Array.isArray(ref.route) ? [...ref.route] : [];
    const hasEdge = forwardTargets(ref).includes(stageId);
    let nextRoute = route;
    if (wanted.has(id) && !hasEdge) nextRoute = [...route, { to: stageId }];
    if (!wanted.has(id) && hasEdge) {
      nextRoute = route.filter(
        (entry) => !(isObj(entry) && entry.type !== "loop" && entry.to === stageId),
      );
    }
    if (nextRoute.length > 0) ref.route = nextRoute;
    else delete ref.route;
  });
  normalizeEntries(stages, ids);
  return next;
}

export function movePipelineStage(
  draft: DraftPackagePayload,
  stageId: string,
  delta: number,
): DraftPackagePayload {
  const ids = pipelineIds(draft);
  const from = ids.indexOf(stageId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length || delta === 0) return draft;
  const stages = [...draft.pipeline.stages];
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved!);
  return { ...draft, pipeline: { ...draft.pipeline, stages } };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObj(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stageSnapshot(draft: DraftPackagePayload, stageId: string): string | null {
  const loc = locateStage(draft, stageId);
  if (!loc) return null;
  const ref: Obj = { ...loc.ref };
  delete ref.route;
  delete ref.entry;
  const body = loc.fileIndex >= 0 ? draft.stages![loc.fileIndex]!.body : null;
  return stableStringify({ ref, body });
}

export function stageChangeKind(
  draft: DraftPackagePayload,
  baseline: DraftPackagePayload | null,
  stageId: string,
): StageChangeKind {
  if (!baseline) return "new";
  const before = stageSnapshot(baseline, stageId);
  if (before === null) return "new";
  return before === stageSnapshot(draft, stageId) ? "unchanged" : "edited";
}

export function pipelineChanged(
  draft: DraftPackagePayload,
  baseline: DraftPackagePayload | null,
): boolean {
  if (!baseline) return true;
  return stableStringify(draft.pipeline) !== stableStringify(baseline.pipeline);
}

export function isUntitledPipelineId(id: string): boolean {
  const trimmed = id.trim().toLowerCase();
  return trimmed === "" || trimmed === "untitled";
}

export function pipelineFileLabel(id: string): string {
  const trimmed = id.trim();
  return `${trimmed || "untitled"}.yaml`;
}

const FIELD_ALIASES: Record<string, StageFieldKey> = {
  id: "id",
  model: "model",
  system_prompt: "system_prompt",
  prompt: "system_prompt",
  io: "io.inputs",
  "io.input": "io.inputs",
  "io.inputs": "io.inputs",
  inputs: "io.inputs",
  "io.output": "io.outputs",
  "io.outputs": "io.outputs",
  outputs: "io.outputs",
  verify: "verify.command",
  "verify.command": "verify.command",
  on_verify_fail: "on_verify_fail",
  recovery: "on_verify_fail",
  ask_operator: "ask_operator",
  gate_kinds: "ask_operator",
  hitl: "ask_operator",
  general: "general",
};

export function normalizeStageFieldKey(field: string): StageFieldKey {
  return FIELD_ALIASES[field.trim()] ?? "general";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IO_INCOMPATIBLE =
  /stage "([^"]+)" io\.input is not a structural subset of "([^"]+)" io\.output/;

function mentionsStage(message: string, stageId: string): boolean {
  const quoted = new RegExp(`(?<!pipeline )"${escapeRegExp(stageId)}"`, "i");
  return quoted.test(message);
}

function findingTouchesStage(
  finding: ValidationFinding,
  stageId: string,
  stagePath: string | null,
): boolean {
  if (finding.stageId === stageId) return true;
  if (mentionsStage(finding.message, stageId)) return true;
  if (!stagePath) return false;
  const path = normalizePath(stagePath);
  if (finding.category === "stage" && normalizePath(finding.path).endsWith(path)) return true;
  return finding.message.replace(/\\/g, "/").includes(path);
}

function fieldFromMessage(message: string): StageFieldKey {
  if (/system_prompt/.test(message)) return "system_prompt";
  if (/on_verify_fail|recovery/.test(message)) return "on_verify_fail";
  if (/gate_kinds|ask_operator|gate kind/.test(message)) return "ask_operator";
  if (/\bverify\b|completion/.test(message)) return "verify.command";
  if (/io\.output|payload_schema/.test(message)) return "io.outputs";
  if (/\bio\b|io\.input|clone_input_schema/.test(message)) return "io.inputs";
  if (/\bmodel\b/.test(message)) return "model";
  if (/\bid\b/.test(message)) return "id";
  return "general";
}

function fieldFromCode(finding: ValidationFinding): StageFieldKey {
  const { code, message } = finding;
  switch (code) {
    case "stage.invalid_model":
    case "stage.missing_model":
    case "pipeline.invalid_model":
    case "pipeline.model_applies":
      return "model";
    case "stage.invalid_payload_schema":
      return "io.outputs";
    case "stage.invalid_clone_input_schema":
      return "io.inputs";
    case "stage.invalid_io":
    case "stage.unresolved_schema_ref":
      return /io\.output|payload_schema/.test(message) ? "io.outputs" : "io.inputs";
    case "pipeline.invalid_verify":
    case "pipeline.invalid_completion":
    case "stage.invalid_pre_emit_checks":
      return /gate_kinds|\bgate\b|kind/.test(message) && !/\bcommand\b/.test(message)
        ? "ask_operator"
        : "verify.command";
    case "pipeline.invalid_recovery":
      return "on_verify_fail";
    case "stage.invalid_gate_kinds":
      return "ask_operator";
    case "pipeline.stage_id_mismatch":
    case "stage.id_filename_mismatch":
    case "pipeline.include_duplicate_stage":
      return "id";
    default:
      return fieldFromMessage(message);
  }
}

export function stageFieldForFinding(
  finding: ValidationFinding,
  stageId: string,
  stagePath: string | null = null,
): StageFieldKey | null {
  if (finding.code === "pipeline.io_incompatible") {
    const match = IO_INCOMPATIBLE.exec(finding.message);
    if (match) {
      if (match[1] === stageId) return "io.inputs";
      if (match[2] === stageId) return "io.outputs";
      return null;
    }
  }
  if (!findingTouchesStage(finding, stageId, stagePath)) return null;
  return fieldFromCode(finding);
}

export type StageFieldFindings = Record<StageFieldKey, ValidationFinding[]>;

export function emptyStageFieldFindings(): StageFieldFindings {
  return Object.fromEntries(STAGE_FIELD_KEYS.map((key) => [key, []])) as unknown as StageFieldFindings;
}

export function findingsForField(
  findings: ValidationFinding[],
  stageId: string,
  stagePath: string | null = null,
): StageFieldFindings {
  const out = emptyStageFieldFindings();
  for (const finding of findings) {
    const field = stageFieldForFinding(finding, stageId, stagePath);
    if (field) out[field].push(finding);
  }
  return out;
}

export function errorChipValues(
  values: string[],
  findings: ValidationFinding[],
): string[] {
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length === 0) return [];
  const named = values.filter((value) => errors.some((f) => f.message.includes(value)));
  return named.length > 0 ? named : values;
}

export function locateFindingField(
  finding: ValidationFinding,
  draft: DraftPackagePayload,
): { stageId: string; field: StageFieldKey } | null {
  const ids = pipelineIds(draft);
  const ordered = finding.stageId && ids.includes(finding.stageId)
    ? [finding.stageId, ...ids.filter((id) => id !== finding.stageId)]
    : ids;
  for (const stageId of ordered) {
    const field = stageFieldForFinding(finding, stageId, stagePathLabel(draft, stageId));
    if (field) return { stageId, field };
  }
  return null;
}

export function findingsForPipelineField(
  findings: ValidationFinding[],
  draft: DraftPackagePayload,
): Record<PipelineFieldKey, ValidationFinding[]> {
  const out: Record<PipelineFieldKey, ValidationFinding[]> = {
    id: [],
    model: [],
    stages: [],
    general: [],
  };
  for (const finding of findings) {
    if (finding.category !== "pipeline" && finding.category !== "catalog") continue;
    if (locateFindingField(finding, draft)) {
      if (finding.code === "pipeline.dag_error" || finding.code === "pipeline.route_if_invalid") {
        out.stages.push(finding);
      }
      continue;
    }
    if (finding.code === "catalog.duplicate_pipeline_id") out.id.push(finding);
    else if (finding.code === "pipeline.invalid_model" || finding.code === "pipeline.model_applies") {
      out.model.push(finding);
    } else if (
      finding.code === "pipeline.dag_error" ||
      finding.code === "pipeline.missing_stage" ||
      finding.code === "pipeline.route_if_invalid" ||
      finding.code === "pipeline.route_all_gated" ||
      finding.code === "pipeline.string_stage_ref" ||
      finding.code === "pipeline.io_incompatible"
    ) {
      out.stages.push(finding);
    } else if (finding.category === "pipeline") {
      const field = fieldFromMessage(finding.message);
      if (field === "id") out.id.push(finding);
      else if (field === "model") out.model.push(finding);
      else out.general.push(finding);
    }
  }
  return out;
}
