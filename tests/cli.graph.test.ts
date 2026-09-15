import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LoadedPipeline,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../src/types/pipeline.js";
import { renderGraph } from "../src/cli/graphRender.js";
import { runGraphCommand } from "../src/cli/graphCommand.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function node(id: string, extra: Partial<ResolvedPipelineStageNode> = {}): ResolvedPipelineStageNode {
  return {
    id,
    needs: null,
    needsEdges: [],
    ancestors: [],
    stageIndex: 0,
    ...extra,
  };
}

function dagFromNodes(
  nodes: ResolvedPipelineStageNode[],
  roots: string[],
  childrenOf: Record<string, string[]>,
): ResolvedPipelineDag {
  return { nodes, roots, childrenOf };
}

describe("renderGraph", () => {
  it("marks an entry node with the entry marker", () => {
    const dag = dagFromNodes(
      [node("start", { entry: true }), node("next")],
      ["start"],
      { start: ["next"], next: [] },
    );
    const out = renderGraph(dag);
    expect(out).toMatch(/▶ start/);
    expect(out).not.toMatch(/▶ next/);
  });

  it("renders a clone band on the emitter edge and not N child rows", () => {
    const dag = dagFromNodes(
      [
        node("emit", { clone_cap: 8, clone_mode: "parallel" }),
        node("child", { stageIndex: 1 }),
      ],
      ["emit"],
      { emit: ["child"], child: [] },
    );
    const out = renderGraph(dag);
    expect(out).toMatch(/child~8/);
    expect(out).toMatch(/parallel/);
    // The actual child node is drawn exactly once as a node line.
    expect(out.split("\n").filter((line) => line.startsWith("  child")).length).toBe(1);
  });

  it("renders a loop return cue and leaves childrenOf unchanged", () => {
    const dag = dagFromNodes(
      [
        node("a"),
        node("b", {
          stageIndex: 1,
          feedback_loop: {
            target: "a",
            max_replays: 3,
            on_max_replays: "wait_for_human",
            replay_session: "new_session",
          },
        }),
      ],
      ["a"],
      { a: ["b"], b: [] },
    );
    const before = JSON.stringify(dag.childrenOf);
    const out = renderGraph(dag);
    expect(out).toMatch(/↩ loop ×3 → a/);
    expect(out).toMatch(/wait_for_human/);
    expect(JSON.stringify(dag.childrenOf)).toBe(before);
  });

  it("keeps every line within 80 columns", () => {
    const dag = dagFromNodes(
      [
        node("decompose", { entry: true, clone_cap: 8, clone_mode: "parallel" }),
        node("plan"),
        node("align", { clone_cap: 8, clone_mode: "sequential" }),
        node("implement"),
        node("verify"),
        node("review"),
        node("address-feedback", {
          feedback_loop: {
            target: "review",
            max_replays: 2,
            on_max_replays: "wait_for_human",
            replay_session: "new_session",
          },
        }),
        node("publish", { replay_safe: false }),
      ],
      ["decompose"],
      {
        decompose: ["plan"],
        plan: ["align"],
        align: ["implement"],
        implement: ["verify"],
        verify: ["review"],
        review: ["address-feedback"],
        "address-feedback": ["publish"],
        publish: [],
      },
    );
    const out = renderGraph(dag);
    for (const line of out.split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
  });

  it("clamps an oversized node id to <=80 columns", () => {
    const longId = "x".repeat(151);
    const dag = dagFromNodes(
      [node(longId, { entry: true }), node("next")],
      [longId],
      { [longId]: ["next"], next: [] },
    );
    const out = renderGraph(dag);
    const lines = out.split("\n");
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
    // The 151-char id cannot fit alone in an 80-col line, so it must be elided.
    expect(out).toMatch(/…/);
    // No emitted line is wider than the original 151-char id would be.
    expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(80);
  });

  it("clamps an oversized feedback-loop target to <=80 columns", () => {
    const longTarget = "t".repeat(134);
    const dag = dagFromNodes(
      [
        node("a"),
        node("b", {
          stageIndex: 1,
          feedback_loop: {
            target: longTarget,
            max_replays: 2,
            on_max_replays: "wait_for_human",
            replay_session: "new_session",
          },
        }),
      ],
      ["a"],
      { a: ["b"], b: [] },
    );
    const out = renderGraph(dag);
    const lines = out.split("\n");
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(80);
    }
    // The loop cue line names the target and must be elided past 80 columns.
    const cue = lines.find((l) => l.includes("↩ loop"))!;
    expect(cue).toContain("↩ loop");
    expect([...cue].length).toBeLessThanOrEqual(80);
    expect(out).toMatch(/…/);
  });

  it("orders nodes from roots downward", () => {
    const dag = dagFromNodes(
      [node("a"), node("b", { stageIndex: 1 }), node("c", { stageIndex: 2 })],
      ["a"],
      { a: ["b"], b: ["c"], c: [] },
    );
    const out = renderGraph(dag);
    expect(out.indexOf("a")).toBeLessThan(out.indexOf("b"));
    expect(out.indexOf("b")).toBeLessThan(out.indexOf("c"));
  });
});

