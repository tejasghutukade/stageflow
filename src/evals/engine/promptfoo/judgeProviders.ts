import type { ResolvedGrader } from "../../types.js";
import { EngineError } from "./errors.js";

export type JudgeMapping ={ promptfooProvider: string; envVar: string; stageflowProvider: string };

type JudgeProviderRow = {
  stageflowProvider: string;
  envVar: string;
  spec: (model: string) => string;
};

export const JUDGE_PROVIDERS: readonly JudgeProviderRow[] = [
  { stageflowProvider: "anthropic", envVar: "ANTHROPIC_API_KEY", spec: (m) => `anthropic:messages:${m}` },
  { stageflowProvider: "openai", envVar: "OPENAI_API_KEY", spec: (m) => `openai:chat:${m}` },
  { stageflowProvider: "openrouter", envVar: "OPENROUTER_API_KEY", spec: (m) => `openrouter:${m}` },
];

export function supportedJudgeProviders(): string[] {
  return JUDGE_PROVIDERS.map((row) => row.stageflowProvider);
}

export function mapJudge(modelId: string): JudgeMapping | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const provider = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  if (model.length === 0) return null;
  const row = JUDGE_PROVIDERS.find((entry) => entry.stageflowProvider === provider);
  if (row === undefined) return null;
  return { promptfooProvider: row.spec(model), envVar: row.envVar, stageflowProvider: provider };
}

export function judgeCapableModels(modelIds: readonly string[]): string[] {
  return modelIds.filter((id) => mapJudge(id) !== null);
}

export function unsupportedJudgeMessage(modelId: string): string {
  return `Judge model "${modelId}" cannot be used: supported judge providers are ${supportedJudgeProviders().join(", ")}.`;
}

export function assertJudgesSupported(graders: readonly ResolvedGrader[]): void {
  for (const grader of graders) {
    if ((grader.type === "rubric" || grader.type === "goal_reached") && mapJudge(grader.judge) === null) {
      throw new EngineError("EVAL_INVALID", unsupportedJudgeMessage(grader.judge));
    }
  }
}
