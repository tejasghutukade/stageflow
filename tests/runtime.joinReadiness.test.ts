import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predecessorEdges } from "../src/config/pipelineNeeds.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  classifyInboundAfterSuccess,
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

describe("clone-expanded join if", () => {
  it("reads if from the join node, not minted clone nodes", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in-clone"), {
      cwd: fixtures,
    });
    const snapshot = buildPipelineDagSnapshotFromLoaded(loaded);
    const withIf = {
      ...snapshot,
      nodes: snapshot.nodes.map((n) =>
        n.id === "synthesize"
          ? {
              ...n,
              needsEdges: n.needsEdges.map((edge) =>
                edge.id === "research" ? { ...edge, if: readyIf } : edge,
              ),
            }
          : n,
      ),
    };
    const { snapshot: dag } = appendCloneInstances(withIf, {
      catalogId: "research",
      predecessorId: "clarify",
      count: 2,
    });
    const cloneNode = dag.nodes.find((n) => n.id === "research~1");
    const joinNode = dag.nodes.find((n) => n.id === "synthesize");
    expect(cloneNode).toBeDefined();
    expect(joinNode).toBeDefined();
    expect(predecessorEdges(cloneNode!).every((edge) => edge.if === undefined)).toBe(
      true,
    );
    expect(
      predecessorEdges(joinNode!).find((edge) => edge.id === "research")?.if,
    ).toEqual(readyIf);

    const states = new Map<string, StageScheduleState>([
      ["clarify", "succeeded"],
      ["research~1", "succeeded"],
      ["research~2", "succeeded"],
      ["validation", "succeeded"],
      ["synthesize", "pending"],
    ]);
    const fired = new Map<string, StageEnvelope>([
      ["research~1", okEnvelope("r1", { payload: { ready: true } })],
      ["research~2", okEnvelope("r2", { payload: { ready: true } })],
      ["validation", okEnvelope("v-ok")],
    ]);
    expect(joinAllowsRun(dag, "synthesize", states, fired)).toBe(true);
    expect(pickStalledJoinSkips(dag, states, fired)).toEqual([]);

    const missed = new Map<string, StageEnvelope>([
      ["research~1", okEnvelope("r1", { payload: { ready: true } })],
      ["research~2", okEnvelope("r2", { payload: { ready: false } })],
      ["validation", okEnvelope("v-ok")],
    ]);
    expect(joinAllowsRun(dag, "synthesize", states, missed)).toBe(false);
    expect(pickStalledJoinSkips(dag, states, missed)).toEqual(["synthesize"]);
  });
});
