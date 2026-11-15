import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type {
  AbandonStageResult,
  CancelRunResult,
  DeleteRunResult,
  GcRunsResult,
} from "../runtime/runManager.js";
import { mapRetryStageFailure, mapStoreLookupError } from "../server/operatorResults.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
} from "../server/requestAuthContext.js";
import { attemptStreamLogPath } from "../runstore/workspaceLayout.js";
import { parseAskOperatorAnswer } from "../tools/askOperator.js";
import type { McpToolDeps } from "./deps.js";
import { readStreamLogTail } from "../runread/tailStreamLog.js";
import { textResult } from "./toolResults.js";
import { projectWaitingGates } from "../runread/waitingGates.js";
import { readStageVerificationHistory } from "../runstore/verificationHistory.js";
import {
  deleteRunsFlatSchema,
  getStageFlatSchema,
  listWaitingFlatSchema,
  stageActionFlatSchema,
} from "../toolkit/runToolModes.js";

const auditLog = rootLogger.child({ component: "audit" });

const decisionAnswer = z.enum(["accept", "reject"]);
const freeTextOrConfirmAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free_text"), text: z.string() }),
  z.object({
    kind: z.literal("confirm"),
    decision: decisionAnswer,
    text: z.string().optional(),
  }),
]);
const askOperatorAnswerInput = z.discriminatedUnion("kind", [
  z.object({
    promptId: z.string().min(1),
    kind: z.literal("free_text"),
    text: z.string(),
  }),
  z.object({
    promptId: z.string().min(1),
    kind: z.literal("confirm"),
    decision: decisionAnswer,
    text: z.string().optional(),
  }),
  z.object({
    promptId: z.string().min(1),
    kind: z.literal("artifact_backed"),
    decision: decisionAnswer,
    text: z.string().optional(),
  }),
  z.object({
    promptId: z.string().min(1),
    kind: z.literal("multi_question"),
    answers: z.record(z.string(), freeTextOrConfirmAnswer),
  }),
]);

