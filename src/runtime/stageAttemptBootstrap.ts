import type {
  AgentPort,
  FeedbackLoopContext,
  StageHandle,
  StageRepairContext,
  StageRunInput,
  StageSessionMode,
} from "../agent/port.js";
import { resolveSkillByName } from "../config/listSkills.js";
import { mkdir } from "node:fs/promises";
import {
  MCP_CATALOG_FILENAME,
  STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV,
  StageMcpError,
  resolveStageMcpServers,
  stampStagePromptArtifactsDir,
  type ResolvedMcpServers,
} from "../config/resolveStageMcpServers.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import { resolveCloneEmitContext, resolveForkEmitContext } from "../config/resolveForkEmitContext.js";
import { createAttemptQaTrailReader } from "../hitl/qaTrail.js";
import { instancesOfDefinition } from "../runstore/pipelineDagSnapshot.js";
import type { RunPipelineDagSnapshot, RunStore } from "../runstore/port.js";
import { cloneInstanceOrdinal } from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { LoadedStageConfig, StageConfig } from "../types/stage.js";
import type { TaskFile } from "../types/task.js";
import {
  assertPriorInputPayload,
  payloadInstanceMismatch,
} from "../envelope/payloadSchema.js";
import {
  buildCompletedEnvelopesFromRun,
  resolvePriorEnvelope,
  type ResolvePriorEnvelopeResult,
} from "./envelopeRouting.js";
import { resumeSessionFilePath, type StageAttemptContext } from "./stageAttemptContext.js";
import {
  buildStageRoots,
  rootsForStageWorker,
  withResolvedAuthPath,
  type StageRoots,
} from "./stageRoots.js";

export type OperatorCatalog = {
  cwd?: string;
  agentDir?: string;
};

type OpenStageWithOperatorCatalogResult =
  | { ok: true; handle: StageHandle }
  | { ok: false; reason: string };

export type StageAttemptOpenInput = {
  agent: Pick<AgentPort, "openStage">;
  store: RunStore;
  runId: string;
  stage: LoadedStageConfig;
  task: TaskFile;
  dag: ResolvedPipelineDag;
  checkoutRoot?: string;
  workspaceDir: string;
  factoryCwd?: string;
  attemptCtx?: StageAttemptContext;
  operatorCatalog?: OperatorCatalog;
  onActivity?: StageRunInput["onActivity"];
  roots?: StageRoots;
  resumeToken?: string;
  sessionMode?: StageSessionMode;
  workerRoots?: boolean;
  completedEnvelopes?: Map<string, StageEnvelope>;
  stageId?: string;
  feedbackLoopContext?: FeedbackLoopContext;
};

export type StageAttemptOpenResult =
  | { ok: true; handle: StageHandle; roots: StageRoots; prior: StageEnvelope | null }
  | { ok: false; reason: string };

async function resolveStageSkillForRun(
  stage: Pick<StageConfig, "skill">,
  catalog: OperatorCatalog | undefined,
): Promise<{ ok: true; skillFilePath?: string } | { ok: false; reason: string }> {
  const name = stage.skill;
  if (name === undefined) return { ok: true };
  if (catalog?.agentDir === undefined) {
    return { ok: false, reason: `Skill "${name}" is not installed` };
  }
  const resolved = await resolveSkillByName(name, {
    cwd: catalog.cwd ?? process.cwd(),
    agentDir: catalog.agentDir,
  });
  if (!resolved) {
    return { ok: false, reason: `Skill "${name}" is not installed` };
  }
  return { ok: true, skillFilePath: resolved.filePath };
}

