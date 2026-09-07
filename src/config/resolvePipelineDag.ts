import type {
  PipelineStageRef,
  PipelineStageYamlEntry,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
  FeedbackLoopConfig,
} from "../types/pipeline.js";
import type { CompletionContract, RecoveryPolicy } from "../types/completion.js";
import { isAllowedPipelineStageEntryKey } from "./pipelineStageKeys.js";
import { parseExecutionPolicy } from "./parseCompletionContract.js";

const ALLOWED_FORK_KEYS = new Set(["select", "allow_none"]);

type NormalizedEdge = {
  id: string;
  needs: string | null;
  stageIndex: number;
  fork?: { select: "one" | "subset"; allow_none?: boolean };
  clonable?: boolean;
  clone_cap?: number;
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  feedback_loop?: FeedbackLoopConfig;
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

const ALLOWED_FEEDBACK_LOOP_KEYS = new Set([
  "target",
  "max_replays",
  "on_max_replays",
  "replay_session",
]);

export function parseFeedbackLoopConfig(
  value: unknown,
  stageId: string,
  ctx: ResolvePipelineDagContext,
): FeedbackLoopConfig {
  if (!isPlainObject(value)) {
    throw new Error(formatError(ctx, `stage "${stageId}": feedback_loop must be an object`));
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FEEDBACK_LOOP_KEYS.has(key)) {
      throw new Error(
        formatError(ctx, `stage "${stageId}": feedback_loop: unknown key "${key}"`),
      );
    }
  }
  if (Array.isArray(value.target)) {
    throw new Error(
      formatError(
        ctx,
        `stage "${stageId}": feedback_loop.target must be a single stage id string, not an array`,
      ),
    );
  }
  if (typeof value.target !== "string" || value.target.trim() === "") {
    throw new Error(
      formatError(ctx, `stage "${stageId}": feedback_loop.target must be a non-empty stage id`),
    );
  }
  if (!Number.isInteger(value.max_replays) || (value.max_replays as number) < 1) {
    throw new Error(
      formatError(ctx, `stage "${stageId}": feedback_loop.max_replays must be a positive integer`),
    );
  }
  if (
    value.on_max_replays !== "require_continue" &&
    value.on_max_replays !== "wait_for_human"
  ) {
    throw new Error(
      formatError(
        ctx,
        `stage "${stageId}": feedback_loop.on_max_replays must be "require_continue" or "wait_for_human"`,
      ),
    );
  }
  if (value.replay_session !== "resume" && value.replay_session !== "new_session") {
    throw new Error(
      formatError(
        ctx,
        `stage "${stageId}": feedback_loop.replay_session must be "resume" or "new_session"`,
      ),
    );
  }
  return {
    target: value.target,
    max_replays: value.max_replays as number,
    on_max_replays: value.on_max_replays as FeedbackLoopConfig["on_max_replays"],
    replay_session: value.replay_session as FeedbackLoopConfig["replay_session"],
  };
}

