import type { OpaqueAnswer, OpaqueWaitRequest, StageHandle } from "../agent/port.js";
import {
  appendOperatorAnswer,
  appendOperatorPrompt,
  derivePendingPrompt,
} from "../hitl/qaTrail.js";
import type { RunStore } from "../runstore/port.js";
import { deriveExecutionPatchFromEvent } from "../runstore/stageExecution.js";
import { attemptContext, type StageAttemptContext } from "./stageAttemptContext.js";
import {
  AskOperatorError,
  assertAnswerMatchesPrompt,
  normalizePromptIds,
  parseAskOperatorAnswer,
  parseAskOperatorParams,
  type AskOperatorPrompt,
} from "../tools/askOperator.js";

export type DeliverAnswerResult =
  | { ok: true }
  | { ok: false; reason: string; status: 404 | 409 | 400 | 500 };

export type DeliverAnswerPrefixResult =
  | { ok: true; mode: "live" }
  | { ok: true; mode: "restart" }
  | { ok: false; reason: string; status: 400 };

export type AnswerPromptAssertContext = {
  runId: string;
  stageId: string;
  answer: OpaqueAnswer;
  pendingRequest?: OpaqueWaitRequest;
};

export type AssertAnswerMatchesPrompt = (
  ctx: AnswerPromptAssertContext,
) => void | Promise<void>;

export type HitlWaitEnterContext = {
  runId: string;
  stageId: string;
  request: OpaqueWaitRequest;
  attempt?: number;
};

export type HitlAnswerDeliverContext = {
  runId: string;
  stageId: string;
  answer: OpaqueAnswer;
  pendingRequest?: OpaqueWaitRequest;
  attempt?: number;
};

export type HitlQaHooks = {
  onWaitEnter?: (ctx: HitlWaitEnterContext) => void | Promise<void>;
  onAnswerDeliver?: (ctx: HitlAnswerDeliverContext) => void | Promise<void>;
};

export type HitlSeams = {
  assertAnswerMatchesPrompt?: AssertAnswerMatchesPrompt;
  qaHooks?: HitlQaHooks;
};

export function tryParsePendingPrompt(
  pendingRequest: OpaqueWaitRequest | undefined,
): AskOperatorPrompt | undefined {
  if (pendingRequest === undefined) {
    return undefined;
  }
  try {
    return normalizePromptIds(parseAskOperatorParams(pendingRequest));
  } catch {
    return undefined;
  }
}

export const t2AssertAnswerMatchesPrompt: AssertAnswerMatchesPrompt = (ctx) => {
  const prompt = tryParsePendingPrompt(ctx.pendingRequest);
  if (prompt === undefined) {
    return;
  }
  try {
    const answer = parseAskOperatorAnswer(ctx.answer);
    assertAnswerMatchesPrompt(prompt, answer);
  } catch (err) {
    if (err instanceof AskOperatorError) {
      throw err;
    }
    throw new AskOperatorError(
      err instanceof Error ? err.message : String(err),
    );
  }
};

export function createDefaultHitlQaHooks(store: RunStore): HitlQaHooks {
  return {
    async onWaitEnter(ctx) {
      const prompt = tryParsePendingPrompt(ctx.request);
      if (!prompt) return;
      const options = attemptContext(ctx.attempt ?? 1).eventOptions();
      await appendOperatorPrompt(store, ctx.runId, ctx.stageId, prompt, options);
    },
    async onAnswerDeliver(ctx) {
      let answer;
      try {
        answer = parseAskOperatorAnswer(ctx.answer);
      } catch {
        return;
      }
      const options = attemptContext(ctx.attempt ?? 1).eventOptions();
      await appendOperatorAnswer(store, ctx.runId, ctx.stageId, answer, options);
    },
  };
}

export async function recordWaitEnter(options: {
  store: RunStore;
  runId: string;
  stageId: string;
  request: OpaqueWaitRequest;
  attemptCtx?: StageAttemptContext;
  qaHooks: HitlQaHooks;
}): Promise<void> {
  const { store, runId, stageId, request, qaHooks } = options;
  const resolvedAttempt =
    options.attemptCtx?.attempt ??
    ((await store.getLatestStageExecution(runId, stageId))?.attempt ?? 1);
  const resolvedCtx = options.attemptCtx ?? attemptContext(resolvedAttempt);
  await qaHooks.onWaitEnter?.({
    runId,
    stageId,
    request,
    attempt: resolvedAttempt,
  });
  const event = { event: "waiting_for_input" as const };
  await store.appendStageEvent(
    runId,
    stageId,
    event,
    resolvedCtx.eventOptions(),
  );
  try {
    const execution = await store.getStageExecution(
      runId,
      stageId,
      resolvedAttempt,
    );
    const patch = deriveExecutionPatchFromEvent(event, execution);
    if (Object.keys(patch).length === 0) return;
    await store.updateStageExecution(runId, stageId, resolvedAttempt, patch);
  } catch {
    // no execution row yet
  }
}

