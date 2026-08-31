import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AbandonStageResult } from "../runtime/runManager.js";
import {
  mapRetryStageFailure,
  mapStartFailure,
} from "../server/operatorResults.js";
import { parseAskOperatorAnswer } from "../tools/askOperator.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import { projectWaitingGates } from "./waitingGates.js";

export function registerControlTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store } = deps;

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
      const waiting = await projectWaitingGates(store, { runId });
      return textResult({ waiting });
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
        return textResult(
          { ...mapRetryStageFailure(result), status: result.status },
          true,
        );
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
        return textResult(
          {
            ...mapStartFailure(result),
            ...(result.status !== undefined ? { status: result.status } : {}),
          },
          true,
        );
      }
      return textResult({ runId: result.runId });
    },
  );
}
