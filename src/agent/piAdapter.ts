/**
 * Pi implementation of AgentPort.
 *
 * One stage = one `createAgentSession` (single-shot SDK path, not
 * AgentSessionRuntime / interactive / RPC). The session is sealed from host
 * and global Pi resources so the stage YAML system prompt is the only
 * instruction source. Operator credentials come from
 * `ModelRuntime.create({ authPath })` using the factory-resolved binding
 * (`pi_home` or `.stageflow/agent/auth.json`).
 *
 * Extension-backed providers (e.g. Cursor via pi-cursor-sdk) plug in through
 * `StageProviderSupport` — see `providerSupport.ts` / `cursorProvider.ts`.
 * Built-in providers (anthropic, openai, …) need no support module: sealed
 * session + resolveCliModel after bindExtensions is enough.
 *
 * Lifecycle: create persisted session under the stage workspace →
 * bindExtensions → setModel → `prompt()` → bounded abort + `dispose()` in
 * finally (session file is kept). Stage completion is signaled only by
 * `emit_stage_envelope` returning `terminate: true` (do not abort from
 * inside the tool — that deadlocks bridges that wait on the tool result).
 *
 * HITL: `openStage` wires `AskOperatorWaitChannel` into a real StageHandle
 * (tool Promise → wait yield → deliverAnswer). Same-process prefers the live
 * channel; after process loss, open arms wait then `deliverAnswer` injects
 * via `injectOpaqueAnswerIntoSession` and continues. Missing/corrupt session
 * fails closed with `StageSessionReconstructError` (KTD7). Epic proving
 * vehicle: pipeline `plan-review-proving` (Pi live wait + console answers).
 *
 * `ask_operator` is registered on sealed stage sessions unless the stage
 * declares `gate_kinds: []`.
 */
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isAdvancingEnvelope } from "../envelope/check.js";
import { formatPriorEnvelope } from "../prompt/priorEnvelope.js";
import type { StageRoots } from "../runtime/stageRoots.js";
import {
  attemptContext,
  noAttemptContext,
} from "../runtime/stageAttemptContext.js";
import {
  createEmitStageEnvelopeTool,
  type EmitCapture,
} from "../tools/emitStageEnvelope.js";
import {
  createAskOperatorTool,
  type AskOperatorPrompt,
  type AskOperatorWaitBridge,
} from "../tools/askOperator.js";
import { createWriteStageArtifactTool } from "../tools/writeStageArtifact.js";
import "./cursorProvider.js";
import { findProviderSupport } from "./providerSupport.js";
import { mapSessionEventToActivity, readActivityVerbose, type StageActivityEvent } from "./activity.js";
import {
  createStageActivityObserver,
  type StageActivityObserver,
} from "./activityObserver.js";
import type {
  AgentPort,
  OpaqueAnswer,
  StageHandle,
  StageHandleCloseOptions,
  StageHandleEvent,
  StageRunInput,
  StageRunResult,
} from "./port.js";
import { DEFAULT_STAGE_TIMEOUT_MS, runtimeStageId, runStageViaOpen } from "./port.js";
import type { StageGateKind } from "../types/stage.js";

/**
 * Stage tool allowlist for sealed Pi sessions.
 * Includes `ask_operator` unless `gateKinds` is an empty list (R6).
 * `write_stage_artifact` when registered (always, for bound and unbound —
 * bound/unbound only gates cwd / env bind).
 */
export function resolveStageToolNames(
  emitToolName: string,
  artifactToolName?: string,
  askOperatorToolName = "ask_operator",
  gateKinds?: StageGateKind[],
): string[] {
  const tools = [
    "read",
    "bash",
    "write",
    "edit",
    emitToolName,
  ];
  if (gateKinds === undefined || gateKinds.length > 0) {
    tools.push(askOperatorToolName);
  }
  if (artifactToolName) {
    tools.push(artifactToolName);
  }
  return tools;
}

/**
 * In-process wait channel for `ask_operator` → StageHandle yield/deliver.
 * HITL `openStage` connects this via `setWaitHandler` + handle `deliverAnswer`.
 */
export class AskOperatorWaitChannel implements AskOperatorWaitBridge {
  private pending:
    | {
        prompt: AskOperatorPrompt;
        resolve: (answer: unknown) => void;
        reject: (err: unknown) => void;
      }
    | undefined;
  private onWait: ((prompt: AskOperatorPrompt) => void) | undefined;

  setWaitHandler(handler: (prompt: AskOperatorPrompt) => void): void {
    this.onWait = handler;
  }

  requestWait(prompt: AskOperatorPrompt): Promise<unknown> {
    const handler = this.onWait;
    if (!handler) {
      return Promise.reject(
        new Error(
          "ask_operator: Pi live wait channel not connected (openStage must setWaitHandler; use FakeAgent for scripted HITL)",
        ),
      );
    }
    if (this.pending) {
      return Promise.reject(
        new Error("ask_operator: wait already pending for this stage session"),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      this.pending = { prompt, resolve, reject };
      try {
        handler(prompt);
      } catch (err) {
        this.pending = undefined;
        reject(err);
      }
    });
  }

