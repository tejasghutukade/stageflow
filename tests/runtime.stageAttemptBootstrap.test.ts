import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { pipelinePath, catalogLocators, LINEAR_EXPLICIT_PIPELINE } from "./helpers/fixturePaths.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  appendOperatorAnswer,
  appendOperatorPrompt,
} from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import {
  buildCompletedEnvelopesFromRun,
  resolvePriorEnvelope,
} from "../src/runtime/envelopeRouting.js";
import { attemptContext } from "../src/runtime/stageAttemptContext.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import type { AskOperatorAnswer, AskOperatorPrompt } from "../src/tools/askOperator.js";
import type { RunPipelineDagSnapshot } from "../src/runstore/port.js";
import type { ResolvedPipelineDag } from "../src/types/pipeline.js";
import type { StageConfig } from "../src/types/stage.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { TaskFile } from "../src/types/task.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const task: TaskFile = { id: "t", goal: "g" };

function rootDag(stageId: string): ResolvedPipelineDag {
  return {
    nodes: [{ id: stageId, needs: null, ancestors: [], stageIndex: 0 }],
    roots: [stageId],
    childrenOf: {},
  };
}

function stage(id: string, skill?: string): StageConfig {
  return {
    id,
    system_prompt: "x",
    model: "anthropic/claude-sonnet-4-5",
    ...(skill !== undefined ? { skill } : {}),
  };
}

function recordingAgent() {
  const opened: StageRunInput[] = [];
  const inner = scriptedFakeAgent([
    {
      type: "emit",
      envelope: { status: "success", summary: "done", artifacts: [] },
    },
  ]);
  return {
    opened,
    agent: {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    },
  };
}

async function writeSkill(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  await writeFile(filePath, body, "utf8");
  return filePath;
}

async function writeMcpCatalog(
  root: string,
  servers: Record<string, Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: servers }),
    "utf8",
  );
}

