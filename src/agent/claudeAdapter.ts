/**
 * Claude Agent SDK implementation of AgentPort.
 *
 * One turn = one streaming-input `query()` call, spawned as a subprocess by
 * the SDK. The session is sealed the same way Pi's sealed stage session is:
 * a custom (not preset) system prompt with nothing appended, no filesystem
 * settings sources, and a fixed built-in tool allowlist — plus one
 * in-process MCP server (`buildStageflowMcpServer`) carrying
 * `emit_stage_envelope`, `write_stage_artifact`, and (when the stage's
 * `gate_kinds` allow it) `ask_operator`. Permission prompts are bypassed
 * outright: there is no human attached to a stage session to answer them,
 * exactly like Pi's sealed session never surfaces an interactive approval
 * loop either.
 *
 * HITL — "never let it go dangling" (confirmed by spike, see the adapter's
 * plan doc): `ask_operator`'s handler never blocks. It records the prompt
 * and returns an immediate placeholder result; the tool description tells
 * the model to stop, and this adapter calls `query.interrupt()` right after
 * observing that result as a backstop that doesn't depend on the model
 * cooperating. By the time a stage reports `waiting_for_input`, the Claude
 * CLI subprocess has already exited on its own — `close({park: true})` has
 * nothing to flush or kill. The only state that needs to survive a process
 * restart is the small JSON marker in `claudeSession.ts` (session id + the
 * exact prompt), not a session file to repair.
 *
 * Answering resumes the *same* session (`resume: sessionId`, no
 * `forkSession`) with a new user turn stating the operator's answer — the
 * real prior conversation reloads (confirmed by spike), but this is a new
 * turn on that history, not Pi's mid-thought `continue()`. That gap is
 * permanent and documented, not a bug to chase.
 *
 * Explicitly NOT supported yet, rejected up front with a clear reason
 * rather than silently misbehaving: `stage.skill` (Pi's `/skill:`
 * convention has no Claude equivalent wired up yet) and any `stage.model`
 * outside `anthropic/*` (this backend only runs Claude models).
 *
 * Credentials: delegated entirely to the spawned `claude` CLI's own
 * environment/auth (ANTHROPIC_API_KEY or a logged-in session) — the same
 * story as running `claude` by hand.
 */
import { query, type ModelUsage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isAdvancingEnvelope } from "../envelope/check.js";
import type { EmitCapture } from "../tools/emitStageEnvelope.js";
import {
  assertAnswerMatchesPrompt,
  parseAskOperatorAnswer,
  summarizeAnswer,
  type AskOperatorAnswer,
  type AskOperatorPrompt,
} from "../tools/askOperator.js";
import {
  buildStageflowMcpServer,
  EMIT_STAGE_ENVELOPE_TOOL_NAME,
  STAGEFLOW_MCP_SERVER_NAME,
  WRITE_STAGE_ARTIFACT_TOOL_NAME,
  ASK_OPERATOR_TOOL_NAME,
  type AskOperatorCapture,
} from "./claudeTools.js";
import { createClaudeActivityMapper } from "./claudeActivity.js";
import { readActivityVerbose } from "./activity.js";
import { composeStageUserPrompt } from "./piAdapter.js";
import {
  claudeSessionMarkerPath,
  clearClaudeSessionMarker,
  readClaudeSessionMarker,
  writeClaudeSessionMarker,
} from "./claudeSession.js";
import {
  DEFAULT_STAGE_TIMEOUT_MS,
  runStageViaOpen,
  runtimeStageId,
  type AgentPort,
  type OpaqueAnswer,
  type StageHandle,
  type StageHandleCloseOptions,
  type StageHandleEvent,
  type StageRunInput,
  type StageRunResult,
} from "./port.js";
import { StageMcpError } from "../config/resolveStageMcpServers.js";
import { addModelUsage, emptyStageUsage, type StageUsage } from "../types/usage.js";

/** Built-in tool allowlist, mirroring Pi's sealed-session base set (read/bash/write/edit). */
const CLAUDE_BUILTIN_TOOLS = ["Read", "Write", "Edit", "Bash"];

type Preflight = { ok: true; model: string } | { ok: false; reason: string };