  deliverAnswer(answer: unknown): boolean {
    if (!this.pending) return false;
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(answer);
    return true;
  }

  rejectPending(reason: string): void {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = undefined;
    reject(new Error(reason));
  }

  get hasPending(): boolean {
    return this.pending !== undefined;
  }
}

/**
 * Bridge used when no StageHandle wait loop is connected.
 * Calling ask_operator fails closed instead of hanging the session.
 */
export function createUnconnectedAskWaitBridge(): AskOperatorWaitBridge {
  return {
    requestWait: async () => {
      throw new Error(
        "ask_operator: Pi live wait channel not connected (openStage must setWaitHandler; use FakeAgent for scripted HITL)",
      );
    },
  };
}

export type ConnectedAskWaitResume = {
  onDeliver: (answer: OpaqueAnswer) => void;
  continueRun: () => Promise<StageRunResult>;
};

export type ConnectedAskWaitStageHandleOptions = {
  stageId: string;
  askWaitChannel: AskOperatorWaitChannel;
  run: () => Promise<StageRunResult>;
  onBeforeWaitYield?: (prompt: AskOperatorPrompt) => void;
  onClose?: (options?: StageHandleCloseOptions) => Promise<void>;
  resume?: ConnectedAskWaitResume;
};

/**
 * Connect `AskOperatorWaitChannel` (tool Promise) to a StageHandle wait/deliver
 * loop. Pipeline park stays on StageHitlController via this handle only —
 * runtime never imports the channel.
 */
