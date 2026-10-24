import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BudgetExceededError, CostMeter, createDryRunModel, createRealModel } from "./model.js";
import { loadExistingSession, selectScenarios } from "./scenarios/index.js";
import { aggregate, runProbes, scoreSummary, type Aggregate, type RunScore, type Stat } from "./score.js";
import { fake, selectStrategies } from "./strategies/index.js";
import type { CompactionStrategy, EvalModel, Scenario } from "./types.js";

export const DEFAULT_MODEL = "openrouter/deepseek/deepseek-chat-v3.1";

export type RunOptions = {
  scenario: string;
  strategy: string;
  model: string;
  repeats: number;
  maxCostUsd: number;
  dryRun: boolean;
  seed?: number;
  existingSession?: string;
  keepTail?: number;
  signal?: AbortSignal;
};

export type CellResult = {
  scenarioId: string;
  family: string;
  strategyId: string;
  aggregate: Aggregate;
  runs: RunScore[];
  summaries: string[];
  error?: string;
};

export type EvalReport = {
  model: string;
  dryRun: boolean;
  repeats: number;
  spentUsd: number;
  aborted?: string;
  cells: CellResult[];
};

async function runCell(scenario: Scenario, strategy: CompactionStrategy, model: EvalModel, repeats: number, meter: CostMeter, signal?: AbortSignal): Promise<CellResult> {
  const runs: RunScore[] = [];
  const summaries: string[] = [];
  const toSummarize = scenario.messages.slice(0, scenario.messages.length - scenario.keepTail);
  for (let i = 0; i < repeats; i++) {
    const started = Date.now();
    const out = await strategy.summarize({ messages: toSummarize, model, ...(signal ? { signal } : {}) });
    meter.add(out.usageCostUsd);
    const probes = await runProbes(scenario, out.summary, model, signal);
    const scored = scoreSummary(scenario, out.summary);
    runs.push({
      ...scored,
      probePass: probes.rate,
      probeFailed: probes.failed,
      summaryCostUsd: out.usageCostUsd,
      probeCostUsd: probes.costUsd,
      totalCostUsd: out.usageCostUsd + probes.costUsd,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      latencyMs: Date.now() - started,
    });
    summaries.push(out.summary);
  }
  return { scenarioId: scenario.id, family: scenario.family, strategyId: strategy.id, aggregate: aggregate(runs), runs, summaries };
}

export async function runEval(options: RunOptions): Promise<EvalReport> {
  const meter = new CostMeter(options.maxCostUsd);
  const model = options.dryRun ? createDryRunModel(meter) : await createRealModel(options.model, meter);
  const scenarios = options.existingSession
    ? [loadExistingSession(options.existingSession, { ...(options.keepTail !== undefined ? { keepTail: options.keepTail } : {}) })]
    : selectScenarios(options.scenario, options.seed);
  const strategies = options.dryRun ? [fake] : selectStrategies(options.strategy);
  const report: EvalReport = { model: model.id, dryRun: options.dryRun, repeats: options.repeats, spentUsd: 0, cells: [] };
  try {
    for (const scenario of scenarios) {
      for (const strategy of strategies) {
        const cell = await runCell(scenario, strategy, model, options.repeats, meter, options.signal).catch((error: unknown) => {
          if (error instanceof BudgetExceededError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return { scenarioId: scenario.id, family: scenario.family, strategyId: strategy.id, aggregate: aggregate([]), runs: [], summaries: [], error: message } satisfies CellResult;
        });
        report.cells.push(cell);
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    report.aborted = error.message;
  }
  report.spentUsd = meter.spentUsd;
  return report;
}

const pct = (s: Stat | null): string => (s ? `${Math.round(s.mean * 100)}%` : "-");
const range = (s: Stat | null): string => (s && s.n > 1 ? ` (${Math.round(s.min * 100)}-${Math.round(s.max * 100)})` : "");

export function formatTable(report: EvalReport): string {
  const header = ["scenario", "strategy", "recall", "critical", "early/mid/late", "probes", "leaks", "chars", "$"];
  const rows = report.cells.map((cell) => {
    if (cell.error) return [cell.scenarioId, cell.strategyId, `ERROR: ${cell.error.slice(0, 60)}`, "", "", "", "", "", ""];
    const a = cell.aggregate;
    return [
      cell.scenarioId,
      cell.strategyId,
      pct(a.recall) + range(a.recall),
      pct(a.criticalRecall) + range(a.criticalRecall),
      `${pct(a.early)}/${pct(a.mid)}/${pct(a.late)}`,
      pct(a.probePass) + range(a.probePass),
      a.leaks ? String(a.leaks.max) : "-",
      a.summaryChars ? String(Math.round(a.summaryChars.mean)) : "-",
      a.totalCostUsd ? a.totalCostUsd.mean.toFixed(4) : "-",
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
  out.push(`model=${report.model} repeats=${report.repeats} spent=$${report.spentUsd.toFixed(4)}${report.dryRun ? " (dry run)" : ""}`);
  if (report.aborted) out.push(`ABORTED: ${report.aborted}`);
  return out.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: "string", default: "all" },
      strategy: { type: "string", default: "all" },
      model: { type: "string", default: DEFAULT_MODEL },
      repeats: { type: "string", default: "1" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "max-cost-usd": { type: "string", default: "1.00" },
      seed: { type: "string" },
      "existing-session": { type: "string" },
      "keep-tail": { type: "string" },
    },
  });
  const report = await runEval({
    scenario: values.scenario!,
    strategy: values.strategy!,
    model: values.model!,
    repeats: Math.max(1, Number(values.repeats)),
    maxCostUsd: Number(values["max-cost-usd"]),
    dryRun: values["dry-run"]!,
    ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
    ...(values["existing-session"] ? { existingSession: values["existing-session"] } : {}),
    ...(values["keep-tail"] ? { keepTail: Number(values["keep-tail"]) } : {}),
  });
  console.log(formatTable(report));
  if (values.out) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, JSON.stringify(report, null, 2));
    console.log(`wrote ${values.out}`);
  }
  return report.aborted || report.cells.some((c) => c.error) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
