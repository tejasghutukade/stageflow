import type { CompleteInput, CompleteResult, ConversationBackend, RuntimeUsage } from "../../agents/runtime/types.js";

export type FakeToolStep = {
  tool: string;
  input?: Record<string, unknown>;
  /** What the tool does when the gate lets it run. */
  body?: () => string | Promise<string>;
  /** Report the tool as failed when it ran. */
  fails?: boolean;
};

export type FakeTurnScript = {
  text?: string;
  tools?: FakeToolStep[];
  usage?: RuntimeUsage;
  /** Wait before replying; an abort ends the wait early. */
  delayMs?: number;
  /** Never reply until the turn is aborted. */
  hang?: boolean;
  /** Throw this from the backend. */
  error?: Error;
};

export type FakeTurnReply = FakeTurnScript | ((input: CompleteInput, index: number) => FakeTurnScript);

export const FAKE_USAGE: RuntimeUsage = { inputTokens: 100, outputTokens: 20, costUsd: 0.01 };

function waitOrAbort(ms: number | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = ms === undefined ? undefined : setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * A scriptable conversation backend for eval tests. Each model call takes the next scripted turn; tool calls go
 * through the same gate and hooks the real runtime uses, so tool policy is exercised.
 */
export class FakeAgentBackend implements ConversationBackend {
  readonly id = "pi" as const;
  readonly inputs: CompleteInput[] = [];
  readonly released: string[] = [];
  /** Tool bodies that actually ran, by grant id. */
  readonly executed: string[] = [];
  private index = 0;
  private callSeq = 0;

  constructor(private readonly script: readonly FakeTurnReply[] | ((input: CompleteInput, index: number) => FakeTurnScript) = []) {}

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const index = this.index++;
    this.inputs.push(input);
    const reply = typeof this.script === "function" ? this.script : this.script[index];
    const turn: FakeTurnScript =
      typeof reply === "function" ? reply(input, index) : (reply ?? { text: `reply ${index + 1}` });
    if (turn.error) throw turn.error;
    const usage = turn.usage ?? FAKE_USAGE;
    const toolOutputs: string[] = [];
    const startedAt = new Date();

    if (turn.hang) await waitOrAbort(undefined, input.signal);
    else if (turn.delayMs !== undefined) await waitOrAbort(turn.delayMs, input.signal);
    if (input.signal.aborted) return { text: "", usage, toolOutputs };

    for (const step of turn.tools ?? []) {
      const call = { id: `call_${(this.callSeq += 1)}`, tool: step.tool, input: step.input ?? {} };
      const decision = await input.hooks.gate(call);
      if (!decision.allow) continue;
      input.hooks.toolStarted(call);
      let output: string;
      let ok = step.fails !== true;
      if (step.tool.startsWith("agent:")) {
        output = await input.hooks.delegate(step.tool.slice(6), String(call.input.message ?? ""), call.id);
      } else {
        try {
          this.executed.push(step.tool);
          output = await (step.body ? step.body() : `ran ${step.tool}`);
        } catch (error) {
          ok = false;
          output = error instanceof Error ? error.message : String(error);
        }
      }
      toolOutputs.push(output);
      input.hooks.toolFinished(call, { ok, output });
    }

    const text = turn.text ?? `reply ${index + 1}`;
    input.onDelta(text);
    input.hooks.modelFinished({ startedAt, endedAt: new Date(), ...usage });
    return { text, usage, toolOutputs };
  }

  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }

  get calls(): number {
    return this.index;
  }
}