function resolveClaudeModel(stageModel: string): Preflight {
  const slash = stageModel.indexOf("/");
  if (slash < 0) {
    return {
      ok: false,
      reason: `stage.model "${stageModel}" must be "anthropic/<model>" to run on the claude agent backend`,
    };
  }
  const provider = stageModel.slice(0, slash);
  const model = stageModel.slice(slash + 1);
  if (provider !== "anthropic" || model.length === 0) {
    return {
      ok: false,
      reason: `stage.model "${stageModel}" is not an anthropic model; the claude agent backend only runs anthropic/* models`,
    };
  }
  return { ok: true, model };
}

function preflight(input: StageRunInput): Preflight {
  if (input.stage.skill !== undefined) {
    return {
      ok: false,
      reason: `stage declares skill "${input.stage.skill}"; the claude agent backend does not support skills yet`,
    };
  }
  return resolveClaudeModel(input.stage.model);
}

function resultFromCapture(capture: EmitCapture): StageRunResult {
  if (capture.error && !capture.envelope) {
    return { ok: false, reason: capture.error };
  }
  if (!capture.envelope) {
    return { ok: false, reason: "missing emit_stage_envelope" };
  }
  if (!isAdvancingEnvelope(capture.envelope)) {
    return { ok: false, reason: "status: failure", envelope: capture.envelope };
  }
  return { ok: true, envelope: capture.envelope };
}

function failedPassedMcpConnect(
  resolved: StageRunInput["resolvedMcpServers"],
  listed: ReadonlyArray<{ name: string; status: string; error?: string }>,
): StageMcpError | undefined {
  const names = Object.keys(resolved ?? {});
  if (names.length === 0) return undefined;
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  for (const name of names) {
    const entry = byName.get(name);
    if (entry?.status === "connected") continue;
    const statusOrError = entry?.error ?? entry?.status ?? "missing";
    return new StageMcpError(
      `MCP server "${name}" failed to connect (status: ${statusOrError})`,
      "connect_failed",
    );
  }
  return undefined;
}

type ClaudeTurnOutcome =
  | { kind: "waiting"; sessionId: string; request: AskOperatorPrompt }
  | { kind: "completed"; result: StageRunResult };

/** Merge one query() call's per-model totals (this call's own turns only) into the stage-level accumulator. */
function mergeClaudeModelUsage(usage: StageUsage, modelUsage: Record<string, ModelUsage> | undefined): void {
  if (!modelUsage) return;
  for (const [key, entry] of Object.entries(modelUsage)) {
    addModelUsage(usage, entry.canonicalModel ?? key, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      costUsd: entry.costUSD,
    });
  }
}

const TRAILING_RESULT_WAIT_MS = 2000;

/**
 * emit_stage_envelope's tool_result lands on a "user" message, which the
 * caller interrupts and breaks on immediately (never-let-it-go-dangling) —
 * well before the SDK's own "result" message (the one carrying cost/token
 * totals) would naturally arrive. There can be more than one trailing frame
 * after the interrupted tool-result (observed: another "user" frame before
 * "result"), so this drains messages in a loop, bounded by one overall time
 * budget rather than a single peek. By the docstring above, `interrupt()`
 * resolving means the CLI subprocess has already exited, so its trailing
 * frames are normally already queued or arrive within milliseconds — this
 * claims them without risking a real hang.
 */
