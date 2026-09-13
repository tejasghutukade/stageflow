import type {
  CloneMode,
  PipelineStageRef,
  ResolvedPipelineDag,
} from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { toRouteEdges, toRouteLoopEntries } from "./pipelineRoute.js";

export type DetectedCloneChain = {
  emitterId: string;
  cloneChildId: string;
  joinId: string;
  arrayField: string;
  ref: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namedSchemaRef(schema: unknown): string | undefined {
  if (!isPlainObject(schema)) return undefined;
  const keys = Object.keys(schema);
  if (keys.length !== 1 || keys[0] !== "$ref") return undefined;
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/schemas/")) return undefined;
  const name = ref.slice("#/schemas/".length);
  if (!name || name.includes("/")) return undefined;
  return ref;
}

type NamedRefArray = { field: string; ref: string };

type InspectedOutput = {
  namedRefArrays: NamedRefArray[];
  nonRefArrayFields: string[];
  isRootArray: boolean;
  rootArrayRef: string | undefined;
};

function inspectOutput(schema: unknown): InspectedOutput {
  const empty: InspectedOutput = {
    namedRefArrays: [],
    nonRefArrayFields: [],
    isRootArray: false,
    rootArrayRef: undefined,
  };
  if (!isPlainObject(schema)) return empty;
  if (schema.type === "array") {
    const ref = namedSchemaRef(schema.items);
    return {
      namedRefArrays: [],
      nonRefArrayFields: ref === undefined ? ["<root>"] : [],
      isRootArray: true,
      rootArrayRef: ref,
    };
  }
  if (schema.type !== "object" || !isPlainObject(schema.properties)) return empty;
  const namedRefArrays: NamedRefArray[] = [];
  const nonRefArrayFields: string[] = [];
  for (const [field, prop] of Object.entries(schema.properties)) {
    if (!isPlainObject(prop) || prop.type !== "array") continue;
    const ref = namedSchemaRef(prop.items);
    if (ref !== undefined) namedRefArrays.push({ field, ref });
    else nonRefArrayFields.push(field);
  }
  return {
    namedRefArrays,
    nonRefArrayFields,
    isRootArray: false,
    rootArrayRef: undefined,
  };
}

function inboundSources(
  refs: PipelineStageRef[],
  targetId: string,
): PipelineStageRef[] {
  return refs.filter((ref) =>
    toRouteEdges(ref.route).some((edge) => edge.to === targetId),
  );
}

function isSealedThreeStagePath(
  refs: PipelineStageRef[],
  stageById: Map<string, StageConfig>,
  refById: Map<string, PipelineStageRef>,
  emitter: PipelineStageRef,
  childId: string,
): boolean {
  const edges = toRouteEdges(emitter.route);
  if (edges.length !== 1) return false;
  const childEdge = edges[0]!;
  if (childEdge.to !== childId || childEdge.if !== undefined) return false;

  const childStage = stageById.get(childId);
  const childRef = refById.get(childId);
  if (!childStage || !childRef) return false;
  if (inboundSources(refs, childId).length !== 1) return false;

  const childEdges = toRouteEdges(childRef.route);
  if (childEdges.length !== 1 || childEdges[0]!.if !== undefined) return false;

  const joinId = childEdges[0]!.to;
  if (!stageById.has(joinId)) return false;
  if (inboundSources(refs, joinId).length !== 1) return false;

  return true;
}

function dagError(pipelineId: string, message: string, stageId?: string): LoadIssue {
  return {
    code: "pipeline.dag_error",
    message: `Pipeline ${pipelineId}: ${message}`,
    category: "pipeline",
    pipelineId,
    ...(stageId !== undefined ? { stageId } : {}),
  };
}

function fail(
  pipelineId: string,
  message: string,
  stageId?: string,
): LoadOutcome<DetectedCloneChain[]> {
  return loadFailure([dagError(pipelineId, message, stageId)]);
}

function childOutputIsCloneArray(schema: unknown): boolean {
  const inspected = inspectOutput(schema);
  return inspected.namedRefArrays.length > 0 || inspected.rootArrayRef !== undefined;
}

export function detectCloneChains(
  stages: StageConfig[],
  refs: PipelineStageRef[],
  pipelineId: string,
): LoadOutcome<DetectedCloneChain[]> {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const refById = new Map(refs.map((ref) => [ref.id, ref]));
  const chains: DetectedCloneChain[] = [];

  for (const emitter of refs) {
    const emitterStage = stageById.get(emitter.id);
    if (!emitterStage) continue;
    const edges = toRouteEdges(emitter.route);
    const output = inspectOutput(emitterStage.payload_schema);

    if (output.namedRefArrays.length >= 2 && edges.length > 0) {
      return fail(
        pipelineId,
        `stage "${emitter.id}": Clone Chain emitter output must have exactly one named $ref Clone Array`,
        emitter.id,
      );
    }

    if (output.isRootArray && edges.length > 0) {
      const looksLikeChain = edges.some((edge) => {
        const childStage = stageById.get(edge.to);
        if (!childStage) return false;
        if (namedSchemaRef(childStage.clone_input_schema) === undefined) return false;
        return isSealedThreeStagePath(refs, stageById, refById, emitter, edge.to);
      });
      if (looksLikeChain) {
        return fail(
          pipelineId,
          `stage "${emitter.id}": Clone Chain emitter output is a root-level array, which is not a Clone Array`,
          emitter.id,
        );
      }
    }

    if (
      output.namedRefArrays.length === 0 &&
      output.nonRefArrayFields.length > 0 &&
      edges.length > 0
    ) {
      for (const edge of edges) {
        const childStage = stageById.get(edge.to);
        const childRef = refById.get(edge.to);
        if (!childStage || !childRef) continue;
        if (namedSchemaRef(childStage.clone_input_schema) === undefined) continue;
        if (toRouteEdges(childRef.route).length === 0) continue;
        return fail(
          pipelineId,
          `stage "${emitter.id}": Clone Chain emitter Clone Array items must be a named $ref`,
          emitter.id,
        );
      }
    }

    if (output.namedRefArrays.length !== 1 || edges.length === 0) continue;
    const array = output.namedRefArrays[0]!;

    const childTakesNamedRef = edges.some((edge) => {
      const childStage = stageById.get(edge.to);
      return (
        childStage !== undefined &&
        namedSchemaRef(childStage.clone_input_schema) !== undefined
      );
    });
    const hasClonePolicy =
      emitter.clone_cap !== undefined || emitter.clone_mode !== undefined;
    const sealedLookalike = edges.some((edge) =>
      isSealedThreeStagePath(refs, stageById, refById, emitter, edge.to),
    );
    if (!childTakesNamedRef && !hasClonePolicy && !sealedLookalike) {
      continue;
    }

    const matchingChildIds = edges
      .filter((edge) => {
        const childStage = stageById.get(edge.to);
        return (
          childStage !== undefined &&
          namedSchemaRef(childStage.clone_input_schema) === array.ref
        );
      })
      .map((edge) => edge.to);
    const uniqueMatching = [...new Set(matchingChildIds)];

    if (edges.length !== 1) {
      if (uniqueMatching.length >= 2) {
        return fail(
          pipelineId,
          `stage "${emitter.id}": Clone Chain emitter must have exactly one clone child`,
          emitter.id,
        );
      }
      return fail(
        pipelineId,
        `stage "${emitter.id}": Clone Chain emitter must have exactly one forward Route (the clone child)`,
        emitter.id,
      );
    }

    const childEdge = edges[0]!;
    const cloneChildId = childEdge.to;
    if (childEdge.if !== undefined) {
      return fail(
        pipelineId,
        `stage "${emitter.id}": Clone Chain inbound edge to the clone child must not have if`,
        emitter.id,
      );
    }

    const childStage = stageById.get(cloneChildId);
    const childRef = refById.get(cloneChildId);
    if (!childStage || !childRef) {
      return fail(
        pipelineId,
        `stage "${emitter.id}": Clone Chain emitter must have exactly one forward Route (the clone child)`,
        emitter.id,
      );
    }

    if (namedSchemaRef(childStage.clone_input_schema) !== array.ref) {
      return fail(
        pipelineId,
        `stage "${cloneChildId}": Clone Chain clone child input must be exactly the named $ref of the emitter Clone Array`,
        cloneChildId,
      );
    }

    if (inboundSources(refs, cloneChildId).length !== 1) {
      return fail(
        pipelineId,
        `stage "${cloneChildId}": Clone Chain clone child must have exactly one parent (the emitter)`,
        cloneChildId,
      );
    }

    const childEdges = toRouteEdges(childRef.route);
    if (childEdges.length !== 1) {
      return fail(
        pipelineId,
        `stage "${cloneChildId}": Clone Chain clone child must have exactly one forward Route (the Join)`,
        cloneChildId,
      );
    }
    if (childEdges[0]!.if !== undefined) {
      return fail(
        pipelineId,
        `stage "${cloneChildId}": Clone Chain inbound edge to the Join must not have if`,
        cloneChildId,
      );
    }

    const joinId = childEdges[0]!.to;
    if (!stageById.has(joinId)) {
      return fail(
        pipelineId,
        `stage "${cloneChildId}": Clone Chain clone child must have exactly one forward Route (the Join)`,
        cloneChildId,
      );
    }

    if (inboundSources(refs, joinId).length !== 1) {
      return fail(
        pipelineId,
        `stage "${joinId}": Clone Chain Join must have exactly one parent (the clone child)`,
        joinId,
      );
    }

    if (childOutputIsCloneArray(childStage.payload_schema)) {
      return fail(
        pipelineId,
        `stage "${cloneChildId}": Clone Chain clone child output must not be a Clone Array`,
        cloneChildId,
      );
    }

    chains.push({
      emitterId: emitter.id,
      cloneChildId,
      joinId,
      arrayField: array.field,
      ref: array.ref,
    });
  }

  const emitterIds = new Set<string>();
  const cloneChildIds = new Set<string>();
  const joinIds = new Set<string>();
  for (const chain of chains) {
    if (emitterIds.has(chain.emitterId)) {
      return fail(
        pipelineId,
        `stage "${chain.emitterId}": Clone Chain emitter is shared with another Clone Chain`,
        chain.emitterId,
      );
    }
    if (cloneChildIds.has(chain.cloneChildId)) {
      return fail(
        pipelineId,
        `stage "${chain.cloneChildId}": Clone Chain clone child is shared with another Clone Chain`,
        chain.cloneChildId,
      );
    }
    if (joinIds.has(chain.joinId)) {
      return fail(
        pipelineId,
        `stage "${chain.joinId}": Clone Chain Join is shared with another Clone Chain`,
        chain.joinId,
      );
    }
    emitterIds.add(chain.emitterId);
    cloneChildIds.add(chain.cloneChildId);
    joinIds.add(chain.joinId);
  }

  return loadSuccess(chains);
}

function validateCloneChainLoops(
  refs: PipelineStageRef[],
  chains: DetectedCloneChain[],
  pipelineId: string,
): LoadOutcome<void> {
  if (chains.length === 0) return loadSuccess(undefined);

  const emitterIds = new Set(chains.map((chain) => chain.emitterId));
  const cloneChildIds = new Set(chains.map((chain) => chain.cloneChildId));
  const forbiddenTargets = new Map<string, string>();
  for (const chain of chains) {
    forbiddenTargets.set(chain.emitterId, "emitter");
    forbiddenTargets.set(chain.cloneChildId, "clone child");
    forbiddenTargets.set(chain.joinId, "Join");
  }

  for (const ref of refs) {
    const loops = toRouteLoopEntries(ref.route);
    if (loops.length === 0) continue;

    if (emitterIds.has(ref.id)) {
      return loadFailure([
        dagError(
          pipelineId,
          `stage "${ref.id}": Clone Chain emitter cannot originate a Loop`,
          ref.id,
        ),
      ]);
    }
    if (cloneChildIds.has(ref.id)) {
      return loadFailure([
        dagError(
          pipelineId,
          `stage "${ref.id}": Clone Chain clone child cannot originate a Loop`,
          ref.id,
        ),
      ]);
    }

    for (const loop of loops) {
      const role = forbiddenTargets.get(loop.to);
      if (role === undefined) continue;
      return loadFailure([
        dagError(
          pipelineId,
          `stage "${ref.id}": Loop target "${loop.to}" is a Clone Chain ${role}`,
          ref.id,
        ),
      ]);
    }
  }

  return loadSuccess(undefined);
}

function applyCloneCapToSchema(
  schema: unknown,
  field: string,
  cap: number,
): void {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return;
  const prop = schema.properties[field];
  if (!isPlainObject(prop)) return;
  prop.minItems = 1;
  prop.maxItems = cap;
}

export function applyCloneChains(
  stages: StageConfig[],
  refs: PipelineStageRef[],
  dag: ResolvedPipelineDag,
  pipelineId: string,
): LoadOutcome<void> {
  const detected = detectCloneChains(stages, refs, pipelineId);
  if (!detected.ok) return detected;
  const chains = detected.value;
  const emitterIds = new Set(chains.map((chain) => chain.emitterId));
  const refById = new Map(refs.map((ref) => [ref.id, ref]));
  const nodeById = new Map(dag.nodes.map((node) => [node.id, node]));

  for (const ref of refs) {
    const isEmitter = emitterIds.has(ref.id);
    if (isEmitter) {
      if (ref.clone_cap === undefined || ref.clone_mode === undefined) {
        return loadFailure([
          dagError(
            pipelineId,
            `stage "${ref.id}": Clone Chain emitter requires clone_cap and clone_mode`,
            ref.id,
          ),
        ]);
      }
      continue;
    }
    if (ref.clone_cap !== undefined) {
      return loadFailure([
        dagError(
          pipelineId,
          `stage "${ref.id}": "clone_cap" is no longer supported — use a Clone Chain instead`,
          ref.id,
        ),
      ]);
    }
    if (ref.clone_mode !== undefined) {
      return loadFailure([
        dagError(
          pipelineId,
          `stage "${ref.id}": "clone_mode" is only valid on a Clone Chain emitter`,
          ref.id,
        ),
      ]);
    }
  }

  const loopsOutcome = validateCloneChainLoops(refs, chains, pipelineId);
  if (!loopsOutcome.ok) return loopsOutcome;

  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  for (const chain of chains) {
    const ref = refById.get(chain.emitterId)!;
    const cap = ref.clone_cap as number;
    const mode = ref.clone_mode as CloneMode;
    const node = nodeById.get(chain.emitterId);
    if (node) {
      node.clone_cap = cap;
      node.clone_mode = mode;
      node.clone_array_field = chain.arrayField;
    }
    const emitterStage = stageById.get(chain.emitterId);
    if (emitterStage?.payload_schema !== undefined) {
      applyCloneCapToSchema(emitterStage.payload_schema, chain.arrayField, cap);
    }
  }

  return loadSuccess(undefined);
}
