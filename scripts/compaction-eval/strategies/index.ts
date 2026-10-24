import type { CompactionStrategy } from "../types.js";
import { baseline } from "./baseline.js";
import { fake } from "./fake.js";
import { focus } from "./focus.js";
import { stageflowFocusPins, stageflowFull, stageflowPins } from "./stageflow.js";

export { fake };

/** Register new strategies here (or call registerStrategy from an adapter). `--strategy all` runs every entry. */
const registry = new Map<string, CompactionStrategy>([
  [baseline.id, baseline],
  [focus.id, focus],
  [stageflowPins.id, stageflowPins],
  [stageflowFocusPins.id, stageflowFocusPins],
  [stageflowFull.id, stageflowFull],
]);

export function registerStrategy(strategy: CompactionStrategy): void {
  registry.set(strategy.id, strategy);
}

export function allStrategies(): CompactionStrategy[] {
  return [...registry.values()];
}

export function selectStrategies(selector: string): CompactionStrategy[] {
  if (selector === "all") return allStrategies();
  const out: CompactionStrategy[] = [];
  for (const id of selector.split(",").map((s) => s.trim()).filter(Boolean)) {
    const found = registry.get(id) ?? (id === fake.id ? fake : undefined);
    if (!found) throw new Error(`unknown strategy "${id}" (known: ${[...registry.keys()].join(", ")})`);
    out.push(found);
  }
  return out;
}
