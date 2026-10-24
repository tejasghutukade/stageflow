import type { Scenario } from "../types.js";
import { buildBrowser } from "./browser.js";
import { buildCoding } from "./coding.js";
import { buildLogAnalysis } from "./logAnalysis.js";
import { buildOperatorQa } from "./operatorQa.js";
import { buildProjectAgent } from "./projectAgent.js";
import { buildRepair } from "./repair.js";
import { buildResearch } from "./research.js";

export { loadExistingSession } from "./existingSession.js";

export type ScenarioEntry = { id: string; family: string; build(seed?: number): Scenario };

export const SCENARIOS: ScenarioEntry[] = [
  { id: "log-analysis-1", family: "log-analysis", build: buildLogAnalysis },
  { id: "coding-1", family: "coding", build: buildCoding },
  { id: "research-1", family: "research", build: buildResearch },
  { id: "operator-qa-1", family: "operator-qa", build: buildOperatorQa },
  { id: "repair-1", family: "repair", build: buildRepair },
  { id: "browser-1", family: "browser", build: buildBrowser },
  { id: "project-agent-1", family: "project-agent", build: buildProjectAgent },
];

export function selectScenarios(selector: string, seed?: number): Scenario[] {
  const entries = selector === "all" ? SCENARIOS : SCENARIOS.filter((e) => e.id === selector || e.family === selector);
  if (entries.length === 0) throw new Error(`unknown scenario "${selector}" (known: ${SCENARIOS.map((e) => e.id).join(", ")}, all)`);
  return entries.map((entry) => entry.build(seed));
}
