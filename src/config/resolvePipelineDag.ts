import type {
  PipelineNeedEdge,
  PipelineRouteEdge,
  PipelineRouteLoopEntry,
  PipelineStageRef,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
  FeedbackLoopConfig,
} from "../types/pipeline.js";
import type { CompletionContract, RecoveryPolicy } from "../types/completion.js";
import { BODY_KEYS, isAllowedPipelineStageEntryKey } from "./pipelineStageKeys.js";
import { invertRouteToPredecessorEdges, predecessorEdges } from "./pipelineNeeds.js";
import {
  normalizePipelineStageEntries,
  toWiringRefs,
} from "./normalizePipelineStageEntry.js";
import { toRouteEdges, toRouteLoopEntries } from "./pipelineRoute.js";

type NormalizedEdge = {
  id: string;
  needs: string | null;
  needsEdges: PipelineNeedEdge[];
  /** This stage's own outbound `route` entries (forward direction, not yet inverted). */
  routeEdges: PipelineRouteEdge[];
  /** This stage's own outbound `route` loop entries (ticket 03: no forward edge). */
  routeLoopEntries: PipelineRouteLoopEntry[];
  entry?: boolean;
  stageIndex: number;
  clonable?: boolean;
  clone_cap?: number;
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  replay_safe?: boolean;
};

export type ResolvePipelineDagContext = {
  pipelineId: string;
  path: string;
};

function pipelineLabel(ctx: ResolvePipelineDagContext): string {
  return `Pipeline ${ctx.pipelineId} (${ctx.path})`;
}

