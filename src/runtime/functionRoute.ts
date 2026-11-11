import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { FunctionGrant } from "../config/loadFunction.js";
import { createFunctionInvoker } from "../functions/invoke.js";
import { FunctionService } from "../functions/service.js";
import { FunctionStore } from "../functions/store.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import type { FunctionRouteRecord, RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag, ResolvedPipelineStageNode } from "../types/pipeline.js";
import { evaluateRouteIf } from "./routeIfEval.js";

export type { FunctionRouteRecord };

export type FunctionRouteChild = {
  id: string;
  name: string;
  description?: string;
};

export type FunctionRouteCall = {
  stageId: string;
  runId: string;
  children: FunctionRouteChild[];
  envelope: StageEnvelope;
};

export type FunctionRouteInvokeResult = {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
};

export type FunctionRouteInvoker = {
  invoke(call: FunctionRouteCall): Promise<FunctionRouteInvokeResult>;
};

export type FunctionRouteSelections = ReadonlyMap<string, readonly string[]>;

const ROUTE_FIELDS = new Set(["nextStageIds", "reason"]);

export function routingFailureText(
  stageId: string,
  decision: FunctionRouteRecord | undefined,
): string {
  const detail =
    decision?.status === "error"
      ? decision.message ?? decision.code ?? "routing failed"
      : "routing failed";
  return `routing failed for stage "${stageId}": ${detail}`;
}

