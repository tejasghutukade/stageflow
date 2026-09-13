import { describe, expect, it } from "vitest";
import { loadPipelineOutcome, resolvePipelinePath } from "../src/config/loadPipeline.js";
import { formatGraphHuman, formatGraphJson } from "../src/cli/graphOutput.js";
import { REPO_ROOT } from "./helpers/fixturePaths.js";
import path from "node:path";

const FEATURE_LOOP_PIPELINE = path.join(
  REPO_ROOT,
  "examples",
  "feature-loop",
  "feature-loop.pipeline.yaml",
);

async function loadFeatureLoop() {
  const pipelinePath = await resolvePipelinePath(FEATURE_LOOP_PIPELINE, REPO_ROOT);
  const outcome = await loadPipelineOutcome(pipelinePath, {
    cwd: REPO_ROOT,
    projectRoot: REPO_ROOT,
  });
  if (!outcome.ok) {
    throw new Error(
      `feature-loop fixture failed to load: ${outcome.issues.map((i) => i.message).join(", ")}`,
    );
  }
  return outcome.value;
}

describe("formatGraphHuman", () => {
  it("marks the entry stage", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphHuman(loaded, { path: FEATURE_LOOP_PIPELINE });
    const decomposeLine = output.split("\n").find((line) => line.includes("decompose"));
    expect(decomposeLine).toMatch(/ENTRY/);
  });

  it("renders clone-chain fan-out bands for decompose and align", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphHuman(loaded, { path: FEATURE_LOOP_PIPELINE });
    expect(output).toMatch(/\u00d7 up to 8 \(parallel\)/);
    expect(output).toMatch(/\u00d7 up to 8 \(sequential\)/);
  });

  it("renders the send_back cue for address-feedback -> review, not a second edge", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphHuman(loaded, { path: FEATURE_LOOP_PIPELINE });
    expect(output).toMatch(/send_back.*review/);
    expect(output).toMatch(/max 2 replays/);

    const lines = output.split("\n");
    const start = lines.findIndex(
      (line) => line.startsWith("\u250c") && /\baddress-feedback\b/.test(line),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && line.startsWith("\u2514"));
    const boxBody = lines
      .slice(start + 1, end)
      .filter((line) => line.startsWith("\u2502 "))
      .map((line) => line.slice(2).replace(/\s*\u2502$/, "").trimEnd());
    expect(boxBody.some((line) => line.includes("send_back"))).toBe(true);
    expect(boxBody).not.toContain("\u2192 review");
    expect(boxBody.filter((line) => line.startsWith("\u2192 "))).toEqual([]);
    expect(loaded.dag.childrenOf["address-feedback"]).toEqual(["publish"]);
    expect(loaded.dag.childrenOf["address-feedback"]).not.toContain("review");
    const reviewBox = lines.find(
      (line) => line.startsWith("\u250c") && /\breview\b/.test(line) && !/address-feedback/.test(line),
    );
    expect(reviewBox).toBeDefined();
    const afterAddress = lines.slice(end + 1, end + 5).join("\n");
    expect(afterAddress).not.toMatch(/\u2192\s*review/);
    expect(afterAddress).not.toMatch(/send_back/);
  });

  it("aligns top, body, and bottom box borders to one width", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphHuman(loaded, { path: FEATURE_LOOP_PIPELINE });
    const lines = output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.startsWith("\u250c")) continue;
      const top = line;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j]!.startsWith("\u2502")) {
        body.push(lines[j]!);
        j++;
      }
      const bottom = lines[j]!;
      expect(bottom.startsWith("\u2514")).toBe(true);
      expect(top.length).toBe(bottom.length);
      for (const bodyLine of body) {
        expect(bodyLine.length).toBe(top.length);
      }
    }
  });

  it("aligns borders when a stage label exceeds the prior soft width clamp", async () => {
    const longId = "stage-with-a-very-long-identifier-that-exceeds-seventy-six-columns-abcdefgh";
    const loaded = {
      pipeline: { id: "wide", entry: longId, stages: {} },
      stages: [],
      pipelinePath: "wide.pipeline.yaml",
      dag: {
        nodes: [
          {
            id: longId,
            needs: null,
            needsEdges: [],
            ancestors: [],
            stageIndex: 0,
            entry: true,
            clone_cap: 3,
            clone_mode: "parallel" as const,
            feedback_loop: { type: "loop" as const, target: "upstream", max_replays: 4 },
          },
        ],
        roots: [longId],
        childrenOf: { [longId]: ["next-a", "next-b"] },
      },
    };
    const output = formatGraphHuman(loaded as never, { path: "wide.pipeline.yaml" });
    const lines = output.split("\n");
    const top = lines.find((line) => line.startsWith("\u250c"))!;
    const body = lines.filter((line) => line.startsWith("\u2502 "));
    const bottom = lines.find((line) => line.startsWith("\u2514"))!;
    expect(top.length).toBe(bottom.length);
    for (const bodyLine of body) {
      expect(bodyLine.length).toBe(top.length);
    }
    expect(top.length).toBeGreaterThan(76);
  });

  it("includes every stage id exactly once", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphHuman(loaded, {
      path: "examples/feature-loop/feature-loop.pipeline.yaml",
    });
    const ids = [
      "decompose",
      "plan",
      "align",
      "implement",
      "verify",
      "review",
      "address-feedback",
      "publish",
    ];
    for (const id of ids) {
      const topBorderHits = output
        .split("\n")
        .filter((line) => line.startsWith("\u250c") && new RegExp(`\\b${id}\\b`).test(line));
      expect(topBorderHits.length).toBe(1);
    }
  });

  it("lists multiple forward targets for a branching stage", async () => {
    const pipelinePath = await resolvePipelinePath(
      "tests/fixtures/pipelines/route-select-subset.pipeline.yaml",
      REPO_ROOT,
    );
    const outcome = await loadPipelineOutcome(pipelinePath, {
      cwd: REPO_ROOT,
      projectRoot: REPO_ROOT,
    });
    if (!outcome.ok) {
      throw new Error("route-select-subset fixture failed to load");
    }
    const output = formatGraphHuman(outcome.value, { path: pipelinePath });
    expect(output).toMatch(/\u2192 branch-a/);
    expect(output).toMatch(/\u2192 branch-b/);
    expect(output).toMatch(/\u2192 branch-c/);
  });

  it("keeps every line within 80 columns for the feature-loop fixture", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphHuman(loaded, {
      path: "examples/feature-loop/feature-loop.pipeline.yaml",
    });
    for (const line of output.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("renders a minimal single-stage pipeline without a clone band or send_back line", async () => {
    const pipelinePath = await resolvePipelinePath(
      "tests/fixtures/pipelines/single.pipeline.yaml",
      REPO_ROOT,
    );
    const outcome = await loadPipelineOutcome(pipelinePath, {
      cwd: REPO_ROOT,
      projectRoot: REPO_ROOT,
    });
    if (!outcome.ok) {
      throw new Error("single fixture failed to load");
    }
    expect(() => formatGraphHuman(outcome.value, { path: pipelinePath })).not.toThrow();
    const output = formatGraphHuman(outcome.value, { path: pipelinePath });
    expect(output).not.toMatch(/send_back/);
    expect(output).not.toMatch(/up to \d+/);
  });
});

describe("formatGraphJson", () => {
  it("round-trips the resolved dag shape", async () => {
    const loaded = await loadFeatureLoop();
    const output = formatGraphJson(loaded.dag);
    const parsed = JSON.parse(output) as {
      nodes: unknown[];
      roots: string[];
      childrenOf: Record<string, string[]>;
    };
    expect(Object.keys(parsed).sort()).toEqual(["childrenOf", "nodes", "roots"]);
    expect(parsed.nodes).toEqual(JSON.parse(JSON.stringify(loaded.dag.nodes)));
    expect(parsed.nodes).toHaveLength(loaded.dag.nodes.length);
    expect(parsed.roots).toEqual(loaded.dag.roots);
    expect(parsed.roots).toContain("decompose");
    expect(Object.keys(parsed.childrenOf).sort()).toEqual(
      Object.keys(loaded.dag.childrenOf).sort(),
    );
    expect(parsed.childrenOf).toEqual(loaded.dag.childrenOf);
    expect(parsed.childrenOf["address-feedback"]).toEqual(["publish"]);
    expect(parsed.childrenOf["address-feedback"]).not.toContain("review");
    expect(parsed.childrenOf["review"]).toEqual(
      expect.arrayContaining(["address-feedback"]),
    );
  });
});
