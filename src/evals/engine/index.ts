import type { EvalEngine } from "../types.js";
import { FakeEngine, type FakeEngineOptions } from "./FakeEngine.js";

export { FakeEngine, FakeEngineError } from "./FakeEngine.js";
export type { FakeEngineOptions, FakeJudgeReply } from "./FakeEngine.js";

const factories = new Map<string, (options?: unknown) => EvalEngine>([
  ["fake", (options) => new FakeEngine(options as FakeEngineOptions | undefined)],
]);

export function registerEngine(name: string, factory: (options?: unknown) => EvalEngine): void {
  factories.set(name, factory);
}

export function getEngine(name: string, options?: unknown): EvalEngine {
  const factory = factories.get(name);
  if (!factory) throw new Error(`Unknown eval engine: ${name}`);
  return factory(options);
}
