import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { browseCatalog } from "../config/browseCatalog.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { validateCatalog } from "../config/validateCatalog.js";
import type { ListRunsFilter, RunStatus, RunStore } from "../runstore/port.js";
import type {
  AbandonStageResult,
  RetryStageResult,
  RunManager,
} from "../runtime/runManager.js";
import {
  parseAskOperatorAnswer,
} from "../tools/askOperator.js";
import { projectRunForMcp } from "./projectRun.js";
import { readRunArtifact } from "./readArtifact.js";
import {
  DEFAULT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PROGRESS_EVERY_MS,
  clampTimeoutMs,
  classifyWaitWake,
  sleepAbortable,
  type WaitUntil,
} from "./waitRun.js";

const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
});

const startRunSchema = z
  .object({
    pipeline: z.string().describe("Filesystem path to a pipeline YAML file"),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
  })
  .refine((data) => Boolean(data.task_path) !== Boolean(data.task), {
    message: "Exactly one of task_path or task is required",
  });

const runStatusSchema = z.enum(["created", "running", "succeeded", "failed"]);

function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function inferRetryStageErrorCode(reason: string): string | undefined {
  if (/retry already in progress/i.test(reason)) return "retry_in_progress";
  if (/waiting for input/i.test(reason)) return "hitl_not_retriable";
  if (/already has active orchestration/i.test(reason)) return "run_not_retryable";
  if (/run is not failed/i.test(reason)) return "run_not_retryable";
  if (/stage is not failed/i.test(reason)) return "stage_not_failed";
  return undefined;
}

function retryStageFailureBody(result: Extract<RetryStageResult, { ok: false }>) {
  const { ok: _ok, status: _status, reason, ...rest } = result;
  const code = inferRetryStageErrorCode(reason);
  return { error: reason, status: result.status, ...(code ? { code } : {}), ...rest };
}

function startFailureBody(result: { reason: string; status?: number; [k: string]: unknown }) {
  const { ok: _ok, status, reason, ...rest } = result as {
    ok?: boolean;
    status?: number;
    reason: string;
  } & Record<string, unknown>;
  return { error: reason, ...(status !== undefined ? { status } : {}), ...rest };
}

export type McpToolDeps = {
  manager: RunManager;
  store: RunStore;
  cwd: string;
};

