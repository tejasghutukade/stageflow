import type { AgentDefinition } from "../../config/loadAgent.js";
import type { ConversationBackend } from "../../agents/runtime/types.js";

export type DriverUsage = {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  estimated?: boolean;
};

export type SimulatorModelInput = { system: string; user: string; signal: AbortSignal };
export type SimulatorModelReply = { text: string; usage?: DriverUsage };

export interface SimulatorModel {
  complete(input: SimulatorModelInput): Promise<SimulatorModelReply>;
}

export class SimulatorError extends Error {
  readonly code = "EVAL_SIMULATOR_ERROR";
  constructor(message = "The simulated user model failed to reply.") {
    super(message);
    this.name = "SimulatorError";
  }
}

export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Price in USD per one million tokens. */
export type ModelPrice = { inputPerMillion: number; outputPerMillion: number };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function createBackendSimulatorModel(options: {
  backend: ConversationBackend;
  projectRoot: string;
  definition: AgentDefinition;
  modelId: string;
  priceOf?: (modelId: string) => ModelPrice | undefined;
}): SimulatorModel {
  const { backend, projectRoot, modelId } = options;
  const definition = { ...options.definition, model: { ...options.definition.model, id: modelId } } as AgentDefinition;
  return {
    async complete(input) {
      if (backend.judge === undefined) throw new SimulatorError("The agent backend cannot run a one-shot model call.");
      const prompt = `${input.system}\n\n${input.user}`;
      let text: string;
      try {
        text = await backend.judge({ projectRoot, definition, prompt, signal: input.signal });
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new SimulatorError();
      }
      const tokensIn = estimateTokens(prompt);
      const tokensOut = estimateTokens(text);
      const price = options.priceOf?.(modelId);
      const costUsd = price === undefined ? 0 : (tokensIn * price.inputPerMillion + tokensOut * price.outputPerMillion) / 1_000_000;
      return { text, usage: { costUsd, tokensIn, tokensOut, model: modelId, estimated: true } };
    },
  };
}

export type FakeSimulatorReply = string | { text: string; usage?: DriverUsage } | Error;

export class FakeSimulatorModel implements SimulatorModel {
  readonly calls: SimulatorModelInput[] = [];
  private index = 0;

  constructor(
    private readonly replies: readonly FakeSimulatorReply[] | ((call: SimulatorModelInput, index: number) => FakeSimulatorReply),
    private readonly defaultUsage: DriverUsage = { costUsd: 0.001, tokensIn: 100, tokensOut: 10, model: "fake/simulator" },
  ) {}

  async complete(input: SimulatorModelInput): Promise<SimulatorModelReply> {
    const index = this.index++;
    this.calls.push(input);
    const reply = typeof this.replies === "function" ? this.replies(input, index) : this.replies[index];
    if (reply === undefined) throw new Error("FakeSimulatorModel has no scripted reply left");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "string") return { text: reply, usage: this.defaultUsage };
    return { text: reply.text, usage: reply.usage ?? this.defaultUsage };
  }
}