async function drainTrailingResultUsage(
  stream: AsyncGenerator<unknown, void>,
  usage: StageUsage,
): Promise<void> {
  const debug = readActivityVerbose();
  const deadline = Date.now() + TRAILING_RESULT_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        stream.next(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (debug) {
        console.error(
          `[claudeAdapter] drainTrailingResultUsage: done=${next.done} type=${
            !next.done ? (next.value as { type?: string })?.type : "n/a"
          }`,
        );
      }
      if (next.done) return;
      const message = next.value as { type?: string; modelUsage?: Record<string, ModelUsage> };
      if (message.type === "result") {
        if (debug) {
          console.error(
            `[claudeAdapter] drainTrailingResultUsage: modelUsage=${JSON.stringify(message.modelUsage)}`,
          );
        }
        mergeClaudeModelUsage(usage, message.modelUsage);
        return;
      }
      // not "result" yet (e.g. another "user"/"system" frame) — keep draining within the budget
    }
  } catch (err) {
    if (debug) {
      console.error(
        `[claudeAdapter] drainTrailingResultUsage: threw ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // best-effort; a natural stop may already have ended the turn
  }
}

async function* singleUserMessage(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

/** One `query()` call — either the stage's initial turn or a resume turn. */
async function runTurn(
  input: StageRunInput,
  model: string,
  markerPath: string,
  promptText: string,
  resumeSessionId: string | undefined,
  usage: StageUsage,
): Promise<ClaudeTurnOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const activityMapper = createClaudeActivityMapper();
  const emitCapture: EmitCapture = {};
  const askCapture: AskOperatorCapture = {};

  const gateKinds = input.stage.gate_kinds;
  const hitlAllowed = gateKinds === undefined || gateKinds.length > 0;

  input.onActivity?.({ event: "agent_start" });
  input.onActivity?.({ event: "turn_start" });

  let sessionId = resumeSessionId;

  try {
    const mcpServer = buildStageflowMcpServer({
      capture: emitCapture,
      payloadSchema: input.stage.payload_schema,
      forkEmitContext: input.forkEmitContext,
      cloneEmitContext: input.cloneEmitContext,
      preEmitCheckOptions: {
        checks: input.stage.pre_emit_checks,
        readQaTrail: input.readQaTrail,
      },
      writeStageArtifact: {
        runWorkspaceDir: input.roots.runWorkspaceDir,
        stageId: runtimeStageId(input),
        attempt: input.roots.attempt ?? 1,
      },
      ...(hitlAllowed
        ? {
            askOperator: {
              capture: askCapture,
              ...(gateKinds !== undefined ? { allowedKinds: gateKinds } : {}),
            },
          }
        : {}),
    });

    const passedServers = Object.fromEntries(
      Object.entries(input.resolvedMcpServers ?? {}).map(([name, config]) => [
        name,
        { ...config, alwaysLoad: true },
      ]),
    );

    const stream = query({
      prompt: singleUserMessage(promptText),
      options: {
        abortController: controller,
        cwd: input.roots.cwd,
        model,
        systemPrompt: { type: "custom", prompt: input.stage.system_prompt },
        settingSources: [],
        tools: CLAUDE_BUILTIN_TOOLS,
        mcpServers: { [STAGEFLOW_MCP_SERVER_NAME]: mcpServer, ...passedServers },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        strictMcpConfig: true,
        ...(resumeSessionId !== undefined ? { resume: resumeSessionId } : {}),
      },
    });

    for await (const message of stream) {
      for (const event of activityMapper.map(message)) {
        input.onActivity?.(event);
      }

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        await writeClaudeSessionMarker(markerPath, { sessionId: message.session_id });
        const connectError = failedPassedMcpConnect(input.resolvedMcpServers, message.mcp_servers);
        if (connectError) {
          try {
            await stream.interrupt();
          } catch {
            // best-effort backstop; a natural stop may have already ended the turn
          }
          return { kind: "completed", result: { ok: false, reason: connectError.message } };
        }
      }

      if (
        message.type === "user" &&
        (emitCapture.envelope !== undefined || askCapture.prompt !== undefined)
      ) {
        if (readActivityVerbose()) {
          console.error(`[claudeAdapter] interrupting on user tool-result frame`);
        }
        try {
          await stream.interrupt();
        } catch {
          // best-effort backstop; a natural stop may have already ended the turn
        }
        await drainTrailingResultUsage(stream, usage);
        break;
      }

      if (message.type === "result") {
        if (readActivityVerbose()) {
          console.error(
            `[claudeAdapter] main loop saw result: modelUsage=${JSON.stringify(
              (message as { modelUsage?: unknown }).modelUsage,
            )}`,
          );
        }
        mergeClaudeModelUsage(usage, message.modelUsage);
        break;
      }
    }

    if (askCapture.prompt !== undefined) {
      const resolvedSessionId = sessionId;
      if (resolvedSessionId === undefined) {
        return {
          kind: "completed",
          result: { ok: false, reason: "ask_operator called but no session_id was observed", usage },
        };
      }
      await writeClaudeSessionMarker(markerPath, {
        sessionId: resolvedSessionId,
        prompt: askCapture.prompt,
        usage,
      });
      return { kind: "waiting", sessionId: resolvedSessionId, request: askCapture.prompt };
    }

    await clearClaudeSessionMarker(markerPath);
    return { kind: "completed", result: { ...resultFromCapture(emitCapture), usage } };
  } catch (err) {
    if (askCapture.prompt !== undefined && sessionId !== undefined) {
      await writeClaudeSessionMarker(markerPath, { sessionId, prompt: askCapture.prompt, usage });
      return { kind: "waiting", sessionId, request: askCapture.prompt };
    }
    if (emitCapture.envelope && isAdvancingEnvelope(emitCapture.envelope)) {
      await clearClaudeSessionMarker(markerPath);
      return { kind: "completed", result: { ok: true, envelope: emitCapture.envelope, usage } };
    }
    return {
      kind: "completed",
      result: {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        envelope: emitCapture.envelope,
        usage,
      },
    };
  } finally {
    clearTimeout(timer);
    input.onActivity?.({ event: "agent_end" });
  }
}

function resumePromptText(answer: AskOperatorAnswer): string {
  return [
    summarizeAnswer(answer),
    "",
    `Continue the stage. Call ${EMIT_STAGE_ENVELOPE_TOOL_NAME} when finished, or ${ASK_OPERATOR_TOOL_NAME} again if you need to ask something else.`,
  ].join("\n");
}

export class ClaudeAgentAdapter implements AgentPort {
  openStage(input: StageRunInput): StageHandle {
    const stageId = runtimeStageId(input);
    const markerPath = claudeSessionMarkerPath(input);

    let closed = false;
    let bootstrapped = false;
    let waiting: { sessionId: string; prompt: AskOperatorPrompt } | undefined;
    let pendingAnswer: OpaqueAnswer | undefined;
    const usage: StageUsage = emptyStageUsage();

    const applyOutcome = (outcome: ClaudeTurnOutcome): StageHandleEvent => {
      if (outcome.kind === "waiting") {
        waiting = { sessionId: outcome.sessionId, prompt: outcome.request };
        pendingAnswer = undefined;
        return { status: "waiting_for_input", request: outcome.request };
      }
      waiting = undefined;
      return { status: "completed", result: outcome.result };
    };

    return {
      stageId,
      async next(): Promise<StageHandleEvent> {
        if (closed) {
          return { status: "completed", result: { ok: false, reason: "stage handle closed" } };
        }

        if (!bootstrapped) {
          bootstrapped = true;
          const marker = await readClaudeSessionMarker(markerPath);
          if (marker?.prompt !== undefined) {
            waiting = { sessionId: marker.sessionId, prompt: marker.prompt };
          }
          if (marker?.usage) {
            for (const [model, breakdown] of Object.entries(marker.usage.models)) {
              addModelUsage(usage, model, breakdown);
            }
          }
        }

        if (waiting) {
          if (pendingAnswer === undefined) {
            return { status: "waiting_for_input", request: waiting.prompt };
          }
          const rawAnswer = pendingAnswer;
          pendingAnswer = undefined;
          const prompt = waiting.prompt;
          const sessionId = waiting.sessionId;

          let parsedAnswer: AskOperatorAnswer;
          try {
            parsedAnswer = parseAskOperatorAnswer(rawAnswer);
            assertAnswerMatchesPrompt(prompt, parsedAnswer);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            waiting = undefined;
            await clearClaudeSessionMarker(markerPath);
            return { status: "completed", result: { ok: false, reason: `invalid operator answer: ${message}` } };
          }

          const pre = preflight(input);
          if (!pre.ok) {
            waiting = undefined;
            await clearClaudeSessionMarker(markerPath);
            return { status: "completed", result: { ok: false, reason: pre.reason } };
          }
          const outcome = await runTurn(
            input,
            pre.model,
            markerPath,
            resumePromptText(parsedAnswer),
            sessionId,
            usage,
          );
          return applyOutcome(outcome);
        }

        const pre = preflight(input);
        if (!pre.ok) {
          return { status: "completed", result: { ok: false, reason: pre.reason } };
        }
        const outcome = await runTurn(
          input,
          pre.model,
          markerPath,
          composeStageUserPrompt(
            input,
            EMIT_STAGE_ENVELOPE_TOOL_NAME,
            undefined,
            WRITE_STAGE_ARTIFACT_TOOL_NAME,
          ),
          undefined,
          usage,
        );
        return applyOutcome(outcome);
      },
      deliverAnswer(answer: OpaqueAnswer) {
        pendingAnswer = answer;
      },
      async close(closeOptions?: StageHandleCloseOptions) {
        closed = true;
        if (closeOptions?.park) {
          // Nothing to flush or kill — by the time a turn reports "waiting",
          // its Claude CLI subprocess has already exited on its own and the
          // marker file is already durably written.
          return;
        }
      },
    };
  }

  async runStage(input: StageRunInput): Promise<StageRunResult> {
    return runStageViaOpen(this, input);
  }
}
