import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertRequiredEnvelope,
  isAdvancingEnvelope,
} from "../envelope/check.js";
import { assertEnvelopePayload } from "../envelope/payloadSchema.js";
import { assertCloneForks } from "../envelope/cloneForks.js";
import { assertForkEnvelope } from "../envelope/forkChoice.js";
import type { StageRoots } from "../runtime/stageRoots.js";
import {
  assertAnswerMatchesPrompt,
  parseAskOperatorAnswer,
} from "../tools/askOperator.js";
import { tryParsePendingPrompt } from "../runtime/stageHitl.js";
import type {
  AgentPort,
  OpaqueAnswer,
  OpaqueWaitRequest,
  StageHandle,
  StageHandleEvent,
  StageRunInput,
  StageRunResult,
} from "./port.js";
import { runtimeStageId, runStageViaOpen } from "./port.js";

function opaqueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export type FakeAgentBehavior =
  | { type: "emit"; envelope: unknown }
  | { type: "never_emit" }
  | { type: "throw"; message: string }
  | {
      type: "wait_then_emit";
      waitRequests: OpaqueWaitRequest[];
      expectedAnswers?: OpaqueAnswer[];
      envelope: unknown;
    };

export type RecordedStageRoots = StageRoots;

type FakeHitlResumeState = {
  waitRequests: OpaqueWaitRequest[];
  expectedAnswers?: OpaqueAnswer[];
  envelope: unknown;
  waitIndex: number;
};

export function fakeHitlResumePath(
  roots: Pick<StageRoots, "runWorkspaceDir">,
  stageId: string,
): string {
  return path.join(
    roots.runWorkspaceDir,
    "stages",
    stageId,
    "fake-hitl-resume.json",
  );
}

