import type {
  AgentPort,
  FeedbackLoopContext,
  StageHandle,
  StageRepairContext,
  StageRunInput,
  StageSessionMode,
} from "../agent/port.js";
import {
  bindingKindForOrigin,
  catalogOrSeededOrigin,
  decideWorkspaceConfigTrust,
  skillOriginKind,
  type ConfigOriginRecord,
} from "../config/configOrigin.js";
import { resolveSkillByName } from "../config/listSkills.js";
import { loadHostConfig } from "../config/hostConfig.js";
import { defaultSeededRoots } from "../config/seededCatalog.js";
import { mkdir } from "node:fs/promises";
import {
  MCP_CATALOG_FILENAME,
  STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV,
  StageMcpError,
  mcpCatalogExists,
  mcpCatalogPath,
  resolveStageMcpServers,
  stampStagePromptArtifactsDir,
  type ResolvedMcpServers,
} from "../config/resolveStageMcpServers.js";
import { attemptArtifactsDir, attemptStreamLogPath } from "../runstore/workspaceLayout.js";
import {
  createStageStreamLogWriter,
  type StageStreamLogWriter,
} from "./stageStreamLog.js";
import { resolveCloneEmitContext, resolveForkEmitContext } from "../config/resolveForkEmitContext.js";
import { createAttemptQaTrailReader } from "../hitl/qaTrail.js";
import type { RunPipelineDagSnapshot, RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
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
import { assignment } from "./cloneSchedule.js";
import { resumeSessionFilePath, type StageAttemptContext } from "./stageAttemptContext.js";
import {
  bindingKindFromMeta,
  buildStageRoots,
  rootsForStageWorker,
  withResolvedAuthPath,
  type DerivedBindingKind,
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
  /** Test seam; defaults to the real createStageStreamLogWriter. */
  streamLogWriterFactory?: (streamLogPath: string) => StageStreamLogWriter;
  roots?: StageRoots;
  resumeToken?: string;
  sessionMode?: StageSessionMode;
  workerRoots?: boolean;
  completedEnvelopes?: Map<string, StageEnvelope>;
  stageId?: string;
  feedbackLoopContext?: FeedbackLoopContext;
  stageEnv?: Record<string, string>;
  trustWorkspaceConfig?: string[];
  bindingKind?: DerivedBindingKind;
};

export type StageAttemptOpenResult =
  | {
      ok: true;
      handle: StageHandle;
      roots: StageRoots;
      prior: StageEnvelope | null;
      stageEnv?: Record<string, string>;
    }
  | { ok: false; reason: string };

function resolveTrustWorkspaceConfig(explicit?: string[]): string[] {
  if (explicit !== undefined) return explicit;
  try {
    return loadHostConfig().trustWorkspaceConfig;
  } catch {
    return [];
  }
}

function seededRootPaths(): string[] {
  return defaultSeededRoots().map((root) => root.path);
}

async function resolveStageSkillForRun(
  stage: Pick<StageConfig, "skill">,
  catalog: OperatorCatalog | undefined,
  options: {
    bindingKind: DerivedBindingKind;
    checkoutRoot?: string;
    factoryCwd?: string;
    trustWorkspaceConfig: string[];
  },
): Promise<
  | { ok: true; skillFilePath?: string; origin?: ConfigOriginRecord }
  | { ok: false; reason: string }
> {
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
  const originKind = skillOriginKind(
    resolved.scope,
    resolved.filePath,
    options.checkoutRoot,
  );
  if (originKind === "workspace") {
    const decision = decideWorkspaceConfigTrust({
      bindingKind: bindingKindForOrigin(options.bindingKind),
      projectRoot: options.factoryCwd ?? options.checkoutRoot ?? "",
      trustWorkspaceConfig: options.trustWorkspaceConfig,
      source: "workspace",
    });
    if (!decision.allow) {
      return {
        ok: false,
        reason: decision.code ?? "untrusted_config_origin",
      };
    }
  }
  return {
    ok: true,
    skillFilePath: resolved.filePath,
    origin: {
      name,
      origin: originKind,
      path: resolved.filePath,
    },
  };
}

async function resolveAttemptMcpServers(
  allowlist: readonly string[] | undefined,
  factoryCwd: string | undefined,
  artifactsDir: string,
  options: {
    checkoutRoot?: string;
    bindingKind: DerivedBindingKind;
    trustWorkspaceConfig: string[];
    stageEnv?: Record<string, string>;
    stageId?: string;
  },
): Promise<{
  servers: ResolvedMcpServers | undefined;
  origins: ConfigOriginRecord[];
}> {
  const names = allowlist ?? [];
  if (names.length === 0) return { servers: undefined, origins: [] };
  const env = {
    ...(options.stageEnv ?? {}),
    [STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV]: artifactsDir,
  };
  const stageIdOpt =
    options.stageId !== undefined ? { stageId: options.stageId } : {};
  const bindingKind = bindingKindForOrigin(options.bindingKind);

  if (factoryCwd !== undefined && (await mcpCatalogExists(factoryCwd))) {
    await mkdir(artifactsDir, { recursive: true });
    const resolved = await resolveStageMcpServers({
      projectRoot: factoryCwd,
      allowlist: names,
      env,
      bindingKind,
      trustWorkspaceConfig: options.trustWorkspaceConfig,
      ...stageIdOpt,
    });
    const origin = catalogOrSeededOrigin(factoryCwd, seededRootPaths());
    const catalogPath = mcpCatalogPath(factoryCwd);
    return {
      servers: Object.keys(resolved).length > 0 ? resolved : undefined,
      origins: names.map((name) => ({
        name,
        origin,
        path: catalogPath,
      })),
    };
  }

  const checkoutRoot = options.checkoutRoot;
  if (
    checkoutRoot !== undefined &&
    checkoutRoot !== factoryCwd &&
    (await mcpCatalogExists(checkoutRoot))
  ) {
    await mkdir(artifactsDir, { recursive: true });
    const resolved = await resolveStageMcpServers({
      projectRoot: checkoutRoot,
      allowlist: names,
      env,
      bindingKind,
      trustWorkspaceConfig: options.trustWorkspaceConfig,
      trustProjectRoot: factoryCwd ?? checkoutRoot,
      workspaceSourced: true,
      ...stageIdOpt,
    });
    const catalogPath = mcpCatalogPath(checkoutRoot);
    return {
      servers: Object.keys(resolved).length > 0 ? resolved : undefined,
      origins: names.map((name) => ({
        name,
        origin: "workspace" as const,
        path: catalogPath,
      })),
    };
  }

  throw new StageMcpError(
    `MCP catalog "${MCP_CATALOG_FILENAME}" is missing`,
    "missing_catalog",
  );
}

function verifyCommandOrigins(
  dag: ResolvedPipelineDag,
  stageId: string,
  pipelinePath: string | undefined,
  factoryCwd: string | undefined,
): ConfigOriginRecord[] {
  const completion = dag.nodes.find((node) => node.id === stageId)?.completion;
  const origin = catalogOrSeededOrigin(factoryCwd, seededRootPaths());
  const records: ConfigOriginRecord[] = [];
  for (const check of completion?.checks ?? []) {
    if (check.type !== "command") continue;
    records.push({
      name: check.id,
      origin,
      ...(pipelinePath !== undefined ? { path: pipelinePath } : {}),
    });
  }
  return records;
}

async function openStageWithOperatorCatalog(
  agent: Pick<AgentPort, "openStage">,
  input: Omit<StageRunInput, "skillFilePath">,
  catalog: OperatorCatalog | undefined,
  factoryCwd: string | undefined,
  artifactsDir: string,
  resolveOptions: {
    checkoutRoot?: string;
    bindingKind: DerivedBindingKind;
    trustWorkspaceConfig: string[];
    stageEnv?: Record<string, string>;
    store: RunStore;
    runId: string;
    pipelinePath?: string;
    dag: ResolvedPipelineDag;
  },
): Promise<OpenStageWithOperatorCatalogResult> {
  const skill = await resolveStageSkillForRun(input.stage, catalog, {
    bindingKind: resolveOptions.bindingKind,
    checkoutRoot: resolveOptions.checkoutRoot,
    factoryCwd,
    trustWorkspaceConfig: resolveOptions.trustWorkspaceConfig,
  });
  if (!skill.ok) return skill;
  let resolvedMcpServers: ResolvedMcpServers | undefined;
  const origins: ConfigOriginRecord[] = [];
  if (skill.origin !== undefined) origins.push(skill.origin);
  try {
    const mcp = await resolveAttemptMcpServers(
      input.stage.mcp,
      factoryCwd,
      artifactsDir,
      {
        checkoutRoot: resolveOptions.checkoutRoot,
        bindingKind: resolveOptions.bindingKind,
        trustWorkspaceConfig: resolveOptions.trustWorkspaceConfig,
        stageEnv: resolveOptions.stageEnv,
        stageId: input.stageId,
      },
    );
    resolvedMcpServers = mcp.servers;
    origins.push(...mcp.origins);
  } catch (err) {
    if (err instanceof StageMcpError) {
      return {
        ok: false,
        reason:
          err.code === "untrusted_config_origin" ? err.code : err.message,
      };
    }
    throw err;
  }
  origins.push(
    ...verifyCommandOrigins(
      resolveOptions.dag,
      input.stageId ?? input.stage.id,
      resolveOptions.pipelinePath,
      factoryCwd,
    ),
  );
  if (origins.length > 0) {
    await resolveOptions.store.appendConfigOrigins(resolveOptions.runId, origins);
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
  const assigned = assignment(
    input.dag,
    stageId,
    definitionId,
    completedEnvelopes,
  );
  const priorResult =
    assigned ??
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
  const streamWriter = (input.streamLogWriterFactory ?? createStageStreamLogWriter)(
    attemptStreamLogPath(input.workspaceDir, stageId, attempt),
  );
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
  const feedbackLoopEmitContext = isDynamicCloneInstance
    ? undefined
    : runtimeNode?.feedback_loop;
  const repairContext = await repairContextForAttempt(input, stageId, attempt);
  const readQaTrail = createAttemptQaTrailReader(
    input.store,
    input.runId,
    stageId,
    attempt,
  );

  const meta = await input.store.readRunMeta(input.runId);
  const bindingKind =
    input.bindingKind ?? bindingKindFromMeta(meta);
  const trustWorkspaceConfig = resolveTrustWorkspaceConfig(
    input.trustWorkspaceConfig,
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
      onActivity: (event) => {
        input.onActivity?.(event);
        void streamWriter.flush();
      },
      onAssistantTextDelta: streamWriter.onDelta,
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
    {
      checkoutRoot: input.checkoutRoot ?? meta.checkout_root,
      bindingKind,
      trustWorkspaceConfig,
      stageEnv: input.stageEnv,
      store: input.store,
      runId: input.runId,
      pipelinePath: meta.pipeline_path,
      dag: input.dag,
    },
  );
  if (!opened.ok) return opened;
  return {
    ok: true,
    handle: opened.handle,
    roots,
    prior: priorResult.prior,
    ...(input.stageEnv !== undefined ? { stageEnv: input.stageEnv } : {}),
  };
}
