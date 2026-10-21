import { describe, expect, it } from "vitest";
import type { ValidationFinding, WorkshopChatProposalPayload } from "../../../api";
import {
  artifactsDelta,
  changeRows,
  filterTasks,
  findingLocation,
  lineDelta,
  messageSegments,
  problemsBadge,
  sortFindings,
  taskFieldRows,
  taskTabSuffix,
  validatedMeta,
  type WorkshopMutationCard,
} from "./drawerModel";

function finding(partial: Partial<ValidationFinding>): ValidationFinding {
  return {
    severity: "error",
    code: "stage.invalid_shape",
    path: "stages/x.yaml",
    message: "bad",
    category: "stage",
    ...partial,
  };
}

function proposal(
  id: string,
  artifacts: WorkshopChatProposalPayload["artifacts"],
  summary = `change ${id}`,
): WorkshopChatProposalPayload {
  const draft = { pipeline: { id: "p", stages: [] } };
  return {
    id,
    summary,
    nextDraft: draft,
    baseDraft: draft,
    baseFingerprint: "f",
    artifacts,
    affectedStageIds: [],
  };
}

describe("problemsBadge", () => {
  it("shows an em dash before the first validation", () => {
    expect(problemsBadge(null)).toEqual({ kind: "unvalidated", label: "—" });
  });

  it("counts errors when any exist", () => {
    const badge = problemsBadge([
      finding({ severity: "error" }),
      finding({ severity: "warning" }),
      finding({ severity: "error" }),
    ]);
    expect(badge).toEqual({ kind: "errors", count: 2, label: "2" });
  });

  it("counts all findings when there are no errors", () => {
    expect(problemsBadge([finding({ severity: "warning" })])).toEqual({
      kind: "count",
      count: 1,
      label: "1",
    });
    expect(problemsBadge([])).toEqual({ kind: "count", count: 0, label: "0" });
  });
});

describe("sortFindings", () => {
  it("orders errors, warnings, then info, stable within severity", () => {
    const sorted = sortFindings([
      finding({ severity: "warning", message: "w1" }),
      finding({ severity: "info" as ValidationFinding["severity"], message: "i1" }),
      finding({ severity: "error", message: "e1" }),
      finding({ severity: "warning", message: "w2" }),
      finding({ severity: "error", message: "e2" }),
    ]);
    expect(sorted.map((f) => f.message)).toEqual(["e1", "e2", "w1", "w2", "i1"]);
  });
});

describe("findingLocation", () => {
  it("joins stage id and a field derived from the code", () => {
    expect(
      findingLocation(finding({ stageId: "security-scan", code: "stage.invalid_io" })),
    ).toBe("security-scan.io");
    expect(
      findingLocation(finding({ stageId: "review", code: "pipeline.invalid_recovery" })),
    ).toBe("review.on_verify_fail");
  });

  it("falls back to the stage id alone, the pipeline id, then the path", () => {
    expect(findingLocation(finding({ stageId: "plan", code: "stage.invalid_shape" }))).toBe(
      "plan",
    );
    expect(
      findingLocation(
        finding({ pipelineId: "feature-ship", code: "pipeline.dag_error", path: "a.yaml" }),
      ),
    ).toBe("feature-ship.needs");
    expect(findingLocation(finding({ code: "task.invalid_shape", path: "task.yaml" }))).toBe(
      "task.yaml",
    );
    expect(findingLocation(finding({ code: "pipeline.invalid_shape", path: "<draft>" }))).toBe(
      "draft",
    );
  });
});

describe("messageSegments", () => {
  it("marks quoted and backticked names as code", () => {
    expect(
      messageSegments('references artifact "diff.patch" but `implement` does not'),
    ).toEqual([
      { text: "references artifact ", code: false },
      { text: "diff.patch", code: true },
      { text: " but ", code: false },
      { text: "implement", code: true },
      { text: " does not", code: false },
    ]);
  });

  it("returns plain text untouched", () => {
    expect(messageSegments("command is empty")).toEqual([
      { text: "command is empty", code: false },
    ]);
  });
});

