import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import {
  buildWorkshopGraphModel,
  findingFieldPath,
  nodeErrorSummary,
  onFailLabel,
  stageChangeStatus,
} from "./workshopGraphModel";

const io = { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } };
const verify = [{ id: "tests", type: "command", command: "npm test", when: ["after"] }];
const repair = { mode: "repair", max_attempts: 2, retry_safety: "idempotent", include_failed_checks: true };

function file(id: string, extra: Record<string, unknown> = {}) {
  return { path: `./${id}.yaml`, body: { id, system_prompt: `do ${id}`, io, ...extra } };
}

function baseline(): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      stages: [
        { id: "plan", uses: "./plan.yaml", entry: true, route: [{ to: "implement" }] },
        { id: "implement", uses: "./implement.yaml", route: [{ to: "review" }, { to: "test" }] },
        { id: "review", uses: "./review.yaml", route: [{ to: "ship" }] },
        { id: "test", uses: "./test.yaml", on_verify_fail: "fail", route: [{ to: "ship" }] },
        { id: "ship", uses: "./ship.yaml" },
      ],
    },
    stages: [
      file("plan", { model: "claude-sonnet-4-5", gate_kinds: ["free_text"] }),
      file("implement", { model: "claude-sonnet-4-5", verify }),
      file("review", { model: "claude-sonnet-4-5", verify, gate_kinds: ["confirm"] }),
      file("test", { model: "openai/gpt-5.2", verify }),
      file("ship", { model: "claude-sonnet-4-5", gate_kinds: ["confirm"] }),
    ],
  };
}

function edited(): DraftPackagePayload {
  const draft = baseline();
  draft.pipeline.stages = [
    draft.pipeline.stages[0]!,
    draft.pipeline.stages[1]!,
    { id: "review", uses: "./review.yaml", on_verify_fail: repair, route: [{ to: "security-scan" }] },
    { id: "test", uses: "./test.yaml", on_verify_fail: "fail", route: [{ to: "security-scan" }] },
    {
      id: "security-scan",
      uses: "./security-scan.yaml",
      on_verify_fail: { mode: "manual", retry_safety: "side_effecting" },
      route: [{ to: "ship" }],
    },
    draft.pipeline.stages[4]!,
  ];
  draft.stages = [...draft.stages!, file("security-scan", { verify, gate_kinds: ["confirm"] })];
  return draft;
}

const ioFinding: ValidationFinding = {
  severity: "error",
  code: "stage.invalid_io",
  path: "workshop/feature-ship/security-scan.yaml",
  message: "io.input.schema must declare properties",
  category: "stage",
  stageId: "security-scan",
};

describe("stageChangeStatus", () => {
  it("marks every stage new without a baseline", () => {
    expect([...stageChangeStatus(baseline(), null).values()]).toEqual([
      "new",
      "new",
      "new",
      "new",
      "new",
    ]);
  });

  it("attributes rewired edges to the target, not the source", () => {
    expect(Object.fromEntries(stageChangeStatus(edited(), baseline()))).toEqual({
      plan: "unchanged",
      implement: "unchanged",
      review: "edited",
      test: "unchanged",
      "security-scan": "new",
      ship: "edited",
    });
  });

  it("ignores key order in stage bodies", () => {
    const reordered = baseline();
    const body = reordered.stages![0]!.body;
    reordered.stages![0]!.body = Object.fromEntries(Object.entries(body).reverse());
    expect(stageChangeStatus(reordered, baseline()).get("plan")).toBe("unchanged");
  });
});

