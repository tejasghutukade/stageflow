import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { runShortId } from "../../catalogJoin";
import {
  ALL_PROJECTS_SCOPE,
  ARTIFACTS_EMPTY_BODY,
  ARTIFACTS_EMPTY_TITLE,
  activeArtifactProjectWireId,
  applyArtifactPage,
  artifactListRows,
  artifactProjectScopeOptions,
  artifactScopeQuery,
  initialArtifactCursorState,
  unregisteredProjectLabel,
} from "./artifactsPageModel";

function record(patch: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    key: "stage:sales:summarize/weekly",
    id: "weekly",
    title: "weekly.md",
    description: null,
    tags: [],
    kind: "static.markdown",
    origin: "indexed",
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    source: { run_id: "run_abcdef123456", stage_id: "summarize", attempt: 1, session_id: null },
    version: 1,
    size_bytes: 12,
    content_type: "text/markdown",
    created_at: "2026-11-24T12:00:00.000Z",
    updated_at: "2026-11-24T12:00:00.000Z",
    expires_at: null,
    project: { id: "examples", registered: true },
    ...patch,
  };
}

describe("artifacts page model", () => {
  it("explains that only declared deliverables are indexed", () => {
    expect(ARTIFACTS_EMPTY_TITLE).toBe("No artifacts yet");
    expect(ARTIFACTS_EMPTY_BODY).toMatch(/envelope/i);
    expect(ARTIFACTS_EMPTY_BODY).toMatch(/tool-output/i);
    expect(ARTIFACTS_EMPTY_BODY).toMatch(/do not appear/i);
  });

  it("scopes the list to the active catalog write root", () => {
    expect(
      activeArtifactProjectWireId([
        { project_root: "/data/acme", kind: "registered", read_only: false, available: true },
        { project_root: "workspace", kind: "workspace", read_only: false, available: true },
      ]),
    ).toBe("workspace");
    expect(
      activeArtifactProjectWireId([
        { project_root: "/data/acme", kind: "registered", read_only: false, available: true },
      ]),
    ).toBe("/data/acme");
  });

  it("maps a row to kind, owner, source run and an unregistered project", () => {
    const now = Date.parse("2026-11-24T12:05:00.000Z");
    const [row] = artifactListRows(
      [record({ project: { id: "/gone/root", registered: false }, updated_at: "2026-11-24T12:00:00.000Z" })],
      now,
    );
    expect(row?.kindLabel).toBe("Markdown");
    expect(row?.ownerLabel).toBe("sales / summarize");
    expect(row?.runId).toBe("run_abcdef123456");
    expect(row?.updatedLabel).toBe("5m ago");
    expect(row?.unregistered).toBe(true);
    expect(unregisteredProjectLabel(row!)).toBe("Unregistered project /gone/root");
    expect(unregisteredProjectLabel({ unregistered: false, projectId: "examples" })).toBeNull();
    expect(row?.runLabel).toBe(runShortId("run_abcdef123456"));
    expect(row?.projectLabel).toBe("root");
  });

  it("builds project scope options and a short project label", () => {
    expect(
      artifactProjectScopeOptions(
        [
          { project_root: "/data/acme", kind: "registered", read_only: false, available: true },
          { project_root: "workspace", kind: "workspace", read_only: false, available: true },
          { project_root: "/data/offline", kind: "registered", read_only: false, available: false },
        ],
        "workspace",
      ),
    ).toEqual([
      { id: "workspace", label: "Workspace" },
      { id: "/data/acme", label: "acme" },
      { id: ALL_PROJECTS_SCOPE, label: "All projects" },
    ]);
    const [row] = artifactListRows(
      [record({ project: { id: "/data/acme", registered: true } })],
      Date.parse("2026-11-24T12:00:00.000Z"),
      { showProject: true },
    );
    expect(row?.showProject).toBe(true);
    expect(row?.projectLabel).toBe("acme");
    expect(artifactScopeQuery(ALL_PROJECTS_SCOPE)).toBeUndefined();
    expect(artifactScopeQuery("workspace")).toBe("workspace");
  });

  it("pages with the cursor and labels a known run", () => {
    const first = applyArtifactPage(initialArtifactCursorState(), {
      artifacts: [record()],
      next_cursor: "cursor-1",
    }, "replace");
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor).toBe("cursor-1");
    const second = applyArtifactPage(first, {
      artifacts: [record({ id: "other", key: "stage:sales:summarize/other" })],
      next_cursor: null,
    }, "append");
    expect(second.records.map((row) => row.id)).toEqual(["weekly", "other"]);
    expect(second.nextCursor).toBeNull();
    const runs = new Map([
      ["run_abcdef123456", { run_id: "run_abcdef123456", pipeline_id: "sales", task_id: "weekly-digest" }],
    ]);
    const [row] = artifactListRows([record()], Date.parse("2026-11-24T12:00:00.000Z"), { runs });
    expect(row?.runLabel).toBe(`${runShortId("run_abcdef123456")} · weekly-digest`);
  });
});
