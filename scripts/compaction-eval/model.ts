import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalModel } from "./types.js";

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`cost cap exceeded: $${spentUsd.toFixed(4)} > $${capUsd.toFixed(2)}`);
  }
}

export class CostMeter {
  spentUsd = 0;
  constructor(readonly capUsd: number) {}
  add(usd: number): void {
    this.spentUsd += usd;
    if (this.spentUsd > this.capUsd) throw new BudgetExceededError(this.spentUsd, this.capUsd);
  }
}

/** Echoes the context part of the probe prompt, so a probe passes iff the summary or tail holds the answer. */
export function createDryRunModel(meter: CostMeter): EvalModel {
  return {
    id: "dry-run/echo",
    dryRun: true,
    reserveTokens: 16384,
    async complete({ user }) {
      meter.add(0);
      return { text: user.split("\n\nQuestion:")[0] ?? user, costUsd: 0, tokensIn: Math.ceil(user.length / 4), tokensOut: 0 };
    },
  };
}

const API_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export async function createRealModel(modelRef: string, meter: CostMeter): Promise<EvalModel> {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) throw new Error(`model must look like provider/model-id, got "${modelRef}"`);
  const provider = modelRef.slice(0, slash);
  const modelId = modelRef.slice(slash + 1);
  const { ModelRuntime, DEFAULT_COMPACTION_SETTINGS } = await import("@earendil-works/pi-coding-agent");
  const dir = mkdtempSync(path.join(tmpdir(), "compaction-eval-"));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null });
  const envName = API_KEY_ENV[provider];
  const key = envName ? process.env[envName] : undefined;
  if (!key) throw new Error(`set ${envName ?? `an API key env var for provider ${provider}`} to run against a real model`);
  await runtime.setRuntimeApiKey(provider, key);
  const piModel = runtime.getModel(provider, modelId);
  if (!piModel) throw new Error(`model ${modelRef} is not in Pi's catalog`);
  const resolved = await runtime.getAuth(piModel);
  return {
    id: modelRef,
    dryRun: false,
    piModel,
    ...(resolved?.auth.apiKey ? { apiKey: resolved.auth.apiKey } : {}),
    ...(resolved?.auth.headers ? { headers: resolved.auth.headers as Record<string, string> } : {}),
    ...(resolved?.env ? { env: resolved.env as Record<string, string> } : {}),
    reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    async complete({ system, user, signal, maxTokens }) {
      const reply = await runtime.completeSimple(
        piModel,
        { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
        { temperature: 0, maxTokens: maxTokens ?? 400, ...(signal ? { signal } : {}) },
      );
      if (reply.stopReason === "error") throw new Error(`model call failed: ${reply.errorMessage ?? "unknown error"}`);
      const text = reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      meter.add(reply.usage.cost.total);
      return {
        text,
        costUsd: reply.usage.cost.total,
        tokensIn: reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
        tokensOut: reply.usage.output,
      };
    },
  };
}