describe("buildWorkshopGraphModel", () => {
  const model = buildWorkshopGraphModel(edited(), {
    baseline: baseline(),
    findings: [ioFinding],
    defaultModel: "claude-sonnet-4-5",
  });
  const node = (id: string) => model.nodes.find((n) => n.id === id)!;

  it("lays out layers from route wiring", () => {
    expect(
      model.rows.map((row) => row.items.map((item) => (item.kind === "node" ? item.id : "|"))),
    ).toEqual([["plan"], ["implement"], ["review", "test"], ["security-scan"], ["ship"]]);
    expect(model.width).toBe(432);
    expect(model.rows.map((row) => row.offset)).toEqual([112, 112, 0, 112, 112]);
  });

  it("derives model lines and chips like the design", () => {
    expect(node("plan").model).toBe("claude-sonnet-4-5");
    expect(node("security-scan").model).toBe("inherits · claude-sonnet-4-5");
    expect(node("security-scan").modelInherited).toBe(true);
    const chips = (id: string) => node(id).chips.map((c) => `${c.label}:${c.variant}`);
    expect(chips("plan")).toEqual(["ask: free_text:default"]);
    expect(chips("implement")).toEqual(["verify:default", "no gate:dashed"]);
    expect(chips("review")).toEqual([
      "verify:default",
      "on_fail: retry:changed",
      "ask: confirm:default",
    ]);
    expect(chips("test")).toEqual(["verify:default", "on_fail: fail:default"]);
    expect(chips("security-scan")).toEqual([
      "verify:default",
      "on_fail: ask:default",
      "ask: confirm:default",
    ]);
    expect(chips("ship")).toEqual(["ask: confirm:default", "needs: security-scan:changed"]);
  });

  it("summarizes errors per node", () => {
    expect(node("security-scan").errorSummary).toBe("io.input · 1 error");
    expect(node("security-scan").errorCount).toBe(1);
    expect(node("plan").errorSummary).toBeNull();
  });

  it("builds straight, fork, and merge connectors with changed wiring", () => {
    expect(model.connectors.map((c) => [c.kind, c.height])).toEqual([
      ["straight", 14],
      ["fork", 22],
      ["merge", 22],
      ["straight", 14],
    ]);
    expect(model.connectors[0]!.segments).toEqual([
      { x: 216, y: 0, width: 1, height: 14, changed: false },
    ]);
    expect(model.connectors[1]!.segments).toEqual([
      { x: 216, y: 0, width: 1, height: 11, changed: false },
      { x: 104, y: 11, width: 113, height: 1, changed: false },
      { x: 104, y: 11, width: 1, height: 11, changed: false },
      { x: 216, y: 0, width: 1, height: 11, changed: false },
      { x: 216, y: 11, width: 113, height: 1, changed: false },
      { x: 328, y: 11, width: 1, height: 11, changed: false },
    ]);
    expect(model.connectors[2]!.segments.every((s) => s.changed)).toBe(true);
    expect(model.connectors[3]!.segments).toEqual([
      { x: 216, y: 0, width: 1, height: 14, changed: true },
    ]);
    expect(model.edges.filter((e) => e.changed).map((e) => `${e.from}>${e.to}`)).toEqual([
      "review>security-scan",
      "test>security-scan",
      "security-scan>ship",
    ]);
    expect(model.hasChanges).toBe(true);
  });

  it("uses needs and the implicit previous-stage chain", () => {
    const graph = buildWorkshopGraphModel({
      pipeline: {
        id: "p",
        stages: [{ id: "a" }, { id: "b" }, { id: "c", needs: ["a", "b"] }],
      },
    });
    expect(graph.nodes.map((n) => [n.id, n.layer, n.isEntry])).toEqual([
      ["a", 0, true],
      ["b", 1, false],
      ["c", 2, false],
    ]);
    expect(graph.rows[1]!.items.map((item) => item.kind)).toEqual(["node", "pass"]);
    expect(graph.rows[1]!.width).toBe(208 + 16 + 12);
    expect(graph.connectors.map((c) => c.kind)).toEqual(["fork", "merge"]);
    expect(graph.nodes[0]!.model).toBe("inherits · default");
  });

  it("survives dependency cycles", () => {
    const graph = buildWorkshopGraphModel({
      pipeline: { id: "p", stages: [{ id: "a", needs: "b" }, { id: "b", needs: "a" }] },
    });
    expect(graph.nodes.map((n) => n.layer).sort()).toEqual([0, 1]);
    expect(graph.edges).toHaveLength(1);
  });

  it("is empty for an empty draft", () => {
    const graph = buildWorkshopGraphModel({ pipeline: { id: "untitled", stages: [] } });
    expect(graph).toMatchObject({ nodes: [], rows: [], connectors: [], width: 0, hasChanges: false });
  });
});

describe("finding helpers", () => {
  it("maps findings to field paths", () => {
    expect(findingFieldPath(ioFinding)).toBe("io.input");
    expect(findingFieldPath({ ...ioFinding, code: "stage.missing_model", message: "no default" })).toBe(
      "model",
    );
    expect(findingFieldPath({ ...ioFinding, code: "stage.invalid_timeout_ms", message: "bad" })).toBe(
      "timeout_ms",
    );
  });

  it("pluralizes and collapses multiple fields", () => {
    const second = { ...ioFinding, code: "stage.invalid_model", message: "bad model id" };
    const warning = { ...ioFinding, severity: "warning" as const };
    expect(nodeErrorSummary([ioFinding, second, warning], "security-scan")).toEqual({
      count: 2,
      summary: "io.input +1 · 2 errors",
    });
  });

  it("falls back to the stage id named in the message", () => {
    const { stageId: _drop, ...rest } = ioFinding;
    expect(
      nodeErrorSummary([{ ...rest, message: 'stage "review": verify[0] command is empty' }], "review"),
    ).toEqual({ count: 1, summary: "verify[0] · 1 error" });
  });

  it("labels on_verify_fail policies", () => {
    expect(onFailLabel(repair)).toBe("retry");
    expect(onFailLabel({ mode: "manual" })).toBe("ask");
    expect(onFailLabel("fail")).toBe("fail");
    expect(onFailLabel(undefined)).toBeNull();
  });
});
