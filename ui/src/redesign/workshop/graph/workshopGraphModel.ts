import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import {
  forwardRoutes,
  isForwardRoute,
  stageBodyFor,
  stageIds,
  stagePredecessors,
  stageRefFor,
} from "../stageMutators";

export type StageChangeStatus = "new" | "edited" | "unchanged";

export type WorkshopGraphChipKind = "verify" | "on_fail" | "ask" | "no_gate" | "needs";

export type WorkshopGraphChip = {
  kind: WorkshopGraphChipKind;
  label: string;
  variant: "default" | "changed" | "dashed" | "dashed-changed";
};

export type WorkshopGraphNode = {
  id: string;
  index: number;
  layer: number;
  status: StageChangeStatus;
  model: string;
  modelInherited: boolean;
  chips: WorkshopGraphChip[];
  errorCount: number;
  errorSummary: string | null;
  isEntry: boolean;
  needs: string[];
};

export type WorkshopGraphItem =
  | { kind: "node"; id: string; x: number; width: number }
  | { kind: "pass"; key: string; changed: boolean; x: number; width: number };

export type WorkshopGraphRow = { items: WorkshopGraphItem[]; width: number; offset: number };

export type WorkshopGraphSegment = {
  x: number;
  y: number;
  width: number;
  height: number;
  changed: boolean;
};

export type WorkshopGraphConnectorKind = "straight" | "fork" | "merge" | "shift" | "mixed";

export type WorkshopGraphConnector = {
  kind: WorkshopGraphConnectorKind;
  width: number;
  height: number;
  segments: WorkshopGraphSegment[];
};

export type WorkshopGraphEdge = { from: string; to: string; changed: boolean };

export type WorkshopGraphModel = {
  nodes: WorkshopGraphNode[];
  rows: WorkshopGraphRow[];
  connectors: WorkshopGraphConnector[];
  edges: WorkshopGraphEdge[];
  width: number;
  hasChanges: boolean;
};

export const GRAPH_NODE_WIDTH = 208;
export const GRAPH_PASS_WIDTH = 12;
export const GRAPH_ROW_GAP = 16;
export const GRAPH_CONNECTOR_STRAIGHT_HEIGHT = 14;
export const GRAPH_CONNECTOR_BRANCH_HEIGHT = 22;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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

function onFailOf(ref: Record<string, unknown> | undefined, body: Record<string, unknown> | undefined): unknown {
  return ref?.on_verify_fail ?? ref?.recovery ?? body?.on_verify_fail ?? body?.recovery;
}

function gateKindsOf(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.gate_kinds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((kind): kind is string => typeof kind === "string" && kind.trim().length > 0);
}