async function resolveAttemptMcpServers(
  allowlist: readonly string[] | undefined,
  factoryCwd: string | undefined,
  artifactsDir: string,
): Promise<ResolvedMcpServers | undefined> {
  const names = allowlist ?? [];
  if (names.length === 0) return undefined;
  if (factoryCwd === undefined) {
    throw new StageMcpError(
      `MCP catalog "${MCP_CATALOG_FILENAME}" is missing`,
      "missing_catalog",
    );
  }
  await mkdir(artifactsDir, { recursive: true });
  const resolved = await resolveStageMcpServers({
    projectRoot: factoryCwd,
    allowlist: names,
    env: {
      ...process.env,
      [STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV]: artifactsDir,
    },
  });
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

async function openStageWithOperatorCatalog(
  agent: Pick<AgentPort, "openStage">,
  input: Omit<StageRunInput, "skillFilePath">,
  catalog: OperatorCatalog | undefined,
  factoryCwd: string | undefined,
  artifactsDir: string,
): Promise<OpenStageWithOperatorCatalogResult> {
  const skill = await resolveStageSkillForRun(input.stage, catalog);
  if (!skill.ok) return skill;
  let resolvedMcpServers: ResolvedMcpServers | undefined;
  try {
    resolvedMcpServers = await resolveAttemptMcpServers(
      input.stage.mcp,
      factoryCwd,
      artifactsDir,
    );
  } catch (err) {
    if (err instanceof StageMcpError) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
  try {
    const handle = agent.openStage({
      ...input,
      stage: {
        ...input.stage,
        system_prompt: stampStagePromptArtifactsDir(
          input.stage.system_prompt,
          artifactsDir,
        ),
      },
      ...(skill.skillFilePath !== undefined
        ? { skillFilePath: skill.skillFilePath }
        : {}),
      ...(resolvedMcpServers !== undefined ? { resolvedMcpServers } : {}),
    });
    return { ok: true, handle };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function cloneAssignmentIndex(
  dag: ResolvedPipelineDag,
  stageId: string,
  definitionId: string,
  arrayLength: number,
): number | undefined {
  const ordinal = cloneInstanceOrdinal(stageId, definitionId);
  if (ordinal === undefined) return undefined;
  const snapshot = dag as RunPipelineDagSnapshot;
  if (!Array.isArray(snapshot.stage_ids) || arrayLength < 1) {
    return ordinal - 1;
  }
  const siblings = instancesOfDefinition(snapshot, definitionId)
    .map((id) => ({ id, ordinal: cloneInstanceOrdinal(id, definitionId) }))
    .filter((row): row is { id: string; ordinal: number } => row.ordinal !== undefined)
    .sort((a, b) => a.ordinal - b.ordinal);
  const cohort = siblings.slice(-arrayLength);
  const index = cohort.findIndex((row) => row.id === stageId);
  return index === -1 ? undefined : index;
}

function cloneAssignmentPrior(
  dag: ResolvedPipelineDag,
  stageId: string,
  definitionId: string,
  completedEnvelopes: Map<string, StageEnvelope>,
): ResolvePriorEnvelopeResult | undefined {
  const ordinal = cloneInstanceOrdinal(stageId, definitionId);
  if (ordinal === undefined) return undefined;
  const node = dag.nodes.find((n) => n.id === stageId);
  if (!node) return undefined;
  const emitterId =
    typeof node.needs === "string" && node.needs
      ? node.needs
      : predecessorEdges(node)[0]?.id;
  if (emitterId === undefined) return undefined;
  const emitter = dag.nodes.find((n) => n.id === emitterId);
  const field = emitter?.clone_array_field;
  if (field === undefined) return undefined;
  const parent = completedEnvelopes.get(emitterId);
  if (parent === undefined || parent.status !== "success") {
    return {
      ok: false,
      reason: `missing envelope for Clone Chain emitter "${emitterId}"`,
    };
  }
  const arr = parent.payload?.[field];
  if (!Array.isArray(arr)) {
    return {
      ok: false,
      reason: `missing Clone Array element ${ordinal} on "${emitterId}"`,
    };
  }
  const index = cloneAssignmentIndex(dag, stageId, definitionId, arr.length);
  if (index === undefined || index >= arr.length) {
    return {
      ok: false,
      reason: `missing Clone Array element ${ordinal} on "${emitterId}"`,
    };
  }
  const element = arr[index];
  if (element === null || typeof element !== "object" || Array.isArray(element)) {
    return {
      ok: false,
      reason: `Clone Array element ${index + 1} is not an object`,
    };
  }
  return {
    ok: true,
    prior: {
      status: "success",
      summary: parent.summary,
      artifacts: [],
      payload: structuredClone(element) as Record<string, unknown>,
    },
  };
}

function assertPriorsMatchCloneInput(
  cloneInputSchema: unknown | undefined,
  childId: string,
  priorResult: Extract<ResolvePriorEnvelopeResult, { ok: true }>,
  task: TaskFile,
  skipCloneAssignment: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (cloneInputSchema === undefined) return { ok: true };
  if (skipCloneAssignment) return { ok: true };
  try {
    if (priorResult.priorEnvelopesByStage !== undefined) {
      for (const value of Object.values(priorResult.priorEnvelopesByStage)) {
        const envelopes = Array.isArray(value) ? value : [value];
        for (const envelope of envelopes) {
          if (envelope.status !== "success") continue;
          assertPriorInputPayload(envelope, cloneInputSchema, childId);
        }
      }
      return { ok: true };
    }
    if (priorResult.joinPriors !== undefined) {
      for (const envelope of priorResult.joinPriors) {
        if (envelope.status !== "success") continue;
        assertPriorInputPayload(envelope, cloneInputSchema, childId);
      }
      return { ok: true };
    }
    if (priorResult.prior !== null) {
      assertPriorInputPayload(priorResult.prior, cloneInputSchema, childId);
      return { ok: true };
    }
    const details = payloadInstanceMismatch(task.input ?? {}, cloneInputSchema);
    if (details !== undefined) {
      return {
        ok: false,
        reason: `task input does not match io.input.schema for ${childId}: ${details}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveAttemptRoots(input: StageAttemptOpenInput, stageId: string): StageRoots {
  const baseRoots =
    input.roots ??
    (input.workerRoots
      ? rootsForStageWorker(
          input.workspaceDir,
          stageId,
          input.stage.model,
          input.checkoutRoot,
          input.attemptCtx,
        )
      : buildStageRoots(
          input.workspaceDir,
          stageId,
          input.checkoutRoot,
          input.attemptCtx,
        ));
  return input.factoryCwd !== undefined
    ? withResolvedAuthPath(baseRoots, input.factoryCwd)
    : baseRoots;
}

function evidencePreview(evidence: Record<string, unknown> | undefined): string | undefined {
  if (evidence === undefined) return undefined;
  try {
    const text = JSON.stringify(evidence);
    return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}…`;
  } catch {
    return "Verification evidence could not be serialized.";
  }
}

async function repairContextForAttempt(
  input: StageAttemptOpenInput,
  stageId: string,
  attempt: number,
): Promise<StageRepairContext | undefined> {
  if (attempt <= 1) return undefined;
  const recovery = input.dag.nodes.find((node) => node.id === stageId)?.recovery;
  if (recovery?.mode !== "repair" && recovery?.mode !== "manual") {
    return undefined;
  }
  const events = await input.store.listStageEvents(input.runId, stageId, attempt);
  const guidance = events
    .slice()
    .reverse()
    .find((event) => event.event === "manual_recovery_requested")?.guidance;
  if (recovery.mode === "manual" && typeof guidance !== "string") {
    return undefined;
  }
  const failed = (await input.store.listVerificationCheckResults(
    input.runId,
    stageId,
    attempt - 1,
  )).filter((check) => check.status === "failed");
  return {
    prior_attempt: attempt - 1,
    ...(typeof guidance === "string" && guidance.trim() !== ""
      ? { operator_guidance: guidance.trim() }
      : {}),
    ...(recovery.include_failed_checks !== false
      ? {
          failed_checks: failed.map((check) => {
            const preview = evidencePreview(check.evidence);
            return {
              id: check.check_id,
              type: check.check_type,
              ...(preview !== undefined ? { evidence_preview: preview } : {}),
            };
          }),
        }
      : {}),
  };
}

export async function openStageAttempt(
  input: StageAttemptOpenInput,
): Promise<StageAttemptOpenResult> {
  const stageId = input.stageId ?? input.stage.id;
  const definitionId = input.stage.id;
  const completedEnvelopes =
    input.completedEnvelopes ??
    (await buildCompletedEnvelopesFromRun(
      input.store,
      input.runId,
      undefined,
      input.dag,
    ));
  const assignment = cloneAssignmentPrior(
    input.dag,
    stageId,
    definitionId,
    completedEnvelopes,
  );
  const priorResult =
    assignment ??
    (await resolvePriorEnvelope({
      dag: input.dag,
      stageId,
      completedEnvelopes,
      store: input.store,
      runId: input.runId,
    }));
  if (!priorResult.ok) return priorResult;

  const priorInput = assertPriorsMatchCloneInput(
    input.stage.clone_input_schema,
    stageId,
    priorResult,
    input.task,
    false,
  );
  if (!priorInput.ok) return priorInput;

  const roots = resolveAttemptRoots(input, stageId);
  const attempt = input.attemptCtx?.attempt ?? 1;
  const resumeToken =
    input.resumeToken ??
    resumeSessionFilePath(input.workspaceDir, stageId, attempt);

  const forkEmitContext = resolveForkEmitContext(input.dag, definitionId);
  const snapshot = input.dag as RunPipelineDagSnapshot;
  const cloneEmitContext = resolveCloneEmitContext(input.dag, definitionId, {
    ...(snapshot.clone_input_schema !== undefined
      ? { successorCloneInputSchemas: snapshot.clone_input_schema }
      : {}),
  });
  const completionContract = input.dag.nodes.find(
    (node) => node.id === stageId,
  )?.completion;
  const runtimeNode = input.dag.nodes.find((node) => node.id === stageId);
  const isDynamicCloneInstance =
    runtimeNode?.definition_id !== undefined &&
    runtimeNode.definition_id !== runtimeNode.id;
  const feedbackLoopEmitContext =
    isDynamicCloneInstance || runtimeNode?.clonable === true
      ? undefined
      : runtimeNode?.feedback_loop;
  const repairContext = await repairContextForAttempt(input, stageId, attempt);
  const readQaTrail = createAttemptQaTrailReader(
    input.store,
    input.runId,
    stageId,
    attempt,
  );

  const opened = await openStageWithOperatorCatalog(
    input.agent,
    {
      roots,
      stage: input.stage,
      stageId,
      task: input.task,
      priorEnvelope: priorResult.prior,
      ...(priorResult.joinPriors !== undefined
        ? { priorEnvelopes: priorResult.joinPriors }
        : {}),
      ...(priorResult.priorEnvelopesByStage !== undefined
        ? { priorEnvelopesByStage: priorResult.priorEnvelopesByStage }
        : {}),
      resumeToken,
      ...(input.sessionMode !== undefined ? { sessionMode: input.sessionMode } : {}),
      onActivity: input.onActivity,
      forkEmitContext,
      cloneEmitContext,
      ...(feedbackLoopEmitContext !== undefined ? { feedbackLoopEmitContext } : {}),
      ...(input.feedbackLoopContext !== undefined
        ? { feedbackLoopContext: input.feedbackLoopContext }
        : {}),
      ...(completionContract !== undefined ? { completionContract } : {}),
      ...(repairContext !== undefined ? { repairContext } : {}),
      readQaTrail,
      ...(input.stage.timeout_ms !== undefined
        ? { timeoutMs: input.stage.timeout_ms }
        : {}),
    },
    input.operatorCatalog,
    input.factoryCwd,
    attemptArtifactsDir(input.workspaceDir, stageId, attempt),
  );
  if (!opened.ok) return opened;
  return {
    ok: true,
    handle: opened.handle,
    roots,
    prior: priorResult.prior,
  };
}