export function createConnectedAskWaitStageHandle(
  options: ConnectedAskWaitStageHandleOptions,
): StageHandle {
  const { askWaitChannel: channel } = options;
  let closed = false;
  let runLaunched = false;
  let resumeArmed = options.resume !== undefined;
  let resumeResolve: ((answer: OpaqueAnswer) => void) | undefined;
  let resumePromise: Promise<OpaqueAnswer> | undefined;
  let resumeDeliverError: unknown;
  let resumeDeliverStarted = false;

  if (resumeArmed) {
    resumePromise = new Promise<OpaqueAnswer>((resolve) => {
      resumeResolve = resolve;
    });
  }

  const eventQueue: StageHandleEvent[] = [];
  const eventWaiters: Array<(event: StageHandleEvent) => void> = [];

  const enqueue = (event: StageHandleEvent): void => {
    const waiter = eventWaiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    eventQueue.push(event);
  };

  const takeEvent = (): Promise<StageHandleEvent> => {
    if (eventQueue.length > 0) {
      return Promise.resolve(eventQueue.shift()!);
    }
    return new Promise<StageHandleEvent>((resolve) => {
      eventWaiters.push(resolve);
    });
  };

  const settleFromRun = (run: () => Promise<StageRunResult>): void => {
    void run()
      .then((result) => {
        if (!closed) {
          enqueue({ status: "completed", result });
        }
      })
      .catch((err) => {
        if (!closed) {
          enqueue({
            status: "completed",
            result: {
              ok: false,
              reason: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });
  };

  channel.setWaitHandler((prompt) => {
    options.onBeforeWaitYield?.(prompt);
    enqueue({ status: "waiting_for_input", request: prompt });
  });

  return {
    stageId: options.stageId,
    async next(): Promise<StageHandleEvent> {
      if (closed) {
        return {
          status: "completed",
          result: { ok: false, reason: "stage handle closed" },
        };
      }

      if (resumeArmed) {
        await resumePromise!;
        resumeArmed = false;
        if (closed) {
          return {
            status: "completed",
            result: { ok: false, reason: "stage handle closed" },
          };
        }
        if (resumeDeliverError !== undefined) {
          return {
            status: "completed",
            result: {
              ok: false,
              reason:
                resumeDeliverError instanceof Error
                  ? resumeDeliverError.message
                  : String(resumeDeliverError),
            },
          };
        }
        settleFromRun(options.resume!.continueRun);
        return takeEvent();
      }

      if (!runLaunched) {
        runLaunched = true;
        settleFromRun(options.run);
      }
      return takeEvent();
    },
    deliverAnswer(answer: OpaqueAnswer) {
      if (resumeArmed && options.resume && !resumeDeliverStarted) {
        resumeDeliverStarted = true;
        try {
          options.resume.onDeliver(answer);
        } catch (err) {
          resumeDeliverError = err;
        }
        const resolve = resumeResolve;
        resumeResolve = undefined;
        resolve?.(answer);
        return;
      }
      channel.deliverAnswer(answer);
    },
    async close(closeOptions?: StageHandleCloseOptions) {
      closed = true;
      if (closeOptions?.park) {
        await options.onClose?.({ park: true });
        return;
      }
      channel.rejectPending("stage handle closed");
      if (resumeResolve) {
        const resolve = resumeResolve;
        resumeResolve = undefined;
        resumeArmed = false;
        resolve(undefined as unknown as OpaqueAnswer);
      }
      while (eventWaiters.length > 0) {
        const waiter = eventWaiters.shift();
        waiter?.({
          status: "completed",
          result: { ok: false, reason: "stage handle closed" },
        });
      }
      await options.onClose?.({ park: false });
    },
  };
}

/**
 * Extract display text from a Pi tool_execution_update partialResult.
 * Prefers content[].text blocks; otherwise JSON-stringifies.
 */
export function extractPartialResultText(partialResult: unknown): string {
  if (partialResult === undefined || partialResult === null) {
    return "";
  }
  if (typeof partialResult === "string") {
    return partialResult;
  }
  if (typeof partialResult === "object") {
    const content = (partialResult as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
      if (parts.length > 0) {
        return parts.join("");
      }
    }
    try {
      return JSON.stringify(partialResult);
    } catch {
      return String(partialResult);
    }
  }
  return String(partialResult);
}

export type RouteSessionEventToProgressOptions = {
  observer: StageActivityObserver;
  verbose: boolean;
};

/**
 * Adapter-edge routing: stream deltas to the observer, map milestones to
 * StageActivityEvent. Verbose thinking / live tool partials go to observer
 * hooks (stderr streams + coalesced/throttled persist via onActivity).
 */
export function routeSessionEventToProgress(
  event: Record<string, unknown>,
  options: RouteSessionEventToProgressOptions,
): void {
  const { observer, verbose } = options;

  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;
    if (ame && typeof ame === "object") {
      const update = ame as { type?: string; delta?: string };
      if (update.type === "text_delta") {
        observer.onAssistantTextDelta(update.delta ?? "");
        return;
      }
      if (verbose && update.type === "thinking_delta") {
        observer.onThinkingDelta(update.delta ?? "");
        return;
      }
    }
    return;
  }

  if (
    verbose &&
    event.type === "tool_execution_update"
  ) {
    const text = extractPartialResultText(event.partialResult);
    if (text) {
      observer.onToolPartialResult(text);
    }
    return;
  }

  if (event.type === "message_end" || event.type === "agent_end") {
    observer.onStreamBoundary();
  }

  if (
    event.type === "agent_start" ||
    event.type === "turn_start" ||
    event.type === "tool_execution_start"
  ) {
    observer.onStreamBoundary();
  }

  const activity = mapSessionEventToActivity(event);
  if (!activity) {
    return;
  }
  observer.onActivity(activity);
}

/**
 * Map Pi session events to StageActivityEvent at the adapter edge, then
 * forward to the activity observer (stderr + onActivity).
 */
function attachStageProgress(
  session: AgentSession,
  onActivity?: (event: StageActivityEvent) => void,
): () => void {
  const observer = createStageActivityObserver({ onActivity, writeStderr: true });
  const verbose = readActivityVerbose();

  const unsubscribe = session.subscribe((event) => {
    routeSessionEventToProgress(event as unknown as Record<string, unknown>, {
      observer,
      verbose,
    });
  });

  return () => {
    unsubscribe();
    observer.dispose();
  };
}

function buildUserPrompt(
  input: StageRunInput,
  emitToolName: string,
  emitHintOverride?: string,
  artifactToolName?: string,
): string {
  let emitHint =
    emitHintOverride ??
    `Required final action: call ${emitToolName} exactly once with status, summary, and artifacts (run-relative paths).`;

  if (input.stage.payload_schema !== undefined) {
    emitHint += `\nOn status=success, payload is required and must match this JSON Schema:\n${JSON.stringify(input.stage.payload_schema, null, 2)}`;
  }

  const checklistChecks = input.completionContract?.checks.filter(
    (check) => check.type === "checklist",
  ) ?? [];
  if (checklistChecks.length > 0) {
    emitHint += `\nBefore emitting success, self-review every required checklist item. Include checklist_attestations in the envelope with each check_id and its complete item list exactly as declared:\n${JSON.stringify(checklistChecks, null, 2)}`;
  }

  if (input.repairContext !== undefined) {
    emitHint += `\nThis is recovery attempt ${input.roots.attempt ?? input.repairContext.prior_attempt + 1}. The previous candidate did not pass Stageflow verification. Address the failed checks before emitting success.`;
    if (input.repairContext.operator_guidance) {
      emitHint += `\nThe operator approved this retry with these instructions:\n${input.repairContext.operator_guidance}`;
    }
    if (input.repairContext.failed_checks?.length) {
      emitHint += `\nFailed-check evidence from attempt ${input.repairContext.prior_attempt}:\n${JSON.stringify(input.repairContext.failed_checks, null, 2)}`;
    }
  }

  const attempt = input.roots.attempt ?? 1;
  const attemptArtifactsPath = `stages/${runtimeStageId(input)}/attempts/${attempt}/artifacts/`;
  const skillBaseDir =
    input.stage.skill !== undefined && input.skillFilePath !== undefined
      ? path.dirname(input.skillFilePath)
      : undefined;
  const artifactGuidance =
    input.roots.mode === "bound" && artifactToolName !== undefined
      ? [
          `Project checkout (agent cwd): ${input.roots.checkoutRoot}`,
          `Factory run workspace: ${input.roots.runWorkspaceDir}`,
          `Builtin tools (read, bash, write, edit) are for work inside the project checkout.`,
          skillBaseDir !== undefined
            ? `Absolute read and bash against ${skillBaseDir} are in bounds for the linked skill.`
            : undefined,
          `Create factory stage artifacts only with ${artifactToolName} (path relative to ${attemptArtifactsPath}). Use the returned run-relative path in ${emitToolName}.`,
          `This is soft guidance: prefer ${artifactToolName} for factory files under the run workspace; do not rely on relative builtin writes for those files.`,
        ]
          .filter(Boolean)
          .join("\n")
      : artifactToolName !== undefined
        ? [
            `Create factory stage artifacts with ${artifactToolName} (path relative to ${attemptArtifactsPath}). Use the returned run-relative path in ${emitToolName}.`,
            `This is soft guidance: prefer ${artifactToolName} for factory files under the run workspace; do not rely on relative builtin writes for those files.`,
          ].join("\n")
        : `Create factory stage artifacts under ${attemptArtifactsPath} relative to the run folder.`;

  return [
    `Task id: ${input.task.id}`,
    `Stage id: ${runtimeStageId(input)}`,
    `Goal: ${input.task.goal}`,
    input.task.context ? `Context: ${input.task.context}` : "",
    input.task.constraints ? `Constraints: ${input.task.constraints}` : "",
    formatPriorEnvelope(input.priorEnvelope, input.priorEnvelopes),
    "",
    artifactGuidance,
    emitHint,
  ]
    .filter(Boolean)
    .join("\n");
}

export function composeStageUserPrompt(
  input: StageRunInput,
  emitToolName: string,
  emitHintOverride?: string,
  artifactToolName?: string,
): string {
  const body = buildUserPrompt(
    input,
    emitToolName,
    emitHintOverride,
    artifactToolName,
  );
  if (input.stage.skill !== undefined) {
    return `/skill:${input.stage.skill} ${body}`;
  }
  return body;
}

/**
 * DefaultResourceLoader with host/global discovery turned off.
 *
 * Without these flags the loader walks up from the run folder and would pick
 * up the consumer project's AGENTS.md, `.agents/skills/`, `.pi/extensions`,
 * and APPEND_SYSTEM.md. Stages must not inherit that context.
 *
 * `additionalExtensionPaths` is the only way extensions enter a sealed stage
 * (used by StageProviderSupport implementations). With `noExtensions: true`,
 * discovered global/project packages stay out; only allowlisted paths load.
 * `additionalSkillPaths` is the matching allowlist for one named skill.
 */
export function createSealedResourceLoader(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPrompt: string;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalExtensionPaths: options.additionalExtensionPaths,
    additionalSkillPaths: options.additionalSkillPaths,
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
}

async function shutdownSession(session: AgentSession | undefined): Promise<void> {
  if (!session) {
    return;
  }
  // Bound abort: waitForIdle can hang if a provider bridge is mid-flight.
  try {
    await Promise.race([
      session.abort(),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  } catch {
    // ignore abort errors during teardown
  }
  try {
    session.dispose();
  } catch {
    // ignore dispose errors during teardown
  }
}

function resultFromCapture(capture: EmitCapture): StageRunResult {
  if (capture.error && !capture.envelope) {
    return { ok: false, reason: capture.error };
  }
  if (!capture.envelope) {
    return { ok: false, reason: "missing emit_stage_envelope" };
  }
  if (!isAdvancingEnvelope(capture.envelope)) {
    return {
      ok: false,
      reason: "status: failure",
      envelope: capture.envelope,
    };
  }
  return { ok: true, envelope: capture.envelope };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Stable Pi session JSONL path under the run workspace stage dir. */
export function stageSessionFilePath(
  roots: Pick<StageRoots, "runWorkspaceDir" | "attempt">,
  stageId: string,
): string {
  const ctx =
    roots.attempt !== undefined
      ? attemptContext(roots.attempt)
      : noAttemptContext();
  return ctx.sessionPath(roots.runWorkspaceDir, stageId);
}

export function resolveStageSessionFile(input: StageRunInput): string {
  return (
    input.resumeToken ??
    stageSessionFilePath(input.roots, runtimeStageId(input))
  );
}

export class StageSessionReconstructError extends Error {
  readonly stageId: string;
  readonly sessionFile: string;

  constructor(
    message: string,
    options: { stageId: string; sessionFile: string; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StageSessionReconstructError";
    this.stageId = options.stageId;
    this.sessionFile = options.sessionFile;
  }
}

/**
 * Create or reopen the durable stage session file under the run workspace.
 * Touches an empty file first so Pi flushes the session header immediately.
 */
export async function createStageSessionManager(
  roots: StageRoots,
  stageId: string,
  sessionFile = stageSessionFilePath(roots, stageId),
): Promise<SessionManager> {
  await mkdir(path.dirname(sessionFile), { recursive: true });
  if (!(await fileExists(sessionFile))) {
    await writeFile(sessionFile, "");
  }
  return SessionManager.open(sessionFile, path.dirname(sessionFile), roots.cwd);
}

/**
 * Open an existing stage session for post-restart reconstruct.
 * Missing or corrupt files fail closed (KTD7) — never create a fresh session.
 */
export async function openStageSessionManager(
  roots: StageRoots,
  stageId: string,
): Promise<SessionManager> {
  const sessionFile = stageSessionFilePath(roots, stageId);
  if (!(await fileExists(sessionFile))) {
    throw new StageSessionReconstructError(
      `stage session file missing for resume: ${sessionFile}`,
      { stageId, sessionFile },
    );
  }
  try {
    return SessionManager.open(sessionFile, path.dirname(sessionFile), roots.cwd);
  } catch (err) {
    throw new StageSessionReconstructError(
      `stage session file corrupt or unreadable for resume: ${sessionFile}`,
      { stageId, sessionFile, cause: err },
    );
  }
}

/**
 * Ensure the session is on disk before signaling waiting_for_input (KTD4).
 * Dispose of the live AgentSession must not delete this file.
 */
export function ensureStageSessionFlushed(
  sessionManager: SessionManager,
  stageId: string,
): string {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionManager.isPersisted() || !sessionFile) {
    throw new StageSessionReconstructError(
      "stage session is not persisted; cannot wait for input",
      { stageId, sessionFile: sessionFile ?? "(none)" },
    );
  }
  return sessionFile;
}

const PREMATURE_ASK_OPERATOR_CLOSE = "stage handle closed";

/**
 * Remove an erroneous ask_operator toolResult written when a parked worker
 * tears down before the operator answers. Restores an open tool call on disk.
 */
export async function repairPrematureAskOperatorClosure(
  sessionFile: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }

  const entries: unknown[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      return false;
    }
  }

  let changed = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: string }).type !== "message") continue;
    const message = (entry as { message?: Record<string, unknown> }).message;
    if (!message || message.role !== "toolResult") continue;
    if (message.toolName !== "ask_operator" || message.isError !== true) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const first = content[0] as { text?: string } | undefined;
    if (first?.text !== PREMATURE_ASK_OPERATOR_CLOSE) continue;

    entries.splice(i, 1);
    changed = true;
    while (i < entries.length) {
      const next = entries[i];
      if (!next || typeof next !== "object") break;
      if ((next as { type?: string }).type !== "message") break;
      const nextMessage = (next as { message?: Record<string, unknown> }).message;
      if (nextMessage?.role !== "assistant") break;
      if (
        nextMessage.stopReason === "error" ||
        typeof nextMessage.errorMessage === "string"
      ) {
        entries.splice(i, 1);
        continue;
      }
      break;
    }
    break;
  }

  if (!changed) {
    return false;
  }

  await writeFile(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return true;
}

function opaqueAnswerToText(answer: OpaqueAnswer): string {
  if (typeof answer === "string") return answer;
  try {
    return JSON.stringify(answer);
  } catch {
    return String(answer);
  }
}

type OpenToolCall = { toolCallId: string; toolName: string };

function findOpenToolCall(sessionManager: SessionManager): OpenToolCall | undefined {
  const entries = sessionManager.buildContextEntries();
  const answered = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      toolCallId?: string;
    };
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      content?: unknown;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "toolCall"
      ) {
        const toolCall = block as {
          id?: string;
          name?: string;
        };
        if (
          typeof toolCall.id === "string" &&
          typeof toolCall.name === "string" &&
          !answered.has(toolCall.id)
        ) {
          return { toolCallId: toolCall.id, toolName: toolCall.name };
        }
      }
    }
  }
  return undefined;
}

