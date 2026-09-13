import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predecessorEdges } from "../src/config/pipelineNeeds.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  classifyInboundAfterSuccess,
  expandJoinParent,
  isEagerSingleParentIfSkip,
  joinAllowsRun,
  pickStalledJoinSkips,
} from "../src/runtime/joinReadiness.js";
import type { StageScheduleState } from "../src/runtime/pipelineScheduler.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { RouteIfPredicate } from "../src/types/pipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const okEnvelope = (
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts: [],
  payload: {},
  ...extra,
});

const readyIf: RouteIfPredicate = {
  field: "ready",
  op: "eq",
  value: true,
};

describe("joinAllowsRun", () => {
  it("runs a join when every parent succeeded and every inbound if fired", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: true } })],
      ["draw", okEnvelope("draw-ok", { payload: { complete: true } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(true);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("stalled-skips a join when every parent succeeded but an inbound if missed", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: true } })],
      ["draw", okEnvelope("draw-ok", { payload: { complete: false } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual(["assemble"]);
  });

  it("does not run or stalled-skip while a sibling parent is still running after a miss", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "pending"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: false } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("runs a join when one parent skipped even if the succeeded inbound if missed", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "skipped"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: false } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(true);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("runs a join when one parent skipped and the succeeded inbound if fired", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "skipped"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: { ready: true } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(true);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("does not run or stalled-skip a join when a succeeded inbound is missing_field", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "succeeded"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["write", okEnvelope("write-ok", { payload: {} })],
      ["draw", okEnvelope("draw-ok", { payload: { complete: true } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("does not run or stalled-skip a join when a parent failed", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-join"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["kickoff", "succeeded"],
      ["write", "failed"],
      ["draw", "succeeded"],
      ["assemble", "pending"],
    ]);
    const envelopes = new Map<string, StageEnvelope>([
      ["draw", okEnvelope("draw-ok", { payload: { complete: false } })],
    ]);
    expect(joinAllowsRun(dag, "assemble", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });

  it("stalled-skips a join when every parent is skipped", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research", "skipped"],
      ["validation", "skipped"],
      ["synthesize", "pending"],
    ]);
    expect(joinAllowsRun(dag, "synthesize", states, new Map())).toBe(false);
    expect(pickStalledJoinSkips(dag, states)).toEqual(["synthesize"]);
  });

  it("AND-joins an ungated diamond only after every parent succeeded", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const states = new Map<string, StageScheduleState>(
      dag.nodes.map((n) => [n.id, "pending"]),
    );
    const envelopes = new Map<string, StageEnvelope>();
    expect(joinAllowsRun(dag, "synthesize", states, envelopes)).toBe(false);
    states.set("clarify", "succeeded");
    states.set("research", "succeeded");
    expect(joinAllowsRun(dag, "synthesize", states, envelopes)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
    states.set("validation", "succeeded");
    expect(joinAllowsRun(dag, "synthesize", states, envelopes)).toBe(true);
    expect(pickStalledJoinSkips(dag, states, envelopes)).toEqual([]);
  });
});

describe("Clone Chain Join parent expansion", () => {
  it("expands a catalog clone child to minted instances, else the catalog id", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    expect(expandJoinParent(loaded.dag, "handle-item")).toEqual(["handle-item"]);
    const frozen = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "handle-item",
      predecessorId: "emit-items",
      count: 2,
    });
    expect(expandJoinParent(snapshot, "handle-item")).toEqual([
      "handle-item~1",
      "handle-item~2",
    ]);
    expect(expandJoinParent(snapshot, "emit-items")).toEqual(["emit-items"]);
  });

  it("does not run the Join until every minted instance succeeded", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const frozen = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "handle-item",
      predecessorId: "emit-items",
      count: 2,
    });
    const states = new Map<string, StageScheduleState>([
      ["emit-items", "succeeded"],
      ["handle-item~1", "succeeded"],
      ["handle-item~2", "pending"],
      ["gather", "pending"],
    ]);
    expect(joinAllowsRun(snapshot, "gather", states, new Map())).toBe(false);
    states.set("handle-item~2", "succeeded");
    expect(joinAllowsRun(snapshot, "gather", states, new Map())).toBe(true);
  });

  it("does not run the Join when a minted instance failed", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const frozen = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "handle-item",
      predecessorId: "emit-items",
      count: 2,
    });
    const states = new Map<string, StageScheduleState>([
      ["emit-items", "succeeded"],
      ["handle-item~1", "succeeded"],
      ["handle-item~2", "failed"],
      ["gather", "pending"],
    ]);
    expect(joinAllowsRun(snapshot, "gather", states, new Map())).toBe(false);
    expect(pickStalledJoinSkips(snapshot, states)).toEqual([]);
  });
});

describe("isEagerSingleParentIfSkip", () => {
  it("allows a single-parent fire, skips on miss, and does not skip missing_field", async () => {
    const loaded = await loadPipeline(pipelinePath("route-if-eq"), {
      cwd: fixtures,
    });
    const dag = loaded.dag;
    const page = dag.nodes.find((n) => n.id === "page");
    expect(page).toBeDefined();
    const states = new Map<string, StageScheduleState>([
      ["triage", "succeeded"],
      ["page", "pending"],
      ["notify", "pending"],
    ]);

    const fire = new Map<string, StageEnvelope>([
      ["triage", okEnvelope("ok", { payload: { severity: "high" } })],
    ]);
    expect(joinAllowsRun(dag, "page", states, fire)).toBe(true);
    expect(
      isEagerSingleParentIfSkip(page!, "triage", { severity: "high" }),
    ).toBe(false);
    expect(
      classifyInboundAfterSuccess(page!, "triage", { severity: "high" }),
    ).toBe("fire");

    const miss = new Map<string, StageEnvelope>([
      ["triage", okEnvelope("ok", { payload: { severity: "low" } })],
    ]);
    expect(joinAllowsRun(dag, "page", states, miss)).toBe(false);
    expect(
      isEagerSingleParentIfSkip(page!, "triage", { severity: "low" }),
    ).toBe(true);
    expect(
      classifyInboundAfterSuccess(page!, "triage", { severity: "low" }),
    ).toBe("miss");

    const missing = new Map<string, StageEnvelope>([
      ["triage", okEnvelope("ok", { payload: {} })],
    ]);
    expect(joinAllowsRun(dag, "page", states, missing)).toBe(false);
    expect(isEagerSingleParentIfSkip(page!, "triage", {})).toBe(false);
    expect(classifyInboundAfterSuccess(page!, "triage", {})).toBe(
      "missing_field",
    );

    const notify = dag.nodes.find((n) => n.id === "notify");
    expect(notify).toBeDefined();
    expect(
      classifyInboundAfterSuccess(notify!, "triage", { severity: "low" }),
    ).toBe("ungated");
  });
});


