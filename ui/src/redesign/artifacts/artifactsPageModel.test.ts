import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../api/artifacts";
import { runShortId } from "../../catalogJoin";
import {
  ALL_PROJECTS_SCOPE,
  ARTIFACTS_EMPTY_BODY,
  ARTIFACTS_EMPTY_TITLE,
  DEFAULT_ARTIFACT_LIST_FILTERS,
  activeArtifactProjectWireId,
  applyArtifactPage,
  artifactExpiredShortReason,
  artifactListFiltersActive,
  artifactListFiltersToQuery,
  artifactListRows,
  artifactOwnerPath,
  artifactLiveStatusPill,
  artifactProjectScopeOptions,
  artifactScopeQuery,
  artifactStatusPillForRecord,
  artifactExpiryNote,
  artifactMatchCountLabel,
  artifactSearchQueryRejected,
  initialArtifactCursorState,
  serializeArtifactListFiltersRoundTrip,
  tabToListQuery,
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
    status: "available",
    expired_at: null,
    expired_reason: null,
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
    expect(row?.detailPath).toBe("/artifacts/stage%3Asales%3Asummarize/weekly?project_root=%2Fgone%2Froot");
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

  it("maps filters to query params and tabs", () => {
    expect(tabToListQuery("live")).toEqual({ live: true });
    expect(tabToListQuery("static")).toEqual({ kind: "static" });
    expect(
      artifactListFiltersToQuery({
        ...DEFAULT_ARTIFACT_LIST_FILTERS,
        tab: "static",
        owner: "sales",
        tag: "weekly",
        status: "available",
        sort: "title",
        order: "asc",
      }),
    ).toMatchObject({
      kind: "static",
      owner: "sales",
      tag: "weekly",
      status: "available",
      sort: "title",
      order: "asc",
    });
    expect(
      artifactListFiltersActive({
        ...DEFAULT_ARTIFACT_LIST_FILTERS,
        kind: "markdown",
      }),
    ).toBe(true);
    expect(artifactListFiltersActive(DEFAULT_ARTIFACT_LIST_FILTERS)).toBe(false);
  });

  it("round-trips list filters in the hash path", () => {
    const filters = {
      ...DEFAULT_ARTIFACT_LIST_FILTERS,
      tab: "live" as const,
      kind: "live.declarative",
      owner: "stage:sales:summarize",
      tag: "revenue",
      status: "available" as const,
      sort: "size" as const,
      order: "desc" as const,
    };
    expect(serializeArtifactListFiltersRoundTrip(filters, "workspace")).toEqual(filters);
  });

  it("keeps q in the hash with the other filters", () => {
    const filters = {
      ...DEFAULT_ARTIFACT_LIST_FILTERS,
      q: "revenue",
      kind: "static.markdown",
    };
    expect(serializeArtifactListFiltersRoundTrip(filters, "workspace")).toEqual(filters);
    expect(artifactListFiltersToQuery(filters).q).toBe("revenue");
    expect(artifactListFiltersActive(filters)).toBe(true);
    expect(artifactMatchCountLabel(3)).toBe("3 matches");
    expect(artifactMatchCountLabel(1)).toBe("1 match");
    expect(artifactMatchCountLabel(0)).toBe("0 matches");
    expect(artifactSearchQueryRejected("query has no searchable terms")).toBe(true);
    expect(artifactSearchQueryRejected("artifact store is down")).toBe(false);
    expect(artifactListFiltersActive(DEFAULT_ARTIFACT_LIST_FILTERS)).toBe(false);
  });

  it("derives expiry notes from expires_at with a fixed now", () => {
    const now = Date.parse("2026-06-15T15:00:00.000Z");
    expect(artifactExpiryNote(null, now)).toBeNull();
    expect(artifactExpiryNote("2026-06-15T18:00:00.000Z", now)).toBe("expires today");
    expect(artifactExpiryNote("2026-06-16T00:00:00.000Z", now)).toBe("expires tomorrow");
    expect(artifactExpiryNote("2026-06-27T00:00:00.000Z", now)).toBe("expires in 12 days");
    expect(artifactExpiryNote("2026-06-01T00:00:00.000Z", now)).toBe("expired");
  });

  it("maps indexed and live status pills", () => {
    expect(artifactStatusPillForRecord(record())).toEqual({ label: "Available", variant: "ok" });
    expect(artifactStatusPillForRecord(record({ status: "expired" }))).toEqual({
      label: "Expired",
      variant: "fail",
    });
    expect(artifactLiveStatusPill("fresh")).toEqual({ label: "Fresh", variant: "ok" });
    expect(artifactLiveStatusPill("stale")).toEqual({ label: "Stale", variant: "needs" });
    expect(artifactLiveStatusPill("error")).toEqual({ label: "Error", variant: "fail" });
    expect(artifactLiveStatusPill("refreshing")).toEqual({ label: "Refreshing", variant: "running" });
    expect(
      artifactStatusPillForRecord(record({ live: { status: "stale" } })),
    ).toEqual({ label: "Stale", variant: "needs" });
  });

  it("builds view rows for 1,000 records under a generous bound", () => {
    const now = Date.parse("2026-11-24T12:00:00.000Z");
    const records = Array.from({ length: 1000 }, (_, i) =>
      record({ id: `id-${i}`, key: `stage:sales:summarize/id-${i}`, title: `f-${i}.md` }),
    );
    const start = performance.now();
    const rows = artifactListRows(records, now);
    expect(rows).toHaveLength(1000);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("marks an expired row and keeps a short reason", () => {
    const [row] = artifactListRows([
      record({ status: "expired", expired_at: "2026-11-01T00:00:00.000Z", expired_reason: "file_missing" }),
    ]);
    expect(row?.expired).toBe(true);
    expect(row?.expiredReason).toBe("File is missing");
    expect(artifactExpiredShortReason("run_slimmed")).toBe("Cleaned up to save space");
    expect(artifactExpiredShortReason("run_purged")).toBe("Run was purged");
    expect(artifactExpiredShortReason("run_deleted")).toBe("Run was deleted");
    expect(artifactExpiredShortReason("custom_code")).toBe("custom_code");
    const [live] = artifactListRows([record()]);
    expect(live?.expired).toBe(false);
    expect(live?.expiredReason).toBeNull();
  });

  it("labels an agent owner and links to the agent page while that agent exists", () => {
    const owner = { kind: "agent" as const, agent: "helper" };
    const [row] = artifactListRows([
      record({
        key: "agent:helper/weekly",
        owner,
        source: { run_id: null, stage_id: null, attempt: null, session_id: "sess_1" },
      }),
    ]);
    expect(row?.ownerLabel).toBe("agent · helper");
    expect(row?.ownerPath).toBe("/agents/helper");
    expect(artifactOwnerPath(owner, new Set(["helper"]))).toBe("/agents/helper");
    expect(artifactOwnerPath(owner, new Set(["other"]))).toBeNull();
    expect(artifactOwnerPath({ kind: "stage", pipeline: "sales", stage: "summarize" })).toBeNull();
  });
});
