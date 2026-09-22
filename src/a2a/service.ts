import path from "node:path";
import { readRunArtifactBytes, artifactMediaType } from "../mcp/readArtifact.js";
import { waitRun } from "../mcp/waitRun.js";
import { readYamlObject } from "../config/readYamlObject.js";
import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import { parseAskOperatorAnswer } from "../tools/askOperator.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import {
  EnvelopeRefError,
  resolveEnvelopeRefsToTask,
} from "../runtime/resolveEnvelopeRef.js";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";
import type { PublicationRegistry } from "./registry.js";
import {
  A2aApplicationError,
  contentHash,
  decodePromptHandle,
  encodePromptHandle,
  newTaskId,
  parseIncomingMessage,
  submissionKeyFor,
  type IncomingMessage,
  type RunStageCommand,
} from "./contracts.js";
import type Database from "better-sqlite3";
import { A2aStore, type A2aTaskRow, type TaskState } from "./store.js";
import { MAX_NONTERMINAL_TASKS_PER_CALLER, RateLimiter } from "./limits.js";

export type Caller = { id: string };

export type PublicQuestion = { handle: string; message: string };

export type PublicArtifact = { id: string; name: string; mediaType?: string; size: number };

export type PublicTask = {
  id: string;
  contextId: string;
  state: TaskState;
  publication: string;
  createdAt: string;
  updatedAt: string;
  questions?: PublicQuestion[];
  waitingForOperator?: boolean;
  result?: { summary: string; payload?: Record<string, unknown>; artifacts: PublicArtifact[] };
  /**
   * The underlying run id — only ever populated for a "standalone" (ADR-0001
   * run_stage) task. Published-capability (`invoke`) tasks keep the run id
   * opaque, unchanged from before this field existed. Exposing it here is
   * what makes ADR-0002's `envelope_ref` chaining ({runId, stageId}) usable
   * from an A2A caller in the first place: run_stage's response is the only
   * place a caller can learn the run id of a standalone call it just made,
   * to hand to its *next* run_stage call.
   */
  runId?: string;
};

export type ArtifactRead = { bytes: Buffer; name: string; mediaType?: string };

export class A2aInvocations {
  constructor(
    private readonly registry: PublicationRegistry,
    private readonly manager: RunManager,
    private readonly runStore: RunStore,
    /** Base directory a `stage`/`pipeline` filesystem reference in a run_stage call resolves against. */
    private readonly rootDir: string,
    private readonly store: A2aStore,
    private readonly rateLimiter: RateLimiter = new RateLimiter(),
  ) {}

  close(): void {
    this.store.close();
  }

  /** Deletes terminal tasks and message tombstones past their retention window. Call periodically; the core logic takes an explicit clock so it stays deterministic to test. */
  async pruneExpired(now: Date = new Date()): Promise<{ removedTasks: number; removedMessages: number }> {
    return this.store.pruneExpired(now);
  }

  private checkRate(caller: Caller): void {
    if (!this.rateLimiter.tryConsume(caller.id)) {
      throw new A2aApplicationError("busy", "Rate limit exceeded; retry after a short delay");
    }
  }

  async send(caller: Caller, raw: IncomingMessage): Promise<PublicTask> {
    this.checkRate(caller);
    const message = parseIncomingMessage(raw);
    if (message.kind === "invoke") {
      return this.invoke(caller, message.messageId, message.contextId, message.capability, message.input);
    }
    if (message.kind === "run_stage") {
      return this.runStandalone(caller, message);
    }
    return this.answer(caller, message.messageId, message.taskId, message.handle, message.answer);
  }

  async get(caller: Caller, taskId: string): Promise<PublicTask> {
    this.checkRate(caller);
    return this.projectTask(caller, taskId);
  }

