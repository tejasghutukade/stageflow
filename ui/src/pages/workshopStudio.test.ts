import { describe, expect, it, vi } from "vitest";
import type { DraftPackagePayload } from "../api/types";
import {
  chooseStudioRow,
  historyBuildName,
  mutationMapAfterChange,
  openSessionStudio,
  pickerRowName,
  startNewChatStudio,
  type StudioPickerRow,
  type StudioSelection,
  type WorkshopBuildView,
} from "./workshopStudio";

const releaseDraft: DraftPackagePayload = {
  pipeline: { id: "release", stages: [{ id: "ship" }] },
};

const untitledDraft: DraftPackagePayload = {
  pipeline: { id: "", stages: [{ id: "draft-stage" }] },
};

const previousDraft: DraftPackagePayload = {
  pipeline: { id: "kept", stages: [{ id: "stay" }] },
};

const releaseRow: StudioPickerRow = {
  id: "build-release",
  name: "release",
  projectRoot: "/proj",
  relativePath: "pipelines/release.pipeline.yaml",
};

function selection(partial: Partial<StudioSelection> = {}): StudioSelection {
  return {
    buildId: partial.buildId ?? null,
    draft: partial.draft ?? { pipeline: { id: "untitled", stages: [] } },
    rows: partial.rows ?? [],
    error: partial.error ?? null,
  };
}

