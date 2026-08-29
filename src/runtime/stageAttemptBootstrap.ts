import type { AgentPort, StageHandle, StageRunInput } from "../agent/port.js";
import { resolveSkillByName } from "../config/listSkills.js";
import { resolveCloneEmitContext, resolveForkEmitContext } from "../config/resolveForkEmitContext.js";
import type { RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import type { TaskFile } from "../types/task.js";
import {
  buildCompletedEnvelopesFromRun,
  resolvePriorEnvelope,
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
  stage: StageConfig;
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
  workerRoots?: boolean;
  completedEnvelopes?: Map<string, StageEnvelope>;
  stageId?: string;
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

async function openStageWithOperatorCatalog(
  agent: Pick<AgentPort, "openStage">,
  input: Omit<StageRunInput, "skillFilePath">,
  catalog?: OperatorCatalog,
): Promise<OpenStageWithOperatorCatalogResult> {
  const skill = await resolveStageSkillForRun(input.stage, catalog);
  if (!skill.ok) return skill;
  try {
    const handle = agent.openStage({
      ...input,
      ...(skill.skillFilePath !== undefined
        ? { skillFilePath: skill.skillFilePath }
        : {}),
    });
    return { ok: true, handle };
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
  const priorResult = await resolvePriorEnvelope({
    dag: input.dag,
    stageId,
    completedEnvelopes,
    store: input.store,
    runId: input.runId,
  });
  if (!priorResult.ok) return priorResult;

  const roots = resolveAttemptRoots(input, stageId);
  const attempt = input.attemptCtx?.attempt ?? 1;
  const resumeToken =
    input.resumeToken ??
    resumeSessionFilePath(input.workspaceDir, stageId, attempt);

  const forkEmitContext = resolveForkEmitContext(input.dag, definitionId);
  const cloneEmitContext = resolveCloneEmitContext(input.dag, definitionId);

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
      resumeToken,
      onActivity: input.onActivity,
      forkEmitContext,
      cloneEmitContext,
    },
    input.operatorCatalog,
  );
  if (!opened.ok) return opened;
  return {
    ok: true,
    handle: opened.handle,
    roots,
    prior: priorResult.prior,
  };
}
