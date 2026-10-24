import type { Api, Model } from "@earendil-works/pi-ai";

export type ScenarioMessage = { role: "user" | "assistant" | "toolResult"; [key: string]: unknown };

export type FactPosition = "early" | "mid" | "late";

export type PlantedFact = {
  id: string;
  mustContain: string | RegExp;
  where: FactPosition;
  critical: boolean;
};

export type Probe = {
  question: string;
  expected: RegExp;
  factIds: string[];
};

export type Scenario = {
  id: string;
  family: string;
  description: string;
  messages: ScenarioMessage[];
  keepTail: number;
  facts: PlantedFact[];
  probes: Probe[];
  secrets: string[];
};

export type ModelReply = { text: string; costUsd: number; tokensIn: number; tokensOut: number };

export type EvalModel = {
  id: string;
  dryRun: boolean;
  piModel?: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  reserveTokens: number;
  complete(input: { system: string; user: string; signal?: AbortSignal; maxTokens?: number }): Promise<ModelReply>;
};

export type SummarizeInput = {
  messages: ScenarioMessage[];
  previousSummary?: string;
  model: EvalModel;
  signal?: AbortSignal;
};

export type SummarizeOutput = {
  summary: string;
  usageCostUsd: number;
  tokensIn: number;
  tokensOut: number;
};

export type CompactionStrategy = {
  id: string;
  description: string;
  summarize(input: SummarizeInput): Promise<SummarizeOutput>;
};
