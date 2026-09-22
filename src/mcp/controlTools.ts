import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type {
  AbandonStageResult,
  CancelRunResult,
  DeleteRunResult,
} from "../runtime/runManager.js";
import {
  mapRetryStageFailure,
  mapStartFailure,
  mapStoreLookupError,
} from "../server/operatorResults.js";
import { attemptStreamLogPath } from "../runstore/workspaceLayout.js";
import { parseAskOperatorAnswer } from "../tools/askOperator.js";
import type { McpToolDeps } from "./deps.js";
import { readStreamLogTail } from "./tailStreamLog.js";
import { textResult } from "./toolResults.js";
import { projectWaitingGates } from "./waitingGates.js";
import { readStageVerificationHistory } from "../runstore/verificationHistory.js";

export function registerControlTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store, cwd } = deps;

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
    "get_waiting_summary",
    {
      description:
        "Lightweight count and identity of stages waiting for operator input — no pending_prompt, waiting_artifacts, or waiting_questions (use list_waiting for full detail). Optional runId scopes to one run; optional path scopes to one project (derived via findProjectRoot, same rule as elsewhere); omitting both spans every project the store knows about.",
      inputSchema: z.object({
        runId: z.string().optional(),
        path: z.string().optional(),
      }),
    },
    async ({ runId, path: scopePath }) => {
      const projectRoot =
        runId === undefined && scopePath !== undefined
          ? (findProjectRoot(path.resolve(cwd, scopePath)) ?? path.resolve(cwd, scopePath))
          : undefined;
      const waiting = await projectWaitingGates(store, { runId, projectRoot });
      const runs = waiting.map((item) => ({
        runId: item.runId as string,
        stageId: item.stageId as string,
        ...(item.waiting_kind !== undefined ? { kind: item.waiting_kind as string } : {}),
      }));
      return textResult({ count: runs.length, runs });
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
    "decide_feedback_loop",
    {
      description:
        "Resolve a feedback-loop wait_for_human decision (extend, continue, or abandon). Same semantics as POST /api/runs/:id/stages/:stageId/feedback-decision.",
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
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult({ error: mapped.error, status: 404 }, true);
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
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "tail_stage_log",
    {
      description:
        "Poll for new live assistant text a running (or recently finished) stage attempt has produced, since a byte-offset cursor. Separate from list_stage_events — no prompt/artifact/question detail, just the raw redacted text as it streamed. Omit since_offset to catch up on everything currently retained.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
        attempt: z.number().int().positive().optional(),
        since_offset: z.number().int().nonnegative().optional(),
      }),
    },
    async ({ runId, stageId, attempt, since_offset }) => {
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
          return textResult(
            { error: `Stage not found: ${stageId}`, status: 404 },
            true,
          );
        }
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
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "get_stage_verification",
    {
      description:
        "Read every execution attempt for a stage, including durable completion-check results and their evidence. Use this to understand an automatic repair or a failed verification.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      try {
        return textResult(
          await readStageVerificationHistory(store, runId, stageId),
        );
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "recover_manual_stage",
    {
      description:
        "Explicitly approve one fresh attempt for a manual-recovery stage after a completion verification failure. Optional guidance is recorded and supplied to the agent with the failed-check evidence.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
        guidance: z.string().max(4_000).optional(),
      }),
    },
    async ({ runId, stageId, guidance }) => {
      const result = await manager.recoverManualStage(runId, stageId, guidance);
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
    "stop_manual_recovery",
    {
      description:
        "Record the operator's decision to leave a manual-recovery stage failed. This is terminal for that stage; start a fresh run to try again later.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      const result = await manager.stopManualRecovery(runId, stageId);
      if (!result.ok) {
        return textResult(
          { error: result.reason, status: result.status },
          true,
        );
      }
      return textResult(result);
    },
  );

  server.registerTool(
    "get_envelope",
    {
      description:
        "Read the full StageEnvelope for a run stage. Optional attempt (omit = latest). Returns 404 when absent.",
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
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult({ error: mapped.error, status: 404 }, true);
      }
      try {
        const detail = await store.readRun(runId);
        if (!detail.stages.some((s) => s.stage_id === stageId)) {
          return textResult(
            { error: `Stage not found: ${stageId}`, status: 404 },
            true,
          );
        }
        const envelope = await store.readEnvelope(runId, stageId, attempt);
        return textResult({ runId, stageId, attempt, envelope });
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "envelope" });
        return textResult(
          { error: mapped.error, status: mapped.status },
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
    "resume_stage",
    {
      description:
        "Resume a stage that failed because it timed out, continuing the same attempt/session (same as POST .../resume). Does not start a new attempt — use retry_stage to start over.",
      inputSchema: z.object({
        runId: z.string(),
        stageId: z.string(),
      }),
    },
    async ({ runId, stageId }) => {
      const result = await manager.resumeTimedOutStage(runId, stageId);
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
        "Abandon a running stage (marks it failed/interrupted). Does not dismiss HITL — waiting stages return 409; answer them with answer_gate. Prefer cancel_run to stop an entire run.",
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
    "cancel_run",
    {
      description:
        "Cancel a non-terminal run (marks it cancelled, terminalizes pending/running/waiting stages, releases the checkout lease). Signals live stage workers via StageProcessLauncher.cancelRun, but process-group kill is not fixed yet — a wedged agent subprocess or its descendants may outlive the cancelled run. Reason is required free-text and stored on the run as cancel_reason.",
      inputSchema: z.object({
        runId: z.string(),
        reason: z.string().min(1),
      }),
    },
    async ({ runId, reason }) => {
      const result = await manager.cancelRun(runId, reason);
      if (!result.ok) {
        const fail = result as Extract<CancelRunResult, { ok: false }>;
        return textResult(
          { error: fail.reason, status: fail.status },
          true,
        );
      }
      return textResult({
        ok: true,
        runId: result.runId,
      });
    },
  );

  server.registerTool(
    "delete_run",
    {
      description:
        "Hard-delete a terminal run (store rows, workspace, worktree, run branch, and A2A tasks/artifacts). Active runs (created/queued/running) require force: true, which cancels first then deletes. Irreversible.",
      inputSchema: z.object({
        runId: z.string(),
        force: z.boolean().optional(),
      }),
    },
    async ({ runId, force }) => {
      const result = await manager.deleteRun(runId, {
        force,
        channel: "mcp",
      });
      if (!result.ok) {
        const fail = result as Extract<DeleteRunResult, { ok: false }>;
        return textResult(
          { error: fail.reason, status: fail.status },
          true,
        );
      }
      return textResult({
        ok: true,
        runId: result.runId,
      });
    },
  );

  server.registerTool(
    "rerun",
    {
      description:
        "Start a new run from a completed or failed run's pipeline/task locators. Optional pinned: true replays the prior resolved_sha for repository bindings. Returns { runId } for the new run.",
      inputSchema: z.object({
        runId: z.string(),
        pinned: z.boolean().optional(),
      }),
    },
    async ({ runId, pinned }) => {
      const result = await manager.rerun(
        runId,
        pinned !== undefined ? { pinned } : undefined,
      );
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
