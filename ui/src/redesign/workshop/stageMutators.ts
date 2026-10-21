import type { DraftPackagePayload } from "../../api";
import { stageIdFromRef } from "../editor/draftMutators";

type StageRef = Record<string, unknown>;
type StageFile = NonNullable<DraftPackagePayload["stages"]>[number];
type ForwardRoute = Record<string, unknown> & { to: string };

const DEFAULT_STAGE_DIRECTORY = "./stages/";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function needsTargets(raw: unknown): string[] {
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) ids.push(item.trim());
    else if (isPlainObject(item) && typeof item.id === "string" && item.id.trim()) {
      ids.push(item.id.trim());
    }
  }
  return ids;
}

export function isForwardRoute(entry: unknown): entry is ForwardRoute {
  return (
    isPlainObject(entry) &&
    entry.type === undefined &&
    typeof entry.to === "string" &&
    entry.to.trim().length > 0
  );
}

export function forwardRoutes(ref: StageRef): ForwardRoute[] {
  return Array.isArray(ref.route) ? ref.route.filter(isForwardRoute) : [];
}

export function usesRouteWiring(draft: DraftPackagePayload): boolean {
  return draft.pipeline.stages.some(
    (stage) => stage.entry === true || forwardRoutes(stage).length > 0,
  );
}

export function stageIds(draft: DraftPackagePayload): string[] {
  return draft.pipeline.stages.map((stage, index) => stageIdFromRef(stage, index));
}