function modelOf(ref: Record<string, unknown> | undefined, body: Record<string, unknown> | undefined): string | null {
  for (const value of [body?.model, ref?.model]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function onFailLabel(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (!isPlainObject(raw)) return null;
  const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
  if (mode === "repair") return "retry";
  if (mode === "manual") return "ask";
  return mode || null;
}

function refSignature(ref: Record<string, unknown> | undefined): string {
  if (!ref) return "";
  const { route, needs: _needs, ...rest } = ref;
  const loops = Array.isArray(route) ? route.filter((entry) => !isForwardRoute(entry)) : [];
  return stableStringify({ ...rest, loops });
}

function inboundSignature(
  draft: DraftPackagePayload,
  stageId: string,
  preds: string[],
): string {
  return preds
    .map((from) => {
      const entry = forwardRoutes(stageRefFor(draft, from) ?? {}).find(
        (route) => route.to.trim() === stageId,
      );
      const { to: _to, ...options } = entry ?? { to: "" };
      return `${from}|${stableStringify(options)}`;
    })
    .sort()
    .join(";");
}

type StageSnapshot = {
  ref: Record<string, unknown> | undefined;
  body: Record<string, unknown> | undefined;
  preds: string[];
  signature: string;
};

function snapshotStages(draft: DraftPackagePayload): Map<string, StageSnapshot> {
  const preds = stagePredecessors(draft);
  const result = new Map<string, StageSnapshot>();
  for (const id of stageIds(draft)) {
    const ref = stageRefFor(draft, id);
    const body = stageBodyFor(draft, id);
    const list = preds.get(id) ?? [];
    result.set(id, {
      ref,
      body,
      preds: list,
      signature: [
        refSignature(ref),
        body === ref ? "" : stableStringify(body),
        inboundSignature(draft, id, list),
      ].join("\n"),
    });
  }
  return result;
}

export function stageChangeStatus(
  draft: DraftPackagePayload,
  baseline: DraftPackagePayload | null,
): Map<string, StageChangeStatus> {
  const current = snapshotStages(draft);
  const before = baseline ? snapshotStages(baseline) : new Map<string, StageSnapshot>();
  const result = new Map<string, StageChangeStatus>();
  for (const [id, snapshot] of current) {
    const prior = before.get(id);
    if (!prior) result.set(id, "new");
    else result.set(id, prior.signature === snapshot.signature ? "unchanged" : "edited");
  }
  return result;
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function buildChips(
  snapshot: StageSnapshot,
  prior: StageSnapshot | undefined,
  status: StageChangeStatus,
): WorkshopGraphChip[] {
  const compare = status === "edited" && prior !== undefined;
  const differs = (pick: (s: StageSnapshot) => unknown) =>
    compare && stableStringify(pick(snapshot)) !== stableStringify(pick(prior!));
  const chips: WorkshopGraphChip[] = [];
  const verify = verifyOf(snapshot.body);
  const hasVerify = hasContent(verify);
  if (hasVerify) {
    chips.push({
      kind: "verify",
      label: "verify",
      variant: differs((s) => verifyOf(s.body)) ? "changed" : "default",
    });
  }
  const onFail = onFailLabel(onFailOf(snapshot.ref, snapshot.body));
  if (onFail) {
    chips.push({
      kind: "on_fail",
      label: `on_fail: ${onFail}`,
      variant: differs((s) => onFailOf(s.ref, s.body)) ? "changed" : "default",
    });
  }
  const kinds = gateKindsOf(snapshot.body);
  const gateChanged = differs((s) => gateKindsOf(s.body));
  if (kinds.length > 0) {
    chips.push({
      kind: "ask",
      label: `ask: ${kinds[0]}${kinds.length > 1 ? ` +${kinds.length - 1}` : ""}`,
      variant: gateChanged ? "changed" : "default",
    });
  } else if (hasVerify && !onFail) {
    chips.push({
      kind: "no_gate",
      label: "no gate",
      variant:
        gateChanged || differs((s) => onFailOf(s.ref, s.body)) ? "dashed-changed" : "dashed",
    });
  }
  if (compare && !sameMembers(snapshot.preds, prior!.preds)) {
    chips.push({
      kind: "needs",
      label: `needs: ${snapshot.preds.length > 0 ? snapshot.preds.join(", ") : "none"}`,
      variant: "changed",
    });
  }
  return chips;
}

const FIELD_PATTERN =
  /\b(io\.(?:input|output)(?:\.schema)?|io|verify(?:\[\d+\])?|on_verify_fail|gate_kinds|system_prompt|model|timeout_ms|route|skill|mcp|secrets|requires|browser)(?![\w[])/;

const CODE_FIELDS: Record<string, string> = {
  "stage.invalid_io": "io",
  "stage.invalid_payload_schema": "io.output",
  "stage.invalid_clone_input_schema": "io.input",
  "stage.unresolved_schema_ref": "io",
  "stage.invalid_model": "model",
  "stage.missing_model": "model",
  "stage.invalid_gate_kinds": "gate_kinds",
  "stage.invalid_pre_emit_checks": "verify",
  "pipeline.invalid_completion": "verify",
  "pipeline.invalid_verify": "verify",
  "pipeline.invalid_recovery": "on_verify_fail",
  "pipeline.route_if_invalid": "route",
  "pipeline.dag_error": "route",
  "pipeline.io_incompatible": "io",
};

export function findingFieldPath(finding: ValidationFinding): string {
  const fromMessage = FIELD_PATTERN.exec(finding.message)?.[1];
  if (fromMessage) return fromMessage.replace(/\.schema$/, "");
  const mapped = CODE_FIELDS[finding.code];
  if (mapped) return mapped;
  const suffix = finding.code.split(".").pop() ?? "";
  const field = suffix.replace(/^invalid_|^missing_|^unknown_/, "");
  return field || "stage";
}

export function findingStageId(finding: ValidationFinding): string | null {
  if (finding.stageId) return finding.stageId;
  return /stage "([^"]+)"/.exec(finding.message)?.[1] ?? null;
}

export function nodeErrorSummary(
  findings: ValidationFinding[],
  stageId: string,
): { count: number; summary: string | null } {
  const errors = findings.filter(
    (finding) => finding.severity === "error" && findingStageId(finding) === stageId,
  );
  if (errors.length === 0) return { count: 0, summary: null };
  const fields: string[] = [];
  for (const finding of errors) {
    const field = findingFieldPath(finding);
    if (!fields.includes(field)) fields.push(field);
  }
  const noun = errors.length === 1 ? "error" : "errors";
  const head = fields.length > 1 ? `${fields[0]} +${fields.length - 1}` : fields[0];
  return { count: errors.length, summary: `${head} · ${errors.length} ${noun}` };
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

type LayoutItem =
  | { kind: "node"; id: string; sortIndex: number }
  | { kind: "pass"; key: string; changed: boolean; sortIndex: number };

type Link = { fromLayer: number; from: string; to: string; changed: boolean };

function itemKey(item: LayoutItem): string {
  return item.kind === "node" ? `node:${item.id}` : `pass:${item.key}`;
}

function itemWidth(item: LayoutItem): number {
  return item.kind === "node" ? GRAPH_NODE_WIDTH : GRAPH_PASS_WIDTH;
}

export function buildWorkshopGraphModel(
  draft: DraftPackagePayload,
  options: {
    baseline?: DraftPackagePayload | null;
    findings?: ValidationFinding[];
    defaultModel?: string | null;
  } = {},
): WorkshopGraphModel {
  const baseline = options.baseline ?? null;
  const findings = options.findings ?? [];
  const ids = stageIds(draft);
  const index = new Map(ids.map((id, i) => [id, i]));
  const preds = stagePredecessors(draft);
  const statuses = stageChangeStatus(draft, baseline);
  const current = snapshotStages(draft);
  const before = baseline ? snapshotStages(baseline) : new Map<string, StageSnapshot>();
  const pipelineModel =
    typeof draft.pipeline.model === "string" && draft.pipeline.model.trim()
      ? draft.pipeline.model.trim()
      : null;
  const inheritedModel = pipelineModel ?? options.defaultModel?.trim() ?? null;
  const layers = computeLayers(ids, preds);

  const nodes: WorkshopGraphNode[] = ids.map((id, i) => {
    const snapshot = current.get(id)!;
    const status = statuses.get(id) ?? "new";
    const ownModel = modelOf(snapshot.ref, snapshot.body);
    const errors = nodeErrorSummary(findings, id);
    return {
      id,
      index: i,
      layer: layers.get(id) ?? 0,
      status,
      model: ownModel ?? `inherits · ${inheritedModel || "default"}`,
      modelInherited: ownModel === null,
      chips: buildChips(snapshot, before.get(id), status),
      errorCount: errors.count,
      errorSummary: errors.summary,
      isEntry: (preds.get(id) ?? []).length === 0,
      needs: preds.get(id) ?? [],
    };
  });

  const baselinePreds = baseline ? stagePredecessors(baseline) : new Map<string, string[]>();
  const edges: WorkshopGraphEdge[] = [];
  for (const id of ids) {
    for (const from of preds.get(id) ?? []) {
      if ((layers.get(from) ?? 0) >= (layers.get(id) ?? 0)) continue;
      const changed =
        statuses.get(id) === "new" ||
        statuses.get(from) === "new" ||
        !(baselinePreds.get(id) ?? []).includes(from);
      edges.push({ from, to: id, changed });
    }
  }

  const layerCount = ids.length === 0 ? 0 : Math.max(...ids.map((id) => layers.get(id) ?? 0)) + 1;
  const layerItems: LayoutItem[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) {
    layerItems[layers.get(id) ?? 0]!.push({ kind: "node", id, sortIndex: index.get(id) ?? 0 });
  }
  const links: Link[] = [];
  for (const edge of edges) {
    const start = layers.get(edge.from) ?? 0;
    const end = layers.get(edge.to) ?? 0;
    let prev = `node:${edge.from}`;
    for (let layer = start + 1; layer < end; layer++) {
      const key = `${edge.from}->${edge.to}#${layer}`;
      layerItems[layer]!.push({
        kind: "pass",
        key,
        changed: edge.changed,
        sortIndex: index.get(edge.to) ?? 0,
      });
      links.push({ fromLayer: layer - 1, from: prev, to: `pass:${key}`, changed: edge.changed });
      prev = `pass:${key}`;
    }
    links.push({ fromLayer: end - 1, from: prev, to: `node:${edge.to}`, changed: edge.changed });
  }

  const position = new Map<string, number>();
  layerItems.forEach((items, layer) => {
    if (layer > 0) {
      const bary = new Map<string, number>();
      for (const item of items) {
        const key = itemKey(item);
        const sources = links
          .filter((link) => link.fromLayer === layer - 1 && link.to === key)
          .map((link) => position.get(link.from) ?? 0);
        bary.set(key, sources.length > 0 ? sources.reduce((a, b) => a + b, 0) / sources.length : 0);
      }
      items.sort(
        (a, b) =>
          (bary.get(itemKey(a)) ?? 0) - (bary.get(itemKey(b)) ?? 0) ||
          a.sortIndex - b.sortIndex ||
          (a.kind === b.kind ? 0 : a.kind === "node" ? -1 : 1),
      );
    }
    items.forEach((item, order) => position.set(itemKey(item), order));
  });

  const measured = layerItems.map((items) => {
    let x = 0;
    const placed = items.map((item): WorkshopGraphItem => {
      const width = itemWidth(item);
      const placedItem: WorkshopGraphItem =
        item.kind === "node"
          ? { kind: "node", id: item.id, x, width }
          : { kind: "pass", key: item.key, changed: item.changed, x, width };
      x += width + GRAPH_ROW_GAP;
      return placedItem;
    });
    return { items: placed, width: Math.max(0, x - GRAPH_ROW_GAP) };
  });
  const width = Math.max(0, ...measured.map((row) => row.width));
  const rows: WorkshopGraphRow[] = measured.map((row) => ({
    ...row,
    offset: Math.floor((width - row.width) / 2),
  }));

  const centers = rows.map((row) => {
    const map = new Map<string, number>();
    for (const item of row.items) {
      const key = item.kind === "node" ? `node:${item.id}` : `pass:${item.key}`;
      map.set(key, row.offset + item.x + Math.floor(item.width / 2));
    }
    return map;
  });

  const connectors: WorkshopGraphConnector[] = [];
  for (let layer = 0; layer < rows.length - 1; layer++) {
    const layerLinks = links.filter((link) => link.fromLayer === layer);
    const spans = layerLinks.map((link) => ({
      link,
      x1: centers[layer]!.get(link.from) ?? 0,
      x2: centers[layer + 1]!.get(link.to) ?? 0,
    }));
    const straight = spans.every((span) => span.x1 === span.x2);
    const height = straight ? GRAPH_CONNECTOR_STRAIGHT_HEIGHT : GRAPH_CONNECTOR_BRANCH_HEIGHT;
    const half = Math.floor(height / 2);
    const segments: WorkshopGraphSegment[] = [];
    for (const { link, x1, x2 } of spans) {
      if (x1 === x2) {
        segments.push({ x: x1, y: 0, width: 1, height, changed: link.changed });
        continue;
      }
      segments.push({ x: x1, y: 0, width: 1, height: half, changed: link.changed });
      segments.push({
        x: Math.min(x1, x2),
        y: half,
        width: Math.abs(x2 - x1) + 1,
        height: 1,
        changed: link.changed,
      });
      segments.push({ x: x2, y: half, width: 1, height: height - half, changed: link.changed });
    }
    segments.sort((a, b) => Number(a.changed) - Number(b.changed));
    const outDegree = new Map<string, number>();
    const inDegree = new Map<string, number>();
    for (const link of layerLinks) {
      outDegree.set(link.from, (outDegree.get(link.from) ?? 0) + 1);
      inDegree.set(link.to, (inDegree.get(link.to) ?? 0) + 1);
    }
    const forks = [...outDegree.values()].some((n) => n > 1);
    const merges = [...inDegree.values()].some((n) => n > 1);
    const kind: WorkshopGraphConnectorKind =
      forks && merges ? "mixed" : forks ? "fork" : merges ? "merge" : straight ? "straight" : "shift";
    connectors.push({ kind, width, height, segments });
  }

  return {
    nodes,
    rows,
    connectors,
    edges,
    width,
    hasChanges: nodes.some((node) => node.status !== "unchanged"),
  };
}
