import type { StageEnvelope, TerminalEnvelope } from "../types/envelope.js";
import type { CompletionContract } from "../types/completion.js";
import type { CloneEmitContext, ForkEmitContext } from "../types/forkChoice.js";
import type { StageConfig } from "../types/stage.js";
import type { FeedbackLoopConfig } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";
import type { StageActivityEvent } from "./activity.js";
import type { StageRoots } from "../runtime/stageRoots.js";
import type { QaExchange } from "../hitl/qaTrail.js";

/** Opaque to runtime; adapters interpret. */
export type StageResumeToken = string;

export type StageSessionMode =
  | "fresh"
  | "waiting_resume"
  | "feedback_resume"
  | "new_session";

export type StageRepairContext = {
  prior_attempt: number;
  /** Operator-authored instructions for an explicitly approved manual retry. */
  operator_guidance?: string;
  failed_checks?: Array<{
    id: string;
    type: string;
    evidence_preview?: string;
  }>;
};

export type FeedbackLoopContext = {
  loop_id: string;
  replay_id: string;
  source_stage_id: string;
  target_stage_id: string;
  /** Original send-back envelope from the source (feedback + artifacts). */
  feedback_envelope: StageEnvelope;
  /** One-based replay number for this send-back. */
  replay_number: number;
  max_replays: number;
  remaining_replays: number;
  is_final_replay: boolean;
  replay_session: "resume" | "new_session";
  /** Persistent stages on the active target→source route, forward order. */
  route_stage_ids: string[];
  /** Prior pass/session identity for THIS stage when resuming, if any. */
  prior_stage_attempt?: number;
  prior_pass_status?: string;
  /** Active fork generation for this stage's parent fan-out, if any. */
  active_fork_generation_id?: string;
  active_fork_clone_stage_ids?: string[];
};

export type StageRunInput = {
  roots: StageRoots;
  stage: StageConfig;
  /** Runtime instance id (`work~2`). Defaults to `stage.id` when omitted. */
  stageId?: string;
  task: TaskFile;
  priorEnvelope: StageEnvelope | null;
  priorEnvelopes?: StageEnvelope[];
  priorEnvelopesByStage?: Record<string, TerminalEnvelope | TerminalEnvelope[]>;
  timeoutMs?: number;
  resumeToken?: StageResumeToken;
  /** Launch/session mode; omitted is treated as `"fresh"`. */
  sessionMode?: StageSessionMode;
  /** Optional observe hook; HITL wait/answer uses openStage beside this. */
  onActivity?: (event: StageActivityEvent) => void;
  skillFilePath?: string;
  forkEmitContext?: ForkEmitContext;
  cloneEmitContext?: CloneEmitContext;
  /** Declared source policy; successful emits must continue or send work back. */
  feedbackLoopEmitContext?: FeedbackLoopConfig;
  /** Replay context for stages being replayed (and typically the source on send-back). */
  feedbackLoopContext?: FeedbackLoopContext;
  /** Frozen pipeline-owned checks that must pass before Stageflow advances. */
  completionContract?: CompletionContract;
  /** Compact evidence from the failed verification that triggered this repair. */
  repairContext?: StageRepairContext;
  /** Live attempt-scoped QA trail; read at emit execute time, not bootstrap time. */
  readQaTrail?: () => QaExchange[] | Promise<QaExchange[]>;
};

export function runtimeStageId(input: Pick<StageRunInput, "stage" | "stageId">): string {
  return input.stageId ?? input.stage.id;
}

export type StageRunResult =
  | { ok: true; envelope: StageEnvelope }
  | { ok: false; reason: string; envelope?: StageEnvelope };

/** Opaque wait-request blob; T2 owns concrete prompt shapes later. */
export type OpaqueWaitRequest = unknown;

/** Opaque answer blob; T2 owns concrete answer shapes later. */
export type OpaqueAnswer = unknown;

export type StageHandleCloseOptions = {
  /** Keep an in-flight ask_operator tool call open for cross-process resume. */
  park?: boolean;
};

export type StageHandleEvent =
  | { status: "waiting_for_input"; request: OpaqueWaitRequest }
  | { status: "completed"; result: StageRunResult };

/**
 * Live stage session handle. Runtime pulls wait-or-complete via `next()`,
 * unblocks with `deliverAnswer`, and releases with `close`.
 */
export interface StageHandle {
  readonly stageId: string;
  next(): Promise<StageHandleEvent>;
  deliverAnswer(answer: OpaqueAnswer): void;
  close(options?: StageHandleCloseOptions): Promise<void>;
}

export interface AgentPort {
  openStage(input: StageRunInput): StageHandle;
  runStage(input: StageRunInput): Promise<StageRunResult>;
}

/** Thin non-HITL wrapper: open → next; unexpected wait fails closed. */
export async function runStageViaOpen(
  port: Pick<AgentPort, "openStage">,
  input: StageRunInput,
): Promise<StageRunResult> {
  const handle = port.openStage(input);
  try {
    const event = await handle.next();
    if (event.status === "waiting_for_input") {
      return {
        ok: false,
        reason: "stage requested wait; use openStage/deliverAnswer",
      };
    }
    return event.result;
  } finally {
    await handle.close();
  }
}

/** Wrap a single-shot runner as a handle that never waits (Pi U2 shim). */
export function createCompletedOnlyStageHandle(options: {
  stageId: string;
  run: () => Promise<StageRunResult>;
}): StageHandle {
  let settled: StageHandleEvent | undefined;
  let closed = false;
  const runPromise = options.run().then((result) => {
    settled = { status: "completed", result };
    return settled;
  });

  return {
    stageId: options.stageId,
    async next() {
      if (closed) {
        return {
          status: "completed",
          result: { ok: false, reason: "stage handle closed" },
        };
      }
      if (settled) return settled;
      return runPromise;
    },
    deliverAnswer() {},
    async close() {
      closed = true;
      await runPromise.catch(() => undefined);
    },
  };
}

export const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