  async list(caller: Caller, contextId: string | undefined): Promise<PublicTask[]> {
    this.checkRate(caller);
    const rows = this.store.listTasksForCaller(caller.id, contextId);
    const tasks: PublicTask[] = [];
    for (const row of rows) {
      tasks.push(await this.projectTask(caller, row.task_id));
    }
    return tasks;
  }

  async readArtifact(caller: Caller, taskId: string, artifactId: string): Promise<ArtifactRead> {
    this.checkRate(caller);
    const row = this.requireOwnedTask(caller, taskId);
    if (row.state !== "completed") throw new A2aApplicationError("not-found", "Artifact not found");
    const artifact = this.store.getArtifact(taskId, artifactId);
    if (!artifact) throw new A2aApplicationError("not-found", "Artifact not found");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(artifact.content_path);
    return { bytes, name: artifact.name, mediaType: artifact.media_type ?? undefined };
  }

  private requireOwnedTask(caller: Caller, taskId: string): A2aTaskRow {
    const row = this.store.getTask(taskId);
    if (!row || row.caller_id !== caller.id) throw new A2aApplicationError("not-found", "Task not found");
    return row;
  }

  /**
   * (caller, messageId) dedup shared by invoke and answer: a resend of a message already recorded with
   * the same content hash replays its prior outcome; a resend with different content is a conflict.
   * Returns undefined only for a message this caller has not sent before.
   */
  private async replayOrThrow(caller: Caller, messageId: string, hash: string, conflictMessage: string): Promise<PublicTask | undefined> {
    const existing = this.store.getMessage(caller.id, messageId);
    if (!existing) return undefined;
    if (existing.requestHash !== hash) {
      throw new A2aApplicationError("message-conflict", conflictMessage);
    }
    return this.projectTask(caller, existing.taskId);
  }

  private async invoke(
    caller: Caller,
    messageId: string,
    contextId: string | undefined,
    capability: string,
    input: unknown,
  ): Promise<PublicTask> {
    const publication = this.registry.get(caller.id, capability);
    if (!publication) {
      throw new A2aApplicationError("unknown-capability", "Unknown capability: " + capability);
    }
    try {
      await this.registry.assertUnchanged(caller.id, capability);
    } catch (err) {
      throw new A2aApplicationError(
        "unknown-capability",
        err instanceof Error ? err.message : "Publication configuration changed",
      );
    }
    const mismatch = payloadInstanceMismatch(input ?? {}, publication.inputSchema);
    if (mismatch) {
      throw new A2aApplicationError("invalid-input", mismatch);
    }
    const hash = contentHash({
      operation: "invoke",
      capability,
      revision: publication.revision,
      contextId: contextId ?? null,
      input,
    });
    const replay = await this.replayOrThrow(caller, messageId, hash, "Message ID was already used for different input");
    if (replay) return replay;
    const submissionKey = submissionKeyFor(caller.id, capability, hash);
    const existingTask = this.store.getTaskBySubmissionKey(submissionKey);
    if (!existingTask && this.store.countNonterminal(caller.id) >= MAX_NONTERMINAL_TASKS_PER_CALLER) {
      throw new A2aApplicationError("busy", "Too many active tasks for this caller; wait for one to finish");
    }
    const taskId = existingTask?.task_id ?? newTaskId();
    const contextIdResolved = existingTask?.context_id ?? this.store.ensureContext(caller.id, contextId);
    const result = await this.manager.startRunOnce(
      { pipeline: publication.pipeline, task: { id: taskId, goal: publication.goal, input: input as Record<string, unknown> } },
      { key: submissionKey, requestHash: hash },
    );
    if (!result.ok) {
      throw mapStartFailure(result);
    }
    if (!existingTask) {
      this.store.createTask({
        taskId,
        contextId: contextIdResolved,
        callerId: caller.id,
        publicationId: publication.id,
        publicationRevision: publication.revision,
        submissionKey,
        runId: result.runId,
      });
      if (result.done) {
        void result.done
          .catch(() => undefined)
          .then(() => this.maybeFinalize(this.store.getTask(taskId)!));
      }
    }
    this.store.recordMessage({ callerId: caller.id, messageId, taskId, operation: "invoke", requestHash: hash, outcome: { ok: true } });
    return this.projectTask(caller, taskId);
  }

