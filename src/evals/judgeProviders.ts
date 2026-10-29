export type JudgeMapping = { providerSpec: string; envVar: string; stageflowProvider: string };

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
  return { providerSpec: row.spec(model), envVar: row.envVar, stageflowProvider: provider };
}

export function judgeCapableModels(modelIds: readonly string[]): string[] {
  return modelIds.filter((id) => mapJudge(id) !== null);
}

export function unsupportedJudgeMessage(modelId: string): string {
  return `Judge model "${modelId}" cannot be used: supported judge providers are ${supportedJudgeProviders().join(", ")}.`;
}

/** The model line a model id belongs to (`claude`, `gpt`, `gemini`), ignoring provider, size and version. */
export function modelFamily(modelId: string): string {
  const name = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  const token = name.split(/[-:._@\d]/)[0] ?? "";
  return token === "" ? name : token;
}

/** True when two different model ids come from the same model line, so a judge may favor the stage's output. */
export function sameModelFamily(a: string, b: string): boolean {
  return a !== b && modelFamily(a) !== "" && modelFamily(a) === modelFamily(b);
}

/** A floating id (`-latest`) that can change under a stored run. */
export function isFloatingModelId(modelId: string): boolean {
  return /(^|[-:/@])latest$/i.test(modelId);
}
