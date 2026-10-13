import type { DraftPackagePayload } from "../../api";
import { onFailLabel } from "../workshop/graph/workshopGraphModel";
import {
  needsTargets,
  stageBodyFor,
  stageIds,
  stagePredecessors,
  stageRefFor,
} from "../workshop/stageMutators";

export type EditorGateChip = {
  kind: "verify" | "on_fail" | "ask" | "no_gate";
  label: string;
};

export type EditorLiveNode = {
  key: string;
  stageId: string;
  loop: boolean;
  chips: EditorGateChip[];
};

export type EditorLiveEdge = { from: string; to: string };

export type EditorLiveGraph = {
  stageCount: number;
  lanes: number;
  summary: string;
  useDag: boolean;
  layers: EditorLiveNode[][];
  edges: EditorLiveEdge[];
};

export function editorGraphSummary(stageCount: number, lanes: number): string {
  const stageWord = stageCount === 1 ? "stage" : "stages";
  return `${stageCount} ${stageWord} · ${lanes} parallel`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

function verifyOf(body: Record<string, unknown> | undefined): unknown {
  if (!body) return undefined;
  return body.verify ?? body.completion ?? body.pre_emit_checks;
}

function onFailOf(
  ref: Record<string, unknown> | undefined,
  body: Record<string, unknown> | undefined,
): unknown {
  return ref?.on_verify_fail ?? ref?.recovery ?? body?.on_verify_fail ?? body?.recovery;
}

function gateKindsOf(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.gate_kinds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((kind): kind is string => typeof kind === "string" && kind.trim().length > 0);
}

export function editorGateChips(
  ref: Record<string, unknown> | undefined,
  body: Record<string, unknown> | undefined,
): EditorGateChip[] {
  const chips: EditorGateChip[] = [];
  const verify = verifyOf(body);
  const hasVerify = hasContent(verify);
  if (hasVerify) chips.push({ kind: "verify", label: "verify" });
  const onFail = onFailLabel(onFailOf(ref, body));
  if (onFail) chips.push({ kind: "on_fail", label: `on_fail: ${onFail}` });
  const kinds = gateKindsOf(body);
  if (kinds.length > 0) {
    chips.push({
      kind: "ask",
      label: `ask: ${kinds[0]}${kinds.length > 1 ? ` +${kinds.length - 1}` : ""}`,
    });
  } else if (hasVerify && !onFail) {
    chips.push({ kind: "no_gate", label: "no gate" });
  }
  return chips;
}

function explicitWiring(draft: DraftPackagePayload): boolean {
  return draft.pipeline.stages.some(
    (stage) => needsTargets(stage.needs).length > 0 || (Array.isArray(stage.route) && stage.route.length > 0),
  );
}

function loopTargets(stage: Record<string, unknown>): string[] {
  if (!Array.isArray(stage.route)) return [];
  const ids: string[] = [];
  for (const entry of stage.route) {
    if (!isPlainObject(entry) || entry.type !== "loop") continue;
    if (typeof entry.to === "string" && entry.to.trim()) ids.push(entry.to.trim());
  }
  return ids;
}

function computeLayers(ids: string[], preds: Map<string, string[]>): Map<string, number> {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const layerFor = (id: string): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return -1;
    visiting.add(id);
    const inbound = (preds.get(id) ?? []).map(layerFor).filter((layer) => layer >= 0);
    visiting.delete(id);
    const layer = inbound.length === 0 ? 0 : Math.max(...inbound) + 1;
    layers.set(id, layer);
    return layer;
  };
  for (const id of ids) layerFor(id);
  return layers;
}

type Slot = {
  key: string;
  stageId: string;
  loop: boolean;
  sourceIndex: number;
};

export function buildEditorLiveGraph(draft: DraftPackagePayload): EditorLiveGraph {
  const ids = stageIds(draft);
  const preds = stagePredecessors(draft);
  const rank = computeLayers(ids, preds);
  const buckets = new Map<number, Slot[]>();
  ids.forEach((id, index) => {
    const layer = rank.get(id) ?? 0;
    const list = buckets.get(layer) ?? [];
    list.push({ key: id, stageId: id, loop: false, sourceIndex: index });
    buckets.set(layer, list);
  });

  const edges: EditorLiveEdge[] = [];
  for (const id of ids) {
    for (const from of preds.get(id) ?? []) {
      if ((rank.get(from) ?? 0) < (rank.get(id) ?? 0)) edges.push({ from, to: id });
    }
  }

  draft.pipeline.stages.forEach((stage, index) => {
    const sourceId = ids[index];
    if (!sourceId) return;
    const sourceLayer = rank.get(sourceId) ?? 0;
    for (const target of loopTargets(stage)) {
      if (!rank.has(target)) continue;
      const targetLayer = rank.get(target) ?? 0;
      if (targetLayer > sourceLayer) continue;
      const dest = sourceLayer + 1;
      const key = `loop:${sourceId}>${target}`;
      const list = buckets.get(dest) ?? [];
      if (list.some((node) => node.key === key || (node.stageId === target && !node.loop))) continue;
      list.push({ key, stageId: target, loop: true, sourceIndex: index });
      buckets.set(dest, list);
      edges.push({ from: sourceId, to: key });
    }
  });

  const layers = [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((layer) => {
      const slots = buckets.get(layer) ?? [];
      slots.sort((a, b) => Number(a.loop) - Number(b.loop) || a.sourceIndex - b.sourceIndex);
      return slots.map((slot): EditorLiveNode => ({
        key: slot.key,
        stageId: slot.stageId,
        loop: slot.loop,
        chips: slot.loop ? [] : editorGateChips(stageRefFor(draft, slot.stageId), stageBodyFor(draft, slot.stageId)),
      }));
    });

  const stageCount = ids.length;
  const lanes = layers.reduce((max, layer) => Math.max(max, layer.length), 0);
  return {
    stageCount,
    lanes,
    summary: editorGraphSummary(stageCount, lanes),
    useDag: explicitWiring(draft),
    layers,
    edges,
  };
}
