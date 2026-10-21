import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StagePort } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { closeServer } from "./helpers/closeServer.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { waitFor } from "./helpers/waitFor.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

const MODEL = "anthropic/claude-sonnet-4-5";

function checkStage(id = "check", extra: Record<string, unknown> = {}) {
  return { id, system_prompt: "Do work", model: MODEL, ...REQUIRED_IO, ...extra };
}

const emitOk = (summary = "ok", payload?: Record<string, unknown>) => ({
  type: "emit" as const,
  envelope: {
    status: "success" as const,
    summary,
    artifacts: [],
    ...(payload !== undefined ? { payload } : {}),
  },
});

async function runAndWait(
  base: string,
  store: RunStore,
  args: Record<string, unknown>,
): Promise<string> {
  const started = await mcpCall(base, "run_stage", args);
  expect(started.isError).toBe(false);
  const runId = started.payload.runId as string;
  await waitFor(async () => (await store.readRun(runId)).status === "succeeded");
  return runId;
}

async function readTask(store: RunStore, runId: string) {
  const detail = await store.readRun(runId);
  return parse(detail.task_yaml) as { goal: string; input?: Record<string, unknown> };
}

describe("run_stage — standalone stage execution (MCP)", () => {
  let projectRoot: string;
  let cleanupProject: () => Promise<void>;

  beforeAll(async () => {
    const setup = await initTempGitRepo();
    projectRoot = setup.root;
    cleanupProject = setup.cleanup;
    for (const dir of ["pipelines", "tasks", "stages"]) {
      await cp(path.join(fixtures, dir), path.join(projectRoot, dir), { recursive: true });
    }
    await writeFile(
      path.join(projectRoot, "stageflow.yaml"),
      [
        "version: 1",
        "catalog:",
        "  pipelines:",
        "    - pipelines",
        "  tasks:",
        "    - tasks",
        "  patterns:",
        '    pipeline: "*.yaml"',
        '    task: "*.yaml"',
        "",
      ].join("\n"),
    );
    clearFindProjectRootCacheForTests();
  });

  afterAll(async () => {
    clearFindProjectRootCacheForTests();
    await cleanupProject();
  });

  async function withServer(
    agentOrBehaviors: StagePort | Parameters<typeof scriptedFakeAgent>[0],
    fn: (base: string, store: RunStore) => Promise<void>,
  ): Promise<void> {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-run-stage-"));
    const store = createRunStore({ rootDir: storeRoot });
    await store.ensureProject(projectRoot);
    const agent = Array.isArray(agentOrBehaviors)
      ? scriptedFakeAgent(agentOrBehaviors)
      : agentOrBehaviors;
    const { server } = await startUiServer({
      agent,
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    try {
      await fn(`http://127.0.0.1:${address.port}`, store);
    } finally {
      await closeServer(server);
    }
  }

  it("runs an inline bare stage body to completion, no pipeline wrapper authored by the caller", async () => {
    await withServer([emitOk("checked")], async (base, store) => {
      const started = await mcpCall(base, "run_stage", {
        stage: checkStage("check", { system_prompt: "Review the diff for obvious bugs." }),
        task: { id: "t", goal: "check this change" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;
      expect(runId).toBeTruthy();
      expect(started.payload.stageId).toBe("check");

      await waitFor(async () => (await store.readRun(runId)).status === "succeeded");

      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.pipeline_path).toBeUndefined();
      expect(detail.payload.stages[0]?.envelope.summary).toBe("checked");

      const envelope = await mcpCall(base, "get_envelope", { runId, stageId: "check" });
      expect(envelope.isError).toBe(false);
      expect(envelope.payload.envelope.summary).toBe("checked");

      const listed = await mcpCall(base, "list_runs", {});
      expect(
        listed.payload.runs.some((r: { run_id: string }) => r.run_id === runId),
      ).toBe(true);
    });
  });

  it("runs a catalog stage referenced by filesystem path, no pipeline file authored", async () => {
    await withServer([emitOk("researched")], async (base, store) => {
      const started = await mcpCall(base, "run_stage", {
        stage: "stages/research.yaml",
        task: { id: "t", goal: "look into it" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;
      expect(started.payload.stageId).toBe("research");

      await waitFor(async () => (await store.readRun(runId)).status === "succeeded");

      const envelope = await mcpCall(base, "get_envelope", { runId, stageId: "research" });
      expect(envelope.isError).toBe(false);
      expect(envelope.payload.envelope.summary).toBe("researched");
    });
  });

  it("passes task.checkout through exactly as a normal pipeline run would", async () => {
    await withServer([emitOk()], async (base, store) => {
      const runId = await runAndWait(base, store, {
        stage: checkStage(),
        task: { id: "t", goal: "check", checkout: projectRoot },
      });
      const meta = await store.readRunMeta(runId);
      expect(meta.checkout_root).toBe(projectRoot);
    });
  });

  it.each([
    {
      name: "a body missing io.output.schema fails with a ValidationFinding-shaped stage.invalid_io",
      stage: { id: "check", system_prompt: "Do work" },
      assertPayload: (payload: any) => {
        expect(payload.error).toBe("Stage validation failed");
        expect(
          payload.validation.findings.map((f: { code: string }) => f.code),
        ).toContain("stage.invalid_io");
      },
    },
    {
      name: "uses: on an inline stage body is rejected, same as an inline pipeline stage",
      stage: { id: "check", uses: "./somewhere.yaml" },
      assertPayload: (payload: any) => {
        expect(payload.error).toBe("Stage validation failed");
        expect(payload.validation.findings).toEqual([
          expect.objectContaining({
            code: "pipeline.invalid_shape",
            message: expect.stringContaining('has "uses"'),
          }),
        ]);
      },
    },
    {
      name: "a body with no id is rejected",
      stage: { system_prompt: "Do work", ...REQUIRED_IO },
      assertPayload: (payload: any) => {
        expect(payload.error).toBe("stage.id is required");
      },
    },
  ])("rejects an invalid inline stage body: $name", async ({ stage, assertPayload }) => {
    await withServer([], async (base) => {
      const started = await mcpCall(base, "run_stage", {
        stage,
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(true);
      assertPayload(started.payload);
    });
  });

  it("a stage with verify: runs its after-phase check and records the outcome on the standalone run", async () => {
    await withServer([emitOk("ok", {})], async (base, store) => {
      const runId = await runAndWait(base, store, {
        stage: checkStage("check", {
          verify: [{ id: "handoff", type: "payload_schema", when: ["after"] }],
        }),
        task: { id: "t", goal: "check" },
      });
      const verification = await mcpCall(base, "get_stage_verification", {
        runId,
        stageId: "check",
      });
      expect(verification.isError).toBe(false);
      expect(verification.payload.attempts[0].verification_outcome).toBe("passed");
      expect(verification.payload.attempts[0].checks).toEqual([
        expect.objectContaining({ check_id: "handoff", status: "passed" }),
      ]);
    });
  });

  describe("blocking mode", () => {
    it("a blocking call against a gate-free stage returns the final envelope directly, no polling", async () => {
      await withServer([emitOk("done")], async (base) => {
        const started = await mcpCall(base, "run_stage", {
          stage: checkStage(),
          task: { id: "t", goal: "check" },
          blocking: true,
        });
        expect(started.isError).toBe(false);
        expect(started.payload.status).toBe("completed");
        expect(started.payload.envelope.summary).toBe("done");
        expect(started.payload.runId).toBeTruthy();
        expect(started.payload.stageId).toBe("check");
      });
    });

    it("a blocking call that parks returns needs_input; answering then waiting completes the same run via existing tools", async () => {
      await withServer(
        [
          {
            type: "wait_then_emit",
            waitRequests: [{ kind: "free_text", id: "prompt-1", message: "hold" }],
            envelope: { status: "success", summary: "clarified", artifacts: [] },
          },
        ],
        async (base, store) => {
          const started = await mcpCall(base, "run_stage", {
            stage: checkStage("clarify", { system_prompt: "Ask a question" }),
            task: { id: "t", goal: "check" },
            blocking: true,
          });
          expect(started.isError).toBe(false);
          expect(started.payload.status).toBe("needs_input");
          expect(started.payload.pending_prompt).toMatchObject({
            kind: "free_text",
            id: "prompt-1",
          });
          const runId = started.payload.runId as string;

          const answered = await mcpCall(base, "answer_gate", {
            runId,
            stageId: "clarify",
            answer: { promptId: "prompt-1", kind: "free_text", text: "yes" },
          });
          expect(answered.isError).toBe(false);

          // No new HITL primitive: resuming after a needs_input result reuses
          // the existing wait_run tool, exactly as a pipeline caller would.
          const waited = await mcpCall(base, "wait_run", { runId, until: "terminal" });
          expect(waited.isError).toBe(false);
          // "already" (matched on the very first check, no poll-sleep needed)
          // is just as valid a terminal wake as "terminal" here.
          expect(["terminal", "already"]).toContain(waited.payload.reason);

          await waitFor(async () => (await store.readRun(runId)).status === "succeeded");
        },
      );
    });

    it("a blocking call respects the timeout budget instead of hanging indefinitely", async () => {
      // A FakeAgent behavior always resolves (or fails/parks) near-instantly,
      // so it can't exercise the "still running" timeout path. This stand-in
      // StagePort deliberately never resolves within the test's timeout_ms.
      const hangingAgent: StagePort = {
        openStage(input) {
          return {
            stageId: input.stage.id,
            async next() {
              await new Promise((r) => setTimeout(r, 5000));
              return { status: "completed", result: { ok: false, reason: "never" } };
            },
            deliverAnswer() {},
            async close() {},
          };
        },
        async runStage() {
          await new Promise((r) => setTimeout(r, 5000));
          return { ok: false, reason: "never" };
        },
      };

      await withServer(hangingAgent, async (base) => {
        const started = await mcpCall(base, "run_stage", {
          stage: checkStage(),
          task: { id: "t", goal: "check" },
          blocking: true,
          timeout_ms: 300,
        });
        expect(started.isError).toBe(false);
        expect(started.payload.status).toBe("timeout");
        expect(started.payload.runId).toBeTruthy();
      });
    }, 10000);
  });

  describe("envelope reference input", () => {
    it("resolves a reference to a prior standalone call's envelope and feeds its payload as the next stage's input", async () => {
      await withServer(
        [emitOk("found three leads", { leads: ["a", "b", "c"] }), emitOk("summarized")],
        async (base, store) => {
          const firstRunId = await runAndWait(base, store, {
            stage: checkStage("research", { system_prompt: "Research" }),
            task: { id: "t1", goal: "research it" },
          });
          const secondRunId = await runAndWait(base, store, {
            stage: checkStage("summarize", { system_prompt: "Summarize" }),
            envelope_ref: { runId: firstRunId, stageId: "research" },
          });

          const parsedTask = await readTask(store, secondRunId);
          expect(parsedTask.goal).toBe("found three leads");
          expect(parsedTask.input).toEqual({ leads: ["a", "b", "c"] });
        },
      );
    });

    it("resolves a reference to a stage inside an ordinary multi-stage pipeline run, not just standalone calls", async () => {
      // A controlled two-stage inline pipeline (not an existing fixture) so
      // the topology — and which stage gets which scripted behavior — is
      // fully deterministic, unlike a multi-entry fixture pipeline.
      await withServer(
        [
          emitOk("from pipeline stage", { note: "hi" }),
          emitOk("second stage ok"),
          emitOk("standalone ok"),
        ],
        async (base, store) => {
          const pipelineRun = await mcpCall(base, "start_run", {
            pipeline: {
              id: "two-stage",
              stages: [
                {
                  id: "first",
                  entry: true,
                  system_prompt: "First",
                  model: MODEL,
                  ...REQUIRED_IO,
                  route: [{ to: "second" }],
                },
                { id: "second", system_prompt: "Second", model: MODEL, ...REQUIRED_IO },
              ],
            },
            task: { id: "t", goal: "g" },
          });
          expect(pipelineRun.isError).toBe(false);
          const pipelineRunId = pipelineRun.payload.runId as string;
          // Only the "first" stage needs a stored envelope to be
          // referenceable — don't require the whole run to finish.
          await waitFor(async () => {
            const detail = await store.readRun(pipelineRunId);
            return detail.stages.find((s) => s.stage_id === "first")?.status === "succeeded";
          });

          const standaloneRunId = await runAndWait(base, store, {
            stage: checkStage("picks-up", { system_prompt: "Pick up from that stage" }),
            envelope_ref: { runId: pipelineRunId, stageId: "first" },
          });
          const parsedTask = await readTask(store, standaloneRunId);
          expect(parsedTask.goal).toBe("from pipeline stage");
          expect(parsedTask.input).toEqual({ note: "hi" });
        },
      );
    });

    it("an unknown envelope reference fails with a 404-style error, matching get_envelope, as a bare ref or inside a multi-ref array", async () => {
      await withServer([emitOk()], async (base, store) => {
        const bare = await mcpCall(base, "run_stage", {
          stage: checkStage(),
          envelope_ref: { runId: "does-not-exist", stageId: "whatever" },
        });
        expect(bare.isError).toBe(true);
        expect(bare.payload.status).toBe(404);

        const researchRunId = await runAndWait(base, store, {
          stage: checkStage("research", { system_prompt: "Research" }),
          task: { id: "t1", goal: "research it" },
        });
        const runsBefore = await store.listRuns();
        const inArray = await mcpCall(base, "run_stage", {
          stage: checkStage(),
          envelope_ref: [
            { runId: researchRunId, stageId: "research" },
            { runId: "does-not-exist", stageId: "whatever" },
          ],
        });
        expect(inArray.isError).toBe(true);
        expect(inArray.payload.status).toBe(404);
        expect(await store.listRuns()).toHaveLength(runsBefore.length);
      });
    });

    it("checkout stays explicit and is never implied by an envelope reference", async () => {
      await withServer([emitOk(), emitOk("ok2")], async (base, store) => {
        const firstRunId = await runAndWait(base, store, {
          stage: checkStage("a", { system_prompt: "a" }),
          task: { id: "t", goal: "g", checkout: projectRoot },
        });
        expect((await store.readRunMeta(firstRunId)).checkout_root).toBe(projectRoot);

        const secondRunId = await runAndWait(base, store, {
          stage: checkStage("b", { system_prompt: "b" }),
          envelope_ref: { runId: firstRunId, stageId: "a" },
        });
        expect((await store.readRunMeta(secondRunId)).checkout_root).toBeUndefined();
      });
    });
  });

  describe("per-call model override", () => {
    function modelRecordingAgent(models: string[]): StagePort {
      const inner = scriptedFakeAgent([emitOk()]);
      return {
        openStage(input) {
          models.push(input.stage.model);
          return inner.openStage(input);
        },
        runStage: (input) => inner.runStage(input),
      };
    }

    it.each([
      { name: "an explicit override wins over the stage's declared model", override: MODEL, expected: MODEL },
      { name: "omitting the override falls back to the stage's declared model", override: undefined, expected: "cursor/auto" },
    ])("$name", async ({ override, expected }) => {
      const models: string[] = [];
      await withServer(modelRecordingAgent(models), async (base, store) => {
        await runAndWait(base, store, {
          stage: checkStage("check", { model: "cursor/auto" }),
          ...(override !== undefined ? { model: override } : {}),
          task: { id: "t", goal: "check" },
        });
      });
      expect(models).toEqual([expected]);
    });

    it("an invalid (empty) model override fails clearly instead of silently falling back to the stage default", async () => {
      // Stageflow doesn't validate model ids against a known allowlist at
      // load time (see parseModelField) — the one structurally-invalid value
      // is an empty/whitespace string, which stage.model validation rejects.
      await withServer([], async (base) => {
        const started = await mcpCall(base, "run_stage", {
          stage: checkStage(),
          model: "",
          task: { id: "t", goal: "check" },
        });
        expect(started.isError).toBe(true);
        expect(started.payload.error).toBe("Stage validation failed");
        expect(
          started.payload.validation.findings.some(
            (f: { code: string }) => f.code === "stage.invalid_model",
          ),
        ).toBe(true);
      });
    });
  });

  describe("reference-scoped artifact access", () => {
    it("a caller resolves a referenced envelope's artifact list, reads the bytes, and inlines them into the next call's input — using the existing get_envelope/read_artifact tools, no new tool needed", async () => {
      const artifactRelPath = path.join(
        "stages",
        "research",
        "attempts",
        "1",
        "artifacts",
        "findings.md",
      );
      const producingAgent: StagePort = {
        openStage(input) {
          return {
            stageId: input.stage.id,
            async next() {
              const absPath = path.join(input.roots.runWorkspaceDir, artifactRelPath);
              await mkdir(path.dirname(absPath), { recursive: true });
              await writeFile(absPath, "# Findings\n\nThree leads found.", "utf8");
              return {
                status: "completed",
                result: {
                  ok: true,
                  envelope: {
                    status: "success",
                    summary: "researched",
                    artifacts: [artifactRelPath],
                    payload: {},
                  },
                },
              };
            },
            deliverAnswer() {},
            async close() {},
          };
        },
        async runStage(input) {
          const handle = this.openStage(input);
          const event = await handle.next();
          if (event.status !== "completed") throw new Error("unexpected wait");
          return event.result;
        },
      };

      await withServer(producingAgent, async (base, store) => {
        const runId = await runAndWait(base, store, {
          stage: checkStage("research", { system_prompt: "Research" }),
          task: { id: "t", goal: "research it" },
        });

        // Caller resolves the reference: which artifacts does it declare?
        const envelopeResult = await mcpCall(base, "get_envelope", {
          runId,
          stageId: "research",
        });
        expect(envelopeResult.isError).toBe(false);
        expect(envelopeResult.payload.envelope.artifacts).toEqual([artifactRelPath]);

        // Caller reads the bytes via the existing artifact-read tool.
        const artifact = await mcpCall(base, "read_artifact", {
          runId,
          path: envelopeResult.payload.envelope.artifacts[0],
        });
        expect(artifact.isError).toBe(false);
        expect(artifact.payload.content).toContain("Three leads found.");

        // Caller inlines that content into the next call's typed input —
        // no automatic copying into a new workspace (ADR-0002).
        const summarizeRunId = await runAndWait(base, store, {
          stage: {
            id: "summarize",
            system_prompt: "Summarize the findings given in the input",
            model: MODEL,
            io: {
              input: {
                schema: {
                  type: "object",
                  properties: { findings: { type: "string" } },
                },
              },
              output: { schema: { type: "object" } },
            },
          },
          task: {
            id: "t2",
            goal: "summarize",
            input: { findings: artifact.payload.content },
          },
        });
        const summarizeTask = await readTask(store, summarizeRunId);
        expect(summarizeTask.input).toEqual({ findings: artifact.payload.content });
      });
    });
  });

  describe("multiple envelope references", () => {
    it("resolves an array of envelope_refs, namespacing each payload under its stageId", async () => {
      await withServer(
        [
          emitOk("found leads", { leads: ["a", "b"] }),
          emitOk("catchy title", { title: "Great Leads" }),
          emitOk("combined"),
        ],
        async (base, store) => {
          const researchRunId = await runAndWait(base, store, {
            stage: checkStage("research", { system_prompt: "Research" }),
            task: { id: "t1", goal: "research it" },
          });
          const titleizeRunId = await runAndWait(base, store, {
            stage: checkStage("titleize", { system_prompt: "Titleize" }),
            task: { id: "t2", goal: "titleize it" },
          });
          const combinedRunId = await runAndWait(base, store, {
            stage: checkStage("combine", { system_prompt: "Combine" }),
            envelope_ref: [
              { runId: researchRunId, stageId: "research" },
              { runId: titleizeRunId, stageId: "titleize" },
            ],
          });

          const parsedTask = await readTask(store, combinedRunId);
          expect(parsedTask.input).toEqual({
            research: { leads: ["a", "b"] },
            titleize: { title: "Great Leads" },
          });
          expect(parsedTask.goal).toContain("research: found leads");
          expect(parsedTask.goal).toContain("titleize: catchy title");
        },
      );
    });

    it("a single-item array behaves identically to a bare object envelope_ref (input = payload verbatim, not namespaced)", async () => {
      await withServer(
        [emitOk("found leads", { leads: ["a"] }), emitOk()],
        async (base, store) => {
          const researchRunId = await runAndWait(base, store, {
            stage: checkStage("research", { system_prompt: "Research" }),
            task: { id: "t1", goal: "research it" },
          });
          const nextRunId = await runAndWait(base, store, {
            stage: checkStage("next", { system_prompt: "Next" }),
            envelope_ref: [{ runId: researchRunId, stageId: "research" }],
          });

          const parsedTask = await readTask(store, nextRunId);
          expect(parsedTask.input).toEqual({ leads: ["a"] });
        },
      );
    });
  });
});