type LiveWaitEntry = {
  handle: StageHandle;
  pendingRequest: OpaqueWaitRequest;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export function waitKey(runId: string, stageId: string): string {
  return `${runId}\0${stageId}`;
}

/**
 * HITL coordinator: wait-enter + answer-deliver (live and restart), with a
 * single pending source for the T2 assert gate.
 */
export class StageHitlController {
  private readonly live = new Map<string, LiveWaitEntry>();
  private readonly assertAnswerMatchesPrompt: AssertAnswerMatchesPrompt;
  private readonly qaHooks: HitlQaHooks;

  constructor(
    private readonly options: {
      store: RunStore;
      seams?: HitlSeams;
    },
  ) {
    this.assertAnswerMatchesPrompt =
      options.seams?.assertAnswerMatchesPrompt ?? t2AssertAnswerMatchesPrompt;
    this.qaHooks =
      options.seams?.qaHooks ?? createDefaultHitlQaHooks(options.store);
  }

  hasLiveWait(runId: string, stageId: string): boolean {
    return this.live.has(waitKey(runId, stageId));
  }

  private async latestAttemptForStage(
    runId: string,
    stageId: string,
  ): Promise<number> {
    const latest = await this.options.store.getLatestStageExecution(
      runId,
      stageId,
    );
    return latest?.attempt ?? 1;
  }

  private attemptEventOptions(attempt: number) {
    return attemptContext(attempt).eventOptions();
  }

  /**
   * KTD6 wait-enter: T3 wait-enter hook → lifecycle waiting_for_input → park.
   */
  async enterWait(
    runId: string,
    stageId: string,
    handle: StageHandle,
    request: OpaqueWaitRequest,
    attemptCtx?: StageAttemptContext,
  ): Promise<void> {
    await recordWaitEnter({
      store: this.options.store,
      runId,
      stageId,
      request,
      attemptCtx,
      qaHooks: this.qaHooks,
    });
    console.error(`Stage ${stageId} waiting for input.`);
    await this.parkUntilAnswer(runId, stageId, handle, request);
  }

  private parkUntilAnswer(
    runId: string,
    stageId: string,
    handle: StageHandle,
    pendingRequest: OpaqueWaitRequest,
  ): Promise<void> {
    const key = waitKey(runId, stageId);
    const existing = this.live.get(key);
    if (existing) {
      existing.reject(
        new Error(`duplicate wait registration for ${runId}/${stageId}`),
      );
      this.live.delete(key);
    }
    return new Promise<void>((resolve, reject) => {
      this.live.set(key, { handle, pendingRequest, resolve, reject });
    });
  }

  clearLiveWait(runId: string, stageId: string): void {
    const key = waitKey(runId, stageId);
    const entry = this.live.get(key);
    if (!entry) return;
    this.live.delete(key);
    entry.reject(new Error("wait cancelled"));
  }

  /**
   * Resolve pending for assert: live park map, else trail-derived T2 prompt.
   * Non-T2 string fixtures yield undefined (assert pass-through).
   */
  private async resolvePendingRequest(
    runId: string,
    stageId: string,
  ): Promise<OpaqueWaitRequest | undefined> {
    const live = this.live.get(waitKey(runId, stageId));
    if (live) {
      return live.pendingRequest;
    }
    const attempt = await this.latestAttemptForStage(runId, stageId);
    const events = await this.options.store.listStageEvents(
      runId,
      stageId,
      attempt,
    );
    const pending = derivePendingPrompt(events);
    return pending ?? undefined;
  }

  /**
   * KTD6 answer-deliver prefix for live and restart:
   * resolve pending → assert → answer hook → resumed → live unpark or restart ok.
   */
  async deliverAnswerPrefix(
    runId: string,
    stageId: string,
    opaqueAnswer: OpaqueAnswer,
    attemptCtx?: StageAttemptContext,
  ): Promise<DeliverAnswerPrefixResult> {
    const key = waitKey(runId, stageId);
    const live = this.live.get(key);
    const attempt =
      attemptCtx?.attempt ?? (await this.latestAttemptForStage(runId, stageId));
    const resolvedCtx = attemptCtx ?? attemptContext(attempt);
    const pendingRequest = await this.resolvePendingRequest(runId, stageId);

    try {
      await this.assertAnswerMatchesPrompt({
        runId,
        stageId,
        answer: opaqueAnswer,
        pendingRequest,
      });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 400,
      };
    }

    await this.qaHooks.onAnswerDeliver?.({
      runId,
      stageId,
      answer: opaqueAnswer,
      pendingRequest,
      attempt,
    });

    await this.options.store.appendStageEvent(
      runId,
      stageId,
      {
        event: "resumed",
      },
      this.attemptEventOptions(resolvedCtx.attempt),
    );

    if (live) {
      this.live.delete(key);
      live.handle.deliverAnswer(opaqueAnswer);
      live.resolve();
      return { ok: true, mode: "live" };
    }

    return { ok: true, mode: "restart" };
  }
}
