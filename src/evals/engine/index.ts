import type { EvalEngine } from "../types.js";
import { FakeEngine, type FakeEngineOptions } from "./FakeEngine.js";
import { PromptfooEngine, type PromptfooEngineOptions } from "./promptfoo/PromptfooEngine.js";

export { FakeEngine, FakeEngineError } from "./FakeEngine.js";
export type { FakeEngineOptions, FakeJudgeReply } from "./FakeEngine.js";

export { PromptfooEngine } from "./promptfoo/PromptfooEngine.js";
export type { PromptfooEngineOptions } from "./promptfoo/PromptfooEngine.js";
export { RunTokenRegistry } from "./promptfoo/runTokens.js";
export { judgeCapableModels, mapJudge } from "../judgeProviders.js";

const factories = new Map<string, (options?: unknown) => EvalEngine>([
  ["fake", (options) => new FakeEngine(options as FakeEngineOptions | undefined)],
  ["promptfoo", (options) => new PromptfooEngine(options as PromptfooEngineOptions)],
]);

export function registerEngine(name: string, factory: (options?: unknown) => EvalEngine): void {
  factories.set(name, factory);
}

export function getEngine(name: string, options?: unknown): EvalEngine {
  const factory = factories.get(name);
  if (!factory) throw new Error(`Unknown eval engine: ${name}`);
  return factory(options);
}