describe("runGraphCommand", () => {
  it("--json dumps the resolved DAG from the loader", async () => {
    const fakeDag = dagFromNodes(
      [node("only")],
      ["only"],
      { only: [] },
    );
    const loadPipeline = vi.fn(async () => ({ dag: fakeDag }) as unknown as LoadedPipeline);
    const logs: string[] = [];
    const code = await runGraphCommand(["--json", "--pipeline", "x.yaml"], {
      loadPipeline,
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(code).toBe(0);
    expect(loadPipeline).toHaveBeenCalledWith("x.yaml", expect.any(Object));
    expect(() => JSON.parse(logs[0]!)).not.toThrow();
    expect(JSON.parse(logs[0]!)).toEqual(fakeDag);
  });

  it("renders ASCII for the default (non-json) mode", async () => {
    const fakeDag = dagFromNodes(
      [node("top", { entry: true }), node("bottom")],
      ["top"],
      { top: ["bottom"], bottom: [] },
    );
    const loadPipeline = vi.fn(async () => ({ dag: fakeDag }) as unknown as LoadedPipeline);
    const logs: string[] = [];
    const code = await runGraphCommand(["--pipeline", "x.yaml"], {
      loadPipeline,
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(code).toBe(0);
    expect(logs[0]).toMatch(/▶ top/);
    expect(logs[0]).toMatch(/bottom/);
  });

  it("errors when --pipeline is missing", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand([], {
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Missing value for --pipeline/);
  });

  it("errors when --pipeline has no value", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline"], {
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Missing value for --pipeline/);
  });

  it("rejects unknown flags", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", "x.yaml", "--bogus"], {
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown flag: --bogus/);
  });

  it("prints usage and exits 0 on --help", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand(["--help"], {
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(0);
    expect(errors.join("\n")).toMatch(/sf graph --pipeline/);
  });
});

describe("sf graph integration", { timeout: 30_000 }, () => {
  const featureLoop = "examples/feature-loop/feature-loop.pipeline.yaml";

  it("renders entry, clone bands, and loop cue for feature-loop", () => {
    const result = runCli(["graph", "--pipeline", featureLoop]);
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toMatch(/▶ decompose/);
    expect(out).toMatch(/child~8/);

    // child~8 appears adjacent to decompose and to align.
    const lines = out.split("\n");
    const decomposeIdx = lines.findIndex((l) => l.includes("▶ decompose"));
    const alignIdx = lines.findIndex((l) => l.trim().startsWith("align"));
    expect(decomposeIdx).toBeGreaterThanOrEqual(0);
    expect(alignIdx).toBeGreaterThanOrEqual(0);
    const bandAfterDecompose = lines
      .slice(decomposeIdx, decomposeIdx + 6)
      .some((l) => l.includes("child~8"));
    const bandAfterAlign = lines
      .slice(alignIdx, alignIdx + 6)
      .some((l) => l.includes("child~8"));
    expect(bandAfterDecompose).toBe(true);
    expect(bandAfterAlign).toBe(true);

    // Loop cue from address-feedback naming review.
    const addressIdx = lines.findIndex((l) => l.trim().startsWith("address-feedback"));
    expect(addressIdx).toBeGreaterThanOrEqual(0);
    const loopCue = lines
      .slice(addressIdx, addressIdx + 4)
      .find((l) => l.includes("↩ loop"));
    expect(loopCue).toMatch(/review/);
  });

  it("--json exposes clone_cap / clone_mode / feedback_loop fields", () => {
    const result = runCli(["graph", "--pipeline", featureLoop, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      nodes: Array<Record<string, unknown>>;
      roots?: unknown;
      childrenOf?: unknown;
      stages?: unknown;
      path?: unknown;
    };
    expect(parsed).toEqual(
      expect.objectContaining({
        nodes: expect.any(Array),
        roots: expect.any(Array),
        childrenOf: expect.any(Object),
      }),
    );
    expect(parsed).not.toHaveProperty("stages");
    expect(parsed).not.toHaveProperty("path");
    const byId = Object.fromEntries(parsed.nodes.map((n) => [n.id, n]));
    expect(byId.decompose).toMatchObject({ clone_cap: 8, clone_mode: "parallel", entry: true });
    expect(byId.align).toMatchObject({ clone_cap: 8, clone_mode: "sequential" });
    expect(byId["address-feedback"]).toMatchObject({
      feedback_loop: { target: "review", max_replays: 2 },
    });
  });

  it("exits 1 with a clear error on a missing pipeline file", () => {
    const result = runCli(["graph", "--pipeline", "does-not-exist.yaml"]);
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/Missing value for --pipeline|not found/i);
  });
});