export function stagePredecessors(draft: DraftPackagePayload): Map<string, string[]> {
  const stages = draft.pipeline.stages;
  const ids = stageIds(draft);
  const order = new Map(ids.map((id, index) => [id, index]));
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const add = (to: string, from: string) => {
    if (from === to || !order.has(from)) return;
    const list = preds.get(to);
    if (list && !list.includes(from)) list.push(from);
  };
  stages.forEach((stage, index) => {
    for (const from of needsTargets(stage.needs)) add(ids[index]!, from);
  });
  stages.forEach((stage, index) => {
    for (const entry of forwardRoutes(stage)) add(entry.to.trim(), ids[index]!);
  });
  if (!usesRouteWiring(draft)) {
    stages.forEach((stage, index) => {
      if (index === 0 || needsTargets(stage.needs).length > 0) return;
      add(ids[index]!, ids[index - 1]!);
    });
  }
  for (const list of preds.values()) {
    list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  return preds;
}

function normalizeStagePath(value: string): string {
  let next = value.replace(/\\/g, "/");
  while (next.startsWith("./")) next = next.slice(2);
  return next;
}

function findStageRefIndex(draft: DraftPackagePayload, stageId: string): number {
  return draft.pipeline.stages.findIndex(
    (stage, index) => stageIdFromRef(stage, index) === stageId,
  );
}

export function stageFileIndex(draft: DraftPackagePayload, stageId: string): number {
  const files = draft.stages ?? [];
  const ref = draft.pipeline.stages[findStageRefIndex(draft, stageId)];
  if (ref && typeof ref.uses === "string" && ref.uses.trim()) {
    const key = normalizeStagePath(ref.uses.trim());
    const byPath = files.findIndex((file) => normalizeStagePath(file.path) === key);
    if (byPath >= 0) return byPath;
  }
  return files.findIndex((file) => file.body.id === stageId);
}

export function stageRefFor(
  draft: DraftPackagePayload,
  stageId: string,
): StageRef | undefined {
  return draft.pipeline.stages[findStageRefIndex(draft, stageId)];
}

export function stageBodyFor(
  draft: DraftPackagePayload,
  stageId: string,
): Record<string, unknown> | undefined {
  const fileIndex = stageFileIndex(draft, stageId);
  if (fileIndex >= 0) return draft.stages![fileIndex]!.body;
  return stageRefFor(draft, stageId);
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function applyPredecessors(
  draft: DraftPackagePayload,
  next: Map<string, string[]>,
  current: Map<string, string[]> = stagePredecessors(draft),
): DraftPackagePayload {
  const rewriteAll = !usesRouteWiring(draft);
  const ids = stageIds(draft);
  const changed = new Set(
    ids.filter(
      (id) => rewriteAll || !sameMembers(current.get(id) ?? [], next.get(id) ?? []),
    ),
  );
  if (changed.size === 0) return draft;
  const stages = draft.pipeline.stages.map((stage, index) => {
    const sourceId = ids[index]!;
    const route = Array.isArray(stage.route) ? stage.route : [];
    const kept = route.filter((entry) => {
      if (!isForwardRoute(entry)) return true;
      const to = entry.to.trim();
      if (!changed.has(to)) return true;
      return (next.get(to) ?? []).includes(sourceId);
    });
    const routed = new Set(kept.filter(isForwardRoute).map((entry) => entry.to.trim()));
    const additions = ids
      .filter(
        (target) =>
          changed.has(target) &&
          !routed.has(target) &&
          (next.get(target) ?? []).includes(sourceId),
      )
      .map((target) => ({ to: target }));
    const nextStage: StageRef = { ...stage };
    if (kept.length !== route.length || additions.length > 0) {
      const nextRoute = [...kept, ...additions];
      if (nextRoute.length > 0) nextStage.route = nextRoute;
      else delete nextStage.route;
    }
    if (changed.has(sourceId)) {
      delete nextStage.needs;
      if ((next.get(sourceId) ?? []).length === 0) nextStage.entry = true;
      else delete nextStage.entry;
    }
    return nextStage;
  });
  return { ...draft, pipeline: { ...draft.pipeline, stages } };
}

function descendantsOf(preds: Map<string, string[]>, stageId: string): Set<string> {
  const found = new Set<string>();
  const queue = [stageId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [id, list] of preds) {
      if (list.includes(current) && !found.has(id)) {
        found.add(id);
        queue.push(id);
      }
    }
  }
  return found;
}

function stageDirectory(draft: DraftPackagePayload): string {
  const files = draft.stages ?? [];
  const dirs = new Set<string>();
  for (const stage of draft.pipeline.stages) {
    if (typeof stage.uses !== "string" || !stage.uses.trim()) continue;
    const uses = stage.uses.trim().replace(/\\/g, "/");
    const key = normalizeStagePath(uses);
    if (!files.some((file) => normalizeStagePath(file.path) === key)) continue;
    const slash = uses.lastIndexOf("/");
    dirs.add(slash >= 0 ? uses.slice(0, slash + 1) : "./");
  }
  return dirs.size === 1 ? [...dirs][0]! : DEFAULT_STAGE_DIRECTORY;
}

function uniqueStageId(draft: DraftPackagePayload, requested: string | undefined): string {
  const taken = new Set(stageIds(draft));
  for (const file of draft.stages ?? []) {
    if (typeof file.body.id === "string") taken.add(file.body.id);
  }
  const base = requested?.trim();
  if (base) {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
  }
  for (let n = 1; ; n++) {
    if (!taken.has(`stage-${n}`)) return `stage-${n}`;
  }
}

export function addStage(
  draft: DraftPackagePayload,
  opts: { id?: string; after?: string; model?: string } = {},
): { draft: DraftPackagePayload; stageId: string } {
  const ids = stageIds(draft);
  const stageId = uniqueStageId(draft, opts.id);
  const after = opts.after && ids.includes(opts.after) ? opts.after : ids.at(-1);
  const uses = `${stageDirectory(draft)}${stageId}.yaml`;
  const body: Record<string, unknown> = {
    id: stageId,
    system_prompt: `Describe what the ${stageId} stage should do.`,
    ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
    io: {
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
    },
  };
  const ref: StageRef = { id: stageId, uses };
  const insertAt =
    opts.after && ids.includes(opts.after) ? ids.indexOf(opts.after) + 1 : ids.length;
  const stages = [...draft.pipeline.stages];
  stages.splice(insertAt, 0, ref);
  const next = new Map(stagePredecessors(draft));
  next.set(stageId, after ? [after] : []);
  const appended: DraftPackagePayload = {
    ...draft,
    pipeline: { ...draft.pipeline, stages },
    stages: [...(draft.stages ?? []), { path: uses, body }],
  };
  return { draft: applyPredecessors(appended, next), stageId };
}

function withoutTarget(raw: unknown, stageId: string): unknown {
  if (typeof raw === "string") return raw.trim() === stageId ? undefined : raw;
  if (!Array.isArray(raw)) return raw;
  const kept = raw.filter((item) => needsTargets([item])[0] !== stageId);
  return kept.length > 0 ? kept : undefined;
}

export function deleteStage(
  draft: DraftPackagePayload,
  stageId: string,
): DraftPackagePayload {
  const refIndex = findStageRefIndex(draft, stageId);
  if (refIndex < 0) return draft;
  const preds = stagePredecessors(draft);
  const removedPreds = preds.get(stageId) ?? [];
  const next = new Map<string, string[]>();
  for (const [id, list] of preds) {
    if (id === stageId) continue;
    const kept = list.filter((from) => from !== stageId);
    next.set(
      id,
      list.includes(stageId) && kept.length === 0 ? [...removedPreds] : kept,
    );
  }
  const ref = draft.pipeline.stages[refIndex]!;
  const fileIndex = stageFileIndex(draft, stageId);
  const sharedFile =
    typeof ref.uses === "string" &&
    draft.pipeline.stages.some(
      (stage, index) =>
        index !== refIndex &&
        typeof stage.uses === "string" &&
        normalizeStagePath(stage.uses) === normalizeStagePath(ref.uses as string),
    );
  const stages = draft.pipeline.stages
    .filter((_, index) => index !== refIndex)
    .map((stage) => {
      const nextStage: StageRef = { ...stage };
      if (Array.isArray(stage.route)) {
        const route = stage.route.filter(
          (entry) => !(isPlainObject(entry) && entry.to === stageId),
        );
        if (route.length > 0) nextStage.route = route;
        else delete nextStage.route;
      }
      if (stage.needs !== undefined) {
        const needs = withoutTarget(stage.needs, stageId);
        if (needs === undefined) delete nextStage.needs;
        else nextStage.needs = needs;
      }
      return nextStage;
    });
  const files = (draft.stages ?? []).filter(
    (_, index) => sharedFile || index !== fileIndex,
  );
  const removed: DraftPackagePayload = {
    ...draft,
    pipeline: { ...draft.pipeline, stages },
    ...(draft.stages ? { stages: files } : {}),
  };
  return applyPredecessors(removed, next, preds);
}

function renameUses(uses: string, fromId: string, toId: string): string {
  const slash = uses.lastIndexOf("/");
  const dir = slash >= 0 ? uses.slice(0, slash + 1) : "";
  const base = slash >= 0 ? uses.slice(slash + 1) : uses;
  for (const suffix of [".stage.yaml", ".stage.yml", ".yaml", ".yml"]) {
    if (base === `${fromId}${suffix}`) return `${dir}${toId}${suffix}`;
  }
  return uses;
}

function renameNeeds(raw: unknown, fromId: string, toId: string): unknown {
  if (typeof raw === "string") return raw.trim() === fromId ? toId : raw;
  if (!Array.isArray(raw)) return raw;
  return raw.map((item) => {
    if (typeof item === "string") return item.trim() === fromId ? toId : item;
    if (isPlainObject(item) && item.id === fromId) return { ...item, id: toId };
    return item;
  });
}

export function renameStage(
  draft: DraftPackagePayload,
  fromId: string,
  toId: string,
): DraftPackagePayload {
  const target = toId.trim();
  const refIndex = findStageRefIndex(draft, fromId);
  if (refIndex < 0 || !target || target === fromId) return draft;
  if (stageIds(draft).includes(target)) return draft;
  const ref = draft.pipeline.stages[refIndex]!;
  const fileIndex = stageFileIndex(draft, fromId);
  const oldUses = typeof ref.uses === "string" ? ref.uses : undefined;
  const newUses = oldUses ? renameUses(oldUses, fromId, target) : undefined;
  const stages = draft.pipeline.stages.map((stage, index) => {
    const nextStage: StageRef = { ...stage };
    if (index === refIndex) {
      nextStage.id = target;
      if (newUses) nextStage.uses = newUses;
    }
    if (Array.isArray(stage.route)) {
      nextStage.route = stage.route.map((entry) =>
        isPlainObject(entry) && entry.to === fromId ? { ...entry, to: target } : entry,
      );
    }
    if (stage.needs !== undefined) nextStage.needs = renameNeeds(stage.needs, fromId, target);
    return nextStage;
  });
  const files = draft.stages?.map((file, index): StageFile => {
    if (index !== fileIndex) return file;
    const path =
      oldUses && newUses && normalizeStagePath(file.path) === normalizeStagePath(oldUses)
        ? newUses
        : renameUses(file.path, fromId, target);
    return { path, body: { ...file.body, id: target } };
  });
  return {
    ...draft,
    pipeline: { ...draft.pipeline, stages },
    ...(files ? { stages: files } : {}),
  };
}

export function setStageNeeds(
  draft: DraftPackagePayload,
  stageId: string,
  needs: string[],
): DraftPackagePayload {
  if (findStageRefIndex(draft, stageId) < 0) return draft;
  const ids = stageIds(draft);
  const preds = stagePredecessors(draft);
  const blocked = descendantsOf(preds, stageId);
  const wanted: string[] = [];
  for (const raw of needs) {
    const id = raw.trim();
    if (!ids.includes(id) || id === stageId || blocked.has(id) || wanted.includes(id)) {
      continue;
    }
    wanted.push(id);
  }
  const next = new Map(preds);
  next.set(stageId, wanted);
  return applyPredecessors(draft, next);
}