export type InjectOpaqueAnswerResult = {
  injectedAs: "tool_result" | "custom_message";
  toolCallId?: string;
  toolName?: string;
};

/**
 * Inject an opaque operator answer into the persisted conversation (R9).
 * Prefers completing an open tool call as a tool result (T2 seam); otherwise
 * appends a custom message that stays in LLM context.
 */
export function injectOpaqueAnswerIntoSession(
  sessionManager: SessionManager,
  answer: OpaqueAnswer,
): InjectOpaqueAnswerResult {
  const text = opaqueAnswerToText(answer);
  const open = findOpenToolCall(sessionManager);
  if (open) {
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: open.toolCallId,
      toolName: open.toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    });
    return {
      injectedAs: "tool_result",
      toolCallId: open.toolCallId,
      toolName: open.toolName,
    };
  }

  sessionManager.appendCustomMessageEntry(
    "stageflow.operator_answer",
    text,
    true,
    { answer },
  );
  return { injectedAs: "custom_message" };
}

export type ReconstructedStageSession = {
  session: AgentSession;
  sessionManager: SessionManager;
  sessionFile: string;
  injection: InjectOpaqueAnswerResult;
  restore: () => void;
  shutdown: () => Promise<void>;
};

type StageSessionWiring = {
  sessionManager: SessionManager;
  modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
  settingsManager: SettingsManager;
  loader: DefaultResourceLoader;
  tools: string[];
  customTools: ReturnType<typeof defineTool>[];
  emitDefName: string;
  askOperatorDefName?: string;
  artifactDefName?: string;
  providerEmitHint?: string;
  restoreProvider?: () => void;
  capture: EmitCapture;
  askWaitChannel: AskOperatorWaitChannel;
};