export function parsePipelineStageEntries(
  raw: unknown,
  ctx: ResolvePipelineDagContext,
): PipelineStageYamlEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error(formatError(ctx, "stages[] is required"));
  }
  if (raw.length === 0) {
    throw new Error(formatError(ctx, "stages must be non-empty"));
  }

  const entries: PipelineStageYamlEntry[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (typeof entry === "string") {
      const hint = entry
        ? `invalid stage entry at index ${index}: bare string stage refs are not supported; use { id: "${entry}", uses: "./${entry}.yaml" } or inline body`
        : `invalid stage entry at index ${index}: bare string stage refs are not supported; use { id: "…", uses: "./….yaml" } or inline body`;
      throw new Error(formatError(ctx, hint));
    }

    if (!isPlainObject(entry)) {
      throw new Error(formatError(ctx, `invalid stage entry at index ${index}`));
    }

    const keys = Object.keys(entry);
    for (const key of keys) {
      if (!isAllowedPipelineStageEntryKey(key)) {
        throw new Error(
          formatError(ctx, `invalid stage entry "${String(entry.id ?? index)}": unknown key "${key}"`),
        );
      }
    }

    if (typeof entry.id !== "string" || !entry.id) {
      throw new Error(formatError(ctx, `invalid stage entry at index ${index}: id must be a non-empty string`));
    }

    let forkValue: { select: "one" | "subset"; allow_none?: boolean } | undefined;
    if (entry.fork !== undefined) {
      if (!isPlainObject(entry.fork)) {
        throw new Error(formatError(ctx, `stage "${entry.id}": fork must be an object`));
      }
      for (const fk of Object.keys(entry.fork)) {
        if (!ALLOWED_FORK_KEYS.has(fk)) {
          throw new Error(formatError(ctx, `stage "${entry.id}": fork: unknown key "${fk}"`));
        }
      }
      forkValue = entry.fork as { select: "one" | "subset"; allow_none?: boolean };
    }

    const clonableFields: Pick<PipelineStageYamlEntry, "clonable" | "clone_cap"> = {
      ...(entry.clonable !== undefined ? { clonable: entry.clonable as boolean } : {}),
      ...(entry.clone_cap !== undefined ? { clone_cap: entry.clone_cap as number } : {}),
    };
    const policyOutcome = parseExecutionPolicy(entry, entry.id);
    if (!policyOutcome.ok) {
      throw new Error(
        formatError(
          ctx,
          policyOutcome.issues[0]?.message ?? "invalid execution policy",
        ),
      );
    }
    const policyFields = {
      ...(policyOutcome.value.completion !== undefined
        ? { completion: policyOutcome.value.completion }
        : {}),
      ...(policyOutcome.value.recovery !== undefined
        ? { recovery: policyOutcome.value.recovery }
        : {}),
    };
    const feedbackLoopFields =
      entry.feedback_loop !== undefined
        ? { feedback_loop: parseFeedbackLoopConfig(entry.feedback_loop, entry.id, ctx) }
        : {};
    if (entry.replay_safe !== undefined && typeof entry.replay_safe !== "boolean") {
      throw new Error(
        formatError(ctx, `stage "${entry.id}": replay_safe must be a boolean`),
      );
    }
    const replaySafetyFields =
      entry.replay_safe !== undefined ? { replay_safe: entry.replay_safe } : {};

    if (entry.needs === undefined) {
      entries.push({
        id: entry.id,
        ...(forkValue !== undefined ? { fork: forkValue } : {}),
        ...clonableFields,
        ...policyFields,
        ...feedbackLoopFields,
        ...replaySafetyFields,
      });
      continue;
    }

    if (Array.isArray(entry.needs)) {
      if (entry.needs.length > 1) {
        throw new Error(
          formatError(ctx, `stage "${entry.id}": fan-in not supported; needs must be a single stage id`),
        );
      }
      throw new Error(
        formatError(ctx, `stage "${entry.id}": needs must be a string, not an array`),
      );
    }

    if (typeof entry.needs !== "string" || !entry.needs) {
      throw new Error(formatError(ctx, `stage "${entry.id}": needs must be a non-empty string`));
    }

    entries.push({
      id: entry.id,
      needs: entry.needs,
      ...(forkValue !== undefined ? { fork: forkValue } : {}),
      ...clonableFields,
      ...policyFields,
      ...feedbackLoopFields,
      ...replaySafetyFields,
    });
  }

  return entries;
}

