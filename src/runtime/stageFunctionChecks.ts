import type Database from "better-sqlite3";
import {
  type FunctionCheckRequest,
  type FunctionCheckScope,
} from "../envelope/functionVerification.js";
import { createFunctionInvoker, type FunctionInvoker } from "../functions/invoke.js";
import { FunctionService } from "../functions/service.js";
import { FunctionStore } from "../functions/store.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import type { JsonValue } from "../functions/protocol.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { StageRoots } from "./stageRoots.js";

const invokers = new WeakMap<Database.Database, FunctionInvoker>();

export function functionIdsForStage(
  stage: StageConfig,
  dag: ResolvedPipelineDag | undefined,
  stageId: string,
): string[] {
  const ids = new Set<string>();
  for (const check of stage.pre_emit_checks ?? []) {
    if (check.type === "function") ids.add(check.function);
  }
  const node = dag?.nodes.find((item) => item.id === stageId);
  for (const check of node?.completion?.checks ?? []) {
    if (check.type === "function") ids.add(check.function);
  }
  return [...ids];
}

function functionInvokerFor(db: Database.Database): FunctionInvoker {
  let invoker = invokers.get(db);
  if (!invoker) {
    invoker = createFunctionInvoker({ db });
    invokers.set(db, invoker);
  }
  return invoker;
}

export async function pinMissingRunFunctions(
  db: Database.Database,
  projectRoot: string,
  runId: string,
  functionIds: readonly string[],
): Promise<void> {
  if (functionIds.length === 0) return;
  const service = new FunctionService({ store: new FunctionStore(db) });
  const missing: string[] = [];
  for (const functionId of functionIds) {
    const pin = await service.getPin(projectRoot, "run", runId, functionId);
    if (!pin) missing.push(functionId);
  }
  if (missing.length > 0) await service.pinRun(projectRoot, runId, missing);
}

function envelopeSnapshot(envelope: StageEnvelope): JsonValue {
  return JSON.parse(JSON.stringify({
    status: envelope.status,
    summary: envelope.summary,
    artifacts: envelope.artifacts,
    ...(envelope.payload !== undefined ? { payload: envelope.payload } : {}),
    ...(envelope.notes !== undefined ? { notes: envelope.notes } : {}),
    ...(envelope.stage_id !== undefined ? { stage_id: envelope.stage_id } : {}),
    ...(envelope.checklist_attestations !== undefined
      ? { checklist_attestations: envelope.checklist_attestations }
      : {}),
  })) as JsonValue;
}

export function createFunctionCheckScope(input: {
  db: Database.Database;
  projectRoot: string;
  runId: string;
  stageId: string;
  attempt: number;
  roots: StageRoots;
}): FunctionCheckScope {
  const service = new FunctionService({ store: new FunctionStore(input.db) });
  const invoker = functionInvokerFor(input.db);
  return {
    runId: input.runId,
    stageId: input.stageId,
    attempt: input.attempt,
    async revision(functionId) {
      const pin = await service.getPin(input.projectRoot, "run", input.runId, functionId);
      return pin?.revision;
    },
    async invoke(request: FunctionCheckRequest) {
      try {
        const view = await invoker.call(input.projectRoot, {
          functionId: request.functionId,
          kind: "verification",
          revision: request.revision,
          grants: [...request.grants],
          input: {
            kind: "verification",
            input: {},
            envelope: envelopeSnapshot(request.envelope),
            execution: {
              functionId: request.functionId,
              revision: request.revision,
              checkId: request.checkId,
              phase: request.phase,
              runId: request.runId ?? input.runId,
              stageId: request.stageId ?? input.stageId,
              attempt: request.attempt ?? input.attempt,
            },
          },
          runId: request.runId ?? input.runId,
          stageId: request.stageId ?? input.stageId,
          attempt: request.attempt ?? input.attempt,
          attachmentId: request.checkId,
          roots: {
            artifacts: attemptArtifactsDir(input.roots.runWorkspaceDir, input.stageId, input.attempt),
            workspace: input.roots.checkoutRoot ?? input.roots.cwd,
          },
          ...(input.roots.containerName !== undefined ? { containerName: input.roots.containerName } : {}),
          ...(input.roots.containerDockerBin !== undefined
            ? { containerDockerBin: input.roots.containerDockerBin }
            : {}),
        });
        return {
          ok: view.ok,
          ...(view.value !== undefined ? { value: view.value } : {}),
          ...(view.code !== undefined ? { code: view.code } : {}),
          ...(view.message !== undefined ? { message: view.message } : {}),
          revision: view.revision,
        };
      } catch (error) {
        return {
          ok: false,
          code: "exception",
          message: error instanceof Error ? error.message : String(error),
          revision: request.revision,
        };
      }
    },
  };
}
