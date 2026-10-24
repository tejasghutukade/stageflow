import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatTable, main, runEval } from "../scripts/compaction-eval/run.js";
import { fake, selectStrategies } from "../scripts/compaction-eval/strategies/index.js";

describe("compaction-eval runner (dry run)", () => {
  it("runs the fake strategy over every scenario without a network", async () => {
    const report = await runEval({ scenario: "all", strategy: "all", model: "x/y", repeats: 2, maxCostUsd: 1, dryRun: true });
    expect(report.cells).toHaveLength(7);
    expect(report.cells.every((c) => c.strategyId === "fake" && !c.error)).toBe(true);
    const log = report.cells.find((c) => c.family === "log-analysis")!;
    expect(log.runs).toHaveLength(2);
    expect(log.aggregate.recall!.mean).toBeLessThan(1);
    expect(log.aggregate.leaks!.max).toBe(0);
    expect(report.spentUsd).toBe(0);
  });

  it("filters by family and renders a table", async () => {
    const report = await runEval({ scenario: "coding", strategy: "fake", model: "x/y", repeats: 1, maxCostUsd: 1, dryRun: true });
    expect(report.cells.map((c) => c.scenarioId)).toEqual(["coding-1"]);
    const table = formatTable(report);
    expect(table).toContain("coding-1");
    expect(table).toContain("critical");
  });

  it("writes JSON through the CLI entry", async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "ceval-")), "r.json");
    const code = await main(["--dry-run", "--scenario", "repair", "--out", out]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).cells[0].scenarioId).toBe("repair-1");
  });

  it("rejects unknown scenarios and strategies", async () => {
    await expect(runEval({ scenario: "nope", strategy: "all", model: "x/y", repeats: 1, maxCostUsd: 1, dryRun: true })).rejects.toThrow(/unknown scenario/);
    expect(() => selectStrategies("nope")).toThrow(/unknown strategy/);
    expect(selectStrategies("fake")).toEqual([fake]);
  });
});
