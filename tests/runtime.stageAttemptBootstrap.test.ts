import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { pipelinePath, catalogLocators, LINEAR_EXPLICIT_PIPELINE, SAMPLE_TASK } from "./helpers/fixturePaths.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  buildCompletedEnvelopesFromRun,
  resolvePriorEnvelope,
} from "../src/runtime/envelopeRouting.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
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
});
