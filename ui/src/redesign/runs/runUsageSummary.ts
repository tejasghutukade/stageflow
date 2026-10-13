type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    if (thousands >= 999.95) return "1.0m";
    return `${thousands.toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function headerModelLabel(key: string): string {
  const slash = key.lastIndexOf("/");
  if (slash < 0) return key;
  const name = key.slice(slash + 1);
  return name || key;
}

export function runUsageSummary(
  stages: Array<{
    usage?: {
      models: Record<string, ModelUsage>;
    };
  }>,
): { tokensLabel: string; modelLabel: string } | null {
  let total = 0;
  const ioByModel = new Map<string, number>();

  for (const stage of stages) {
    const models = stage.usage?.models;
    if (!models) continue;
    for (const [key, model] of Object.entries(models)) {
      const input = finite(model.inputTokens);
      const output = finite(model.outputTokens);
      total +=
        input +
        output +
        finite(model.cacheReadInputTokens) +
        finite(model.cacheCreationInputTokens);
      ioByModel.set(key, (ioByModel.get(key) ?? 0) + input + output);
    }
  }

  if (total <= 0) return null;

  let modelKey: string | null = null;
  let bestIo = -1;
  for (const [key, io] of ioByModel) {
    if (io > bestIo) {
      bestIo = io;
      modelKey = key;
    }
  }
  if (!modelKey) return null;

  return {
    tokensLabel: formatTokenCount(total),
    modelLabel: headerModelLabel(modelKey),
  };
}
