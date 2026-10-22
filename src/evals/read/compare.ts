import { compareRuns, type CompareResult, type CompareRunInput } from "../compare.js";
import { toGradeRecords, toResultRecord } from "../statsAdapter.js";
import type { EvalRunRow } from "../storeTypes.js";
import { graderRefsOf, type ReadStore } from "./runs.js";

async function compareInput(store: ReadStore, row: EvalRunRow): Promise<CompareRunInput> {
  const results = await store.listEvalResults(row.evalRunId);
  const target = (row.config as { target?: { stage_definition?: unknown; definition?: unknown; revision?: unknown } })
    .target;
  const isAgent = row.targetKind === "agent";
  const definition = isAgent ? undefined : target?.stage_definition;
  const agentDefinition = isAgent ? target?.definition : undefined;
  const plain = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  return {
    targetKind: row.targetKind === "agent" ? "agent" : "stage",
    ...(isAgent
      ? {
          agentId: row.targetRef.agent_id ?? null,
          agentRevision: typeof target?.revision === "number" ? target.revision : null,
          agentDefinition: plain(agentDefinition),
        }
      : {}),
    evalId: row.evalId,
    runNumber: row.runNumber,
    datasetHash: row.datasetHash,
    stageVersionHash: row.targetVersionHash,
    stageDefinition:
      typeof definition === "object" && definition !== null && !Array.isArray(definition)
        ? (definition as Record<string, unknown>)
        : null,
    configComponents: row.configComponents,
    results: results.map(toResultRecord),
    grades: results.flatMap(toGradeRecords),
    graders: graderRefsOf(row),
    repeats: row.repeats,
    passThreshold: row.passThreshold,
  };
}

export async function buildCompare(store: ReadStore, a: EvalRunRow, b: EvalRunRow): Promise<CompareResult> {
  const [left, right] = await Promise.all([compareInput(store, a), compareInput(store, b)]);
  return compareRuns(left, right);
}
