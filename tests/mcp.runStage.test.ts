import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

async function mcpCall(
  base: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP response: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const contentText = message.result?.content?.[0]?.text ?? "";
  return {
    isError: Boolean(message.result?.isError),
    payload: contentText ? JSON.parse(contentText) : null,
  };
}

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

describe("run_stage — standalone stage execution (MCP)", () => {
  let projectRoot: string;
  let cleanupProject: () => Promise<void>;

  beforeAll(async () => {
    const setup = await initTempGitRepo();
    projectRoot = setup.root;
    cleanupProject = setup.cleanup;
    await cp(path.join(fixtures, "pipelines"), path.join(projectRoot, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "tasks"), path.join(projectRoot, "tasks"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "stages"), path.join(projectRoot, "stages"), {
      recursive: true,
    });
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
    agentBehaviors: Parameters<typeof scriptedFakeAgent>[0],
    fn: (base: string, store: ReturnType<typeof createRunStore>) => Promise<void>,
  ): Promise<void> {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-run-stage-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent(agentBehaviors);
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
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await fn(base, store);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it("runs an inline bare stage body to completion, no pipeline wrapper authored by the caller", async () => {
    await withServer(
      [{ type: "emit", envelope: { status: "success", summary: "checked", artifacts: [] } }],
      async (base, store) => {
        const started = await mcpCall(base, "run_stage", {
          stage: {
            id: "check",
            system_prompt: "Review the diff for obvious bugs.",
            model: "anthropic/claude-sonnet-4-5",
            ...REQUIRED_IO,
          },
          task: { id: "t", goal: "check this change" },
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;
        expect(runId).toBeTruthy();
        expect(started.payload.stageId).toBe("check");

        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.status === "succeeded";
        });

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
      },
    );
  });

  it("runs a catalog stage referenced by filesystem path, no pipeline file authored", async () => {
    await withServer(
      [{ type: "emit", envelope: { status: "success", summary: "researched", artifacts: [] } }],
      async (base, store) => {
        const started = await mcpCall(base, "run_stage", {
          stage: "stages/research.yaml",
          task: { id: "t", goal: "look into it" },
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;
        expect(started.payload.stageId).toBe("research");

        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.status === "succeeded";
        });

        const envelope = await mcpCall(base, "get_envelope", { runId, stageId: "research" });
        expect(envelope.isError).toBe(false);
        expect(envelope.payload.envelope.summary).toBe("researched");
      },
    );
  });

  it("passes task.checkout through exactly as a normal pipeline run would", async () => {
    await withServer(
      [{ type: "emit", envelope: { status: "success", summary: "ok", artifacts: [] } }],
      async (base, store) => {
        const started = await mcpCall(base, "run_stage", {
          stage: {
            id: "check",
            system_prompt: "Do work",
            model: "anthropic/claude-sonnet-4-5",
            ...REQUIRED_IO,
          },
          task: { id: "t", goal: "check", checkout: projectRoot },
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;
        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.status === "succeeded";
        });
        const meta = await store.readRunMeta(runId);
        expect(meta.checkout_root).toBe(projectRoot);
      },
    );
  });

  it("a structurally invalid inline stage body fails with the same ValidationFinding-shaped error a bad file would", async () => {
    await withServer([], async (base) => {
      // Missing io.output.schema — the exact same defect a bad file would hit.
      const started = await mcpCall(base, "run_stage", {
        stage: { id: "check", system_prompt: "Do work" },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(true);
      expect(started.payload.error).toBe("Stage validation failed");
      expect(started.payload).toHaveProperty("validation");
      expect(
        started.payload.validation.findings.some(
          (f: { code: string }) => f.code === "stage.invalid_io",
        ),
      ).toBe(true);
    });
  });

  it("uses: on an inline stage body is rejected, same as an inline pipeline stage", async () => {
    await withServer([], async (base) => {
      const started = await mcpCall(base, "run_stage", {
        stage: { id: "check", uses: "./somewhere.yaml" },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(true);
      const message = JSON.stringify(started.payload);
      expect(message).toMatch(/uses/);
    });
  });

  it("rejects a stage body with no id", async () => {
    await withServer([], async (base) => {
      const started = await mcpCall(base, "run_stage", {
        stage: { system_prompt: "Do work", ...REQUIRED_IO },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(true);
      expect(started.payload.error).toMatch(/id/);
    });
  });

  it("a stage with verify: configured goes through the same on_verify_fail path as a pipeline stage", async () => {
    await withServer(
      [{ type: "emit", envelope: { status: "success", summary: "ok", artifacts: ["out.txt"] } }],
      async (base, store) => {
        const started = await mcpCall(base, "run_stage", {
          stage: {
            id: "check",
            system_prompt: "Do work",
            model: "anthropic/claude-sonnet-4-5",
            ...REQUIRED_IO,
            verify: [{ id: "out-declared", type: "artifact", basename: "out.txt", when: ["emit"] }],
          },
          task: { id: "t", goal: "check" },
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;
        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.status === "succeeded";
        });
        const verification = await mcpCall(base, "get_stage_verification", {
          runId,
          stageId: "check",
        });
        expect(verification.isError).toBe(false);
        expect(verification.payload.attempts.length).toBeGreaterThan(0);
      },
    );
  });

  it("list_pipelines is unaffected by a run_stage call having happened", async () => {
    await withServer(
      [{ type: "emit", envelope: { status: "success", summary: "ok", artifacts: [] } }],
      async (base, store) => {
        const before = await mcpCall(base, "list_pipelines");
        const started = await mcpCall(base, "run_stage", {
          stage: {
            id: "no-leak",
            system_prompt: "Do work",
            model: "anthropic/claude-sonnet-4-5",
            ...REQUIRED_IO,
          },
          task: { id: "t", goal: "check" },
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;
        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.status === "succeeded";
        });
        const after = await mcpCall(base, "list_pipelines");
        // Not a strict equality: fanning out over every known project root can
        // list the same on-disk directory twice under distinct path spellings
        // once a new run's project root is recorded — a pre-existing quirk
        // unrelated to run_stage (see mcp.startRunInline.test.ts). What matters
        // here is that nothing from the run_stage call leaked into the catalog.
        const beforePaths = new Set(
          before.payload.pipelines.map((p: { path: string }) => p.path),
        );
        const afterPaths = new Set(
          after.payload.pipelines.map((p: { path: string }) => p.path),
        );
        for (const p of beforePaths) expect(afterPaths.has(p)).toBe(true);
        expect(
          after.payload.pipelines.some((p: { id?: string }) => p.id === "no-leak"),
        ).toBe(false);
      },
    );
  });

  describe("blocking mode", () => {
    it("a blocking call against a gate-free stage returns the final envelope directly, no polling", async () => {
      await withServer(
        [{ type: "emit", envelope: { status: "success", summary: "done", artifacts: [] } }],
        async (base) => {
          const started = await mcpCall(base, "run_stage", {
            stage: {
              id: "check",
              system_prompt: "Do work",
              model: "anthropic/claude-sonnet-4-5",
              ...REQUIRED_IO,
            },
            task: { id: "t", goal: "check" },
            blocking: true,
          });
          expect(started.isError).toBe(false);
          expect(started.payload.status).toBe("completed");
          expect(started.payload.envelope.summary).toBe("done");
          expect(started.payload.runId).toBeTruthy();
          expect(started.payload.stageId).toBe("check");
        },
      );
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
            stage: {
              id: "clarify",
              system_prompt: "Ask a question",
              model: "anthropic/claude-sonnet-4-5",
              ...REQUIRED_IO,
            },
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
      // AgentPort deliberately never resolves within the test's timeout_ms.
      const hangingAgent: AgentPort = {
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

      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-run-stage-timeout-"));
      const store = createRunStore({ rootDir: storeRoot });
      const { server } = await startUiServer({
        agent: hangingAgent,
        cwd: projectRoot,
        store,
        port: 0,
        uiDistDir: path.join(storeRoot, "missing-ui"),
        mcpStateless: true,
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const base = `http://127.0.0.1:${address.port}`;

      try {
        const started = await mcpCall(base, "run_stage", {
          stage: {
            id: "check",
            system_prompt: "Do work",
            model: "anthropic/claude-sonnet-4-5",
            ...REQUIRED_IO,
          },
          task: { id: "t", goal: "check" },
          blocking: true,
          timeout_ms: 300,
        });
        expect(started.isError).toBe(false);
        expect(started.payload.status).toBe("timeout");
        expect(started.payload.runId).toBeTruthy();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }, 10000);
  });
});
