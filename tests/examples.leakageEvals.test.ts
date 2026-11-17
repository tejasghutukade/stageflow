import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import { REPO_ROOT } from "./helpers/fixturePaths.js";

const SAMPLE_DIR = path.join(REPO_ROOT, "examples", "evals");

describe("examples/evals leakage sample", () => {
  it("is judge-free and names a fixture principal on every case", async () => {
    const evalText = await readFile(path.join(SAMPLE_DIR, "leakage-sample.eval.yaml"), "utf8");
    const doc = parseYaml(evalText);
    const types = (doc.graders as Array<{ type: string }>).map((g) => g.type);
    expect(types).toEqual(["consumer_scope"]);
    expect(types.filter((t) => t === "rubric" || t === "goal_reached")).toEqual([]);
    expect(doc.defaults?.judge).toBeUndefined();

    const dataset = await loadDatasetFile(path.join(SAMPLE_DIR, "leakage-sample.dataset.jsonl"), { root: REPO_ROOT });
    expect(dataset.cases).toHaveLength(3);
    for (const c of dataset.cases) {
      expect((c.metadata as { principal?: string }).principal).toBe("customer-a");
      expect((c.input as { mode?: string }).mode).toBe("script");
    }
  });
});