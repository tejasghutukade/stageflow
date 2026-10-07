import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { pipelinePath, catalogLocators, LINEAR_EXPLICIT_PIPELINE } from "./helpers/fixturePaths.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV,
} from "../src/config/resolveStageMcpServers.js";
import { attemptArtifactsDir, attemptStreamLogPath } from "../src/runstore/workspaceLayout.js";
import {
  appendOperatorAnswer,
  appendOperatorPrompt,
} from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { attemptContext } from "../src/runtime/stageAttemptContext.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import type { AskOperatorAnswer, AskOperatorPrompt } from "../src/tools/askOperator.js";
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

const titleInputSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

const unconstrainedObjectSchema = { type: "object" };

function linearDag(parent: string, child: string): ResolvedPipelineDag {
  return {
    nodes: [
      { id: parent, needs: null, ancestors: [], stageIndex: 0 },
      {
        id: child,
        needs: parent,
        needsEdges: [{ id: parent, on: ["succeeded"] }],
        ancestors: [parent],
        stageIndex: 1,
      },
    ],
    roots: [parent],
    childrenOf: { [parent]: [child] },
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

function envelopeOf(summary: string, payload?: Record<string, unknown>): StageEnvelope {
  return {
    status: "success",
    summary,
    artifacts: [],
    ...(payload !== undefined ? { payload } : {}),
  };
}

async function seedSucceeded(
  store: RunStore,
  runId: string,
  stageId: string,
  envelope: StageEnvelope,
): Promise<void> {
  await store.ensureStageWorkspace(runId, stageId);
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" });
  await store.appendStageEvent(runId, stageId, { event: "succeeded" });
  await store.writeEnvelope(runId, stageId, envelope);
  await store.updateStageExecution(runId, stageId, 1, {
    status: "succeeded",
    envelope,
  });
}

type OpenOverrides = Omit<
  Parameters<typeof openStageAttempt>[0],
  "agent" | "store" | "runId" | "task" | "workspaceDir" | "dag"
> & { dag?: ResolvedPipelineDag };

/** A fresh store + run with a recording agent; `open` calls openStageAttempt with defaults filled in. */
async function bootHarness(
  prefix: string,
  factoryCwd: string | undefined,
  runArgs: Record<string, unknown> = {},
  taskOverride: TaskFile = task,
) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const store = createRunStore({ rootDir: root });
  const run = await store.createRun({
    pipelineId: "docs-only",
    taskYaml: "id: t\ngoal: g\n",
    ...runArgs,
  } as Parameters<typeof store.createRun>[0]);
  const { agent, opened } = recordingAgent();
  return {
    store,
    run,
    opened,
    open: (overrides: OpenOverrides) =>
      openStageAttempt({
        agent,
        store,
        runId: run.runId,
        task: taskOverride,
        workspaceDir: run.workspaceDir,
        ...(factoryCwd !== undefined ? { factoryCwd } : {}),
        ...overrides,
        dag: overrides.dag ?? rootDag(overrides.stageId ?? overrides.stage.id),
      }),
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
    const { open, opened } = await bootHarness("sf-boot-skill-", factoryCwd);

    const result = await open({
      stage: stage("clarify", "operator-fixture"),
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.skillFilePath).toBe(filePath);
  });

  it("resolves run-scoped skill under repository binding without trust_workspace_config", async () => {
    const { open, opened, run } = await bootHarness(
      "sf-boot-run-skill-",
      factoryCwd,
      { repository: "https://github.com/example/repo.git" },
    );
    const { materializeRunSkills } = await import("../src/runtime/runSkills.js");
    await materializeRunSkills(run.workspaceDir, {
      "run-fixture": {
        "SKILL.md":
          "---\nname: run-fixture\ndescription: Run-scoped fixture.\n---\n# Run\n",
      },
    });

    const result = await open({
      stage: stage("clarify", "run-fixture"),
      checkoutRoot: await mkdtemp(path.join(tmpdir(), "sf-boot-co-")),
      bindingKind: "repository",
      trustWorkspaceConfig: [],
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.skillFilePath).toContain(
      path.join("skills", "run-fixture", "SKILL.md"),
    );
  });

  it("forwards stage.timeout_ms and sessionMode with feedback context to openStage", async () => {
    const { open, opened } = await bootHarness("sf-boot-forward-", factoryCwd);

    const result = await open({
      stage: { ...stage("clarify"), timeout_ms: 3600000 },
      sessionMode: "feedback_resume",
      feedbackLoopContext: {
        loop_id: "loop-1",
        replay_id: "replay-1",
        source_stage_id: "review",
        target_stage_id: "clarify",
        feedback_envelope: envelopeOf("revise"),
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
    expect(opened[0]?.timeoutMs).toBe(3600000);
    expect(opened[0]?.sessionMode).toBe("feedback_resume");
    expect(opened[0]?.feedbackLoopContext?.loop_id).toBe("loop-1");
  });

  it.each([
    {
      name: "the named skill is missing from the catalog",
      skill: "missing-skill",
      withCatalog: true,
    },
    {
      name: "the Operator catalog has no agentDir",
      skill: "operator-fixture",
      withCatalog: false,
    },
  ])("fails closed without openStage when $name", async ({ skill, withCatalog }) => {
    const { open, opened } = await bootHarness("sf-boot-skill-miss-", factoryCwd);

    const result = await open({
      stage: stage("clarify", skill),
      ...(withCatalog
        ? { operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir } }
        : {}),
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(new RegExp(`Skill "${skill}" is not installed`)),
    });
    expect(opened).toHaveLength(0);
  });

  it("passes the stored upstream StageEnvelope as prior for a needs Stage", async () => {
    const loaded = await loadPipeline(LINEAR_EXPLICIT_PIPELINE, { cwd: fixtures });
    const { open, opened, store, run } = await bootHarness(
      "sf-boot-prior-",
      factoryCwd,
      catalogLocators("linear-explicit"),
    );
    const parent: StageEnvelope = {
      ...envelopeOf("from-clarify", {}),
      artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
    };
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", parent);

    const result = await open({
      stage: loaded.stages.find((s) => s.id === "design-doc")!,
      dag: loaded.dag,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(opened).toHaveLength(1);
    expect(opened[0]?.priorEnvelope).toEqual(parent);
    expect(result.prior).toEqual(parent);
    expect(opened[0]?.priorEnvelopes).toBeUndefined();
    expect(opened[0]?.priorEnvelopesByStage).toBeUndefined();
  });

  it("fails closed without openStage when the upstream envelope is missing", async () => {
    const loaded = await loadPipeline(LINEAR_EXPLICIT_PIPELINE, { cwd: fixtures });
    const { open, opened } = await bootHarness(
      "sf-boot-no-prior-",
      factoryCwd,
      catalogLocators("linear-explicit"),
    );

    const result = await open({
      stage: loaded.stages.find((s) => s.id === "design-doc")!,
      dag: loaded.dag,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'missing envelope for upstream stage "clarify"',
    });
    expect(opened).toHaveLength(0);
  });

  it("forwards instance stageId into AgentPort input", async () => {
    const { open, opened } = await bootHarness("sf-boot-clone-id-", factoryCwd);

    const result = await open({
      stage: stage("work"),
      stageId: "work~2",
      dag: {
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
      },
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

  const feedbackLoop = {
    target: "implement",
    max_replays: 1,
    on_max_replays: "require_continue" as const,
    replay_session: "resume" as const,
  };

  it.each([
    {
      name: "is not exposed to dynamic clone instances",
      node: {
        id: "review~1",
        definition_id: "review",
        needs: null,
        ancestors: [],
        stageIndex: 0,
        feedback_loop: feedbackLoop,
      },
      stageId: "review~1",
      stageName: "review",
      expected: undefined,
    },
    {
      name: "stays available to persistent fork parents",
      node: {
        id: "review-work",
        definition_id: "review-work",
        needs: null,
        ancestors: [],
        stageIndex: 0,
        fork: { select: "subset", allow_none: false },
        feedback_loop: feedbackLoop,
      },
      stageId: undefined,
      stageName: "review-work",
      expected: feedbackLoop,
    },
  ] as const)(
    "feedback-loop decision context $name",
    async ({ node, stageId, stageName, expected }) => {
      const { open, opened } = await bootHarness("sf-boot-feedback-", factoryCwd);

      const result = await open({
        stage: stage(stageName),
        ...(stageId !== undefined ? { stageId } : {}),
        dag: {
          nodes: [node],
          roots: [node.id],
          childrenOf: { [node.id]: [] },
        } as ResolvedPipelineDag,
      });

      expect(result.ok).toBe(true);
      expect(opened[0]?.feedbackLoopEmitContext).toEqual(expected);
    },
  );

  it("passes a live attempt-scoped QA trail reader into openStage", async () => {
    const { open, opened, store, run } = await bootHarness(
      "sf-boot-trail-",
      factoryCwd,
    );
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

    const result = await open({
      stage: stage("clarify"),
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

  it.each([
    { fixture: "diamond-fan-in", order: ["research", "validation"] },
    { fixture: "diamond-fan-in-reversed", order: ["validation", "research"] },
  ])(
    "synthesize in $fixture passes priorEnvelopesByStage keyed in declaration order and omits priorEnvelopes",
    async ({ fixture, order }) => {
      const loaded = await loadPipeline(pipelinePath(fixture), { cwd: fixtures });
      const { open, opened, store, run } = await bootHarness(
        "sf-boot-diamond-",
        factoryCwd,
        catalogLocators(fixture),
      );
      const research = envelopeOf("from-research", {});
      const validation = envelopeOf("from-validation", {});
      await seedSucceeded(store, run.runId, "validation", validation);
      await seedSucceeded(store, run.runId, "research", research);

      const result = await open({
        stage: loaded.stages.find((s) => s.id === "synthesize")!,
        dag: loaded.dag,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(opened).toHaveLength(1);
      expect(opened[0]?.priorEnvelope).toBeNull();
      expect(opened[0]?.priorEnvelopes).toBeUndefined();
      expect(Object.keys(opened[0]?.priorEnvelopesByStage ?? {})).toEqual(order);
      expect(opened[0]?.priorEnvelopesByStage?.research).toEqual(research);
      expect(opened[0]?.priorEnvelopesByStage?.validation).toEqual(validation);
      expect(result.prior).toBeNull();
    },
  );

  it.each([
    { name: "stage.mcp is omitted", mcp: undefined },
    { name: "stage.mcp is empty", mcp: [] },
  ])("omits resolvedMcpServers when $name", async ({ mcp }) => {
    const { open, opened } = await bootHarness("sf-boot-mcp-omit-", factoryCwd);

    const result = await open({
      stage: { ...stage("clarify"), ...(mcp !== undefined ? { mcp } : {}) },
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
    const { open, opened, store, run } = await bootHarness(
      "sf-boot-mcp-ok-",
      factoryCwd,
    );

    const result = await open({ stage: { ...stage("clarify"), mcp: ["github"] } });

    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.resolvedMcpServers).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        cwd: path.resolve(factoryCwd),
      },
    });
    const detail = await store.readRun(run.runId);
    expect(detail.config_origins).toEqual([
      {
        name: "github",
        origin: "catalog",
        path: path.join(factoryCwd, ".mcp.json"),
      },
    ]);
  });

  it.each([
    {
      name: "refuses checkout-only .mcp.json for repository binding",
      repository: true,
      bindingKind: "repository",
      trust: [],
      allowed: false,
    },
    {
      name: "allows checkout-only .mcp.json for checkout binding and records workspace origin",
      repository: false,
      bindingKind: "checkout",
      trust: [],
      allowed: true,
    },
    {
      name: "trust_workspace_config allowlists checkout .mcp.json for repository binding",
      repository: true,
      bindingKind: "repository",
      trust: "factoryCwd",
      allowed: true,
    },
  ] as const)("checkout .mcp.json trust: $name", async (row) => {
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-boot-mcp-co-"));
    await writeMcpCatalog(checkout, {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
    });
    const { open, opened, store, run } = await bootHarness(
      "sf-boot-mcp-trust-",
      factoryCwd,
      {
        projectRoot: factoryCwd,
        checkoutRoot: checkout,
        ...(row.repository ? { repository: "https://github.com/example/repo.git" } : {}),
      },
    );

    const result = await open({
      stage: { ...stage("clarify"), mcp: ["github"] },
      checkoutRoot: checkout,
      bindingKind: row.bindingKind,
      trustWorkspaceConfig: row.trust === "factoryCwd" ? [factoryCwd] : [],
    });

    if (!row.allowed) {
      expect(result).toEqual({ ok: false, reason: "untrusted_config_origin" });
      expect(opened).toHaveLength(0);
      return;
    }
    expect(result.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.resolvedMcpServers?.github).toMatchObject({
      command: "npx",
      cwd: path.resolve(checkout),
    });
    const detail = await store.readRun(run.runId);
    expect(detail.config_origins).toEqual([
      {
        name: "github",
        origin: "workspace",
        path: path.join(checkout, ".mcp.json"),
      },
    ]);
  });

  it("stamps STAGEFLOW_STAGE_ARTIFACTS_DIR onto resolved MCP args", async () => {
    await writeMcpCatalog(factoryCwd, {
      playwright: {
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          "--output-dir",
          `\${${STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV}:-./fallback-mcp-out}`,
        ],
      },
    });
    const { open, opened, run } = await bootHarness("sf-boot-mcp-art-", factoryCwd);

    const result = await open({ stage: { ...stage("clarify"), mcp: ["playwright"] } });

    const artifactsDir = attemptArtifactsDir(run.workspaceDir, "clarify", 1);
    expect(result.ok).toBe(true);
    expect(opened[0]?.resolvedMcpServers?.playwright.args).toEqual([
      "-y",
      "@playwright/mcp@latest",
      "--output-dir",
      artifactsDir,
    ]);
    await expect(access(artifactsDir)).resolves.toBeUndefined();
  });

  it("stamps STAGEFLOW_STAGE_ARTIFACTS_DIR into the stage system_prompt", async () => {
    const { open, opened, run } = await bootHarness("sf-boot-mcp-prompt-", factoryCwd);

    const result = await open({
      stage: {
        ...stage("clarify"),
        system_prompt: `filename \${${STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV}}/page.png`,
      },
    });

    const artifactsDir = attemptArtifactsDir(run.workspaceDir, "clarify", 1);
    expect(result.ok).toBe(true);
    expect(opened[0]?.stage.system_prompt).toBe(`filename ${artifactsDir}/page.png`);
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
    const { open, opened } = await bootHarness("sf-boot-mcp-var-", factoryCwd);

    try {
      const result = await open({
        stage: { ...stage("clarify"), mcp: ["github"] },
        stageId: "clarify",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain(envKey);
      expect(result.reason).toContain('stage "clarify"');
      expect(opened).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previous;
      }
    }
  });

  it("interpolates MCP catalog vars from curated stageEnv grants", async () => {
    const envKey = "STAGEFLOW_TEST_MCP_GRANT";
    await writeMcpCatalog(factoryCwd, {
      github: {
        url: "https://api.github.com/mcp",
        headers: { Authorization: `Bearer \${${envKey}}` },
      },
    });
    const { open, opened } = await bootHarness("sf-boot-mcp-grant-", factoryCwd);

    const result = await open({
      stage: { ...stage("clarify"), mcp: ["github"] },
      stageEnv: { [envKey]: "grant-token-value-xx" },
    });

    expect(result.ok).toBe(true);
    expect(opened[0]?.resolvedMcpServers?.github).toMatchObject({
      headers: { Authorization: "Bearer grant-token-value-xx" },
    });
  });

  it.each([
    {
      name: "the allowlisted server is unknown",
      catalog: { github: { command: "npx" } },
      mcp: ["notion"],
      withFactoryCwd: true,
      reason: /notion/,
    },
    {
      name: "the catalog uses a reserved name",
      catalog: { stageflow: { command: "npx" } },
      mcp: ["stageflow"],
      withFactoryCwd: true,
      reason: /reserved name "stageflow"/,
    },
    {
      name: "mcp is set and factoryCwd is missing",
      catalog: undefined,
      mcp: ["github"],
      withFactoryCwd: false,
      reason: /MCP catalog.*missing/i,
    },
  ])("fails closed without openStage when $name", async (row) => {
    if (row.catalog) await writeMcpCatalog(factoryCwd, row.catalog);
    const { open, opened } = await bootHarness(
      "sf-boot-mcp-fail-",
      row.withFactoryCwd ? factoryCwd : undefined,
    );

    const result = await open({ stage: { ...stage("clarify"), mcp: row.mcp } });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(row.reason),
    });
    expect(opened).toHaveLength(0);
  });

  describe("clone_input_schema prior validation", () => {
    it.each([
      {
        name: "opens when a single predecessor payload matches",
        payload: { title: "Calendar" },
        schema: titleInputSchema,
        reason: undefined,
      },
      {
        name: "fails closed when a single predecessor payload is missing",
        payload: undefined,
        schema: titleInputSchema,
        reason: "prior payload is required by io.input.schema for design-doc",
      },
      {
        name: "fails closed when a single predecessor payload does not match",
        payload: { title: 12 },
        schema: titleInputSchema,
        reason: /^prior payload does not match io\.input\.schema for design-doc:/,
      },
      {
        name: "skips the check when clone_input_schema is omitted",
        payload: undefined,
        schema: undefined,
        reason: undefined,
      },
    ])("$name", async ({ payload, schema, reason }) => {
      const { open, opened, store, run } = await bootHarness(
        "sf-boot-prior-",
        factoryCwd,
      );
      await store.createStageExecution(run.runId, "clarify");
      await store.writeEnvelope(
        run.runId,
        "clarify",
        envelopeOf("from-parent", payload),
      );

      const result = await open({
        stage: {
          ...stage("design-doc"),
          ...(schema !== undefined ? { clone_input_schema: schema } : {}),
        },
        dag: linearDag("clarify", "design-doc"),
      });

      if (reason === undefined) {
        expect(result.ok).toBe(true);
        expect(opened).toHaveLength(1);
      } else {
        expect(result).toEqual({
          ok: false,
          reason: typeof reason === "string" ? reason : expect.stringMatching(reason),
        });
        expect(opened).toHaveLength(0);
      }
    });

    it.each([
      {
        name: "fails closed when a fan-in prior payload does not match",
        validationTitle: 1,
        reason: /^prior payload does not match io\.input\.schema for synthesize:/,
      },
      {
        name: "opens when every fan-in prior payload matches",
        validationTitle: "v",
        reason: undefined,
      },
    ])("$name", async ({ validationTitle, reason }) => {
      const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
        cwd: fixtures,
      });
      const { open, opened, store, run } = await bootHarness(
        "sf-boot-fanin-",
        factoryCwd,
        catalogLocators("diamond-fan-in"),
      );
      await seedSucceeded(
        store,
        run.runId,
        "validation",
        envelopeOf("from-validation", { title: validationTitle }),
      );
      await seedSucceeded(
        store,
        run.runId,
        "research",
        envelopeOf("from-research", { title: "r" }),
      );

      const result = await open({
        stage: {
          ...loaded.stages.find((s) => s.id === "synthesize")!,
          clone_input_schema: titleInputSchema,
        },
        dag: loaded.dag,
      });

      if (reason === undefined) {
        expect(result.ok).toBe(true);
        expect(opened).toHaveLength(1);
      } else {
        expect(result).toEqual({ ok: false, reason: expect.stringMatching(reason) });
        expect(opened).toHaveLength(0);
      }
    });

    it.each([
      {
        name: "treats omitted task.input as {} on entry and opens when it matches",
        schema: unconstrainedObjectSchema,
        input: undefined,
        ok: true,
      },
      {
        name: "fails closed when omitted task.input does not match entry io.input.schema",
        schema: titleInputSchema,
        input: undefined,
        ok: false,
      },
      {
        name: "fails closed when task.input does not match entry io.input.schema",
        schema: titleInputSchema,
        input: { title: 9 },
        ok: false,
      },
    ])("$name", async ({ schema, input, ok }) => {
      const { open, opened } = await bootHarness(
        "sf-boot-entry-",
        factoryCwd,
        {},
        input !== undefined ? { ...task, input } : task,
      );

      const result = await open({
        stage: { ...stage("clarify"), clone_input_schema: schema },
      });

      if (ok) {
        expect(result.ok).toBe(true);
        expect(opened).toHaveLength(1);
      } else {
        expect(result).toEqual({
          ok: false,
          reason: expect.stringMatching(
            /^task input does not match io\.input\.schema for clarify:/,
          ),
        });
        expect(opened).toHaveLength(0);
      }
    });
  });
});

describe("openStageAttempt — stream-log wiring", () => {
  let factoryCwd: string;

  beforeEach(async () => {
    factoryCwd = await mkdtemp(path.join(tmpdir(), "sf-boot-cwd-"));
  });

  it("constructs the writer at the attempt's stream-log path and threads onAssistantTextDelta through to openStage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-stream-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const fakeWriter = {
      onDelta: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const streamLogWriterFactory = vi.fn().mockReturnValue(fakeWriter);

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
      streamLogWriterFactory,
    });

    expect(result.ok).toBe(true);
    expect(streamLogWriterFactory).toHaveBeenCalledWith(
      attemptStreamLogPath(run.workspaceDir, "clarify", 1),
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]?.onAssistantTextDelta).toBe(fakeWriter.onDelta);
  });

  it("flushes the writer whenever onActivity fires, alongside the caller's own onActivity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-boot-stream-flush-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { agent, opened } = recordingAgent();
    const fakeWriter = {
      onDelta: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const callerOnActivity = vi.fn();

    const result = await openStageAttempt({
      agent,
      store,
      runId: run.runId,
      stage: stage("clarify"),
      task,
      dag: rootDag("clarify"),
      workspaceDir: run.workspaceDir,
      factoryCwd,
      onActivity: callerOnActivity,
      streamLogWriterFactory: () => fakeWriter,
    });

    expect(result.ok).toBe(true);
    const wrappedOnActivity = opened[0]?.onActivity;
    expect(wrappedOnActivity).toBeDefined();

    const activity = { event: "agent_start" as const };
    wrappedOnActivity?.(activity);

    expect(callerOnActivity).toHaveBeenCalledWith(activity);
    expect(fakeWriter.flush).toHaveBeenCalledTimes(1);
  });
});