  /**
   * ADR-0001's wildcard-access operation: run any catalog or inline
   * stage/pipeline directly. Deliberately does NOT call `this.registry.get`/
   * `.list` — that allowlist lookup is the entire mechanism `invoke` uses to
   * restrict a caller to its published capabilities, and this operation's
   * whole point is to bypass it. The caller is still authenticated (by the
   * time `send` reaches here) and still rate-limited/admission-capped like
   * any other task.
   */
  private async runStandalone(caller: Caller, cmd: RunStageCommand): Promise<PublicTask> {
    let taskInput: string | TaskFile;
    if (cmd.envelope_ref) {
      try {
        taskInput = await resolveEnvelopeRefsToTask(this.runStore, cmd.envelope_ref, cmd.checkout);
      } catch (err) {
        if (err instanceof EnvelopeRefError) {
          throw new A2aApplicationError(
            err.kind === "not_found" ? "not-found" : "invalid-input",
            err.message,
          );
        }
        throw err;
      }
    } else {
      taskInput = (cmd.task_path ?? cmd.task)!;
    }

    let pipelineArg: string | InlinePipelineDefinition;
    let resultStageId: string | undefined;
    if (cmd.stage !== undefined) {
      let stageBody: Record<string, unknown>;
      if (typeof cmd.stage === "string") {
        if (!cmd.stage.trim()) throw new A2aApplicationError("invalid-input", "stage is required");
        const absPath = path.resolve(this.rootDir, cmd.stage);
        try {
          stageBody = await readYamlObject(absPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new A2aApplicationError("invalid-input", `Failed to read stage file: ${message}`);
        }
      } else {
        stageBody = cmd.stage;
      }
      if (typeof stageBody.id !== "string" || !stageBody.id.trim()) {
        throw new A2aApplicationError("invalid-input", "stage.id is required");
      }
      resultStageId = stageBody.id;
      const effectiveStageBody = cmd.model !== undefined ? { ...stageBody, model: cmd.model } : stageBody;
      pipelineArg = { id: `standalone-${resultStageId}`, stages: [effectiveStageBody] };
    } else {
      const pipeline = cmd.pipeline!;
      if (typeof pipeline === "string") {
        if (!pipeline.trim()) throw new A2aApplicationError("invalid-input", "pipeline is required");
        pipelineArg = pipeline;
      } else {
        if (typeof pipeline.id !== "string" || !pipeline.id.trim() || !Array.isArray(pipeline.stages)) {
          throw new A2aApplicationError("invalid-input", "Inline pipeline requires id and stages");
        }
        pipelineArg = pipeline as unknown as InlinePipelineDefinition;
      }
      // No single result stage for a multi-stage pipeline call: finalize
      // surfaces every stage's outcome instead of one envelope (see maybeFinalize).
    }

    const hash = contentHash({
      operation: "run_stage",
      stage: cmd.stage ?? null,
      pipeline: cmd.pipeline ?? null,
      task_path: cmd.task_path ?? null,
      task: cmd.task ?? null,
      envelope_ref: cmd.envelope_ref ?? null,
      checkout: cmd.checkout ?? null,
      model: cmd.model ?? null,
    });
    const replay = await this.replayOrThrow(caller, cmd.messageId, hash, "Message ID was already used for different input");
    if (replay) return replay;
    // Same at-most-once-per-content shape as invoke: a resend under a FRESH
    // messageId (e.g. the caller lost the first response) must still land on
    // the same task/run rather than starting a duplicate, so this is keyed
    // on content hash via submissionKey/getTaskBySubmissionKey, not messageId.
    const submissionKey = submissionKeyFor(caller.id, "__run_stage__", hash);
    const existingTask = this.store.getTaskBySubmissionKey(submissionKey);
    if (!existingTask && this.store.countNonterminal(caller.id) >= MAX_NONTERMINAL_TASKS_PER_CALLER) {
      throw new A2aApplicationError("busy", "Too many active tasks for this caller; wait for one to finish");
    }

    const taskId = existingTask?.task_id ?? newTaskId();
    const contextIdResolved = existingTask?.context_id ?? this.store.ensureContext(caller.id, cmd.contextId);

    let result;
    try {
      result = await this.manager.startRunOnce(
        { pipeline: pipelineArg, task: taskInput },
        { key: submissionKey, requestHash: hash },
      );
    } catch (err) {
      if (err instanceof PipelineValidationError) {
        throw new A2aApplicationError(
          "invalid-input",
          "Stage/pipeline validation failed: " + JSON.stringify(err.result.findings),
        );
      }
      throw err;
    }
    if (!result.ok) {
      throw mapStartFailure(result);
    }

    if (!existingTask) {
      this.store.createTask({
        taskId,
        contextId: contextIdResolved,
        callerId: caller.id,
        publicationId: "",
        publicationRevision: "",
        submissionKey,
        runId: result.runId,
        kind: "standalone",
        resultStageId: resultStageId ?? null,
      });
      if (result.done) {
        void result.done
          .catch(() => undefined)
          .then(() => this.maybeFinalize(this.store.getTask(taskId)!));
      }
    }
    this.store.recordMessage({ callerId: caller.id, messageId: cmd.messageId, taskId, operation: "run_stage", requestHash: hash, outcome: { ok: true } });

    if (cmd.blocking) {
      await waitRun({ store: this.runStore, runId: result.runId, timeoutMs: cmd.timeout_ms, until: "any" }).catch(() => undefined);
    }
    return this.projectTask(caller, taskId);
  }

  private async answer(
    caller: Caller,
    messageId: string,
    taskId: string,
    handle: string,
    answerPayload: { kind: "free_text"; text: string },
  ): Promise<PublicTask> {
    const row = this.requireOwnedTask(caller, taskId);
    const hash = contentHash({ operation: "answer", taskId, handle, answer: answerPayload });
    const replay = await this.replayOrThrow(caller, messageId, hash, "Message ID was already used for a different answer");
    if (replay) return replay;
    const decoded = decodePromptHandle(handle);
    if (!decoded || decoded.taskId !== taskId) {
      throw new A2aApplicationError("stale-question", "Unknown or expired prompt handle");
    }
    if (row.kind !== "standalone") {
      // Published-capability tasks stay gated by the publication's own
      // explicit caller_answerable_stages allowlist (config-time restricted
      // to single-free_text-gate stages in registry.ts's validatePublication).
      const publication = this.registry.get(caller.id, row.publication_id);
      if (!publication || !publication.caller_answerable_stages.includes(decoded.stageId)) {
        throw new A2aApplicationError("stale-question", "This prompt cannot be answered by the caller");
      }
    }
    // A "standalone" (ADR-0001 run_stage) task has no publication/allowlist to
    // consult — the caller already owns this ad hoc run outright (requireOwnedTask
    // above). Any of its own free_text prompts are answerable; the pending_prompt.kind
    // check below (shared with the publication path) is what still keeps an
    // operator-only gate (confirm, etc.) out of reach here, same as for `invoke`.
    if (!row.run_id) {
      throw new A2aApplicationError("stale-question", "Task has no active run to answer");
    }
    const detail = await this.runStore.readRun(row.run_id);
    const stage = detail.stages.find((candidate) => candidate.stage_id === decoded.stageId);
    if (
      !stage ||
      stage.status !== "waiting_for_input" ||
      stage.pending_prompt?.id !== decoded.promptId ||
      stage.pending_prompt?.kind !== "free_text"
    ) {
      throw new A2aApplicationError("stale-question", "This question is no longer pending");
    }
    let parsed;
    try {
      parsed = parseAskOperatorAnswer({ promptId: decoded.promptId, kind: "free_text", text: answerPayload.text });
    } catch (err) {
      throw new A2aApplicationError("invalid-input", err instanceof Error ? err.message : "Invalid answer");
    }
    const delivered = await this.manager.deliverAnswer(row.run_id, decoded.stageId, parsed);
    if (!delivered.ok) {
      const category = delivered.status === 404 ? "not-found" : "stale-question";
      throw new A2aApplicationError(category, delivered.reason);
    }
    this.store.recordMessage({ callerId: caller.id, messageId, taskId, operation: "answer", requestHash: hash, outcome: { ok: true } });
    return this.projectTask(caller, taskId);
  }

  private async maybeFinalize(row: A2aTaskRow): Promise<A2aTaskRow> {
    if (row.state === "completed" || row.state === "failed") return row;
    if (!row.run_id) return row;
    let detail;
    try {
      detail = await this.runStore.readRun(row.run_id);
    } catch {
      return row;
    }
    if (detail.status !== "succeeded" && detail.status !== "failed") return row;
    if (row.kind === "standalone") {
      if (detail.status === "failed") {
        await this.store.freezeFailed(row.task_id);
        return this.store.getTask(row.task_id)!;
      }
      try {
        if (row.result_stage_id) {
          // A `stage`-shaped call: exactly one synthesized result stage, same
          // as run_stage's MCP `blocking` result. Unlike the publication path,
          // every artifact the stage produced is exposed (no declared-artifact
          // allowlist to filter by — see ADR-0001).
          const stage = detail.stages.find((candidate) => candidate.stage_id === row.result_stage_id);
          if (!stage || !stage.envelope) throw new Error("Result stage did not produce an envelope");
          const artifacts = [];
          for (const match of stage.artifacts) {
            const name = match.split("/").pop()!;
            const bytes = await readRunArtifactBytes(this.runStore, row.run_id, match);
            artifacts.push({ name, mediaType: artifactMediaType(name), bytes });
          }
          await this.store.freezeCompleted(row.task_id, {
            summary: stage.envelope.summary,
            payload: stage.envelope.payload,
            artifacts,
          });
        } else {
          // A `pipeline`-shaped call: no single designated result stage, so
          // surface every stage's outcome instead of one envelope. Files are
          // not copied here; per ADR-0002 a caller chains into the next
          // standalone call via envelope_ref rather than downloading artifacts
          // from this summary.
          await this.store.freezeCompleted(row.task_id, {
            summary: `Run ${detail.pipeline_id} completed`,
            payload: {
              stages: detail.stages.map((s) => ({
                stageId: s.stage_id,
                status: s.status,
                summary: s.envelope?.summary,
                payload: s.envelope?.payload,
              })),
            },
            artifacts: [],
          });
        }
      } catch {
        await this.store.freezeFailed(row.task_id);
      }
      return this.store.getTask(row.task_id)!;
    }
    const publication = this.registry.get(row.caller_id, row.publication_id);
    if (detail.status === "failed" || !publication) {
      await this.store.freezeFailed(row.task_id);
    } else {
      try {
        const stage = detail.stages.find((candidate) => candidate.stage_id === publication.results.stage);
        if (!stage || !stage.envelope) throw new Error("Result stage did not produce an envelope");
        const artifacts = [];
        for (const name of publication.results.artifacts) {
          const match = stage.artifacts.find((entry) => entry.split("/").pop() === name);
          if (!match) throw new Error("Declared artifact " + name + " was not produced");
          const bytes = await readRunArtifactBytes(this.runStore, row.run_id, match);
          artifacts.push({ name, mediaType: artifactMediaType(name), bytes });
        }
        await this.store.freezeCompleted(row.task_id, {
          summary: stage.envelope.summary,
          payload: publication.results.include_payload ? stage.envelope.payload : undefined,
          artifacts,
        });
      } catch {
        await this.store.freezeFailed(row.task_id);
      }
    }
    return this.store.getTask(row.task_id)!;
  }

  /** The five PublicTask fields every projection shares; call sites layer in only what differs per state. */
  private buildTask(row: A2aTaskRow, extra: Partial<Omit<PublicTask, "id" | "contextId" | "publication" | "createdAt" | "updatedAt">> = {}): PublicTask {
    return {
      id: row.task_id,
      contextId: row.context_id,
      publication: row.publication_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: row.state,
      ...extra,
    };
  }

  private async projectTask(caller: Caller, taskId: string): Promise<PublicTask> {
    let row = this.requireOwnedTask(caller, taskId);
    row = await this.maybeFinalize(row);
    const runIdExtra = row.kind === "standalone" && row.run_id ? { runId: row.run_id } : {};
    if (row.state === "completed" || row.state === "failed") {
      const resultData = row.result_json
        ? (JSON.parse(row.result_json) as { summary: string; payload?: Record<string, unknown> })
        : undefined;
      const artifacts: PublicArtifact[] = this.store
        .listArtifacts(taskId)
        .map((artifact) => ({ id: artifact.artifact_id, name: artifact.name, mediaType: artifact.media_type ?? undefined, size: artifact.size }));
      return this.buildTask(row, {
        ...runIdExtra,
        result: resultData ? { summary: resultData.summary, payload: resultData.payload, artifacts } : undefined,
      });
    }
    if (!row.run_id) {
      return this.buildTask(row, { state: "submitted" });
    }
    const detail = await this.runStore.readRun(row.run_id);
    const waitingIds = detail.waiting_stage_ids ?? (detail.waiting_stage_id ? [detail.waiting_stage_id] : []);
    let answerableIds: string[];
    if (row.kind === "standalone") {
      // No publication/allowlist to consult (ADR-0001): the caller owns this
      // whole ad hoc run, so any of its own free_text prompts are answerable —
      // same free_text-only boundary invoke's publication config enforces,
      // just read off the live prompt instead of a config list.
      answerableIds = waitingIds.filter((id) => {
        const stage = detail.stages.find((candidate) => candidate.stage_id === id);
        return stage?.pending_prompt?.kind === "free_text";
      });
    } else {
      const publication = this.registry.get(caller.id, row.publication_id);
      answerableIds = waitingIds.filter((id) => publication?.caller_answerable_stages.includes(id));
    }
    if (answerableIds.length > 0) {
      const questions: PublicQuestion[] = answerableIds.map((stageId) => {
        const stage = detail.stages.find((candidate) => candidate.stage_id === stageId)!;
        const prompt = stage.pending_prompt!;
        const message = prompt.kind === "free_text" ? prompt.message : "Additional input required";
        return { handle: encodePromptHandle(row.task_id, stageId, prompt.id), message };
      });
      return this.buildTask(row, { ...runIdExtra, state: "input-required", questions });
    }
    const state: TaskState = waitingIds.length > 0 || detail.status === "running" ? "working" : "submitted";
    return this.buildTask(row, { ...runIdExtra, state, waitingForOperator: waitingIds.length > 0 });
  }
}

function mapStartFailure(result: { reason: string; status?: number; code?: string }): A2aApplicationError {
  if (result.code === "busy_capacity" || result.code === "busy_checkout") {
    return new A2aApplicationError("busy", result.reason);
  }
  if (result.status === 409) {
    return new A2aApplicationError("message-conflict", result.reason);
  }
  return new A2aApplicationError("invalid-input", result.reason);
}

export function createA2aInvocations(
  registry: PublicationRegistry,
  manager: RunManager,
  runStore: RunStore,
  rootDir: string,
  connection?: Database.Database,
  rateLimiter?: RateLimiter,
): A2aInvocations {
  return new A2aInvocations(registry, manager, runStore, rootDir, new A2aStore(rootDir, connection), rateLimiter);
}