async function prepareStageSessionWiring(
  input: StageRunInput,
  sessionManager: SessionManager,
  existingAskWaitChannel?: AskOperatorWaitChannel,
): Promise<StageSessionWiring | StageRunResult> {
  const { roots } = input;
  const provider = findProviderSupport(input.stage.model);
  const capture: EmitCapture = {};
  const askWaitChannel = existingAskWaitChannel ?? new AskOperatorWaitChannel();

  const emitDef = createEmitStageEnvelopeTool(
    capture,
    input.stage.payload_schema,
    input.forkEmitContext,
    input.cloneEmitContext,
  );
  const emitTool = defineTool(emitDef);

  const gateKinds = input.stage.gate_kinds;
  const includeAsk = gateKinds === undefined || gateKinds.length > 0;
  const askDef = includeAsk
    ? createAskOperatorTool({
        requestWait: (prompt) => askWaitChannel.requestWait(prompt),
        ...(gateKinds !== undefined ? { allowedKinds: gateKinds } : {}),
      })
    : undefined;
  const askTool = askDef ? defineTool(askDef) : undefined;

  const artifactDef = createWriteStageArtifactTool({
    runWorkspaceDir: roots.runWorkspaceDir,
    stageId: runtimeStageId(input),
    attempt: roots.attempt ?? 1,
  });
  const artifactTool = defineTool(artifactDef);

  if (input.stage.skill !== undefined && input.skillFilePath === undefined) {
    return {
      ok: false,
      reason: `Skill "${input.stage.skill}" is not installed`,
    };
  }

  const additionalExtensionPaths: string[] = [];
  let restoreProvider: (() => void) | undefined;
  if (provider) {
    const prepared = provider.prepare(input.stage.model);
    if (prepared.error) {
      return { ok: false, reason: prepared.error };
    }
    additionalExtensionPaths.push(...prepared.extensionPaths);
    restoreProvider = prepared.restore;
  }

  try {
    const modelRuntime = await ModelRuntime.create(
      roots.authPath
        ? {
            authPath: roots.authPath,
            // ModelRuntime otherwise resolves models.json from getAgentDir(),
            // which bindPiAgentDirEnv seals to an empty per-attempt sandbox
            // dir. Point it at the same durable agent dir as authPath so
            // custom providers (e.g. a self-hosted OpenAI-compatible
            // gateway) defined there stay usable in sealed stage sessions.
            modelsPath: path.join(path.dirname(roots.authPath), "models.json"),
          }
        : undefined,
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const loader = createSealedResourceLoader({
      cwd: roots.cwd,
      agentDir: roots.agentDir,
      settingsManager,
      systemPrompt: input.stage.system_prompt,
      additionalExtensionPaths,
      ...(input.skillFilePath !== undefined
        ? { additionalSkillPaths: [input.skillFilePath] }
        : {}),
    });
    await loader.reload();

    const extensionErrors = loader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      restoreProvider?.();
      return {
        ok: false,
        reason: `Failed to load Pi extension(s): ${extensionErrors
          .map((e) => `${e.path}: ${e.error}`)
          .join("; ")}`,
      };
    }

    const skillDiagnostics = loader
      .getSkills()
      .diagnostics.filter((d) => d.type === "error" || d.type === "collision");
    if (skillDiagnostics.length > 0) {
      restoreProvider?.();
      return {
        ok: false,
        reason: `Failed to load skill(s): ${skillDiagnostics
          .map((d) => (d.path !== undefined ? `${d.path}: ${d.message}` : d.message))
          .join("; ")}`,
      };
    }
    if (
      input.stage.skill !== undefined &&
      !loader.getSkills().skills.some((skill) => skill.name === input.stage.skill)
    ) {
      restoreProvider?.();
      return {
        ok: false,
        reason: `Skill "${input.stage.skill}" is not installed`,
      };
    }

    const customTools = askTool
      ? [emitTool, askTool, artifactTool]
      : [emitTool, artifactTool];

    return {
      sessionManager,
      modelRuntime,
      settingsManager,
      loader,
      tools: resolveStageToolNames(
        emitDef.name,
        artifactDef.name,
        askDef?.name ?? "ask_operator",
        gateKinds,
      ),
      customTools,
      emitDefName: emitDef.name,
      ...(askDef ? { askOperatorDefName: askDef.name } : {}),
      artifactDefName: artifactDef.name,
      providerEmitHint: provider?.emitToolHint?.(emitDef.name),
      restoreProvider,
      capture,
      askWaitChannel,
    };
  } catch (err) {
    restoreProvider?.();
    throw err;
  }
}

