import type { DraftPackagePayload } from "../../api";
import type { FunctionCapability, FunctionGrant, FunctionKind } from "../../api/functions";
import { stageIdFromRef } from "../editor/draftMutators";
import { setStageBodyValue, setStageRefValue } from "../workshop/inspector/stageFields";
import { functionPath } from "../../routes";

export type FunctionSlot = "check" | "tool" | "route";

export type FunctionAttachmentDraft = { id: string; grants: FunctionGrant[] };

const SLOT_KIND: Record<FunctionSlot, FunctionKind> = {
  check: "verification",
  tool: "tool",
  route: "routing",
};

export function placeFunction(
  slot: FunctionSlot,
  fn: { id: string; kind: string },
): { ok: true } | { ok: false; message: string; href: string } {
  const expected = SLOT_KIND[slot];
  if (fn.kind === expected) return { ok: true };
  const slotLabel = slot === "check" ? "check" : slot;
  return {
    ok: false,
    message: `A ${fn.kind} function cannot be attached as a ${slotLabel}.`,
    href: functionPath(fn.id),
  };
}

export function grantsForCapabilities(capabilities: readonly FunctionCapability[]): FunctionGrant[] {
  return capabilities.map((capability) => {
    if (capability.type === "file") return { id: capability.id, root: capability.root, path: capability.path };
    if (capability.type === "env") return { id: capability.id };
    return {
      id: capability.id,
      origin: capability.origin,
      methods: capability.methods,
      path_prefix: capability.path_prefix,
      ...(capability.credential_ref ? { credential_ref: capability.credential_ref } : {}),
    };
  });
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function locate(draft: DraftPackagePayload, stageId: string): { ref: Obj; body: Obj } | null {
  const index = draft.pipeline.stages.findIndex((stage, i) => stageIdFromRef(stage, i) === stageId);
  if (index < 0) return null;
  const ref = draft.pipeline.stages[index]!;
  const uses = typeof ref.uses === "string" ? ref.uses.trim().replace(/\\/g, "/").replace(/^\.\//, "") : "";
  if (!uses) return { ref, body: ref };
  const file = (draft.stages ?? []).find((item) => item.path.trim().replace(/\\/g, "/").replace(/^\.\//, "") === uses);
  return { ref, body: file?.body ?? ref };
}

function readAttachments(value: unknown): FunctionAttachmentDraft[] {
  if (!Array.isArray(value)) return [];
  const out: FunctionAttachmentDraft[] = [];
  for (const entry of value) {
    if (!isObj(entry) || typeof entry.id !== "string") continue;
    const grants = Array.isArray(entry.grants) ? entry.grants.filter(isObj).map((grant) => ({ ...grant, id: String(grant.id) })) : [];
    out.push({ id: entry.id, grants: grants as FunctionGrant[] });
  }
  return out;
}

export function readStageFunctionTools(draft: DraftPackagePayload, stageId: string): FunctionAttachmentDraft[] {
  const loc = locate(draft, stageId);
  if (!loc || !isObj(loc.body.tools)) return [];
  return readAttachments(loc.body.tools.functions);
}

export function readFunctionChecks(draft: DraftPackagePayload, stageId: string): FunctionAttachmentDraft[] {
  const loc = locate(draft, stageId);
  if (!loc || !Array.isArray(loc.body.verify)) return [];
  const out: FunctionAttachmentDraft[] = [];
  for (const check of loc.body.verify) {
    if (!isObj(check) || check.type !== "function" || typeof check.function !== "string") continue;
    out.push({ id: check.function, grants: readGrantList(check.grants) });
  }
  return out;
}

function readGrantList(value: unknown): FunctionGrant[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).map((grant) => ({ ...grant, id: String(grant.id) })) as FunctionGrant[];
}

export function readRouteFunction(draft: DraftPackagePayload, stageId: string): FunctionAttachmentDraft | null {
  const loc = locate(draft, stageId);
  if (!loc) return null;
  if (typeof loc.ref.function === "string") return { id: loc.ref.function, grants: [] };
  if (!isObj(loc.ref.function) || typeof loc.ref.function.id !== "string") return null;
  return { id: loc.ref.function.id, grants: readGrantList(loc.ref.function.grants) };
}

export function writeStageFunctionTools(
  draft: DraftPackagePayload,
  stageId: string,
  functions: readonly FunctionAttachmentDraft[],
): DraftPackagePayload {
  return setStageBodyValue(draft, stageId, ["tools"], functions.length > 0 ? { functions } : undefined);
}

export function writeFunctionChecks(
  draft: DraftPackagePayload,
  stageId: string,
  checks: readonly FunctionAttachmentDraft[],
): DraftPackagePayload {
  const loc = locate(draft, stageId);
  const current = loc && Array.isArray(loc.body.verify) ? loc.body.verify.filter(isObj) : [];
  const others = current.filter((check) => check.type !== "function");
  const next = [
    ...others,
    ...checks.map((check) => ({
      id: check.id,
      type: "function",
      function: check.id,
      ...(check.grants.length > 0 ? { grants: check.grants } : {}),
    })),
  ];
  return setStageBodyValue(draft, stageId, ["verify"], next.length > 0 ? next : undefined);
}

export function writeRouteFunction(
  draft: DraftPackagePayload,
  stageId: string,
  attachment: FunctionAttachmentDraft | null,
): DraftPackagePayload {
  if (!attachment) return setStageRefValue(draft, stageId, ["function"], undefined);
  if (attachment.grants.length === 0) return setStageRefValue(draft, stageId, ["function"], attachment.id);
  return setStageRefValue(draft, stageId, ["function"], { id: attachment.id, grants: attachment.grants });
}

export function readAgentFunctions(tools: { functions?: unknown } | undefined): FunctionAttachmentDraft[] {
  return readAttachments(tools?.functions);
}

export function slotMismatches(
  slot: FunctionSlot,
  attachments: readonly { id: string }[],
  catalog: readonly { id: string; kind: string | null }[],
): Array<{ ok: false; message: string; href: string }> {
  const out: Array<{ ok: false; message: string; href: string }> = [];
  for (const attachment of attachments) {
    const fn = catalog.find((item) => item.id === attachment.id);
    if (!fn || fn.kind === null) continue;
    const placed = placeFunction(slot, { id: fn.id, kind: fn.kind });
    if (!placed.ok) out.push(placed);
  }
  return out;
}