export function registerControlTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store, cwd } = deps;

  server.registerTool(
    "list_waiting",
    {
      description:
        "Stages waiting for operator input. detail: full (default) includes pending_prompt and waiting_* fields; detail: summary returns only count and run/stage identity. Optional runId filter; optional path scopes to one project when runId is omitted.",
      inputSchema: listWaitingFlatSchema,
    },
    async ({ runId, path: scopePath, detail }) => {
      const projectRoot =
        runId === undefined && scopePath !== undefined
          ? (findProjectRoot(path.resolve(cwd, scopePath)) ?? path.resolve(cwd, scopePath))
          : undefined;
      const waiting = await projectWaitingGates(store, { runId, projectRoot });
      if (detail === "summary") {
        const runs = waiting.map((item) => ({
          runId: item.runId as string,
          stageId: item.stageId as string,
          ...(item.waiting_kind !== undefined ? { kind: item.waiting_kind as string } : {}),
        }));
        return textResult({ count: runs.length, runs });
      }
      return textResult({ waiting });
    },
  );

  server.registerTool(
    "answer_gate",
    {
      description:
        "Deliver an AskOperatorAnswer for a stage in waiting_for_input. Pass answer as { promptId, kind, ... } matching the pending prompt.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
        answer: askOperatorAnswerInput,
      }),
    },
    async ({ runId, stageId, answer }) => {
      let parsed;
      try {
        parsed = parseAskOperatorAnswer(answer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "answer_gate",
          target_run_id: runId,
          outcome: "error",
        });
        return textResult({ error: message, status: 400 }, true);
      }
      const result = await manager.deliverAnswer(runId, stageId, parsed);
      if (!result.ok) {
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "answer_gate",
          target_run_id: runId,
          outcome: "error",
        });
        return textResult(
          { error: result.reason, status: result.status },
          true,
        );
      }
      writeAudit(auditLog, {
        caller_id: callerIdFromRequestAuth(),
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "answer_gate",
        target_run_id: runId,
        outcome: "ok",
      });
      return textResult(
        result.verification !== undefined
          ? { ok: true, verification: result.verification }
          : { ok: true },
      );
    },
  );

  server.registerTool(
    "decide_feedback_loop",
    {
      description:
        "Resolve a feedback-loop wait_for_human decision (extend, continue, or abandon).",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
        decision: z.enum(["extend", "continue", "abandon"]),
        loopId: z.string().optional(),
        reason: z.string().optional(),
      }),
    },
    async ({ runId, stageId, decision, loopId, reason }) => {
      const result = await manager.decideFeedbackLoop(runId, stageId, {
        decision,
        ...(loopId !== undefined ? { loopId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      if (!result.ok) {
        return textResult(
          { error: result.reason, status: result.status },
          true,
        );
      }
      return textResult({
        ok: true,
        effect: result.effect,
        loopId: result.loopId,
      });
    },
  );

  server.registerTool(
    "get_stage",
    {
      description:
        "Read stage detail for a run. view: events — persisted log events; log — live assistant text since a byte cursor; envelope — full StageEnvelope (404 when absent); verification — attempt history and completion checks.",
      inputSchema: getStageFlatSchema,
    },
    async ({ runId, stageId, view, attempt, since_offset }) => {
      if (view === "verification") {
        try {
          return textResult(await readStageVerificationHistory(store, runId, stageId));
        } catch (err) {
          const mapped = mapStoreLookupError(err, { policy: "run" });
          return textResult({ error: mapped.error, status: mapped.status }, true);
        }
      }
      try {
        await store.readRunMeta(runId);
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult({ error: mapped.error, status: 404 }, true);
      }
      try {
        const detail = await store.readRun(runId);
        const stage = detail.stages.find((s) => s.stage_id === stageId);
        if (!stage) {
          return textResult({ error: `Stage not found: ${stageId}`, status: 404 }, true);
        }
        if (view === "events") {
          const events = await store.listStageEvents(runId, stageId, attempt);
          return textResult({ runId, stageId, attempt, events });
        }
        if (view === "log") {
          const effectiveAttempt = attempt ?? stage.attempt_count;
          const attemptComplete =
            effectiveAttempt < stage.attempt_count || stage.status !== "running";
          const streamLogPath = attemptStreamLogPath(
            store.getWorkspaceDir(runId),
            stageId,
            effectiveAttempt,
          );
          const tail = await readStreamLogTail(streamLogPath, since_offset);
          return textResult({
            text: tail.text,
            next_offset: tail.nextOffset,
            attempt_complete: attemptComplete,
            ...(tail.truncated ? { truncated: true, earliest_offset: tail.earliestOffset } : {}),
          });
        }
        const envelope = await store.readEnvelope(runId, stageId, attempt);
        return textResult({ runId, stageId, attempt, envelope });
      } catch (err) {
        const mapped = mapStoreLookupError(
          err,
          { policy: view === "envelope" ? "envelope" : "run" },
        );
        return textResult({ error: mapped.error, status: mapped.status }, true);
      }
    },
  );

  server.registerTool(
    "stage_action",
    {
      description:
        "Operate on a run stage. action: retry — new attempt on failure; resume — continue a timed-out/interrupted attempt; recover — approve manual recovery; stop_recovery — leave a manual-recovery stage failed.",
      inputSchema: stageActionFlatSchema,
    },
    async ({ runId, stageId, action, guidance }) => {
      if (action === "recover") {
        const result = await manager.recoverManualStage(runId, stageId, guidance);
        if (!result.ok) {
          return textResult({ ...mapRetryStageFailure(result), status: result.status }, true);
        }
        return textResult({
          runId: result.runId,
          stageId: result.stageId,
          attemptIndex: result.attemptIndex,
        });
      }
      if (action === "stop_recovery") {
        const result = await manager.stopManualRecovery(runId, stageId);
        if (!result.ok) {
          return textResult({ error: result.reason, status: result.status }, true);
        }
        return textResult(result);
      }
      if (action === "resume") {
        const result = await manager.resumeTimedOutStage(runId, stageId);
        if (!result.ok) {
          writeAudit(auditLog, {
            caller_id: callerIdFromRequestAuth(),
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "resume_stage",
            target_run_id: runId,
            outcome: "error",
            ...(result.code !== undefined ? { error_code: result.code } : {}),
          });
          return textResult({ ...mapRetryStageFailure(result), status: result.status }, true);
        }
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "resume_stage",
          target_run_id: runId,
          outcome: "ok",
        });
        return textResult({
          runId: result.runId,
          stageId: result.stageId,
          attemptIndex: result.attemptIndex,
        });
      }
      const result = await manager.retryStage(runId, stageId);
      if (!result.ok) {
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "retry_stage",
          target_run_id: runId,
          outcome: "error",
          ...(result.code !== undefined ? { error_code: result.code } : {}),
        });
        return textResult({ ...mapRetryStageFailure(result), status: result.status }, true);
      }
      writeAudit(auditLog, {
        caller_id: callerIdFromRequestAuth(),
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "retry_stage",
        target_run_id: runId,
        outcome: "ok",
      });
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
        "Abandon a running stage (marks it failed). Does not dismiss HITL — waiting stages return 409; answer them with answer_gate. Prefer cancel_run to stop an entire run.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      const result = await manager.abandonStage(runId, stageId);
      if (!result.ok) {
        const fail = result as Extract<AbandonStageResult, { ok: false }>;
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "abandon_stage",
          target_run_id: runId,
          outcome: "error",
        });
        return textResult(
          { error: fail.reason, status: fail.status },
          true,
        );
      }
      writeAudit(auditLog, {
        caller_id: callerIdFromRequestAuth(),
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "abandon_stage",
        target_run_id: runId,
        outcome: "ok",
      });
      return textResult({
        ok: true,
        runId: result.runId,
        stageId: result.stageId,
      });
    },
  );

  server.registerTool(
    "cancel_run",
    {
      description:
        "Cancel a non-terminal run (marks it cancelled, terminalizes pending/running/waiting stages, releases the checkout lease). Signals live stage workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included. Reason is required free-text and stored on the run as cancel_reason.",
      inputSchema: z.object({
        runId: z.string(),
        reason: z.string().min(1),
      }),
    },
    async ({ runId, reason }) => {
      const result = await manager.cancelRun(runId, reason);
      if (!result.ok) {
        const fail = result as Extract<CancelRunResult, { ok: false }>;
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "cancel_run",
          target_run_id: runId,
          outcome: "error",
        });
        return textResult(
          { error: fail.reason, status: fail.status },
          true,
        );
      }
      writeAudit(auditLog, {
        caller_id: callerIdFromRequestAuth(),
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "cancel_run",
        target_run_id: runId,
        outcome: "ok",
      });
      return textResult({
        ok: true,
        runId: result.runId,
      });
    },
  );

  server.registerTool(
    "delete_runs",
    {
      description:
        "Delete one run (runId) or run retention GC (gc: true). Active runs require force: true before delete. GC defaults to dry-run unless execute: true.",
      inputSchema: deleteRunsFlatSchema,
    },
    async ({ runId, force, gc, execute }) => {
      if (gc === true) {
        const result = await manager.gcRuns({
          execute: execute === true,
          channel: "mcp",
        });
        if (!result.ok) {
          const fail = result as Extract<GcRunsResult, { ok: false }>;
          return textResult({ error: fail.reason, status: fail.status }, true);
        }
        return textResult({
          slimmed: result.slimmed,
          purged: result.purged,
          bareCachesEvicted: result.bareCachesEvicted,
        });
      }
      const result = await manager.deleteRun(runId!, {
        force,
        channel: "mcp",
      });
      if (!result.ok) {
        const fail = result as Extract<DeleteRunResult, { ok: false }>;
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "delete_run",
          target_run_id: runId,
          outcome: "error",
        });
        return textResult({ error: fail.reason, status: fail.status }, true);
      }
      writeAudit(auditLog, {
        caller_id: callerIdFromRequestAuth(),
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "delete_run",
        target_run_id: runId,
        outcome: "ok",
      });
      return textResult({ ok: true, runId: result.runId });
    },
  );
}