describe("workshop studio selection", () => {
  it("starting a new chat applies an empty studio and does not add a list row for that empty package", () => {
    const rows = [releaseRow];
    const next = startNewChatStudio(rows);
    expect(next.buildId).toBeNull();
    expect(next.draft.pipeline.stages).toEqual([]);
    expect(next.rows).toEqual(rows);
    expect(next.rows).toHaveLength(1);
  });

  it("opening a session whose activeBuildId is set loads that draft into the studio", () => {
    const build: WorkshopBuildView = {
      id: "build-release",
      draft: releaseDraft,
      projectRoot: "/proj",
      relativePath: "pipelines/release.pipeline.yaml",
    };
    const next = openSessionStudio({
      activeBuildId: "build-release",
      build,
      rows: [],
    });
    expect(next.buildId).toBe("build-release");
    expect(next.draft).toEqual(releaseDraft);
  });

  it("opening a session with no pointer leaves the studio empty", () => {
    const next = openSessionStudio({
      activeBuildId: undefined,
      build: null,
      rows: [releaseRow],
    });
    expect(next.buildId).toBeNull();
    expect(next.draft.pipeline.stages).toEqual([]);
    expect(next.rows).toEqual([releaseRow]);
  });

  it("selecting an unbound path twice shows one build, and a failed open leaves the previous selection", async () => {
    const unbound: StudioPickerRow = {
      id: null,
      name: "release",
      projectRoot: "/proj",
      relativePath: "pipelines/release.pipeline.yaml",
    };
    const tied: WorkshopBuildView = {
      id: "build-tied",
      draft: releaseDraft,
      projectRoot: "/proj",
      relativePath: "pipelines/release.pipeline.yaml",
    };
    const focus = vi.fn(async () => ({ ok: true as const, build: tied }));
    const updatePointer = vi.fn(async () => ({ ok: true as const }));
    const loadBuild = vi.fn(async () => ({ ok: true as const, build: tied }));
    let current = selection({
      buildId: "build-old",
      draft: previousDraft,
      rows: [unbound],
    });

    current = (
      await chooseStudioRow({
        sessionId: "sess-1",
        row: unbound,
        selection: current,
        focus,
        updatePointer,
        loadBuild,
      })
    ).selection;
    current = (
      await chooseStudioRow({
        sessionId: "sess-1",
        row: current.rows.find((row) => row.relativePath === unbound.relativePath)!,
        selection: current,
        focus,
        updatePointer,
        loadBuild,
      })
    ).selection;

    expect(current.rows.filter((row) => row.id === "build-tied")).toHaveLength(1);
    expect(
      current.rows.filter(
        (row) =>
          row.projectRoot === "/proj" &&
          row.relativePath === "pipelines/release.pipeline.yaml",
      ),
    ).toHaveLength(1);
    expect(current.buildId).toBe("build-tied");
    expect(current.draft).toEqual(releaseDraft);
    expect(updatePointer).toHaveBeenCalledWith("sess-1", "build-tied");

    const failedFocus = vi.fn(async () => ({
      ok: false as const,
      error: "cannot open pipeline",
    }));
    const failedPointer = vi.fn(async () => ({ ok: true as const }));
    const failed = await chooseStudioRow({
      sessionId: "sess-1",
      row: unbound,
      selection: current,
      focus: failedFocus,
      updatePointer: failedPointer,
      loadBuild,
    });
    expect(failed.selection.buildId).toBe("build-tied");
    expect(failed.selection.draft).toEqual(releaseDraft);
    expect(failed.selection.rows).toEqual(current.rows);
    expect(failed.selection.error).toBe("cannot open pipeline");
    expect(failedPointer).not.toHaveBeenCalled();
  });

  it("a history row for a chat with a pointer shows that build's pipeline id, or Untitled when it has none", () => {
    expect(pickerRowName("release")).toBe("release");
    expect(pickerRowName("")).toBe("Untitled");
    expect(pickerRowName("   ")).toBe("Untitled");
    expect(
      historyBuildName("build-release", [
        releaseRow,
        {
          id: "build-blank",
          name: pickerRowName(untitledDraft.pipeline.id),
          projectRoot: null,
          relativePath: null,
        },
      ]),
    ).toBe("release");
    expect(
      historyBuildName("build-blank", [
        {
          id: "build-blank",
          name: pickerRowName(untitledDraft.pipeline.id),
          projectRoot: null,
          relativePath: null,
        },
      ]),
    ).toBe("Untitled");
    expect(historyBuildName(undefined, [releaseRow])).toBeNull();
  });

  it("selecting a listed build updates the session pointer and the map", async () => {
    const listed: WorkshopBuildView = {
      id: "build-release",
      draft: releaseDraft,
      projectRoot: "/proj",
      relativePath: "pipelines/release.pipeline.yaml",
    };
    const updatePointer = vi.fn(async () => ({ ok: true as const }));
    const loadBuild = vi.fn(async () => ({ ok: true as const, build: listed }));
    const result = await chooseStudioRow({
      sessionId: "sess-9",
      row: releaseRow,
      selection: selection({
        buildId: "build-old",
        draft: previousDraft,
        rows: [releaseRow],
      }),
      focus: vi.fn(),
      updatePointer,
      loadBuild,
    });
    expect(updatePointer).toHaveBeenCalledWith("sess-9", "build-release");
    expect(loadBuild).toHaveBeenCalledWith("build-release");
    expect(result.selection.buildId).toBe("build-release");
    expect(result.selection.draft).toEqual(releaseDraft);
    expect(result.changed).toBe(true);
  });

  it("changing the selected build clears the mutation-card map", () => {
    const cards = new Map<string, { id: string }>([["m1", { id: "m1" }]]);
    expect(
      mutationMapAfterChange(
        { sessionId: "sess-1", buildId: "build-a" },
        { sessionId: "sess-1", buildId: "build-b" },
        cards,
      ).size,
    ).toBe(0);
    expect(
      mutationMapAfterChange(
        { sessionId: "sess-1", buildId: "build-a" },
        { sessionId: "sess-2", buildId: "build-a" },
        cards,
      ).size,
    ).toBe(0);
    expect(
      mutationMapAfterChange(
        { sessionId: "sess-1", buildId: "build-a" },
        { sessionId: "sess-1", buildId: "build-a" },
        cards,
      ),
    ).toBe(cards);
  });
});