function formatError(ctx: ResolvePipelineDagContext, message: string): string {
  return `${pipelineLabel(ctx)}: ${message}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapRawStagesForNormalize(
  rawStages: unknown[],
  ctx: ResolvePipelineDagContext,
): { raw: unknown; declaringPath: string }[] {
  return rawStages.map((raw) => {
    if (!isPlainObject(raw)) {
      return { raw, declaringPath: ctx.path };
    }
    const id = typeof raw.id === "string" && raw.id ? raw.id : undefined;
    const hasUses = typeof raw.uses === "string";
    const hasBody = Object.keys(raw).some(
      (key) => BODY_KEYS.has(key) && key !== "skill" && key !== "mcp",
    );
    if (hasUses || hasBody || !id) {
      return { raw, declaringPath: ctx.path };
    }
    return {
      raw: { ...raw, uses: `./${id}.yaml` },
      declaringPath: ctx.path,
    };
  });
}

function normalizeToEdges(entries: PipelineStageRef[]): NormalizedEdge[] {
  return entries.map((entry, index) => {
    const needsEdges: PipelineNeedEdge[] = [];
    const routeEdges = toRouteEdges(entry.route);
    const routeLoopEntries = toRouteLoopEntries(entry.route);
    return {
      id: entry.id,
      needs: needsEdges.length === 1 ? needsEdges[0]!.id : null,
      needsEdges,
      routeEdges,
      routeLoopEntries,
      stageIndex: index,
      ...(entry.entry !== undefined ? { entry: entry.entry } : {}),
      ...(entry.clonable !== undefined ? { clonable: entry.clonable } : {}),
      ...(entry.clone_cap !== undefined ? { clone_cap: entry.clone_cap } : {}),
      ...(entry.completion !== undefined ? { completion: entry.completion } : {}),
      ...(entry.recovery !== undefined ? { recovery: entry.recovery } : {}),
      ...(entry.replay_safe !== undefined ? { replay_safe: entry.replay_safe } : {}),
    };
  });
}

function detectDuplicateIds(edges: NormalizedEdge[], ctx: ResolvePipelineDagContext): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    if (seen.has(edge.id)) {
      throw new Error(formatError(ctx, `duplicate stage "${edge.id}"`));
    }
    seen.add(edge.id);
  }
}

function validateRouteTargets(edges: NormalizedEdge[], ctx: ResolvePipelineDagContext): void {
  const declared = new Set(edges.map((edge) => edge.id));
  for (const edge of edges) {
    for (const route of edge.routeEdges) {
      if (!declared.has(route.to)) {
        throw new Error(
          formatError(ctx, `stage "${edge.id}" has unknown route target "${route.to}"`),
        );
      }
    }
  }
}

/**
 * A stage's own resolved node can carry only one `feedback_loop`-shaped
 * replay policy (`ResolvedPipelineStageNode.feedback_loop` is a single
 * object, not a list — the shape the runtime already consumes and that this
 * ticket must not change). A stage declaring more than one `type: loop`
 * route entry has no unambiguous single replay policy to synthesize onto
 * that field, so it is rejected at parse time rather than silently picking
 * one and discarding the rest.
 */
function validateRouteLoopEntryCount(edges: NormalizedEdge[], ctx: ResolvePipelineDagContext): void {
  for (const edge of edges) {
    if (edge.routeLoopEntries.length > 1) {
      throw new Error(
        formatError(
          ctx,
          `stage "${edge.id}": route supports at most one loop entry, got ${edge.routeLoopEntries.length}`,
        ),
      );
    }
  }
}

/**
 * Inverts each stage's own outbound `route` entries into predecessor edges on
 * their targets, stored under the same `needs`/`needsEdges` fields the
 * resolver already produces from `needs` — so cycle detection, ancestor
 * computation, topological sort, and childrenOf all pick route-declared
 * fan-in/fan-out up for free, with no changes to that machinery.
 */
function mergeRouteEdgesIntoNeeds(edges: NormalizedEdge[]): void {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const inbound = invertRouteToPredecessorEdges(
    edges.map((edge) => ({ id: edge.id, route: edge.routeEdges })),
  );

  for (const [targetId, incoming] of inbound) {
    const target = byId.get(targetId);
    if (!target || incoming.length === 0) continue;
    target.needsEdges = [...target.needsEdges, ...incoming];
    target.needs = target.needsEdges.length === 1 ? target.needsEdges[0]!.id : null;
  }
}

/**
 * `entry`/unreachable-stage validation only applies to pipelines that opt into
 * the `route`/`entry` vocabulary at all — a pipeline that only uses `needs`
 * (and never declares `route` or `entry` anywhere) is left completely alone,
 * so existing needs-based pipelines keep working unchanged.
 */
function validateEntryStageUsage(edges: NormalizedEdge[], ctx: ResolvePipelineDagContext): void {
  const usesRouteVocabulary = edges.some(
    (edge) => edge.entry === true || edge.routeEdges.length > 0,
  );
  if (!usesRouteVocabulary) return;

  const hasEntry = edges.some((edge) => edge.entry === true);
  if (!hasEntry) {
    throw new Error(formatError(ctx, "no stage is marked entry: true"));
  }

  const targeted = new Set<string>();
  for (const edge of edges) {
    for (const route of edge.routeEdges) {
      targeted.add(route.to);
    }
  }

  for (const edge of edges) {
    if (edge.entry === true) continue;
    if (targeted.has(edge.id)) continue;
    throw new Error(
      formatError(
        ctx,
        `stage "${edge.id}" is unreachable: not marked entry: true and not targeted by any route entry`,
      ),
    );
  }
}

function detectCycle(edges: NormalizedEdge[], ctx: ResolvePipelineDagContext): void {
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const edge of edges) {
    indegree.set(edge.id, 0);
    children.set(edge.id, []);
  }

  for (const edge of edges) {
    for (const parent of edge.needsEdges) {
      indegree.set(edge.id, (indegree.get(edge.id) ?? 0) + 1);
      children.get(parent.id)?.push(edge.id);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const child of children.get(current) ?? []) {
      const nextDegree = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, nextDegree);
      if (nextDegree === 0) queue.push(child);
    }
  }

  if (visited !== edges.length) {
    throw new Error(formatError(ctx, "dependency cycle detected"));
  }
}

function computeAncestors(edges: NormalizedEdge[]): Map<string, string[]> {
  const parentsById = new Map(edges.map((edge) => [edge.id, edge.needsEdges]));
  const ancestorsById = new Map<string, string[]>();

  function ancestorsFor(id: string): string[] {
    const cached = ancestorsById.get(id);
    if (cached) return cached;

    const parents = parentsById.get(id) ?? [];
    if (parents.length === 0) {
      ancestorsById.set(id, []);
      return [];
    }

    const seen = new Set<string>();
    const ancestors: string[] = [];
    for (const parent of parents) {
      for (const ancestor of ancestorsFor(parent.id)) {
        if (seen.has(ancestor)) continue;
        seen.add(ancestor);
        ancestors.push(ancestor);
      }
      if (!seen.has(parent.id)) {
        seen.add(parent.id);
        ancestors.push(parent.id);
      }
    }
    ancestorsById.set(id, ancestors);
    return ancestors;
  }

  for (const edge of edges) {
    ancestorsFor(edge.id);
  }

  return ancestorsById;
}

function topologicalSort(edges: NormalizedEdge[]): NormalizedEdge[] {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const edge of edges) {
    indegree.set(edge.id, 0);
    children.set(edge.id, []);
  }

  for (const edge of edges) {
    for (const parent of edge.needsEdges) {
      indegree.set(edge.id, (indegree.get(edge.id) ?? 0) + 1);
      children.get(parent.id)?.push(edge.id);
    }
  }

  for (const [, childIds] of children) {
    childIds.sort(
      (a, b) => (byId.get(a)?.stageIndex ?? 0) - (byId.get(b)?.stageIndex ?? 0),
    );
  }

  const roots = edges
    .filter((edge) => edge.needsEdges.length === 0)
    .sort((a, b) => a.stageIndex - b.stageIndex)
    .map((edge) => edge.id);

  const sorted: NormalizedEdge[] = [];
  const queue = [...roots];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const edge = byId.get(current);
    if (edge) sorted.push(edge);

    for (const child of children.get(current) ?? []) {
      const nextDegree = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, nextDegree);
      if (nextDegree === 0) queue.push(child);
    }
  }

  return sorted;
}

/**
 * Ticket 03: a route loop entry carries the same replay-policy fields as
 * today's `feedback_loop` (just `to` instead of `target`). Synthesizing it
 * into the exact `FeedbackLoopConfig` shape here — onto the same
 * `ResolvedPipelineStageNode.feedback_loop` field the legacy path populates
 * — means `validateFeedbackLoopFields` below and every downstream
 * runtime/executor consumer of `.feedback_loop` need zero changes to also
 * support route-declared loops.
 */
function toFeedbackLoopConfigFromRouteLoopEntry(entry: PipelineRouteLoopEntry): FeedbackLoopConfig {
  return {
    target: entry.to,
    max_replays: entry.max_replays,
    on_max_replays: entry.on_max_replays,
    replay_session: entry.replay_session,
  };
}

function buildResolvedPipelineDag(edges: NormalizedEdge[]): ResolvedPipelineDag {
  const ancestorsById = computeAncestors(edges);
  const sortedEdges = topologicalSort(edges);

  const childrenOf: Record<string, string[]> = {};
  for (const edge of edges) {
    childrenOf[edge.id] = [];
  }
  for (const edge of edges) {
    for (const parent of edge.needsEdges) {
      childrenOf[parent.id].push(edge.id);
    }
  }
  for (const id of Object.keys(childrenOf)) {
    childrenOf[id].sort(
      (a, b) =>
        (edges.find((edge) => edge.id === a)?.stageIndex ?? 0) -
        (edges.find((edge) => edge.id === b)?.stageIndex ?? 0),
    );
  }

  const roots = edges
    .filter((edge) => edge.needsEdges.length === 0)
    .sort((a, b) => a.stageIndex - b.stageIndex)
    .map((edge) => edge.id);

  const nodes: ResolvedPipelineStageNode[] = sortedEdges.map((edge) => ({
    id: edge.id,
    needs: edge.needs,
    needsEdges: edge.needsEdges,
    ancestors: ancestorsById.get(edge.id) ?? [],
    stageIndex: edge.stageIndex,
    ...(edge.entry === true ? { entry: true } : {}),
    ...(edge.clonable === true
      ? { clonable: true, clone_cap: edge.clone_cap ?? 5 }
      : {}),
    ...(edge.completion !== undefined ? { completion: edge.completion } : {}),
    ...(edge.recovery !== undefined ? { recovery: edge.recovery } : {}),
    ...(edge.routeLoopEntries.length === 1
      ? { feedback_loop: toFeedbackLoopConfigFromRouteLoopEntry(edge.routeLoopEntries[0]!) }
      : {}),
    ...(edge.replay_safe !== undefined ? { replay_safe: edge.replay_safe } : {}),
  }));

  return { nodes, roots, childrenOf };
}

function validateClonableFields(
  edges: NormalizedEdge[],
  dag: ResolvedPipelineDag,
  ctx: ResolvePipelineDagContext,
): void {
  for (const edge of edges) {
    if (edge.clone_cap !== undefined && edge.clonable !== true) {
      throw new Error(
        formatError(ctx, `stage "${edge.id}": clone_cap requires clonable: true`),
      );
    }
    if (edge.clonable === true && edge.clone_cap !== undefined) {
      if (!Number.isInteger(edge.clone_cap) || edge.clone_cap < 2) {
        throw new Error(
          formatError(
            ctx,
            `stage "${edge.id}": clone_cap must be an integer greater than or equal to 2`,
          ),
        );
      }
    }
    if (edge.clonable === true && (dag.childrenOf[edge.id] ?? []).length === 0) {
      throw new Error(
        formatError(ctx, `clonable on stage "${edge.id}": no children in the DAG`),
      );
    }
  }
}

function validateFeedbackLoopFields(
  dag: ResolvedPipelineDag,
  ctx: ResolvePipelineDagContext,
): void {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  for (const source of dag.nodes) {
    const policy = source.feedback_loop;
    if (!policy) continue;
    if (source.clonable === true) {
      throw new Error(
        formatError(
          ctx,
          `stage "${source.id}": feedback_loop source cannot be clonable`,
        ),
      );
    }
    const targetId = policy.target;
    const target = byId.get(targetId);
    if (!target) {
      throw new Error(
        formatError(ctx, `stage "${source.id}": feedback_loop target "${targetId}" is not declared`),
      );
    }
    if (!source.ancestors.includes(targetId)) {
      throw new Error(
        formatError(ctx, `stage "${source.id}": feedback_loop target "${targetId}" must be an earlier ancestor`),
      );
    }
    if (target.clonable === true) {
      throw new Error(
        formatError(ctx, `stage "${source.id}": feedback_loop target "${targetId}" cannot be clonable`),
      );
    }
    const targetIndex = source.ancestors.indexOf(targetId);
    const route = [...source.ancestors.slice(targetIndex), source.id];
    const unsafeStage = route.find((stageId) => byId.get(stageId)?.replay_safe === false);
    if (unsafeStage !== undefined) {
      throw new Error(
        formatError(
          ctx,
          `stage "${source.id}": feedback_loop target "${targetId}" replays replay_safe: false stage "${unsafeStage}"`,
        ),
      );
    }
  }
}

export function resolvePipelineDagFromRefs(
  refs: PipelineStageRef[],
  ctx: ResolvePipelineDagContext,
): { stages: string[]; dag: ResolvedPipelineDag } {
  const edges = normalizeToEdges(refs);
  detectDuplicateIds(edges, ctx);
  validateRouteTargets(edges, ctx);
  validateRouteLoopEntryCount(edges, ctx);
  validateEntryStageUsage(edges, ctx);
  mergeRouteEdgesIntoNeeds(edges);
  detectCycle(edges, ctx);

  const stages = edges
    .slice()
    .sort((a, b) => a.stageIndex - b.stageIndex)
    .map((edge) => edge.id);
  const dag = buildResolvedPipelineDag(edges);
  validateClonableFields(edges, dag, ctx);
  validateFeedbackLoopFields(dag, ctx);

  return { stages, dag };
}

export function resolvePipelineDag(
  rawStages: unknown,
  ctx: ResolvePipelineDagContext,
): { stages: string[]; dag: ResolvedPipelineDag } {
  if (!Array.isArray(rawStages)) {
    throw new Error(formatError(ctx, "stages[] is required"));
  }
  if (rawStages.length === 0) {
    throw new Error(formatError(ctx, "stages must be non-empty"));
  }
  const outcome = normalizePipelineStageEntries(
    wrapRawStagesForNormalize(rawStages, ctx),
    ctx,
  );
  if (!outcome.ok) {
    throw new Error(
      outcome.issues[0]?.message ?? formatError(ctx, "invalid stage entries"),
    );
  }
  return resolvePipelineDagFromRefs(toWiringRefs(outcome.value), ctx);
}

function sameNeedIf(
  a: PipelineNeedEdge["if"],
  b: PipelineNeedEdge["if"],
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function areResolvedDagsEquivalent(a: ResolvedPipelineDag, b: ResolvedPipelineDag): boolean {
  const nodeIdsA = new Set(a.nodes.map((node) => node.id));
  const nodeIdsB = new Set(b.nodes.map((node) => node.id));
  if (nodeIdsA.size !== nodeIdsB.size) return false;
  for (const id of nodeIdsA) {
    if (!nodeIdsB.has(id)) return false;
  }

  const byIdA = new Map(a.nodes.map((node) => [node.id, node]));
  const byIdB = new Map(b.nodes.map((node) => [node.id, node]));

  for (const id of nodeIdsA) {
    const nodeA = byIdA.get(id)!;
    const nodeB = byIdB.get(id)!;
    if (nodeA.needs !== nodeB.needs) return false;
    const edgesA = predecessorEdges(nodeA);
    const edgesB = predecessorEdges(nodeB);
    if (edgesA.length !== edgesB.length) return false;
    for (let i = 0; i < edgesA.length; i++) {
      if (edgesA[i]!.id !== edgesB[i]!.id) return false;
      if (edgesA[i]!.on.length !== edgesB[i]!.on.length) return false;
      for (let j = 0; j < edgesA[i]!.on.length; j++) {
        if (edgesA[i]!.on[j] !== edgesB[i]!.on[j]) return false;
      }
      if (!sameNeedIf(edgesA[i]!.if, edgesB[i]!.if)) return false;
    }
    if (nodeA.ancestors.length !== nodeB.ancestors.length) return false;
    for (let i = 0; i < nodeA.ancestors.length; i++) {
      if (nodeA.ancestors[i] !== nodeB.ancestors[i]) return false;
    }
    if ((nodeA.replay_safe ?? true) !== (nodeB.replay_safe ?? true)) return false;
    if (nodeA.feedback_loop?.max_replays !== nodeB.feedback_loop?.max_replays) {
      return false;
    }
    if (
      nodeA.feedback_loop?.on_max_replays !==
      nodeB.feedback_loop?.on_max_replays
    ) {
      return false;
    }
    if (
      nodeA.feedback_loop?.replay_session !== nodeB.feedback_loop?.replay_session
    ) {
      return false;
    }
    if (nodeA.feedback_loop?.target !== nodeB.feedback_loop?.target) return false;
  }

  return true;
}

export function extractPipelineStageIds(rawStages: unknown[]): string[] | null {
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    return null;
  }

  const stageIds: string[] = [];
  for (const entry of rawStages) {
    if (typeof entry === "string") {
      return null;
    }

    if (!isPlainObject(entry)) return null;
    const keys = Object.keys(entry);
    for (const key of keys) {
      if (!isAllowedPipelineStageEntryKey(key)) return null;
    }
    if (typeof entry.id !== "string" || !entry.id) return null;
    if (
      entry.needs !== undefined ||
      entry.fork !== undefined ||
      entry.feedback_loop !== undefined ||
      entry.route_select !== undefined ||
      entry.allow_none !== undefined
    ) {
      return null;
    }
    stageIds.push(entry.id);
  }

  return stageIds;
}