function writeFakeHitlResume(
  roots: StageRoots,
  stageId: string,
  state: FakeHitlResumeState,
): void {
  const filePath = fakeHitlResumePath(roots, stageId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state)}\n`, "utf8");
}

function clearFakeHitlResume(
  roots: Pick<StageRoots, "runWorkspaceDir">,
  stageId: string,
): void {
  const filePath = fakeHitlResumePath(roots, stageId);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

function loadFakeHitlResume(
  roots: StageRoots,
  stageId: string,
): FakeHitlResumeState | "corrupt" | undefined {
  const filePath = fakeHitlResumePath(roots, stageId);
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as FakeHitlResumeState;
    if (
      !raw ||
      !Array.isArray(raw.waitRequests) ||
      typeof raw.waitIndex !== "number" ||
      raw.envelope === undefined
    ) {
      return "corrupt";
    }
    return raw;
  } catch {
    return "corrupt";
  }
}

export class FakeAgent implements AgentPort {
  lastRoots?: RecordedStageRoots;
  receivedAnswers: OpaqueAnswer[] = [];

  constructor(private readonly behavior: FakeAgentBehavior) {}

  openStage(input: StageRunInput): StageHandle {
    this.lastRoots = input.roots;
    this.receivedAnswers = [];

    let behavior = this.behavior;
    const receivedAnswers = this.receivedAnswers;
    let waitIndex = 0;
    let waiting = false;
    let closed = false;
    let answerResolver: ((answer: OpaqueAnswer) => void) | undefined;
    let answerPromise: Promise<OpaqueAnswer> | undefined;
    let started = false;
    let resumeCorrupt = false;

    const armWait = () => {
      waiting = true;
      answerPromise = new Promise<OpaqueAnswer>((resolve) => {
        answerResolver = resolve;
      });
    };

    const awaitAnswer = async (): Promise<OpaqueAnswer | undefined> => {
      if (!answerPromise) return undefined;
      const answer = await answerPromise;
      waiting = false;
      answerResolver = undefined;
      answerPromise = undefined;
      return answer;
    };

    if (behavior.type === "wait_then_emit") {
      const loaded = loadFakeHitlResume(input.roots, runtimeStageId(input));
      if (loaded === "corrupt") {
        resumeCorrupt = true;
      } else if (loaded) {
        behavior = {
          type: "wait_then_emit",
          waitRequests: loaded.waitRequests,
          expectedAnswers: loaded.expectedAnswers,
          envelope: loaded.envelope,
        };
        waitIndex = loaded.waitIndex;
        armWait();
      }
    }

    const emitStartActivity = () => {
      if (started) return;
      started = true;
      input.onActivity?.({ event: "agent_start" });
      input.onActivity?.({
        event: "tool_start",
        toolName: "fake_tool",
        toolCallId: "fake-1",
      });
      input.onActivity?.({
        event: "tool_end",
        toolName: "fake_tool",
        toolCallId: "fake-1",
        isError: false,
      });
    };

    const finishEmit = (): StageHandleEvent => {
      clearFakeHitlResume(input.roots, runtimeStageId(input));
      if (behavior.type === "throw") {
        input.onActivity?.({ event: "agent_end" });
        return {
          status: "completed",
          result: { ok: false, reason: behavior.message },
        };
      }
      if (behavior.type === "never_emit") {
        input.onActivity?.({ event: "agent_end" });
        return {
          status: "completed",
          result: { ok: false, reason: "missing emit_stage_envelope" },
        };
      }

      const envelopeValue =
        behavior.type === "emit" || behavior.type === "wait_then_emit"
          ? behavior.envelope
          : undefined;

      try {
        const envelope = assertRequiredEnvelope(envelopeValue);
        if (input.forkEmitContext !== undefined) {
          assertForkEnvelope(envelope, input.forkEmitContext);
        }
        if (input.cloneEmitContext !== undefined) {
          assertCloneForks(envelope, input.cloneEmitContext);
        }
        assertEnvelopePayload(envelope, input.stage.payload_schema);
        if (!isAdvancingEnvelope(envelope)) {
          input.onActivity?.({ event: "agent_end" });
          return {
            status: "completed",
            result: {
              ok: false,
              reason: "status: failure",
              envelope,
            },
          };
        }
        input.onActivity?.({
          event: "message",
          role: "assistant",
          text: envelope.summary,
        });
        input.onActivity?.({ event: "agent_end" });
        return { status: "completed", result: { ok: true, envelope } };
      } catch (err) {
        input.onActivity?.({ event: "agent_end" });
        return {
          status: "completed",
          result: {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          },
        };
      }
    };

    return {
      stageId: runtimeStageId(input),
      async next(): Promise<StageHandleEvent> {
        if (closed) {
          return {
            status: "completed",
            result: { ok: false, reason: "stage handle closed" },
          };
        }

        if (resumeCorrupt) {
          input.onActivity?.({ event: "agent_end" });
          return {
            status: "completed",
            result: {
              ok: false,
              reason: "corrupt resume context for waiting stage",
            },
          };
        }

        emitStartActivity();

        if (behavior.type !== "wait_then_emit") {
          return finishEmit();
        }

        if (waiting) {
          const answer = await awaitAnswer();
          if (answer === undefined && closed) {
            return {
              status: "completed",
              result: { ok: false, reason: "stage handle closed" },
            };
          }
          const priorRequest = behavior.waitRequests[waitIndex - 1];
          const t2Prompt = tryParsePendingPrompt(priorRequest);
          if (t2Prompt !== undefined && answer !== undefined) {
            try {
              const parsed = parseAskOperatorAnswer(answer);
              assertAnswerMatchesPrompt(t2Prompt, parsed);
            } catch (err) {
              input.onActivity?.({ event: "agent_end" });
              clearFakeHitlResume(input.roots, runtimeStageId(input));
              return {
                status: "completed",
                result: {
                  ok: false,
                  reason:
                    err instanceof Error
                      ? err.message
                      : `invalid T2 answer at wait ${waitIndex - 1}`,
                },
              };
            }
          }
          const expected = behavior.expectedAnswers?.[waitIndex - 1];
          if (
            expected !== undefined &&
            answer !== undefined &&
            !opaqueEqual(answer, expected)
          ) {
            input.onActivity?.({ event: "agent_end" });
            clearFakeHitlResume(input.roots, runtimeStageId(input));
            return {
              status: "completed",
              result: {
                ok: false,
                reason: `unexpected answer at wait ${waitIndex - 1}`,
              },
            };
          }
        }

        if (waitIndex < behavior.waitRequests.length) {
          const request = behavior.waitRequests[waitIndex];
          waitIndex += 1;
          armWait();
          writeFakeHitlResume(input.roots, runtimeStageId(input), {
            waitRequests: behavior.waitRequests,
            expectedAnswers: behavior.expectedAnswers,
            envelope: behavior.envelope,
            waitIndex,
          });
          return { status: "waiting_for_input", request };
        }

        return finishEmit();
      },
      deliverAnswer(answer: OpaqueAnswer) {
        if (!waiting || !answerResolver) return;
        const resolve = answerResolver;
        answerResolver = undefined;
        receivedAnswers.push(answer);
        resolve(answer);
      },
      async close(options?: { park?: boolean }) {
        closed = true;
        if (options?.park) {
          return;
        }
        if (waiting && answerResolver) {
          const resolve = answerResolver;
          answerResolver = undefined;
          waiting = false;
          answerPromise = undefined;
          resolve(undefined as unknown as OpaqueAnswer);
        }
      },
    };
  }

  async runStage(input: StageRunInput): Promise<StageRunResult> {
    return runStageViaOpen(this, input);
  }
}

export function scriptedFakeAgent(
  behaviors: FakeAgentBehavior[],
): AgentPort & { recorded: RecordedStageRoots[] } {
  const recorded: RecordedStageRoots[] = [];
  let index = 0;
  return {
    recorded,
    openStage(input) {
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      index += 1;
      const agent = new FakeAgent(behavior);
      const handle = agent.openStage(input);
      if (agent.lastRoots) recorded.push(agent.lastRoots);
      return handle;
    },
    async runStage(input) {
      return runStageViaOpen(this, input);
    },
  };
}