export function judgeFunctionRoute(
  value: unknown,
  eligible: ReadonlySet<string>,
): FunctionRouteRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "error",
      code: "invalid_output",
      message: "routing result must be an object",
    };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ROUTE_FIELDS.has(key)) {
      return {
        status: "error",
        code: "invalid_output",
        message: `routing result has unexpected field "${key}"`,
      };
    }
  }
  const ids = record.nextStageIds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return {
      status: "error",
      code: "invalid_output",
      message: "nextStageIds must be an array of strings",
    };
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return {
        status: "error",
        code: "invalid_output",
        message: `duplicate stage id "${id}"`,
      };
    }
    seen.add(id);
    if (!eligible.has(id)) {
      return {
        status: "error",
        code: "invalid_output",
        message: `unknown stage id "${id}"`,
      };
    }
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    return {
      status: "error",
      code: "invalid_output",
      message: "reason must be a string",
    };
  }
  return {
    status: "selected",
    nextStageIds: ids,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

export function withCloneExpansion(
  decision: Extract<FunctionRouteRecord, { status: "selected" }>,
  dag: ResolvedPipelineDag,
  stageId: string,
): Extract<FunctionRouteRecord, { status: "selected" }> {
  const catalogId = cloneCatalogId(dag, stageId);
  const needsMint = catalogId !== undefined && decision.nextStageIds.includes(catalogId);
  return {
    ...decision,
    cloneExpansion: needsMint ? "pending" : "not_needed",
  };
}

export function eligibleRouteChildren(
  dag: ResolvedPipelineDag,
  stageId: string,
  payload: Record<string, unknown> | undefined,
): FunctionRouteChild[] {
  const seen = new Set<string>();
  const children: FunctionRouteChild[] = [];
  for (const childId of dag.childrenOf[stageId] ?? []) {
    const child = dag.nodes.find((node) => node.id === childId);
    if (!child) continue;
    const definitionId = child.definition_id ?? child.id;
    if (definitionId !== child.id) continue;
    if (seen.has(definitionId)) continue;
    const edge = predecessorEdges(child).find((item) => item.id === stageId);
    if (edge !== undefined && !edge.on.includes("succeeded")) continue;
    if (edge?.if !== undefined && evaluateRouteIf(edge.if, payload) !== "fire") continue;
    seen.add(definitionId);
    children.push({ id: definitionId, name: definitionId });
  }
  return children;
}

export function cloneCatalogId(
  dag: ResolvedPipelineDag,
  emitterId: string,
): string | undefined {
  const emitter = dag.nodes.find((node) => node.id === emitterId);
  if (emitter?.clone_array_field === undefined) return undefined;
  for (const childId of dag.childrenOf[emitterId] ?? []) {
    const child = dag.nodes.find((node) => node.id === childId);
    if (child !== undefined && (child.definition_id ?? child.id) === child.id) {
      return childId;
    }
  }
  for (const childId of dag.childrenOf[emitterId] ?? []) {
    const child = dag.nodes.find((node) => node.id === childId);
    if (child?.definition_id !== undefined && child.definition_id !== child.id) {
      return child.definition_id;
    }
  }
  return undefined;
}

export function functionSelectionReleases(
  dag: ResolvedPipelineDag,
  childId: string,
  selected: ReadonlySet<string>,
): boolean {
  const child = dag.nodes.find((node) => node.id === childId);
  const definitionId = child?.definition_id ?? childId;
  return selected.has(definitionId);
}

function routeNode(
  dag: ResolvedPipelineDag | undefined,
  stageId: string,
): ResolvedPipelineStageNode | undefined {
  if (dag === undefined) return undefined;
  const node = dag.nodes.find((item) => item.id === stageId);
  if (node?.routeFunction !== undefined) return node;
  const definitionId = node?.definition_id;
  if (definitionId !== undefined && definitionId !== stageId) {
    const definition = dag.nodes.find((item) => item.id === definitionId);
    if (definition?.routeFunction !== undefined) return definition;
  }
  return node;
}

async function readStoredRoute(
  store: RunStore,
  runId: string,
  stageId: string,
  attempt: number,
): Promise<FunctionRouteRecord | undefined> {
  try {
    const execution = await store.getStageExecution(runId, stageId, attempt);
    return execution.function_route ?? undefined;
  } catch {
    return undefined;
  }
}

function realRouteInvoker(input: {
  db: NonNullable<ReturnType<typeof sqliteConnectionFromStore>>;
  projectRoot: string;
  routeFunction: { id: string; grants: FunctionGrant[] };
  attempt: number;
  roots?: { artifacts?: string; workspace?: string };
}): FunctionRouteInvoker {
  const service = new FunctionService({ store: new FunctionStore(input.db) });
  const invoker = createFunctionInvoker({ db: input.db });
  return {
    async invoke(call) {
      const pin = await service.getPin(input.projectRoot, "run", call.runId, input.routeFunction.id);
      const view = await invoker.call(input.projectRoot, {
        functionId: input.routeFunction.id,
        kind: "routing",
        ...(pin !== undefined ? { revision: pin.revision } : {}),
        grants: [...input.routeFunction.grants],
        input: {
          kind: "routing",
          envelope: JSON.parse(JSON.stringify(call.envelope)),
          children: call.children,
        },
        runId: call.runId,
        stageId: call.stageId,
        attempt: input.attempt,
        ...(input.roots !== undefined ? { roots: input.roots } : {}),
      });
      return {
        ok: view.ok,
        ...(view.value !== undefined ? { value: view.value } : {}),
        ...(view.code !== undefined ? { code: view.code } : {}),
        ...(view.message !== undefined ? { message: view.message } : {}),
      };
    },
  };
}

export async function commitFunctionRoute(input: {
  store: RunStore;
  dag: ResolvedPipelineDag | undefined;
  runId: string;
  stageId: string;
  attempt?: number;
  envelope: StageEnvelope;
  projectRoot?: string;
  invoker?: FunctionRouteInvoker;
  force?: boolean;
  roots?: { artifacts?: string; workspace?: string };
}): Promise<FunctionRouteRecord | undefined> {
  const node = routeNode(input.dag, input.stageId);
  if (input.dag === undefined || node?.routeFunction === undefined) return undefined;
  if (input.envelope.status !== "success") return undefined;
  if (input.envelope.feedback_loop?.action === "send_back") return undefined;
  const attempt =
    input.attempt ??
    (await input.store.getLatestStageExecution(input.runId, input.stageId))?.attempt ??
    1;
  if (input.force !== true) {
    const existing = await readStoredRoute(input.store, input.runId, input.stageId, attempt);
    if (existing !== undefined) return existing;
  }
  const children = eligibleRouteChildren(input.dag, input.stageId, input.envelope.payload);
  const routeFunction = node.routeFunction;
  let decision: FunctionRouteRecord;
  try {
    const db = sqliteConnectionFromStore(input.store);
    const invoker =
      input.invoker ??
      (db !== undefined && input.projectRoot !== undefined
        ? realRouteInvoker({
            db,
            projectRoot: input.projectRoot,
            routeFunction,
            attempt,
            ...(input.roots !== undefined ? { roots: input.roots } : {}),
          })
        : undefined);
    if (invoker === undefined) {
      decision = {
        status: "error",
        code: "exception",
        message: "routing function requires a project store",
      };
    } else {
      const response = await invoker.invoke({
        stageId: input.stageId,
        runId: input.runId,
        children,
        envelope: input.envelope,
      });
      decision = response.ok
        ? judgeFunctionRoute(response.value, new Set(children.map((child) => child.id)))
        : {
            status: "error",
            code: response.code && response.code.length > 0 ? response.code : "exception",
            message: response.message ?? "routing failed",
          };
    }
  } catch (error) {
    decision = {
      status: "error",
      code: "exception",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const stored =
    decision.status === "selected"
      ? withCloneExpansion(decision, input.dag, input.stageId)
      : decision;
  await input.store.updateStageExecution(input.runId, input.stageId, attempt, {
    function_route: stored,
  });
  return stored;
}

export async function loadFunctionRouteSelections(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
): Promise<Map<string, readonly string[]>> {
  const selections = new Map<string, readonly string[]>();
  for (const node of dag.nodes) {
    if (node.routeFunction === undefined) continue;
    const execution = await store.getLatestStageExecution(runId, node.id);
    if (execution?.function_route?.status === "selected") {
      selections.set(node.id, execution.function_route.nextStageIds);
    }
  }
  return selections;
}
