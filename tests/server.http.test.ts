import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { startUiServer } from "../src/server/http.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import type { StageEnvelope } from "../src/types/envelope.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const freeTextPrompt: AskOperatorPrompt = {
  kind: "free_text",
  id: "prompt-1",
  message: "What should the module name be?",
};

const freeTextAnswer = {
  promptId: "prompt-1",
  kind: "free_text" as const,
  text: "payments",
};

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

async function withServer(
  root: string,
  agent: ReturnType<typeof scriptedFakeAgent> | Parameters<typeof startUiServer>[0]["agent"],
  store = createRunStore({ rootDir: root }),
  opts: { maxConcurrent?: number; cwd?: string; agentDir?: string; providerAuthContext?: Parameters<typeof startUiServer>[0]["providerAuthContext"] } = {},
) {
  const started = await startUiServer({
    agent,
    cwd: opts.cwd ?? fixtures,
    agentDir: opts.agentDir,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    maxConcurrent: opts.maxConcurrent,
    providerAuthContext: opts.providerAuthContext,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    ...started,
    store,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function waitUntilIdleHealth(base: string): Promise<void> {
  await waitFor(async () => {
    const health = await jsonFetch(`${base}/api/health`);
    return health.body.activeCount === 0;
  });
}

async function postRetry(
  base: string,
  runId: string,
  stageId: string,
  init?: RequestInit,
) {
  return jsonFetch(
    `${base}/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...init,
    },
  );
}

function okEnvelope(summary: string): StageEnvelope {
  return { status: "success", summary, artifacts: [] };
}

function failEnvelope(summary: string): StageEnvelope {
  return { status: "failure", summary, artifacts: [] };
}

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort {
  const stageIndex = new Map<string, number>();
  return {
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      const scripted = scriptedFakeAgent([behavior]);
      return scripted.openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

function parallelRetryFanoutAgent(): { agent: AgentPort; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agent = stageKeyedAgent({
    clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
    "design-doc": [
      { type: "emit", envelope: failEnvelope("design-fail") },
      { type: "emit", envelope: okEnvelope("design-retry") },
    ],
    "implementation-plan": [
      { type: "emit", envelope: failEnvelope("impl-fail") },
      { type: "emit", envelope: okEnvelope("impl-retry") },
    ],
    "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
  });
  let designOpens = 0;
  const baseOpenStage = agent.openStage.bind(agent);
  agent.openStage = (input) => {
    if (input.stage.id === "design-doc") {
      designOpens += 1;
      const handle = baseOpenStage(input);
      if (designOpens >= 2) {
        const baseNext = handle.next.bind(handle);
        handle.next = async () => {
          const event = await baseNext();
          if (event.status !== "waiting_for_input") {
            await gate;
          }
          return event;
        };
      }
      return handle;
    }
    return baseOpenStage(input);
  };
  return { agent, release };
}

function parallelFanoutStuckDesignAgent(): AgentPort {
  const stageIndex = new Map<string, number>();
  let designOpens = 0;

  return {
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;

      if (stageId === "design-doc") {
        designOpens += 1;
        if (designOpens === 1) {
          return createCompletedOnlyStageHandle({
            stageId,
            run: () => new Promise(() => {}),
          });
        }
      }

      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviorsByStage: Record<string, FakeAgentBehavior[]> = {
        clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
        "design-doc": [{ type: "emit", envelope: okEnvelope("design-retry") }],
        "implementation-plan": [
          { type: "emit", envelope: failEnvelope("impl-fail") },
          { type: "emit", envelope: okEnvelope("impl-retry") },
        ],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
      };
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      const scripted = scriptedFakeAgent([behavior]);
      return scripted.openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

async function postAbandon(
  base: string,
  runId: string,
  stageId: string,
  init?: RequestInit,
) {
  return jsonFetch(
    `${base}/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/abandon`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...init,
    },
  );
}

describe("localhost HTTP API", () => {
  it("lists stages with valid and broken rows, and lists models", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-stage-catalog-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-http-stage-cwd-"));
    await mkdir(path.join(cwd, "stages"), { recursive: true });
    await mkdir(path.join(cwd, "pipelines"), { recursive: true });
    await writeFile(
      path.join(cwd, "stages", "beta.yaml"),
      [
        "id: beta",
        "system_prompt: Beta prompt",
        "model: cursor/custom-z",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "alpha.yaml"),
      [
        "id: alpha",
        "gate_kinds:",
        "  - confirm",
        "system_prompt: Alpha prompt",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "broken.yaml"),
      [
        "id: broken",
        "gate_kinds: confirm",
        "system_prompt: Broken prompt",
        "model: cursor/custom-z",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(cwd, "pipelines", "uses-alpha.yaml"),
      ["id: uses-alpha", "stages:", "  - alpha", ""].join("\n"),
    );

    const { server, base } = await withServer(root, scriptedFakeAgent([]), undefined, { cwd });

    try {
      const stages = await jsonFetch(`${base}/api/stages`);
      expect(stages.status).toBe(200);
      expect(stages.body.stages).toEqual([
        {
          path: "stages/alpha.yaml",
          id: "alpha",
          gate_kinds: ["confirm"],
          used_by_pipeline_ids: ["uses-alpha"],
        },
        {
          path: "stages/beta.yaml",
          id: "beta",
          used_by_pipeline_ids: [],
        },
        {
          path: "stages/broken.yaml",
          error: expect.stringMatching(/gate_kinds must be an array of strings/),
          id: "broken",
          model: "cursor/custom-z",
        },
      ]);

      const models = await jsonFetch(`${base}/api/models`);
      expect(models.status).toBe(200);
      expect(models.body.models).toEqual([
        "anthropic/claude-sonnet-4-5",
        "cursor/auto",
        "cursor/composer-2-5",
        "cursor/custom-z",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST /api/stages creates stage YAML and rejects invalid or conflicting input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-post-stage-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-http-post-stage-cwd-"));
    await mkdir(path.join(cwd, "stages"), { recursive: true });
    await writeFile(
      path.join(cwd, "stages", "existing.yaml"),
      ["id: existing", "system_prompt: Existing.", "model: cursor/auto", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "alias.yaml"),
      ["id: taken-id", "system_prompt: Alias.", "model: cursor/auto", ""].join("\n"),
    );

    const { server, base } = await withServer(root, scriptedFakeAgent([]), undefined, { cwd });

    try {
      const created = await jsonFetch(`${base}/api/stages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "fresh-stage",
          system_prompt: "Line one\nLine two",
          model: "anthropic/claude-sonnet-4-5",
          gate_kinds: ["confirm"],
        }),
      });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        path: "stages/fresh-stage.yaml",
        id: "fresh-stage",
        gate_kinds: ["confirm"],
        used_by_pipeline_ids: [],
      });

      const written = await readFile(path.join(cwd, "stages", "fresh-stage.yaml"), "utf8");
      expect(written).toBe(
        [
          "id: fresh-stage",
          "gate_kinds:",
          "  - confirm",
          "system_prompt: |",
          "  Line one",
          "  Line two",
          "model: anthropic/claude-sonnet-4-5",
          "",
        ].join("\n"),
      );

      const pathCollision = await jsonFetch(`${base}/api/stages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "existing",
          system_prompt: "Again.",
          model: "cursor/auto",
        }),
      });
      expect(pathCollision.status).toBe(409);

      const yamlIdCollision = await jsonFetch(`${base}/api/stages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "taken-id",
          system_prompt: "Again.",
          model: "cursor/auto",
        }),
      });
      expect(yamlIdCollision.status).toBe(409);

      const invalid = await jsonFetch(`${base}/api/stages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "Bad",
          system_prompt: "x",
          model: "m",
          payload_schema: {},
        }),
      });
      expect(invalid.status).toBe(400);

      const forbiddenOrigin = await jsonFetch(`${base}/api/stages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          id: "blocked",
          system_prompt: "x",
          model: "m",
        }),
      });
      expect(forbiddenOrigin.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST /api/pipelines creates pipeline YAML and rejects invalid or conflicting input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-post-pipeline-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-http-post-pipeline-cwd-"));
    await mkdir(path.join(cwd, "stages"), { recursive: true });
    await mkdir(path.join(cwd, "pipelines"), { recursive: true });
    await writeFile(
      path.join(cwd, "stages", "alpha.yaml"),
      ["id: alpha", "system_prompt: Alpha.", "model: cursor/auto", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "beta.yaml"),
      [
        "id: beta",
        "gate_kinds:",
        "  - confirm",
        "system_prompt: Beta.",
        "model: cursor/auto",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "recon.yaml"),
      ["id: recon", "system_prompt: Recon.", "model: cursor/auto", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "improve-a.yaml"),
      ["id: improve-a", "system_prompt: Improve A.", "model: cursor/auto", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "improve-b.yaml"),
      ["id: improve-b", "system_prompt: Improve B.", "model: cursor/auto", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "stages", "improve-c.yaml"),
      ["id: improve-c", "system_prompt: Improve C.", "model: cursor/auto", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "pipelines", "existing.yaml"),
      ["id: existing", "stages:", "  - alpha", ""].join("\n"),
    );
    await writeFile(
      path.join(cwd, "pipelines", "alias.yaml"),
      ["id: taken-id", "stages:", "  - alpha", ""].join("\n"),
    );

    const { server, base } = await withServer(root, scriptedFakeAgent([]), undefined, { cwd });

    try {
      const created = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "fresh-pipeline",
          stages: ["alpha", "beta"],
        }),
      });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        path: "pipelines/fresh-pipeline.yaml",
        id: "fresh-pipeline",
        stages: [{ id: "alpha" }, { id: "beta", gate_kinds: ["confirm"] }],
      });

      const written = await readFile(path.join(cwd, "pipelines", "fresh-pipeline.yaml"), "utf8");
      expect(written).toBe(
        ["id: fresh-pipeline", "stages:", "  - alpha", "  - beta", ""].join("\n"),
      );

      const pathCollision = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "existing",
          stages: ["alpha"],
        }),
      });
      expect(pathCollision.status).toBe(409);

      const yamlIdCollision = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "taken-id",
          stages: ["alpha"],
        }),
      });
      expect(yamlIdCollision.status).toBe(409);

      const duplicateStages = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "dup",
          stages: ["alpha", "alpha"],
        }),
      });
      expect(duplicateStages.status).toBe(422);

      const missingStage = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "missing-ref",
          stages: ["alpha", "gone"],
        }),
      });
      expect(missingStage.status).toBe(422);
      expect(missingStage.body.error).toBe("one or more selected Stages no longer exist");

      const dagCreated = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "recon-review",
          stages: [
            { id: "recon" },
            { id: "improve-a", needs: "recon" },
            { id: "improve-b", needs: "recon" },
            { id: "improve-c", needs: "recon" },
          ],
        }),
      });
      expect(dagCreated.status).toBe(201);
      expect(dagCreated.body).toEqual({
        path: "pipelines/recon-review.yaml",
        id: "recon-review",
        stages: [
          { id: "recon" },
          { id: "improve-a" },
          { id: "improve-b" },
          { id: "improve-c" },
        ],
      });

      const dagYaml = await readFile(path.join(cwd, "pipelines", "recon-review.yaml"), "utf8");
      expect(dagYaml).toBe(
        [
          "id: recon-review",
          "stages:",
          "  - id: recon",
          "  - id: improve-a",
          "    needs: recon",
          "  - id: improve-b",
          "    needs: recon",
          "  - id: improve-c",
          "    needs: recon",
          "",
        ].join("\n"),
      );

      const cycle = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cycle-pipeline",
          stages: [{ id: "alpha", needs: "beta" }, { id: "beta", needs: "alpha" }],
        }),
      });
      expect(cycle.status).toBe(422);
      expect(cycle.body.error).toContain("dependency cycle detected");
      await expect(
        access(path.join(cwd, "pipelines", "cycle-pipeline.yaml")),
      ).rejects.toThrow();

      const invalid = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "Bad",
          stages: [],
        }),
      });
      expect(invalid.status).toBe(400);

      const forbiddenOrigin = await jsonFetch(`${base}/api/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          id: "blocked",
          stages: ["alpha"],
        }),
      });
      expect(forbiddenOrigin.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("lists runs, returns detail, starts and re-runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-"));
    const store = createRunStore({ rootDir: root });
    await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: existing\ngoal: prior\n",
      taskId: "existing",
    });

    const agent = scriptedFakeAgent(
      Array.from({ length: 12 }, (_, i) => ({
        type: "emit" as const,
        envelope: { status: "success" as const, summary: `s${i}`, artifacts: [] },
      })),
    );

    const { server, url, base } = await withServer(root, agent, store);

    try {
      const listed = await jsonFetch(`${base}/api/runs`);
      expect(listed.status).toBe(200);
      expect(listed.body.runs.length).toBeGreaterThanOrEqual(1);

      const runId = listed.body.runs[0].run_id as string;
      const detail = await jsonFetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
      expect(detail.status).toBe(200);
      expect(detail.body.pipeline_id).toBe("docs-only");

      const tasks = await jsonFetch(`${base}/api/tasks`);
      expect(tasks.status).toBe(200);
      expect(tasks.body.tasks.length).toBeGreaterThan(0);

      const pipelines = await jsonFetch(`${base}/api/pipelines`);
      expect(pipelines.status).toBe(200);
      expect(pipelines.body.pipelines.some((p: { id: string }) => p.id === "docs-only")).toBe(
        true,
      );
      const proving = pipelines.body.pipelines.find(
        (p: { id: string }) => p.id === "plan-review-proving",
      );
      expect(proving?.stages).toEqual([
        { id: "plan-review", gate_kinds: ["artifact_backed"] },
        { id: "plan-review-followup" },
      ]);
      const fourKinds = pipelines.body.pipelines.find(
        (p: { id: string }) => p.id === "hitl-four-kinds-proving",
      );
      expect(fourKinds?.stages).toEqual([
        {
          id: "hitl-four-kinds",
          gate_kinds: [
            "free_text",
            "confirm",
            "multi_question",
            "artifact_backed",
          ],
        },
      ]);

      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "docs-only",
        }),
      });
      expect(started.status).toBe(202);
      expect(started.body.runId).toBeTruthy();

      await waitUntilIdleHealth(base);

      const rerun = await jsonFetch(`${base}/api/runs/${encodeURIComponent(runId)}/rerun`, {
        method: "POST",
      });
      expect(rerun.status).toBe(202);
      expect(rerun.body.runId).not.toBe(runId);

      await waitUntilIdleHealth(base);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    void url;
  });

  it("POST answer delivers T2 free_text into waiting stage (202)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-ans-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
    ]);
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "single",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "waiting_for_input"
        );
      });

      const listedWhileWaiting = await jsonFetch(`${base}/api/runs`);
      expect(listedWhileWaiting.status).toBe(200);
      const waitingRow = listedWhileWaiting.body.runs.find(
        (r: { run_id: string }) => r.run_id === runId,
      );
      expect(waitingRow?.waiting_stage_id).toBe("clarify");
      expect(waitingRow?.waiting_summary).toBe(
        "What should the module name be?",
      );
      expect(waitingRow?.waiting_kind).toBe("free_text");
      expect(waitingRow?.waiting_prompt_id).toBe("prompt-1");
      expect(waitingRow?.stages).toEqual([
        { id: "clarify", status: "waiting_for_input", attempt_count: 1 },
      ]);

      const waitingDetail = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}`,
      );
      expect(waitingDetail.status).toBe(200);
      expect(waitingDetail.body.status).toBe("running");
      expect(waitingDetail.body.waiting_stage_id).toBe("clarify");
      expect(waitingDetail.body.waiting_summary).toBe(
        "What should the module name be?",
      );
      expect(waitingDetail.body.waiting_kind).toBe("free_text");
      expect(waitingDetail.body.waiting_prompt_id).toBe("prompt-1");

      const answered = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/clarify/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(freeTextAnswer),
        },
      );
      expect(answered.status).toBe(202);
      expect(answered.body).toEqual({ ok: true });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const after = await store.readRun(runId);
      expect(
        after.stages.find((s) => s.stage_id === "clarify")?.status,
      ).toBe("succeeded");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET list/detail expose waiting_stage_ids during dual sibling wait", async () => {
    const promptA: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-a",
      message: "Question for branch A?",
    };
    const promptB: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-b",
      message: "Question for branch B?",
    };
    const answerA = {
      promptId: "prompt-a",
      kind: "free_text" as const,
      text: "answer-a",
    };
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-mw-"));
    const clarifyAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "ancestor",
          artifacts: [],
        },
      },
    ]);
    const branchAAgent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [promptA],
        envelope: {
          status: "success",
          summary: "branch-a",
          artifacts: [],
        },
      },
    ]);
    const branchBAgent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [promptB],
        envelope: {
          status: "success",
          summary: "branch-b",
          artifacts: [],
        },
      },
    ]);
    const branchCAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "branch-c",
          artifacts: [],
        },
      },
    ]);
    const agent = {
      openStage(input: Parameters<typeof clarifyAgent.openStage>[0]) {
        if (input.stage.id === "clarify") return clarifyAgent.openStage(input);
        if (input.stage.id === "branch-a") return branchAAgent.openStage(input);
        if (input.stage.id === "branch-b") return branchBAgent.openStage(input);
        if (input.stage.id === "branch-c") return branchCAgent.openStage(input);
        return clarifyAgent.openStage(input);
      },
      runStage(input: Parameters<typeof clarifyAgent.runStage>[0]) {
        const handle = agent.openStage(input);
        return (async () => {
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false as const, reason: "wait" };
          }
          return event.result;
        })();
      },
    };
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "parallel-hitl-multi-wait",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        const a = detail.stages.find((s) => s.stage_id === "branch-a");
        const b = detail.stages.find((s) => s.stage_id === "branch-b");
        return a?.status === "waiting_for_input" && b?.status === "waiting_for_input";
      });

      const listedWhileWaiting = await jsonFetch(`${base}/api/runs`);
      const waitingRow = listedWhileWaiting.body.runs.find(
        (r: { run_id: string }) => r.run_id === runId,
      );
      expect(waitingRow?.waiting_stage_ids).toEqual(["branch-a", "branch-b"]);
      expect(waitingRow?.waiting_stage_id).toBe("branch-a");
      expect(waitingRow?.stages).toEqual(
        expect.arrayContaining([
          { id: "branch-a", status: "waiting_for_input", attempt_count: 1 },
          { id: "branch-b", status: "waiting_for_input", attempt_count: 1 },
        ]),
      );

      const waitingDetail = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}`,
      );
      expect(waitingDetail.body.waiting_stage_ids).toEqual([
        "branch-a",
        "branch-b",
      ]);

      const answered = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/branch-a/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(answerA),
        },
      );
      expect(answered.status).toBe(202);

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return (
          detail.stages.find((s) => s.stage_id === "branch-a")?.status ===
          "succeeded"
        );
      });

      const afterPartial = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}`,
      );
      expect(
        afterPartial.body.stages.find(
          (s: { stage_id: string }) => s.stage_id === "branch-b",
        )?.status,
      ).toBe("waiting_for_input");
      expect(afterPartial.body.waiting_stage_ids).toEqual(["branch-b"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET run detail exposes pipeline_track during fan-out mid-run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-track-"));
    let releaseImproves: () => void = () => undefined;
    const improveGate = new Promise<void>((resolve) => {
      releaseImproves = resolve;
    });
    const reconAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "recon complete",
          artifacts: [],
        },
      },
    ]);
    const agent = {
      openStage(input: Parameters<typeof reconAgent.openStage>[0]) {
        if (input.stage.id === "recon") return reconAgent.openStage(input);
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            await improveGate;
            return {
              ok: true as const,
              envelope: {
                status: "success" as const,
                summary: `${input.stage.id} done`,
                artifacts: [],
              },
            };
          },
        });
      },
      runStage(input: Parameters<typeof reconAgent.runStage>[0]) {
        const handle = agent.openStage(input);
        return (async () => {
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false as const, reason: "wait" };
          }
          return event.result;
        })();
      },
    };
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "parallel-track-fanout",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        const improves = ["improve-a", "improve-b", "improve-c"].map((id) =>
          detail.stages.find((s) => s.stage_id === id),
        );
        return (
          detail.stages.find((s) => s.stage_id === "recon")?.status ===
            "succeeded" &&
          improves.every((s) => s?.status === "running")
        );
      });

      const midDetail = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}`,
      );
      expect(midDetail.status).toBe(200);
      const track = midDetail.body.pipeline_track;
      expect(track.nodes.find((n: { stage_id: string }) => n.stage_id === "recon")?.layer).toBe(0);
      const siblings = track.nodes.filter((n: { stage_id: string }) =>
        ["improve-a", "improve-b", "improve-c"].includes(n.stage_id),
      );
      expect(siblings).toHaveLength(3);
      expect(siblings.every((n: { layer: number }) => n.layer === 1)).toBe(true);
      expect(siblings.every((n: { status: string }) => n.status === "running")).toBe(
        true,
      );
      expect(track.edges).toEqual(
        expect.arrayContaining([
          {
            from: "recon",
            to: "improve-a",
            envelope_summary: "recon complete",
          },
        ]),
      );

      const listed = await jsonFetch(`${base}/api/runs`);
      const row = listed.body.runs.find(
        (r: { run_id: string }) => r.run_id === runId,
      );
      expect(row?.pipeline_track).toBeUndefined();

      releaseImproves();
      await waitUntilIdleHealth(base);
    } finally {
      releaseImproves();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET /api/runs includes compact stages and failed fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-list-fail-"));
    const { server, base, store } = await withServer(
      root,
      scriptedFakeAgent([]),
    );

    try {
      const created = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: fail\n",
        taskId: "t",
      });
      await store.appendStageEvent(created.runId, "clarify", { event: "started" });
      await store.appendStageEvent(created.runId, "verify", { event: "started" });
      await store.appendStageEvent(created.runId, "verify", {
        event: "failed",
        reason: "envelope payload failed schema",
      });

      const listed = await jsonFetch(`${base}/api/runs`);
      expect(listed.status).toBe(200);
      const row = listed.body.runs.find(
        (r: { run_id: string }) => r.run_id === created.runId,
      );
      expect(row?.status).toBe("failed");
      expect(row?.failed_stage_id).toBe("verify");
      expect(row?.failed_reason).toBe("envelope payload failed schema");
      expect(row?.waiting_stage_id).toBeUndefined();
      expect(row?.stages).toEqual([
        { id: "clarify", status: "running", attempt_count: 1 },
        { id: "verify", status: "failed", attempt_count: 1 },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST answer delivers T2 confirm into waiting stage (202)", async () => {
    const confirmPrompt: AskOperatorPrompt = {
      kind: "confirm",
      id: "confirm-proceed",
      message: "Proceed with the plan?",
    };
    const confirmAnswer = {
      promptId: "confirm-proceed",
      kind: "confirm" as const,
      decision: "accept" as const,
    };
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-confirm-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [confirmPrompt],
        envelope: {
          status: "success",
          summary: "confirm-ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "single",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "waiting_for_input"
        );
      });

      const answered = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/clarify/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(confirmAnswer),
        },
      );
      expect(answered.status).toBe(202);
      expect(answered.body).toEqual({ ok: true });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST answer delivers T2 multi_question into waiting stage (202)", async () => {
    const multiPrompt: AskOperatorPrompt = {
      kind: "multi_question",
      id: "ae3-clarifications",
      questions: [
        {
          id: "q-module",
          kind: "free_text",
          message: "What is the module name?",
        },
        {
          id: "q-owner",
          kind: "free_text",
          message: "Who owns this module?",
        },
      ],
    };
    const multiAnswer = {
      promptId: "ae3-clarifications",
      kind: "multi_question" as const,
      answers: {
        "q-module": { kind: "free_text" as const, text: "payments" },
        "q-owner": { kind: "free_text" as const, text: "platform-team" },
      },
    };
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-multi-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [multiPrompt],
        envelope: {
          status: "success",
          summary: "multi-ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "single",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "waiting_for_input"
        );
      });

      const answered = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/clarify/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(multiAnswer),
        },
      );
      expect(answered.status).toBe(202);
      expect(answered.body).toEqual({ ok: true });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST answer returns 409 when stage is not waiting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-409-"));
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
    ]);
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "single",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const answered = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/clarify/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(freeTextAnswer),
        },
      );
      expect(answered.status).toBe(409);
      expect(answered.body.error).toMatch(/not waiting/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST answer returns 400 for malformed or mismatched T2 body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-400-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
        },
      },
    ]);
    const { server, base, store } = await withServer(root, agent);

    try {
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.yaml",
          pipeline: "single",
        }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "waiting_for_input"
        );
      });

      const malformed = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/clarify/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "free_text", text: "no promptId" }),
        },
      );
      expect(malformed.status).toBe(400);

      const mismatched = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(runId)}/stages/clarify/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptId: "prompt-1",
            kind: "confirm",
            decision: "accept",
          }),
        },
      );
      expect(mismatched.status).toBe(400);

      const stillWaiting = await store.readRun(runId);
      expect(
        stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
      ).toBe("waiting_for_input");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST answer is gated by loopback Host/Origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-gate-"));
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base } = await withServer(root, agent);

    try {
      const forbiddenOrigin = await jsonFetch(
        `${base}/api/runs/r1/stages/clarify/answer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: JSON.stringify(freeTextAnswer),
        },
      );
      expect(forbiddenOrigin.status).toBe(403);
      expect(forbiddenOrigin.body.error).toMatch(/origin|host/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET /api/health exposes multi-active capacity (not exclusive inFlight)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-health-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "a-ok",
          artifacts: [],
        },
      },
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "b-ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base } = await withServer(root, agent, undefined, {
      maxConcurrent: 2,
    });

    try {
      const idle = await jsonFetch(`${base}/api/health`);
      expect(idle.status).toBe(200);
      expect(idle.body).toEqual({
        ok: true,
        activeRunIds: [],
        activeCount: 0,
        maxConcurrent: 2,
        slotsAvailable: 2,
        activeStageProcesses: 0,
        maxActiveStageProcesses: null,
      });
      expect(idle.body).not.toHaveProperty("inFlight");

      const first = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "single",
          task: { id: "a", goal: "first" },
        }),
      });
      const second = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "single",
          task: { id: "b", goal: "second" },
        }),
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const runA = first.body.runId as string;
      const runB = second.body.runId as string;

      await waitFor(async () => {
        const health = await jsonFetch(`${base}/api/health`);
        return (
          health.body.activeCount === 2 &&
          Array.isArray(health.body.activeRunIds) &&
          health.body.activeRunIds.includes(runA) &&
          health.body.activeRunIds.includes(runB)
        );
      });

      const busy = await jsonFetch(`${base}/api/health`);
      expect(busy.body).toMatchObject({
        ok: true,
        activeCount: 2,
        maxConcurrent: 2,
        slotsAvailable: 0,
      });
      expect(busy.body.activeRunIds).toEqual(
        expect.arrayContaining([runA, runB]),
      );
      expect(busy.body.activeRunIds).toHaveLength(2);
      expect(busy.body).not.toHaveProperty("inFlight");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST /api/runs returns structured busy_capacity vs busy_checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-busy-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-http-co-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "hold",
          artifacts: [],
        },
      },
    ]);
    const { server, base } = await withServer(root, agent, undefined, {
      maxConcurrent: 1,
    });

    try {
      const first = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "single",
          task: { id: "holder", goal: "hold slot", checkout },
        }),
      });
      expect(first.status).toBe(202);
      const holderId = first.body.runId as string;

      await waitFor(async () => {
        const health = await jsonFetch(`${base}/api/health`);
        return health.body.activeRunIds?.includes(holderId);
      });

      const capacity = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "single",
          task: { id: "cap", goal: "over max" },
        }),
      });
      expect(capacity.status).toBe(409);
      expect(capacity.body.code).toBe("busy_capacity");
      expect(capacity.body.error).toBeTruthy();
      expect(capacity.body.activeCount).toBe(1);
      expect(capacity.body.maxConcurrent).toBe(1);
      expect(capacity.body.activeRunIds).toEqual([holderId]);
      expect(capacity.body).not.toHaveProperty("conflictingRunId");

      const otherRoot = await mkdtemp(path.join(tmpdir(), "sf-http-busy2-"));
      const otherAgent = scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [freeTextPrompt],
          envelope: {
            status: "success",
            summary: "hold2",
            artifacts: [],
          },
        },
      ]);
      const other = await withServer(otherRoot, otherAgent, undefined, {
        maxConcurrent: 3,
      });
      try {
        const bound = await jsonFetch(`${other.base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipeline: "single",
            task: { id: "a", goal: "first", checkout },
          }),
        });
        expect(bound.status).toBe(202);
        const conflictId = bound.body.runId as string;
        await waitFor(async () => {
          const health = await jsonFetch(`${other.base}/api/health`);
          return health.body.activeRunIds?.includes(conflictId);
        });

        const checkoutBusy = await jsonFetch(`${other.base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipeline: "single",
            task: { id: "b", goal: "same checkout", checkout },
          }),
        });
        expect(checkoutBusy.status).toBe(409);
        expect(checkoutBusy.body.code).toBe("busy_checkout");
        expect(checkoutBusy.body.conflictingRunId).toBe(conflictId);
        expect(checkoutBusy.body.conflictingCheckout).toBeTruthy();
        expect(checkoutBusy.body.activeRunIds).toEqual([conflictId]);
        expect(checkoutBusy.body.maxConcurrent).toBe(3);
      } finally {
        await new Promise<void>((resolve, reject) => {
          other.server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET artifact returns UTF-8 text; rejects escape and missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-art-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join("stages", "clarify", "attempts", "1", "artifacts", "note.txt");
    await mkdir(
      path.join(created.workspaceDir, "stages", "clarify", "attempts", "1", "artifacts"),
      { recursive: true },
    );
    await writeFile(
      path.join(created.workspaceDir, rel),
      "hello artifact",
      "utf8",
    );

    const agent = scriptedFakeAgent([]);
    const { server, base } = await withServer(root, agent, store);

    try {
      const ok = await fetch(
        `${base}/api/runs/${encodeURIComponent(created.runId)}/artifact?path=${encodeURIComponent(rel)}`,
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/text\/plain/);
      expect(await ok.text()).toBe("hello artifact");

      const escaped = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(created.runId)}/artifact?path=${encodeURIComponent("../outside.txt")}`,
      );
      expect(escaped.status).toBe(400);

      const missing = await jsonFetch(
        `${base}/api/runs/${encodeURIComponent(created.runId)}/artifact?path=${encodeURIComponent("stages/clarify/attempts/1/artifacts/nope.txt")}`,
      );
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST /api/settings updates maxConcurrent, persists, and 400s invalid bodies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-settings-"));
    const { server, base } = await withServer(
      root,
      scriptedFakeAgent([]),
      undefined,
      { maxConcurrent: 2, cwd: root },
    );

    try {
      const raised = await jsonFetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: 4 }),
      });
      expect(raised.status).toBe(200);
      expect(raised.body).toMatchObject({
        ok: true,
        maxConcurrent: 4,
        activeCount: 0,
        slotsAvailable: 4,
      });

      const health = await jsonFetch(`${base}/api/health`);
      expect(health.body.maxConcurrent).toBe(4);

      const persisted = JSON.parse(
        await readFile(path.join(storeRootFor(root), "settings.json"), "utf8"),
      ) as { maxConcurrent: number };
      expect(persisted.maxConcurrent).toBe(4);

      const invalid = await jsonFetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: 0 }),
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toMatch(/integer/i);

      const missing = await jsonFetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("POST /api/settings lowering the cap does not evict active runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-settings-lower-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "hold",
          artifacts: [],
        },
      },
    ]);
    const { server, base } = await withServer(root, agent, undefined, {
      maxConcurrent: 2,
    });

    try {
      const first = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "single",
          task: { id: "holder", goal: "hold slot" },
        }),
      });
      expect(first.status).toBe(202);
      const runId = first.body.runId as string;

      await waitFor(async () => {
        const health = await jsonFetch(`${base}/api/health`);
        return health.body.activeCount === 1 && health.body.activeRunIds.includes(runId);
      });

      const lowered = await jsonFetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: 1 }),
      });
      expect(lowered.status).toBe(200);
      expect(lowered.body).toMatchObject({
        maxConcurrent: 1,
        activeCount: 1,
        slotsAvailable: 0,
      });
      expect(lowered.body.activeRunIds).toEqual([runId]);

      await waitFor(async () => {
        const detail = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(runId)}`,
        );
        return (
          detail.status === 200 &&
          detail.body.stages.some(
            (s: { status: string }) => s.status === "waiting_for_input",
          )
        );
      });
      const stillWaiting = await jsonFetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
      expect(stillWaiting.status).toBe(200);
      expect(
        stillWaiting.body.stages.some(
          (s: { status: string }) => s.status === "waiting_for_input",
        ),
      ).toBe(true);

      const over = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: "single",
          task: { id: "blocked", goal: "should 409" },
        }),
      });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe("busy_capacity");
    } finally {
      await rm(path.join(storeRootFor(fixtures), "settings.json"), { force: true });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("GET /api/health reads maxConcurrent from settings.json when not injected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-settings-boot-"));
    await mkdir(storeRootFor(root), { recursive: true });
    await writeFile(
      path.join(storeRootFor(root), "settings.json"),
      `${JSON.stringify({ maxConcurrent: 6 }, null, 2)}\n`,
    );
    const { server, base } = await withServer(
      root,
      scriptedFakeAgent([]),
      undefined,
      { cwd: root },
    );

    try {
      const health = await jsonFetch(`${base}/api/health`);
      expect(health.status).toBe(200);
      expect(health.body.maxConcurrent).toBe(6);
      expect(health.body.slotsAvailable).toBe(6);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("lists Pi extensions from injected agentDir and cwd", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(path.join(tmpdir(), "sf-http-ext-home-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-http-ext-cwd-"));
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-ext-root-"));
    const agentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;

    try {
      const extDir = path.join(agentDir, "extensions");
      await mkdir(extDir, { recursive: true });
      await writeFile(
        path.join(extDir, "http-fixture-ext.ts"),
        "export default function () {}\n",
        "utf8",
      );
      const pkgDir = path.join(home, "http-local-pkg");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "sf-http-fixture-pkg",
          pi: { extensions: ["hello.ts"] },
        }),
        "utf8",
      );
      await writeFile(
        path.join(pkgDir, "hello.ts"),
        "export default function () {}\n",
        "utf8",
      );
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: [pkgDir] }),
        "utf8",
      );

      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        createRunStore({ rootDir: root }),
        { cwd, agentDir },
      );

      try {
        const listed = await jsonFetch(`${base}/api/extensions`);
        expect(listed.status).toBe(200);
        const names = (
          listed.body.extensions as { name: string }[]
        ).map((e) => e.name);
        expect(names).toContain("http-fixture-ext");
        const sources = (
          listed.body.packages as { source: string }[]
        ).map((p) => p.source);
        expect(sources).toContain(pkgDir);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("lists Pi skills from injected agentDir and cwd", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(path.join(tmpdir(), "sf-http-skills-home-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-http-skills-cwd-"));
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-skills-root-"));
    const agentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;

    try {
      const skillDir = path.join(agentDir, "skills", "http-fixture-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: http-fixture-skill\ndescription: HTTP catalog fixture.\n---\n# Fixture\n",
        "utf8",
      );

      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        createRunStore({ rootDir: root }),
        { cwd, agentDir },
      );

      try {
        const listed = await jsonFetch(`${base}/api/skills`);
        expect(listed.status).toBe(200);
        const names = (listed.body.skills as { name: string }[]).map((s) => s.name);
        expect(names).toContain("http-fixture-skill");
        expect(listed.body.diagnostics).toEqual(expect.any(Array));
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  describe("POST stage retry", () => {
    it("returns 202 with same runId and attemptIndex on successful retry (AE1)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-ok-"));
      const agent = scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "failure", summary: "design-fail", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "design-ok-retry", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "plan-ok", artifacts: [] },
        },
      ]);
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        expect(started.status).toBe(202);
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const failedDetail = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(runId)}`,
        );
        const designBefore = failedDetail.body.stages.find(
          (s: { stage_id: string }) => s.stage_id === "design-doc",
        );
        expect(designBefore?.attempt_count).toBe(1);

        const retried = await postRetry(base, runId, "design-doc");
        expect(retried.status).toBe(202);
        expect(retried.body).toEqual({
          runId,
          stageId: "design-doc",
          attemptIndex: 2,
        });

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "succeeded";
        });

        const detail = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(runId)}`,
        );
        const design = detail.body.stages.find(
          (s: { stage_id: string }) => s.stage_id === "design-doc",
        );
        expect(design?.status).toBe("succeeded");
        expect(design?.attempt_count).toBe(2);

        const trackNode = detail.body.pipeline_track.nodes.find(
          (n: { stage_id: string }) => n.stage_id === "design-doc",
        );
        expect(trackNode?.attempt_count).toBe(2);

        const listed = await jsonFetch(`${base}/api/runs`);
        const row = listed.body.runs.find(
          (r: { run_id: string }) => r.run_id === runId,
        );
        const compactDesign = row?.stages.find(
          (s: { id: string }) => s.id === "design-doc",
        );
        expect(compactDesign?.attempt_count).toBe(2);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns failed run with attempt_count 2 when retry fails again (AE2)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-fail-"));
      const agent = scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "failure", summary: "design-fail-1", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "failure", summary: "design-fail-2", artifacts: [] },
        },
      ]);
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const retried = await postRetry(base, runId, "design-doc");
        expect(retried.status).toBe(202);
        expect(retried.body.attemptIndex).toBe(2);

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const detail = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(runId)}`,
        );
        const design = detail.body.stages.find(
          (s: { stage_id: string }) => s.stage_id === "design-doc",
        );
        expect(design?.status).toBe("failed");
        expect(design?.attempt_count).toBe(2);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns 409 stage_not_failed for succeeded stage on failed run (AE3)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-succ-"));
      const agent = scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "failure", summary: "design-fail", artifacts: [] },
        },
      ]);
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const retried = await postRetry(base, runId, "clarify");
        expect(retried.status).toBe(409);
        expect(retried.body.code).toBe("stage_not_failed");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns 409 hitl_not_retriable for waiting stage (AE3)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-hitl-"));
      const agent = scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [freeTextPrompt],
          envelope: {
            status: "success",
            summary: "clarify-ok",
            artifacts: [],
          },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "design-ok", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "plan-ok", artifacts: [] },
        },
      ]);
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.stages.some((s) => s.status === "waiting_for_input");
        });

        const retried = await postRetry(base, runId, "clarify");
        expect(retried.status).toBe(409);
        expect(retried.body.code).toBe("hitl_not_retriable");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns 409 run_not_retryable while run is active (AE6)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-run-"));
      const agent = {
        openStage(input: { stage: { id: string } }) {
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: () => new Promise(() => {}),
          });
        },
        async runStage(input: { stage: { id: string } }) {
          const handle = this.openStage(input);
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false, reason: "wait" };
          }
          return event.result;
        },
      };
      const { server, base } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const health = await jsonFetch(`${base}/api/health`);
          return health.body.activeCount > 0;
        });

        const retried = await postRetry(base, runId, "clarify");
        expect(retried.status).toBe(409);
        expect(retried.body.code).toBe("run_not_retryable");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns 404 for unknown run or stage", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-404-"));
      const { server, base } = await withServer(root, scriptedFakeAgent([]));

      try {
        const missingRun = await postRetry(base, "missing-run", "design-doc");
        expect(missingRun.status).toBe(404);

        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;
        await waitUntilIdleHealth(base);

        const missingStage = await postRetry(base, runId, "no-such-stage");
        expect(missingStage.status).toBe(404);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns 409 retry_in_progress for duplicate POST (AE5)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-dup-"));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let designOpens = 0;

      const agent = {
        openStage(input: { stage: { id: string } }) {
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: async () => {
              if (input.stage.id === "design-doc") {
                designOpens += 1;
                if (designOpens === 1) {
                  return { ok: false as const, reason: "fail" };
                }
                await gate;
              }
              return {
                ok: true as const,
                envelope: {
                  status: "success" as const,
                  summary: input.stage.id,
                  artifacts: [],
                },
              };
            },
          });
        },
        async runStage(input: { stage: { id: string } }) {
          const handle = this.openStage(input);
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false, reason: "wait" };
          }
          return event.result;
        },
      };

      const { server, base, store, manager } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const first = manager.retryStage(runId, "design-doc");
        const second = await postRetry(base, runId, "design-doc");
        expect(second.status).toBe(409);
        expect(second.body.code).toBe("retry_in_progress");

        release();
        const firstResult = await first;
        expect(firstResult.ok).toBe(true);
        await waitUntilIdleHealth(base);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("accepts concurrent retry on different failed stages while recovery running (AE1b)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-ae1b-"));
      const { agent, release } = parallelRetryFanoutAgent();
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "parallel-retry-fanout",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const detail = await store.readRun(runId);
          const design = detail.stages.find((s) => s.stage_id === "design-doc");
          const impl = detail.stages.find(
            (s) => s.stage_id === "implementation-plan",
          );
          return design?.status === "failed" && impl?.status === "failed";
        });

        const first = postRetry(base, runId, "design-doc");
        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "running";
        });

        const second = await postRetry(base, runId, "implementation-plan");
        expect(second.status).toBe(202);
        expect(second.body.attemptIndex).toBe(2);

        const duplicate = await postRetry(base, runId, "design-doc");
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.code).toBe("retry_in_progress");

        release();
        const firstResult = await first;
        expect(firstResult.status).toBe(202);
        await waitUntilIdleHealth(base);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }, 15000);

    it("accepts retry on failed stage during recovery running (AE4b)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-ae4b-"));
      const { agent, release } = parallelRetryFanoutAgent();
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "parallel-retry-fanout",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const detail = await store.readRun(runId);
          const design = detail.stages.find((s) => s.stage_id === "design-doc");
          const impl = detail.stages.find(
            (s) => s.stage_id === "implementation-plan",
          );
          return design?.status === "failed" && impl?.status === "failed";
        });

        const first = postRetry(base, runId, "design-doc");
        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "running";
        });

        const second = await postRetry(base, runId, "implementation-plan");
        expect(second.status).toBe(202);
        expect(second.body.code).toBeUndefined();

        release();
        const firstResult = await first;
        expect(firstResult.status).toBe(202);
        await waitUntilIdleHealth(base);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }, 15000);

    it("POST rerun still returns a new runId (AE4 / R12)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-rerun-"));
      const agent = scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "failure", summary: "design-fail", artifacts: [] },
        },
      ]);
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "linear-explicit",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const rerun = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(runId)}/rerun`,
          { method: "POST" },
        );
        expect(rerun.status).toBe(202);
        expect(rerun.body.runId).not.toBe(runId);
        await waitUntilIdleHealth(base);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("POST retry is gated by loopback Host/Origin", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-retry-gate-"));
      const { server, base } = await withServer(root, scriptedFakeAgent([]));

      try {
        const forbiddenOrigin = await postRetry(base, "r1", "design-doc", {
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
        });
        expect(forbiddenOrigin.status).toBe(403);
        expect(forbiddenOrigin.body.error).toMatch(/origin|host/i);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  describe("POST stage abandon", () => {
    it("AE4: abandons stuck running stage via HTTP", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-abandon-ae4-"));
      const { server, base, store } = await withServer(
        root,
        scriptedFakeAgent([]),
      );

      try {
        const run = await store.createRun({
          pipelineId: "docs-only",
          taskYaml: "id: t\ngoal: g\n",
        });
        await store.appendStageEvent(run.runId, "build", { event: "started" });
        await store.updateRunStatus(run.runId, "running");

        const abandoned = await postAbandon(base, run.runId, "build");
        expect(abandoned.status).toBe(202);
        expect(abandoned.body).toEqual({
          ok: true,
          runId: run.runId,
          stageId: "build",
        });

        const detail = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(run.runId)}`,
        );
        expect(detail.body.status).toBe("failed");
        expect(
          detail.body.stages.find(
            (s: { stage_id: string }) => s.stage_id === "build",
          )?.status,
        ).toBe("failed");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("returns 409 when stage is not running", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-abandon-409-"));
      const { server, base, store } = await withServer(
        root,
        scriptedFakeAgent([]),
      );

      try {
        const run = await store.createRun({
          pipelineId: "docs-only",
          taskYaml: "id: t\ngoal: g\n",
        });
        await store.appendStageEvent(run.runId, "build", { event: "started" });
        await store.appendStageEvent(run.runId, "build", { event: "failed" });

        const abandoned = await postAbandon(base, run.runId, "build");
        expect(abandoned.status).toBe(409);
        expect(abandoned.body.error).toMatch(/not running/i);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("POST abandon is gated by loopback Host/Origin", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-abandon-gate-"));
      const { server, base } = await withServer(root, scriptedFakeAgent([]));

      try {
        const forbiddenOrigin = await postAbandon(base, "r1", "build", {
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
        });
        expect(forbiddenOrigin.status).toBe(403);
        expect(forbiddenOrigin.body.error).toMatch(/origin|host/i);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("AE5: abandon stuck stage then parallel retry on failed siblings (HTTP)", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "sf-http-abandon-ae5-par-retry-"),
      );
      const agent = parallelFanoutStuckDesignAgent();
      const { server, base, store } = await withServer(root, agent);

      try {
        const started = await jsonFetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: "tasks/sample.yaml",
            pipeline: "parallel-retry-fanout",
          }),
        });
        const runId = started.body.runId as string;

        await waitFor(async () => {
          const detail = await store.readRun(runId);
          const design = detail.stages.find((s) => s.stage_id === "design-doc");
          const impl = detail.stages.find(
            (s) => s.stage_id === "implementation-plan",
          );
          return design?.status === "running" && impl?.status === "failed";
        });

        const abandoned = await postAbandon(base, runId, "design-doc");
        expect(abandoned.status).toBe(202);

        await waitFor(async () => {
          const meta = await store.readRunMeta(runId);
          return meta.status === "failed";
        });

        const retryDesign = postRetry(base, runId, "design-doc");
        await new Promise((r) => setTimeout(r, 50));
        const retryImpl = postRetry(base, runId, "implementation-plan");
        const [designResult, implResult] = await Promise.all([
          retryDesign,
          retryImpl,
        ]);
        expect(designResult.status).toBe(202);
        expect(implResult.status).toBe(202);

        await waitUntilIdleHealth(base);

        const detail = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(runId)}`,
        );
        expect(detail.body.status).toBe("succeeded");
        expect(
          detail.body.stages.find(
            (s: { stage_id: string }) => s.stage_id === "design-doc",
          )?.status,
        ).toBe("succeeded");
        expect(
          detail.body.stages.find(
            (s: { stage_id: string }) => s.stage_id === "implementation-plan",
          )?.status,
        ).toBe("succeeded");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }, 15000);
  });

  describe("provider auth HTTP shell", () => {
    const marker = "sk-test-secret-marker-HTTP-AE3-9f3c2b1a";

    it("lists live providers without changing GET /api/models", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-providers-list-"));
      const { writeCredentialSourceToFile } = await import(
        "../src/runtime/settingsFile.js"
      );
      writeCredentialSourceToFile(root, "sf_owned");

      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        undefined,
        { cwd: root },
      );

      try {
        const providers = await jsonFetch(`${base}/api/providers`);
        expect(providers.status).toBe(200);
        expect(providers.body.authShell).toBe("pi");
        expect(providers.body.via).toBe("pi");
        expect(Array.isArray(providers.body.providers)).toBe(true);
        expect(providers.body.providers.length).toBeGreaterThan(0);
        expect(providers.body.providers[0]).toMatchObject({
          id: expect.any(String),
          name: expect.any(String),
          supportsApiKey: expect.any(Boolean),
          supportsOauth: expect.any(Boolean),
        });
        expect(JSON.stringify(providers.body)).not.toMatch(
          /accessToken|refreshToken|"key"\s*:|sk-[a-zA-Z0-9]/,
        );

        const models = await jsonFetch(`${base}/api/models`);
        expect(models.status).toBe(200);
        expect(Array.isArray(models.body.models)).toBe(true);
        expect(models.body.providers).toBeUndefined();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("API-key login/status/logout round-trip never echoes the key", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-providers-login-"));
      const { writeCredentialSourceToFile } = await import(
        "../src/runtime/settingsFile.js"
      );
      const { sfOwnedAuthPath } = await import(
        "../src/runtime/credentialBinding.js"
      );
      writeCredentialSourceToFile(root, "sf_owned");

      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        undefined,
        { cwd: root },
      );

      try {
        const origin = base;
        const login = await jsonFetch(`${base}/api/providers/deepseek/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
          },
          body: JSON.stringify({ authType: "api_key", apiKey: marker }),
        });
        expect(login.status).toBe(200);
        expect(login.body.ok).toBe(true);
        expect(login.body.provider).toMatchObject({
          providerId: "deepseek",
          configured: true,
          authKind: "api_key",
        });
        expect(JSON.stringify(login.body)).not.toContain(marker);

        const status = await jsonFetch(`${base}/api/providers/deepseek/auth`);
        expect(status.status).toBe(200);
        expect(status.body.provider.configured).toBe(true);
        expect(JSON.stringify(status.body)).not.toContain(marker);

        const authFile = await readFile(sfOwnedAuthPath(root), "utf8");
        expect(authFile).toContain(marker);
        expect(authFile).not.toContain("settings");

        const settingsRaw = await readFile(
          path.join(storeRootFor(root), "settings.json"),
          "utf8",
        );
        expect(settingsRaw).not.toContain(marker);

        const logout = await jsonFetch(`${base}/api/providers/deepseek/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
          },
          body: "{}",
        });
        expect(logout.status).toBe(200);
        expect(logout.body.provider.configured).toBe(false);
        expect(JSON.stringify(logout.body)).not.toContain(marker);

        const after = await jsonFetch(`${base}/api/providers/deepseek/auth`);
        expect(after.body.provider.configured).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("requires Origin on login/logout and rejects bad oauth providers", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-providers-gate-"));
      const { writeCredentialSourceToFile } = await import(
        "../src/runtime/settingsFile.js"
      );
      writeCredentialSourceToFile(root, "sf_owned");
      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        undefined,
        { cwd: root },
      );

      try {
        const noOrigin = await jsonFetch(`${base}/api/providers/deepseek/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authType: "api_key", apiKey: marker }),
        });
        expect(noOrigin.status).toBe(403);
        expect(JSON.stringify(noOrigin.body)).not.toContain(marker);

        const badOrigin = await jsonFetch(
          `${base}/api/providers/deepseek/login`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "https://evil.example",
            },
            body: JSON.stringify({ authType: "api_key", apiKey: marker }),
          },
        );
        expect(badOrigin.status).toBe(403);
        expect(JSON.stringify(badOrigin.body)).not.toContain(marker);

        const oauthMissing = await jsonFetch(
          `${base}/api/providers/not-a-real-provider-zz/login`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: base,
            },
            body: JSON.stringify({ authType: "oauth" }),
          },
        );
        expect(oauthMissing.status).toBe(404);

        const missing = await jsonFetch(
          `${base}/api/providers/not-a-real-provider-zz/login`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: base,
            },
            body: JSON.stringify({ authType: "api_key", apiKey: marker }),
          },
        );
        expect(missing.status).toBe(404);
        expect(JSON.stringify(missing.body)).not.toContain(marker);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("oauth login session poll/answer/cancel never echoes secrets", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-oauth-sess-"));
      const { writeCredentialSourceToFile } = await import(
        "../src/runtime/settingsFile.js"
      );
      const { makeMutationLock } = await import("../src/agent/providerAuth.js");
      const { resetSessionsForTests } = await import(
        "../src/agent/oauthSessionManager.js"
      );
      writeCredentialSourceToFile(root, "sf_owned");

      const canary = "OAUTH-ANSWER-CANARY-http-secret";
      const providers = [
        {
          id: "oauth-provider",
          name: "OAuth Provider",
          auth: {
            oauth: {
              name: "OAuth",
              async login() {
                return {
                  type: "oauth" as const,
                  refresh: "r",
                  access: "a",
                  expires: Date.now() + 60_000,
                };
              },
              async refresh(c: unknown) {
                return c;
              },
              async toAuth() {
                return { apiKey: "x" };
              },
            },
          },
          getModels: () => [],
          stream: () => {
            throw new Error("n/a");
          },
          streamSimple: () => {
            throw new Error("n/a");
          },
        },
      ];
      const store = new Map<string, "api_key" | "oauth">();
      const fakeRuntime = {
        getProviders: () => providers as never,
        getProvider: (id: string) =>
          providers.find((p) => p.id === id) as never,
        getProviderAuthStatus: (id: string) => ({
          configured: store.has(id),
          source: store.has(id) ? "stored" : undefined,
        }),
        listCredentials: async () =>
          [...store.entries()].map(([providerId, type]) => ({
            providerId,
            type,
          })),
        checkAuth: async (id: string) => {
          const type = store.get(id);
          return type ? { type, source: "stored" } : undefined;
        },
        login: async (
          providerId: string,
          type: "api_key" | "oauth",
          interaction: {
            notify: (e: unknown) => void;
            prompt: (p: unknown) => Promise<string>;
          },
        ) => {
          interaction.notify({
            type: "auth_url",
            url: "https://example.test/start",
          });
          const value = await interaction.prompt({
            type: "manual_code",
            message: "Paste URL",
          });
          if (value !== canary) throw new Error("bad answer");
          store.set(providerId, type);
          return { type };
        },
        logout: async (providerId: string) => {
          store.delete(providerId);
        },
      };
      const providerAuthContext = {
        createRuntime: async () => fakeRuntime as never,
        lock: makeMutationLock(),
      };

      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        undefined,
        { cwd: root, providerAuthContext },
      );

      try {
        const origin = base;
        const started = await jsonFetch(
          `${base}/api/providers/oauth-provider/login`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
            },
            body: JSON.stringify({ authType: "oauth" }),
          },
        );
        expect(started.status).toBe(200);
        expect(started.body.ok).toBe(true);
        expect(started.body.session.status).toBe("running");
        const sessionId = started.body.session.id as string;

        let pending: { body: { session: { pendingPrompt?: { type: string } } } } | undefined;
        for (let i = 0; i < 100; i++) {
          const poll = await jsonFetch(
            `${base}/api/providers/oauth-provider/login/${sessionId}`,
          );
          expect(poll.status).toBe(200);
          if (poll.body.session.pendingPrompt?.type === "manual_code") {
            pending = poll;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(pending?.body.session.pendingPrompt?.type).toBe("manual_code");

        const answered = await jsonFetch(
          `${base}/api/providers/oauth-provider/login/${sessionId}/answer`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
            },
            body: JSON.stringify({ value: canary }),
          },
        );
        expect(answered.status).toBe(200);
        expect(JSON.stringify(answered.body)).not.toContain(canary);
        expect(answered.body.session.pendingPrompt).toBeUndefined();

        let completed = false;
        for (let i = 0; i < 100; i++) {
          const poll = await jsonFetch(
            `${base}/api/providers/oauth-provider/login/${sessionId}`,
          );
          if (poll.body.session.status === "completed") {
            completed = true;
            expect(JSON.stringify(poll.body)).not.toContain(canary);
            expect(poll.body.session.provider.configured).toBe(true);
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(completed).toBe(true);

        const cancelStart = await jsonFetch(
          `${base}/api/providers/oauth-provider/login`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
            },
            body: JSON.stringify({ authType: "oauth" }),
          },
        );
        expect(cancelStart.status).toBe(200);
        const cancelId = cancelStart.body.session.id as string;
        for (let i = 0; i < 100; i++) {
          const poll = await jsonFetch(
            `${base}/api/providers/oauth-provider/login/${cancelId}`,
          );
          if (poll.body.session.pendingPrompt) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        const cancelled = await jsonFetch(
          `${base}/api/providers/oauth-provider/login/${cancelId}/cancel`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
            },
            body: "{}",
          },
        );
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.session.status).toBe("cancelled");

        const answerAfter = await jsonFetch(
          `${base}/api/providers/oauth-provider/login/${cancelId}/answer`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
            },
            body: JSON.stringify({ value: canary }),
          },
        );
        expect([404, 409]).toContain(answerAfter.status);
        expect(JSON.stringify(answerAfter.body)).not.toContain(canary);

        const noOriginAnswer = await jsonFetch(
          `${base}/api/providers/oauth-provider/login/${sessionId}/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: canary }),
          },
        );
        expect(noOriginAnswer.status).toBe(403);
        expect(JSON.stringify(noOriginAnswer.body)).not.toContain(canary);
      } finally {
        resetSessionsForTests();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("get/set credentialSource and detect never return secrets", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-providers-cs-"));
      const { server, base } = await withServer(
        root,
        scriptedFakeAgent([]),
        undefined,
        { cwd: root },
      );

      try {
        const detect = await jsonFetch(`${base}/api/providers/detect`);
        expect(detect.status).toBe(200);
        expect(typeof detect.body.piHomeUsable).toBe("boolean");
        expect(detect.body.source).toMatch(/^(pi_home|sf_owned)$/);
        expect(detect.body.authPath).toBeUndefined();
        expect(JSON.stringify(detect.body)).not.toMatch(/sk-|apiKey|token/i);

        const setCs = await jsonFetch(`${base}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentialSource: "sf_owned" }),
        });
        expect(setCs.status).toBe(200);
        expect(setCs.body.credentialSource).toBe("sf_owned");
        expect(setCs.body.binding.source).toBe("sf_owned");
        expect(setCs.body.binding.provisional).toBe(false);

        const getSettings = await jsonFetch(`${base}/api/settings`);
        expect(getSettings.status).toBe(200);
        expect(getSettings.body.credentialSource).toBe("sf_owned");
        expect(getSettings.body.maxConcurrent).toEqual(expect.any(Number));
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it("denies auth.json artifact reads over HTTP", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-http-providers-deny-"));
      const store = createRunStore({ rootDir: root });
      const created = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: a\ngoal: g\n",
        taskId: "a",
      });
      const rel = path.join(
        "stages",
        "clarify",
        "attempts",
        "1",
        ".pi-agent",
        "auth.json",
      );
      await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
        recursive: true,
      });
      await writeFile(
        path.join(created.workspaceDir, rel),
        JSON.stringify({ secret: marker }),
      );
      const benign = path.join(
        "stages",
        "clarify",
        "attempts",
        "1",
        "artifacts",
        "note.txt",
      );
      await mkdir(path.dirname(path.join(created.workspaceDir, benign)), {
        recursive: true,
      });
      await writeFile(path.join(created.workspaceDir, benign), "ok");

      const { server, base } = await withServer(root, scriptedFakeAgent([]), store);

      try {
        const denied = await jsonFetch(
          `${base}/api/runs/${encodeURIComponent(created.runId)}/artifact?path=${encodeURIComponent(rel)}`,
        );
        expect(denied.status).toBe(403);
        expect(denied.body.error).toMatch(/Artifact path denied/);
        expect(JSON.stringify(denied.body)).not.toContain(marker);

        const ok = await fetch(
          `${base}/api/runs/${encodeURIComponent(created.runId)}/artifact?path=${encodeURIComponent(benign)}`,
        );
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("ok");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });
});