function normalizeToEdges(entries: PipelineStageRef[]): NormalizedEdge[] {
  return entries.map((entry, index) => ({
    id: entry.id,
    needs: entry.needs ?? null,
    stageIndex: index,
    ...(entry.fork !== undefined ? { fork: entry.fork } : {}),
    ...(entry.clonable !== undefined ? { clonable: entry.clonable } : {}),
    ...(entry.clone_cap !== undefined ? { clone_cap: entry.clone_cap } : {}),
    ...(entry.completion !== undefined ? { completion: entry.completion } : {}),
    ...(entry.recovery !== undefined ? { recovery: entry.recovery } : {}),
    ...(entry.feedback_loop !== undefined ? { feedback_loop: entry.feedback_loop } : {}),
    ...(entry.replay_safe !== undefined ? { replay_safe: entry.replay_safe } : {}),
  }));
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

function validateNeedsTargets(edges: NormalizedEdge[], ctx: ResolvePipelineDagContext): void {
  const declared = new Set(edges.map((edge) => edge.id));
  for (const edge of edges) {
    if (edge.needs !== null && !declared.has(edge.needs)) {
      throw new Error(formatError(ctx, `stage "${edge.id}" has unknown needs "${edge.needs}"`));
    }
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
    if (edge.needs === null) continue;
    indegree.set(edge.id, (indegree.get(edge.id) ?? 0) + 1);
    children.get(edge.needs)?.push(edge.id);
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
  const needsById = new Map(edges.map((edge) => [edge.id, edge.needs]));
  const ancestorsById = new Map<string, string[]>();

  function ancestorsFor(id: string): string[] {
    const cached = ancestorsById.get(id);
    if (cached) return cached;

    const needs = needsById.get(id) ?? null;
    if (needs === null) {
      ancestorsById.set(id, []);
      return [];
    }

    const parentAncestors = ancestorsFor(needs);
    const ancestors = [...parentAncestors, needs];
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
    if (edge.needs === null) continue;
    indegree.set(edge.id, (indegree.get(edge.id) ?? 0) + 1);
    children.get(edge.needs)?.push(edge.id);
  }

  for (const [, childIds] of children) {
    childIds.sort(
      (a, b) => (byId.get(a)?.stageIndex ?? 0) - (byId.get(b)?.stageIndex ?? 0),
    );
  }

  const roots = edges
    .filter((edge) => edge.needs === null)
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

function buildResolvedPipelineDag(edges: NormalizedEdge[]): ResolvedPipelineDag {
  const ancestorsById = computeAncestors(edges);
  const sortedEdges = topologicalSort(edges);

  const childrenOf: Record<string, string[]> = {};
  for (const edge of edges) {
    childrenOf[edge.id] = [];
  }
  for (const edge of edges) {
    if (edge.needs !== null) {
      childrenOf[edge.needs].push(edge.id);
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
    .filter((edge) => edge.needs === null)
    .sort((a, b) => a.stageIndex - b.stageIndex)
    .map((edge) => edge.id);

  const nodes: ResolvedPipelineStageNode[] = sortedEdges.map((edge) => ({
    id: edge.id,
    needs: edge.needs,
    ancestors: ancestorsById.get(edge.id) ?? [],
    stageIndex: edge.stageIndex,
    ...(edge.fork !== undefined
      ? { fork: { select: edge.fork.select, allow_none: edge.fork.allow_none ?? false } }
      : {}),
    ...(edge.clonable === true
      ? { clonable: true, clone_cap: edge.clone_cap ?? 5 }
      : {}),
    ...(edge.completion !== undefined ? { completion: edge.completion } : {}),
    ...(edge.recovery !== undefined ? { recovery: edge.recovery } : {}),
    ...(edge.feedback_loop !== undefined ? { feedback_loop: edge.feedback_loop } : {}),
    ...(edge.replay_safe !== undefined ? { replay_safe: edge.replay_safe } : {}),
  }));

  return { nodes, roots, childrenOf };
}

function validateForkFields(
  edges: NormalizedEdge[],
  dag: ResolvedPipelineDag,
  ctx: ResolvePipelineDagContext,
): void {
  for (const edge of edges) {
    if (!edge.fork) continue;
    if (edge.fork.select !== "one" && edge.fork.select !== "subset") {
      throw new Error(
        formatError(
          ctx,
          `stage "${edge.id}": fork.select must be "one" or "subset"${edge.fork.select === undefined ? " (missing)" : `, got "${String(edge.fork.select)}"`}`,
        ),
      );
    }
    if ((dag.childrenOf[edge.id] ?? []).length === 0) {
      throw new Error(
        formatError(ctx, `fork on stage "${edge.id}": no children in the DAG`),
      );
    }
  }
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
  validateNeedsTargets(edges, ctx);
  detectCycle(edges, ctx);

  const stages = edges
    .slice()
    .sort((a, b) => a.stageIndex - b.stageIndex)
    .map((edge) => edge.id);
  const dag = buildResolvedPipelineDag(edges);
  validateForkFields(edges, dag, ctx);
  validateClonableFields(edges, dag, ctx);
  validateFeedbackLoopFields(dag, ctx);

  return { stages, dag };
}

export function resolvePipelineDag(
  rawStages: unknown,
  ctx: ResolvePipelineDagContext,
): { stages: string[]; dag: ResolvedPipelineDag } {
  const entries = parsePipelineStageEntries(rawStages, ctx);
  return resolvePipelineDagFromRefs(entries, ctx);
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
    if (entry.needs !== undefined) {
      if (Array.isArray(entry.needs)) return null;
      if (typeof entry.needs !== "string" || !entry.needs) return null;
    }
    stageIds.push(entry.id);
  }

  return stageIds;
}