describe("task helpers", () => {
  it("labels the task tab with the task id or filename stem", () => {
    expect(taskTabSuffix(null)).toBeNull();
    expect(taskTabSuffix({ filename: "fix.task.yaml", body: { id: "fix-login-redirect" } })).toBe(
      "· fix-login-redirect",
    );
    expect(taskTabSuffix({ filename: "tasks/add-csv-export.task.yaml", body: {} })).toBe(
      "· add-csv-export",
    );
  });

  it("formats top-level task fields read-only", () => {
    expect(
      taskFieldRows({
        id: "t",
        pipeline: "feature-ship",
        retries: 2,
        labels: ["a", "b"],
        input: { goal: "x", repo: "y" },
        notes: "line one\n  line two",
      }),
    ).toEqual([
      { key: "id", value: "t" },
      { key: "pipeline", value: "feature-ship" },
      { key: "retries", value: "2" },
      { key: "labels", value: "[a, b]" },
      { key: "input", value: "{ goal, repo }" },
      { key: "notes", value: "line one line two" },
    ]);
  });

  it("filters tasks by id or path", () => {
    const tasks = [
      { id: "fix-login", path: "tasks/fix-login.task.yaml" },
      { id: "csv", path: "examples/csv/add.task.yaml" },
    ];
    expect(filterTasks(tasks, "")).toHaveLength(2);
    expect(filterTasks(tasks, "LOGIN").map((t) => t.id)).toEqual(["fix-login"]);
    expect(filterTasks(tasks, "examples").map((t) => t.id)).toEqual(["csv"]);
  });
});

describe("line deltas", () => {
  it("counts added and removed lines via LCS", () => {
    expect(lineDelta("a\nb\nc\n", "a\nx\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineDelta(undefined, "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("a\nb\n", undefined)).toEqual({ added: 0, removed: 2 });
  });

  it("sums deltas across artifacts", () => {
    expect(
      artifactsDelta([
        { path: "a.yaml", kind: "added", after: "x\ny\n" },
        { path: "b.yaml", kind: "modified", before: "1\n2\n", after: "1\n3\n" },
        { path: "c.yaml", kind: "removed", before: "z\n" },
      ]),
    ).toEqual({ added: 3, removed: 2 });
  });
});

describe("changeRows", () => {
  it("maps statuses, counts files, and sorts newest first", () => {
    const cards = new Map<string, WorkshopMutationCard>([
      ["m1", { proposal: proposal("m1", [{ path: "a", kind: "added", after: "x" }]), status: "accepted", at: 100 }],
      [
        "m2",
        {
          proposal: proposal("m2", [
            { path: "a", kind: "modified", before: "x", after: "y" },
            { path: "b", kind: "added", after: "z" },
          ]),
          status: "accepted",
          auto: true,
          at: 300,
        },
      ],
      ["m3", { proposal: proposal("m3", [], "  "), status: "pending", at: 200 }],
      ["m4", { proposal: proposal("m4", []), status: "conflict", notice: "draft moved" }],
    ]);
    const rows = changeRows(cards);
    expect(rows.map((r) => r.id)).toEqual(["m2", "m3", "m1", "m4"]);
    expect(rows[0]).toMatchObject({ status: "auto", fileCount: 2, filesLabel: "2 files", added: 2, removed: 1 });
    expect(rows[1]).toMatchObject({ status: "pending", summary: "Draft change", filesLabel: "0 files" });
    expect(rows[2]).toMatchObject({ status: "accepted", filesLabel: "1 file" });
    expect(rows[3]).toMatchObject({ status: "conflict", notice: "draft moved" });
  });

  it("falls back to reverse insertion order without timestamps", () => {
    const cards = new Map<string, WorkshopMutationCard>([
      ["a", { proposal: proposal("a", []), status: "rejected" }],
      ["b", { proposal: proposal("b", []), status: "pending" }],
    ]);
    expect(changeRows(cards).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("validatedMeta", () => {
  it("describes validation recency", () => {
    expect(validatedMeta(null, false, 10_000)).toBeNull();
    expect(validatedMeta(6_000, false, 10_000)).toBe("validated 4s ago");
    expect(validatedMeta(6_000, true, 10_000)).toBe("validating…");
  });
});