function isStageRunResult(
  value: StageSessionWiring | StageRunResult,
): value is StageRunResult {
  return "ok" in value;
}

/**
 * Reconstruct an equivalent Pi session after process loss and inject the
 * operator answer into conversation context (R5, R9, R10 / KTD5).
 * Does not auto-continue the model turn — U4 owns the yield loop.
 */
export async function reconstructStageSessionForAnswer(
  input: StageRunInput,
  answer: OpaqueAnswer,
): Promise<ReconstructedStageSession> {
  const sessionManager = await openStageSessionManager(
    input.roots,
    runtimeStageId(input),
  );
  const sessionFile = ensureStageSessionFlushed(sessionManager, runtimeStageId(input));

  let injection: InjectOpaqueAnswerResult;
  try {
    injection = injectOpaqueAnswerIntoSession(sessionManager, answer);
  } catch (err) {
    throw new StageSessionReconstructError(
      `failed to inject answer into stage session: ${sessionFile}`,
      { stageId: runtimeStageId(input), sessionFile, cause: err },
    );
  }

  const wiring = await prepareStageSessionWiring(input, sessionManager);
  if (isStageRunResult(wiring)) {
    throw new StageSessionReconstructError(
      wiring.ok === false ? wiring.reason : "stage session reconstruct failed",
      { stageId: runtimeStageId(input), sessionFile },
    );
  }

  let session: AgentSession | undefined;
  try {
    const created = await createAgentSession({
      cwd: input.roots.cwd,
      agentDir: input.roots.agentDir,
      modelRuntime: wiring.modelRuntime,
      tools: wiring.tools,
      customTools: wiring.customTools,
      resourceLoader: wiring.loader,
      sessionManager,
      settingsManager: wiring.settingsManager,
    });
    session = created.session;
    await session.bindExtensions({});

    const resolved = resolveCliModel({
      cliModel: input.stage.model,
      modelRuntime: wiring.modelRuntime,
    });
    if (resolved.error || !resolved.model) {
      throw new StageSessionReconstructError(
        resolved.error ?? `Model not found: ${input.stage.model}`,
        { stageId: runtimeStageId(input), sessionFile },
      );
    }
    await session.setModel(resolved.model);
    if (resolved.thinkingLevel) {
      session.setThinkingLevel(resolved.thinkingLevel);
    }

    const liveSession = session;
    return {
      session: liveSession,
      sessionManager,
      sessionFile,
      injection,
      restore: () => {
        wiring.restoreProvider?.();
      },
      shutdown: async () => {
        await shutdownSession(liveSession);
        wiring.restoreProvider?.();
      },
    };
  } catch (err) {
    await shutdownSession(session);
    wiring.restoreProvider?.();
    if (err instanceof StageSessionReconstructError) throw err;
    throw new StageSessionReconstructError(
      `failed to reconstruct stage session: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { stageId: runtimeStageId(input), sessionFile, cause: err },
    );
  }
}

async function bindStageSession(
  input: StageRunInput,
  sessionManager: SessionManager,
  wiring: StageSessionWiring,
): Promise<AgentSession | StageRunResult> {
  const { roots } = input;
  const created = await createAgentSession({
    cwd: roots.cwd,
    agentDir: roots.agentDir,
    modelRuntime: wiring.modelRuntime,
    tools: wiring.tools,
    customTools: wiring.customTools,
    resourceLoader: wiring.loader,
    sessionManager,
    settingsManager: wiring.settingsManager,
  });
  const session = created.session;
  ensureStageSessionFlushed(sessionManager, runtimeStageId(input));
  await session.bindExtensions({});

  const resolved = resolveCliModel({
    cliModel: input.stage.model,
    modelRuntime: wiring.modelRuntime,
  });
  if (resolved.error || !resolved.model) {
    await shutdownSession(session);
    return {
      ok: false,
      reason: resolved.error ?? `Model not found: ${input.stage.model}`,
    };
  }

  try {
    await session.setModel(resolved.model);
    if (resolved.thinkingLevel) {
      session.setThinkingLevel(resolved.thinkingLevel);
    }
  } catch (err) {
    await shutdownSession(session);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return session;
}

function syncAgentMessagesFromSession(
  session: AgentSession,
  sessionManager: SessionManager,
): void {
  session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

export class PiAgentAdapter implements AgentPort {
  openStage(input: StageRunInput): StageHandle {
    const timeoutMs = input.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    const askWaitChannel = new AskOperatorWaitChannel();
    const sessionFile = resolveStageSessionFile(input);

    let sessionManager: SessionManager | undefined;
    let resumeWaiting = false;

    if (existsSync(sessionFile)) {
      try {
        sessionManager = SessionManager.open(
          sessionFile,
          path.dirname(sessionFile),
          input.roots.cwd,
        );
      } catch (err) {
        throw new StageSessionReconstructError(
          `stage session file corrupt or unreadable for resume: ${sessionFile}`,
          {
            stageId: runtimeStageId(input),
            sessionFile,
            cause: err,
          },
        );
      }
      ensureStageSessionFlushed(sessionManager, runtimeStageId(input));
      if (!findOpenToolCall(sessionManager)) {
        throw new StageSessionReconstructError(
          `stage session has no open tool call for resume: ${sessionFile}`,
          { stageId: runtimeStageId(input), sessionFile },
        );
      }
      resumeWaiting = true;
    }

    let session: AgentSession | undefined;
    let wiring: StageSessionWiring | undefined;
    let unsubscribeProgress: (() => void) | undefined;
    let prepareError: StageRunResult | undefined;

    const preparePromise = (async () => {
      if (!sessionManager) {
        sessionManager = await createStageSessionManager(
          input.roots,
          runtimeStageId(input),
          sessionFile,
        );
      }
      const prepared = await prepareStageSessionWiring(
        input,
        sessionManager,
        askWaitChannel,
      );
      if (isStageRunResult(prepared)) {
        prepareError = prepared;
        return;
      }
      wiring = prepared;
      const bound = await bindStageSession(input, sessionManager, wiring);
      if (bound && typeof bound === "object" && "ok" in bound) {
        prepareError = bound;
        wiring.restoreProvider?.();
        wiring = undefined;
        return;
      }
      session = bound;
      unsubscribeProgress = attachStageProgress(session, input.onActivity);
    })();

    const runWithTimeout = async (
      work: () => Promise<void>,
    ): Promise<StageRunResult> => {
      await preparePromise;
      if (prepareError) return prepareError;
      if (!session || !wiring || !sessionManager) {
        return { ok: false, reason: "stage session failed to prepare" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const workPromise = work();
        const abortPromise = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`stage timed out after ${timeoutMs}ms`));
          });
        });
        await Promise.race([workPromise, abortPromise]);
        return resultFromCapture(wiring.capture);
      } catch (err) {
        if (wiring.capture.envelope && isAdvancingEnvelope(wiring.capture.envelope)) {
          return { ok: true, envelope: wiring.capture.envelope };
        }
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
          envelope: wiring.capture.envelope,
        };
      } finally {
        clearTimeout(timer);
      }
    };

    return createConnectedAskWaitStageHandle({
      stageId: runtimeStageId(input),
      askWaitChannel,
      onBeforeWaitYield: () => {
        if (sessionManager) {
          ensureStageSessionFlushed(sessionManager, runtimeStageId(input));
        }
      },
      run: async () => {
        return runWithTimeout(async () => {
          const userPrompt = composeStageUserPrompt(
            input,
            wiring!.emitDefName,
            wiring!.providerEmitHint,
            wiring!.artifactDefName,
          );
          await session!.prompt(userPrompt);
        });
      },
      resume: resumeWaiting
        ? {
            onDeliver: (answer) => {
              if (!sessionManager) {
                throw new StageSessionReconstructError(
                  "stage session missing during resume deliver",
                  { stageId: runtimeStageId(input), sessionFile },
                );
              }
              injectOpaqueAnswerIntoSession(sessionManager, answer);
              if (session) {
                syncAgentMessagesFromSession(session, sessionManager);
              }
            },
            continueRun: async () => {
              return runWithTimeout(async () => {
                if (!session || !sessionManager) {
                  throw new StageSessionReconstructError(
                    "stage session missing during resume continue",
                    { stageId: runtimeStageId(input), sessionFile },
                  );
                }
                syncAgentMessagesFromSession(session, sessionManager);
                await session.agent.continue();
              });
            },
          }
        : undefined,
      onClose: async (closeOptions) => {
        await preparePromise.catch(() => undefined);
        if (closeOptions?.park) {
          if (sessionManager) {
            ensureStageSessionFlushed(sessionManager, runtimeStageId(input));
            if (askWaitChannel.hasPending) {
              await repairPrematureAskOperatorClosure(sessionFile);
            }
          }
          return;
        }
        askWaitChannel.rejectPending(PREMATURE_ASK_OPERATOR_CLOSE);
        unsubscribeProgress?.();
        await shutdownSession(session);
        wiring?.restoreProvider?.();
      },
    });
  }

  async runStage(input: StageRunInput): Promise<StageRunResult> {
    return runStageViaOpen(this, input);
  }
}