export function registerMcpTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store, cwd } = deps;

  server.registerTool(
    "list_pipelines",
    {
      description: "List manifest-declared pipeline paths from the project catalog",
      inputSchema: z.object({}),
    },
    async () => {
      const catalog = await browseCatalog(cwd);
      return textResult({ pipelines: catalog.pipelines });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List manifest-declared task paths from the project catalog",
      inputSchema: z.object({}),
    },
    async () => {
      const catalog = await browseCatalog(cwd);
      return textResult({ tasks: catalog.tasks });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description:
        "List known pipeline runs. Optional filters: status, since (ISO created_at lower bound), pipeline (id or path).",
      inputSchema: z.object({
        status: runStatusSchema.optional(),
        since: z.string().optional(),
        pipeline: z.string().optional(),
      }),
    },
    async ({ status, since, pipeline }) => {
      const filter: ListRunsFilter = {};
      if (status !== undefined) filter.status = status as RunStatus;
      if (since !== undefined) filter.since = since;
      if (pipeline !== undefined) filter.pipeline = pipeline;
      const runs = await store.listRuns(
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      return textResult({ runs });
    },
  );

  server.registerTool(
    "get_health",
    {
      description:
        "Server health and soft-max run capacity: activeRunIds, activeCount, maxConcurrent, slotsAvailable. Start until slotsAvailable is 0; then wait for a run to finish or raise STAGEFLOW_MAX_CONCURRENT_RUNS.",
      inputSchema: z.object({}),
    },
    async () => textResult(manager.getHealth()),
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start a pipeline run using a filesystem pipeline path and either task_path (catalog task file) or an inline task object. Returns { runId }. On conflict returns isError with code busy_capacity (soft max full) or busy_checkout (same checkout leased), plus activeCount/maxConcurrent/activeRunIds and optional conflictingRunId/conflictingCheckout.",
      inputSchema: startRunSchema,
    },
    async ({ pipeline, task_path, task }) => {
      if (!pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
      }
      const result = await manager.startRun({ pipeline, task: taskInput });
      if (!result.ok) {
        const { ok: _ok, reason, ...rest } = result;
        return textResult({ error: reason, ...rest }, true);
      }
      return textResult({ runId: result.runId });
    },
  );

  server.registerTool(
    "get_run",
    {
      description:
        "Poll a run: status, stage statuses, waiting_* / pending_prompt HITL fields, and envelope summary/payload/artifact paths (no events). Use list_stage_events / get_envelope for timelines and full envelopes.",
      inputSchema: z.object({
        runId: z.string(),
      }),
    },
    async ({ runId }) => {
      try {
        const detail = await store.readRun(runId);
        return textResult(projectRunForMcp(detail));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notFound = /not found|no such|unknown run/i.test(message);
        return textResult(
          {
            error: message,
            status: notFound ? 404 : 500,
          },
          true,
        );
      }
    },
  );

  server.registerTool(
    "wait_run",
    {
      description:
        "Long-poll until a run is waiting for HITL input and/or terminal (succeeded/failed), or until timeout_ms. Default until=any wakes on waiting OR terminal. Abort cancels only this wait (not the run). Optional notifications/progress when the client supplies _meta.progressToken. Compose: wait_run → answer_gate → wait_run.",
      inputSchema: z.object({
        runId: z.string(),
        timeout_ms: z
          .number()
          .optional()
          .describe(`Wait budget in ms (default ${DEFAULT_TIMEOUT_MS}, max 240000)`),
        until: z
          .enum(["any", "waiting", "terminal"])
          .optional()
          .describe('Wake predicate: "any" (default), "waiting", or "terminal"'),
      }),
    },
    async ({ runId, timeout_ms, until }, ctx) => {
      const untilVal: WaitUntil = until ?? "any";
      const clamped = clampTimeoutMs(timeout_ms);
      if (!clamped.ok) {
        return textResult({ error: clamped.error, status: 400 }, true);
      }

      const signal = ctx.mcpReq.signal;
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const started = Date.now();
      let hadWaited = false;
      let pollCount = 0;
      let lastProgressAt = 0;

      const abortedResult = () =>
        textResult({ error: "wait aborted", code: "aborted" }, true);

      while (true) {
        if (signal.aborted) {
          return abortedResult();
        }

        let detail;
        try {
          detail = await store.readRun(runId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const notFound = /not found|no such|unknown run/i.test(message);
          return textResult(
            {
              error: message,
              status: notFound ? 404 : 500,
            },
            true,
          );
        }

        const run = projectRunForMcp(detail);
        const wake = classifyWaitWake(run, untilVal, hadWaited);
        const elapsed_ms = Date.now() - started;
        if (wake !== null) {
          return textResult({
            reason: wake,
            elapsed_ms,
            until: untilVal,
            run,
          });
        }

        if (elapsed_ms >= clamped.value) {
          return textResult({
            reason: "timeout",
            elapsed_ms,
            until: untilVal,
            run,
          });
        }

        if (
          progressToken !== undefined &&
          elapsed_ms - lastProgressAt >= PROGRESS_EVERY_MS
        ) {
          try {
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: pollCount,
                message: `waiting until=${untilVal} elapsed_ms=${elapsed_ms}`,
              },
            });
          } catch {
          }
          lastProgressAt = elapsed_ms;
        }

        const remaining = clamped.value - elapsed_ms;
        const sleepMs = Math.min(POLL_INTERVAL_MS, remaining);
        try {
          await sleepAbortable(sleepMs, signal);
        } catch {
          return abortedResult();
        }
        hadWaited = true;
        pollCount += 1;
      }
    },
  );

  server.registerTool(
    "read_artifact",
    {
      description:
        "Read a text artifact from a run workspace by relative path (contained under the run workspace).",
      inputSchema: z.object({
        runId: z.string(),
        path: z.string(),
      }),
    },
    async ({ runId, path: artifactPath }) => {
      try {
        const content = await readRunArtifact(store, runId, artifactPath);
        return textResult({ runId, path: artifactPath, content });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notFound =
          message.startsWith("Run not found") ||
          message.startsWith("Artifact not found") ||
          /no such|not found/i.test(message);
        return textResult(
          {
            error: message,
            status: notFound ? 404 : 400,
          },
          true,
        );
      }
    },
  );

  server.registerTool(
    "list_waiting",
    {
      description:
        "List stages waiting for operator input across runs (optional runId filter). Includes pending_prompt and waiting_* fields per gate.",
      inputSchema: z.object({
        runId: z.string().optional(),
      }),
    },
    async ({ runId }) => {
      const summaries = runId
        ? (await store.listRuns()).filter((r) => r.run_id === runId)
        : await store.listRuns();
      const waiting = summaries.filter(
        (r) =>
          (r.waiting_stage_ids !== undefined && r.waiting_stage_ids.length > 0) ||
          r.waiting_stage_id !== undefined,
      );

      const items: Array<Record<string, unknown>> = [];
      for (const summary of waiting) {
        const stageIds =
          summary.waiting_stage_ids ??
          (summary.waiting_stage_id !== undefined
            ? [summary.waiting_stage_id]
            : []);
        let detail;
        try {
          detail = await store.readRun(summary.run_id);
        } catch {
          continue;
        }
        for (const stageId of stageIds) {
          const stage = detail.stages.find((s) => s.stage_id === stageId);
          if (!stage || stage.status !== "waiting_for_input") continue;
          const prompt = stage.pending_prompt;
          const item: Record<string, unknown> = {
            runId: summary.run_id,
            stageId,
          };
          if (prompt !== undefined) {
            item.waiting_kind = prompt.kind;
            item.waiting_prompt_id = prompt.id;
            item.pending_prompt = prompt;
            if (prompt.kind === "multi_question") {
              item.waiting_questions = prompt.questions.map((q) => q.message);
            } else {
              item.waiting_summary = prompt.message;
            }
            if (prompt.kind === "artifact_backed") {
              item.waiting_artifacts = prompt.artifacts;
            }
          } else if (stageId === summary.waiting_stage_id) {
            if (summary.waiting_kind !== undefined) {
              item.waiting_kind = summary.waiting_kind;
            }
            if (summary.waiting_summary !== undefined) {
              item.waiting_summary = summary.waiting_summary;
            }
            if (summary.waiting_prompt_id !== undefined) {
              item.waiting_prompt_id = summary.waiting_prompt_id;
            }
            if (summary.waiting_artifacts !== undefined) {
              item.waiting_artifacts = summary.waiting_artifacts;
            }
            if (summary.waiting_questions !== undefined) {
              item.waiting_questions = summary.waiting_questions;
            }
          }
          items.push(item);
        }
      }
      return textResult({ waiting: items });
    },
  );

  server.registerTool(
    "answer_gate",
    {
      description:
        "Deliver an AskOperatorAnswer for a stage in waiting_for_input (same semantics as POST /api/runs/:id/stages/:stageId/answer). Pass answer as { promptId, kind, ... } matching the pending prompt.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
        answer: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ runId, stageId, answer }) => {
      let parsed;
      try {
        parsed = parseAskOperatorAnswer(answer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 400 }, true);
      }
      const result = await manager.deliverAnswer(runId, stageId, parsed);
      if (!result.ok) {
        return textResult(
          { error: result.reason, status: result.status },
          true,
        );
      }
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    "list_stage_events",
    {
      description:
        "List persisted stage log events for a run stage (optional attempt filter). Prefer over bloating get_run.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
        attempt: z.number().int().positive().optional(),
      }),
    },
    async ({ runId, stageId, attempt }) => {
      try {
        await store.readRunMeta(runId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 404 }, true);
      }
      try {
        const detail = await store.readRun(runId);
        const stage = detail.stages.find((s) => s.stage_id === stageId);
        if (!stage) {
          return textResult(
            { error: `Stage not found: ${stageId}`, status: 404 },
            true,
          );
        }
        const events = await store.listStageEvents(runId, stageId, attempt);
        return textResult({ runId, stageId, attempt, events });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notFound = /not found|no such/i.test(message);
        return textResult(
          { error: message, status: notFound ? 404 : 500 },
          true,
        );
      }
    },
  );

  server.registerTool(
    "get_envelope",
    {
      description:
        "Read the full StageEnvelope for a run stage (latest attempt). Returns 404 when absent.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      try {
        await store.readRunMeta(runId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 404 }, true);
      }
      try {
        const detail = await store.readRun(runId);
        if (!detail.stages.some((s) => s.stage_id === stageId)) {
          return textResult(
            { error: `Stage not found: ${stageId}`, status: 404 },
            true,
          );
        }
        const envelope = await store.readEnvelope(runId, stageId);
        return textResult({ runId, stageId, envelope });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notFound = /not found|no such|envelope/i.test(message);
        return textResult(
          { error: message, status: notFound ? 404 : 500 },
          true,
        );
      }
    },
  );

  server.registerTool(
    "retry_stage",
    {
      description:
        "Retry a failed stage (same as POST .../retry). Waiting stages cannot be retried — answer them with answer_gate instead.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      const result = await manager.retryStage(runId, stageId);
      if (!result.ok) {
        return textResult(retryStageFailureBody(result), true);
      }
      return textResult({
        runId: result.runId,
        stageId: result.stageId,
        attemptIndex: result.attemptIndex,
      });
    },
  );

  server.registerTool(
    "abandon_stage",
    {
      description:
        "Abandon a running stage (marks it failed/interrupted). Does not dismiss HITL — waiting stages return 409; answer them with answer_gate. There is no run-level cancel tool.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      const result = await manager.abandonStage(runId, stageId);
      if (!result.ok) {
        const fail = result as Extract<AbandonStageResult, { ok: false }>;
        return textResult(
          { error: fail.reason, status: fail.status },
          true,
        );
      }
      return textResult({
        ok: true,
        runId: result.runId,
        stageId: result.stageId,
      });
    },
  );

  server.registerTool(
    "rerun",
    {
      description:
        "Start a new run from a completed or failed run's pipeline/task locators. Returns { runId } for the new run.",
      inputSchema: z.object({
        runId: z.string(),
      }),
    },
    async ({ runId }) => {
      const result = await manager.rerun(runId);
      if (!result.ok) {
        return textResult(startFailureBody(result), true);
      }
      return textResult({ runId: result.runId });
    },
  );

  server.registerTool(
    "validate",
    {
      description:
        "Validate the project catalog (full), a pipeline path, or a task path. Returns ValidationResult JSON (ok, summary, findings).",
      inputSchema: z.object({
        pipeline: z.string().optional(),
        task: z.string().optional(),
        strict: z.boolean().optional(),
      }),
    },
    async ({ pipeline, task, strict }) => {
      try {
        let scope: "full" | "pipeline" | "task" = "full";
        if (pipeline !== undefined && pipeline.trim()) scope = "pipeline";
        else if (task !== undefined && task.trim()) scope = "task";
        const result = await validateCatalog({
          cwd,
          scope,
          ...(scope === "pipeline" ? { pipeline: pipeline!.trim() } : {}),
          ...(scope === "task" ? { task: task!.trim() } : {}),
          strict: strict ?? false,
        });
        return textResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 400 }, true);
      }
    },
  );

  server.registerTool(
    "describe_pipeline",
    {
      description:
        "Describe a pipeline DAG: stages with needs, fork, clonable, clone_cap, and gate_kinds. Input is a filesystem pipeline path (same as start_run).",
      inputSchema: z.object({
        pipeline: z.string(),
      }),
    },
    async ({ pipeline }) => {
      if (!pipeline.trim()) {
        return textResult({ error: "pipeline is required", status: 400 }, true);
      }
      try {
        const loaded = await loadPipeline(pipeline.trim(), { cwd });
        const gateById = new Map(
          loaded.stages.map((s) => [s.id, s.gate_kinds] as const),
        );
        const stages = loaded.dag.nodes.map((node) => ({
          id: node.id,
          needs: node.needs,
          ...(node.fork !== undefined ? { fork: node.fork } : {}),
          ...(node.clonable !== undefined ? { clonable: node.clonable } : {}),
          ...(node.clone_cap !== undefined ? { clone_cap: node.clone_cap } : {}),
          ...(gateById.get(node.id) !== undefined
            ? { gate_kinds: gateById.get(node.id) }
            : {}),
        }));
        return textResult({
          id: loaded.pipeline.id,
          path: loaded.pipelinePath,
          stages,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 404 }, true);
      }
    },
  );
}
