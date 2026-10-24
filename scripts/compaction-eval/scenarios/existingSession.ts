import { readFileSync } from "node:fs";
import path from "node:path";
import type { Scenario, ScenarioMessage } from "../types.js";

const ROLES = new Set(["user", "assistant", "toolResult"]);

export function loadExistingSession(file: string, options: { keepTail?: number; id?: string } = {}): Scenario {
  const messages: ScenarioMessage[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: ScenarioMessage };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === "compaction") {
      messages.length = 0;
      continue;
    }
    if (entry.type !== "message" || !entry.message || !ROLES.has(entry.message.role)) continue;
    messages.push(entry.message);
  }
  if (messages.length === 0) throw new Error(`${file}: no user/assistant/toolResult messages found`);
  return {
    id: options.id ?? `existing-${path.basename(file, ".jsonl")}`,
    family: "existing-session",
    description: `Replay of ${path.basename(file)}`,
    messages,
    keepTail: Math.min(options.keepTail ?? 8, Math.max(messages.length - 1, 0)),
    facts: [],
    probes: [],
    secrets: [],
  };
}