describe("openStageAttempt", () => {
  const previousHome = process.env.HOME;
  let factoryCwd: string;
  let operatorAgentDir: string;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-boot-home-"));
    factoryCwd = await mkdtemp(path.join(tmpdir(), "sf-boot-cwd-"));
    operatorAgentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("passes resolved skillFilePath into openStage for a named skill", async () => {
    const filePath = await writeSkill(
      path.join(operatorAgentDir, "skills"),
      "operator-fixture",
      "---\nname: operator-fixture\ndescription: Operator catalog fixture.\n---\n# Operator\n",
    );
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-skill-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify", "operator-fixture"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.skillFilePath).toBe(filePath);
  });

  it("forwards stage.timeout_ms as timeoutMs to openStage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-timeout-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: { ...stage("approve"), timeout_ms: 3600000 },
      task,
      dag: rootDag("approve"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.timeoutMs).toBe(3600000);
  });

  it("forwards sessionMode into openStage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-session-mode-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
      sessionMode: "feedback_resume",
      feedbackLoopContext: {
        loop_id: "loop-1",
        replay_id: "replay-1",
        source_stage_id: "review",
        target_stage_id: "clarify",
        feedback_envelope: {
          status: "success",
          summary: "revise",
          artifacts: [],
        },
        replay_number: 1,
        max_replays: 2,
        remaining_replays: 1,
        is_final_replay: false,
        replay_session: "resume",
        route_stage_ids: ["clarify", "review"],
      },
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.sessionMode).toBe("feedback_resume");
    expect(opened[0]?.feedbackLoopContext?.loop_id).toBe("loop-1");
  });

  it("fails closed without openStage when the named skill is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-miss-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify", "missing-skill"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/Skill ".*" is not installed/),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Skill "missing-skill" is not installed/);
    }
    expect(opened).toHaveLength(0);
  });

  it("fails closed without openStage when Operator catalog has no agentDir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-nodir-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify", "operator-fixture"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/Skill ".*" is not installed/),
    });
    expect(opened).toHaveLength(0);
  });

  it("passes prior StageEnvelope matching envelopeRouting for a needs Stage", async () => {
    const loaded = await loadPipeline(LINEAR_EXPLICIT_PIPELINE, { cwd: fixtures });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-prior-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("linear-explicit"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const parent: StageEnvelope = {
      status: "success",
      summary: "from-clarify",
      artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
    };
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", parent);
    const { agent, opened } = recordingAgent();
    const designDoc = loaded.stages.find((s) => s.id === "design-doc");
    expect(designDoc).toBeDefined();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: designDoc!,
      task,
      dag: loaded.dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    const completedEnvelopes = await buildCompletedEnvelopesFromRun(
      store,
      run.runId,
    );
    const routed = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes,
      store,
      runId: run.runId,
    });

    expect(result.ok).toBe(true);
    expect(routed.ok).toBe(true);
    if (!result.ok || !routed.ok) return;
    expect(opened).toHaveLength(1);
    expect(opened[0]?.priorEnvelope).toEqual(routed.prior);
    expect(result.prior).toEqual(routed.prior);
    expect(opened[0]?.priorEnvelope?.summary).toBe("from-clarify");
    expect(opened[0]?.priorEnvelopes).toBeUndefined();
    expect(opened[0]?.priorEnvelopesByStage).toBeUndefined();
  });

  it("fails closed without openStage when the upstream envelope is missing", async () => {
    const loaded = await loadPipeline(LINEAR_EXPLICIT_PIPELINE, { cwd: fixtures });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-no-prior-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("linear-explicit"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const designDoc = loaded.stages.find((s) => s.id === "design-doc");
    expect(designDoc).toBeDefined();

    const routed = await resolvePriorEnvelope({
      dag: loaded.dag,
      stageId: "design-doc",
      completedEnvelopes: new Map(),
      store,
      runId: run.runId,
    });

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: designDoc!,
      task,
      dag: loaded.dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(routed.ok).toBe(false);
    expect(result).toEqual(routed);
    expect(opened).toHaveLength(0);
  });

  it("forwards instance stageId into AgentPort input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-clone-id-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "work~2",
          definition_id: "work",
          needs: null,
          ancestors: [],
          stageIndex: 0,
        },
      ],
      roots: ["work~2"],
      childrenOf: {},
    };

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("work"),
      stageId: "work~2",
      task,
      dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.stage.id).toBe("work");
    expect(opened[0]?.stageId).toBe("work~2");
    expect(opened[0]?.resumeToken).toMatch(
      /stages\/work~2\/attempts\/1\/pi-session\.jsonl$/,
    );
    expect(opened[0]?.feedbackLoopEmitContext).toBeUndefined();
  });

  it("does not expose feedback-loop decisions to dynamic clone instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-feedback-clone-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "review~1",
          definition_id: "review",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          feedback_loop: {
            target: "implement",
            max_replays: 1,
            on_max_replays: "require_continue",
            replay_session: "resume",
          },
        },
      ],
      roots: ["review~1"],
      childrenOf: {},
    };

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("review"),
      stageId: "review~1",
      task,
      dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened[0]?.feedbackLoopEmitContext).toBeUndefined();
  });

  it("keeps feedback-loop decisions available to persistent fork parents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-feedback-fork-parent-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const feedback_loop = {
      target: "implement",
      max_replays: 1,
      on_max_replays: "require_continue" as const,
      replay_session: "resume" as const,
    };
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "review-work",
          definition_id: "review-work",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          fork: { select: "subset", allow_none: false },
          feedback_loop,
        },
      ],
      roots: ["review-work"],
      childrenOf: { "review-work": [] },
    };

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("review-work"),
      task,
      dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened[0]?.feedbackLoopEmitContext).toEqual(feedback_loop);
  });

  it("passes a live attempt-scoped QA trail reader into openStage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-trail-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    const prompt: AskOperatorPrompt = {
      kind: "artifact_backed",
      id: "plan-1",
      message: "Review the plan",
      artifacts: ["plan.md"],
    };
    const accept: AskOperatorAnswer = {
      promptId: "plan-1",
      kind: "artifact_backed",
      decision: "accept",
    };
    await appendOperatorPrompt(store, run.runId, "clarify", prompt, {
      attempt: 1,
    });
    await appendOperatorAnswer(store, run.runId, "clarify", accept, {
      attempt: 1,
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
      attemptCtx: attemptContext(2),
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    const reader = opened[0]?.readQaTrail;
    expect(typeof reader).toBe("function");
    // Attempt-scoped: attempt 1's prompt/answer must not leak into attempt 2.
    expect(await reader?.()).toEqual([]);

    await appendOperatorPrompt(store, run.runId, "clarify", prompt, {
      attempt: 2,
    });
    await appendOperatorAnswer(store, run.runId, "clarify", accept, {
      attempt: 2,
    });
    expect(await reader?.()).toEqual([{ prompt, answer: accept }]);
  });

  it("wires parent clone_actions and successor clone_input_schema into clone emit context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-clone-ctx-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const assignmentSchema = {
      type: "object",
      properties: { area_id: { type: "string" } },
      required: ["area_id"],
    };
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["oss-plan-investigation", "oss-investigate-area"],
      nodes: [
        {
          id: "oss-plan-investigation",
          needs: null,
          ancestors: [],
          stageIndex: 0,
        },
        {
          id: "oss-investigate-area",
          needs: "oss-plan-investigation",
          ancestors: ["oss-plan-investigation"],
          stageIndex: 1,
          clonable: true,
          clone_cap: 4,
        },
      ],
      roots: ["oss-plan-investigation"],
      childrenOf: {
        "oss-plan-investigation": ["oss-investigate-area"],
      },
      clone_input_schema: {
        "oss-investigate-area": assignmentSchema,
      },
    };

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: {
        ...stage("oss-plan-investigation"),
        clone_actions: ["once", "fanout"],
      },
      task,
      dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened[0]?.cloneEmitContext).toEqual({
      clonableSuccessors: [
        {
          successorId: "oss-investigate-area",
          cloneCap: 4,
          cloneInputSchema: assignmentSchema,
        },
      ],
      allowedActions: ["once", "fanout"],
    });
  });

  it("clone join passes priorEnvelopes and omits priorEnvelopesByStage", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 3,
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-clone-join-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("clone-fanout-join"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const completed = new Map<string, StageEnvelope>([
      ["design-doc~1", { status: "success", summary: "d1", artifacts: [] }],
      ["design-doc~2", { status: "success", summary: "d2", artifacts: [] }],
      ["design-doc~3", { status: "success", summary: "d3", artifacts: [] }],
    ]);
    const { agent, opened } = recordingAgent();
    const joinDoc = loaded.stages.find((s) => s.id === "join-doc");
    expect(joinDoc).toBeDefined();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: joinDoc!,
      task,
      dag: snapshot,
      workspaceDir: run.workspaceDir,
      factoryCwd,
      completedEnvelopes: completed,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.priorEnvelope).toBeNull();
    expect(opened[0]?.priorEnvelopes?.map((e) => e.summary)).toEqual([
      "d1",
      "d2",
      "d3",
    ]);
    expect(opened[0]?.priorEnvelopesByStage).toBeUndefined();
  });

  it("diamond synthesize passes priorEnvelopesByStage and omits priorEnvelopes", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-diamond-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("diamond-fan-in"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const research: StageEnvelope = {
      status: "success",
      summary: "from-research",
      artifacts: [],
    };
    const validation: StageEnvelope = {
      status: "success",
      summary: "from-validation",
      artifacts: [],
    };
    for (const [stageId, envelope] of [
      ["validation", validation],
      ["research", research],
    ] as const) {
      await store.ensureStageWorkspace(run.runId, stageId);
      await store.createStageExecution(run.runId, stageId);
      await store.appendStageEvent(run.runId, stageId, { event: "started" });
      await store.appendStageEvent(run.runId, stageId, { event: "succeeded" });
      await store.writeEnvelope(run.runId, stageId, envelope);
      await store.updateStageExecution(run.runId, stageId, 1, {
        status: "succeeded",
        envelope,
      });
    }
    const { agent, opened } = recordingAgent();
    const synthesize = loaded.stages.find((s) => s.id === "synthesize");
    expect(synthesize).toBeDefined();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: synthesize!,
      task,
      dag: loaded.dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.priorEnvelope).toBeNull();
    expect(opened[0]?.priorEnvelopes).toBeUndefined();
    expect(Object.keys(opened[0]?.priorEnvelopesByStage ?? {})).toEqual([
      "research",
      "validation",
    ]);
    expect(opened[0]?.priorEnvelopesByStage?.research).toEqual(research);
    expect(opened[0]?.priorEnvelopesByStage?.validation).toEqual(validation);
    expect(result.prior).toBeNull();
  });

  it("diamond synthesize keys priors in reversed YAML declaration order", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in-reversed"), {
      cwd: fixtures,
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-diamond-rev-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      ...catalogLocators("diamond-fan-in-reversed"),
      taskYaml: "id: t\ngoal: g\n",
    });
    const research: StageEnvelope = {
      status: "success",
      summary: "from-research",
      artifacts: [],
    };
    const validation: StageEnvelope = {
      status: "success",
      summary: "from-validation",
      artifacts: [],
    };
    for (const [stageId, envelope] of [
      ["research", research],
      ["validation", validation],
    ] as const) {
      await store.ensureStageWorkspace(run.runId, stageId);
      await store.createStageExecution(run.runId, stageId);
      await store.appendStageEvent(run.runId, stageId, { event: "started" });
      await store.appendStageEvent(run.runId, stageId, { event: "succeeded" });
      await store.writeEnvelope(run.runId, stageId, envelope);
      await store.updateStageExecution(run.runId, stageId, 1, {
        status: "succeeded",
        envelope,
      });
    }
    const { agent, opened } = recordingAgent();
    const synthesize = loaded.stages.find((s) => s.id === "synthesize");
    expect(synthesize).toBeDefined();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: synthesize!,
      task,
      dag: loaded.dag,
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.priorEnvelope).toBeNull();
    expect(opened[0]?.priorEnvelopes).toBeUndefined();
    expect(Object.keys(opened[0]?.priorEnvelopesByStage ?? {})).toEqual([
      "validation",
      "research",
    ]);
    expect(opened[0]?.priorEnvelopesByStage?.validation).toEqual(validation);
    expect(opened[0]?.priorEnvelopesByStage?.research).toEqual(research);
    expect(result.prior).toBeNull();
  });

  it("omits resolvedMcpServers when stage.mcp is omitted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-omit-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.resolvedMcpServers).toBeUndefined();
  });

  it("omits resolvedMcpServers when stage.mcp is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-empty-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: { ...stage("clarify"), mcp: [] },
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.resolvedMcpServers).toBeUndefined();
  });

  it("forwards resolved MCP snapshot from factoryCwd catalog onto openStage", async () => {
    await writeMcpCatalog(factoryCwd, {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
      notion: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-notion"],
      },
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-ok-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: { ...stage("clarify"), mcp: ["github"] },
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.resolvedMcpServers).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        cwd: path.resolve(factoryCwd),
      },
    });
  });

  it("fails closed without openStage when a catalog variable is unresolved", async () => {
    const envKey = "STAGEFLOW_TEST_MCP_TOKEN";
    const previous = process.env[envKey];
    delete process.env[envKey];
    await writeMcpCatalog(factoryCwd, {
      github: {
        url: "https://api.github.com/mcp",
        headers: { Authorization: `Bearer \${${envKey}}` },
      },
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-var-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    try {
      const result = await openStageAttempt({
        agent,
        store,
        runId: run.runId,
        stage: { ...stage("clarify"), mcp: ["github"] },
        task,
        dag: rootDag("clarify"),
        workspaceDir: run.workspaceDir,
        factoryCwd,
      });

      expect(result).toEqual({
        ok: false,
        reason: expect.stringContaining(envKey),
      });
      expect(opened).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previous;
      }
    }
  });

  it("fails closed without openStage when the allowlisted server is unknown", async () => {
    await writeMcpCatalog(factoryCwd, {
      github: { command: "npx" },
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-unknown-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: { ...stage("clarify"), mcp: ["notion"] },
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("notion"),
    });
    expect(opened).toHaveLength(0);
  });

  it("fails closed without openStage when the catalog uses a reserved name", async () => {
    await writeMcpCatalog(factoryCwd, {
      stageflow: { command: "npx" },
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-reserved-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: { ...stage("clarify"), mcp: ["stageflow"] },
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/reserved name "stageflow"/),
    });
    expect(opened).toHaveLength(0);
  });

  it("fails closed without openStage when mcp is set and factoryCwd is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-nocwd-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: { ...stage("clarify"), mcp: ["github"] },
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/MCP catalog.*missing/i),
    });
    expect(opened).toHaveLength(0);
  });
});
