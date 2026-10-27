import type { DraftPackagePayload } from "../api/types";

export type StudioPickerRow = {
  id: string | null;
  name: string;
  projectRoot: string | null;
  relativePath: string | null;
};

export type WorkshopBuildView = {
  id: string;
  draft: DraftPackagePayload;
  projectRoot: string | null;
  relativePath: string | null;
};

export type StudioSelection = {
  buildId: string | null;
  draft: DraftPackagePayload;
  rows: StudioPickerRow[];
  error: string | null;
};

export function emptyStudioDraft(): DraftPackagePayload {
  return { pipeline: { id: "untitled", stages: [] } };
}

export function pickerRowName(pipelineId: string | null | undefined): string {
  const trimmed = pipelineId?.trim() ?? "";
  return trimmed ? trimmed : "Untitled";
}

export function pickerRowValue(row: StudioPickerRow): string {
  if (row.id) return `build:${row.id}`;
  return `path:${encodeURIComponent(row.projectRoot ?? "")}/${encodeURIComponent(row.relativePath ?? "")}`;
}

export function pickerRowLabel(row: StudioPickerRow): string {
  if (row.relativePath) return `${row.name} · ${row.relativePath}`;
  return row.name;
}

export function draftFrameApplies(
  selectedBuildId: string | null,
  frameBuildId: string | null | undefined,
): boolean {
  if (typeof frameBuildId !== "string" || frameBuildId.length === 0) {
    return false;
  }
  if (selectedBuildId === null) return true;
  return frameBuildId === selectedBuildId;
}

export type DraftFrameAction =
  | { kind: "ignore" }
  | { kind: "set-draft"; draft: DraftPackagePayload }
  | { kind: "adopt-pointer"; buildId: string; draft: DraftPackagePayload };

export function draftFrameAction(
  selectedBuildId: string | null,
  frameBuildId: string | null | undefined,
  draft: DraftPackagePayload,
): DraftFrameAction {
  if (!draftFrameApplies(selectedBuildId, frameBuildId)) {
    return { kind: "ignore" };
  }
  if (selectedBuildId === null) {
    return { kind: "adopt-pointer", buildId: frameBuildId!, draft };
  }
  return { kind: "set-draft", draft };
}

export function startNewChatStudio(
  rows: readonly StudioPickerRow[],
): StudioSelection {
  return {
    buildId: null,
    draft: emptyStudioDraft(),
    rows: rows.map((row) => ({ ...row })),
    error: null,
  };
}

/** Browse/open a package without creating a workshop build (W2). */
export function openEphemeralPackageStudio(input: {
  draft: DraftPackagePayload;
  rows: readonly StudioPickerRow[];
  error?: string | null;
}): StudioSelection {
  return {
    buildId: null,
    draft: input.draft,
    rows: input.rows.map((row) => ({ ...row })),
    error: input.error ?? null,
  };
}

export function openSessionStudio(input: {
  activeBuildId?: string | null;
  build: WorkshopBuildView | null;
  rows: readonly StudioPickerRow[];
  error?: string | null;
}): StudioSelection {
  const rows = input.rows.map((row) => ({ ...row }));
  if (!input.activeBuildId) {
    return {
      buildId: null,
      draft: emptyStudioDraft(),
      rows,
      error: null,
    };
  }
  if (!input.build || input.build.id !== input.activeBuildId) {
    return {
      buildId: null,
      draft: emptyStudioDraft(),
      rows,
      error: input.error ?? "Build not found",
    };
  }
  return {
    buildId: input.build.id,
    draft: input.build.draft,
    rows: mergeFocusedBuild(rows, input.build),
    error: null,
  };
}

export function historyBuildName(
  activeBuildId: string | null | undefined,
  rows: readonly StudioPickerRow[],
): string | null {
  if (!activeBuildId) return null;
  return rows.find((row) => row.id === activeBuildId)?.name ?? "Untitled";
}

export function applyPointerChange(
  selection: StudioSelection,
  frame: { buildId: string; draft: DraftPackagePayload },
): StudioSelection {
  const existing = selection.rows.find((row) => row.id === frame.buildId);
  return selectListedBuild(selection, {
    id: frame.buildId,
    draft: frame.draft,
    projectRoot: existing?.projectRoot ?? null,
    relativePath: existing?.relativePath ?? null,
  });
}

export function rowsAfterPickerLoad(
  serverRows: readonly StudioPickerRow[],
  selected: StudioPickerRow | null,
): StudioPickerRow[] {
  const rows = serverRows.map((row) => ({ ...row }));
  if (!selected?.id) return rows;
  if (rows.some((row) => row.id === selected.id)) return rows;
  return [...rows, { ...selected }];
}

export function mutationMapAfterChange<T>(
  previous: { sessionId: string | null; buildId: string | null },
  next: { sessionId: string | null; buildId: string | null },
  cards: Map<string, T>,
): Map<string, T> {
  if (
    previous.sessionId !== next.sessionId ||
    previous.buildId !== next.buildId
  ) {
    return new Map();
  }
  return cards;
}

export type UnboundPackageOpen =
  | {
      ok: true;
      draft: DraftPackagePayload;
      projectRoot: string;
      relativePath: string;
    }
  | { ok: false; error: string };

export async function chooseStudioRow(input: {
  /** When null, the studio loads the build without writing a session pointer. */
  sessionId: string | null;
  row: StudioPickerRow;
  selection: StudioSelection;
  /**
   * Unbound catalog rows open as an in-memory draft only (no build create).
   * Persistence happens on first chat message / explicit focus.
   */
  openUnbound: (row: StudioPickerRow) => Promise<UnboundPackageOpen>;
  updatePointer: (
    sessionId: string,
    buildId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  loadBuild: (
    buildId: string,
  ) => Promise<
    { ok: true; build: WorkshopBuildView } | { ok: false; error: string }
  >;
}): Promise<{ selection: StudioSelection; changed: boolean }> {
  if (input.row.id) {
    const loaded = await input.loadBuild(input.row.id);
    if (!loaded.ok) {
      return {
        selection: { ...input.selection, error: loaded.error },
        changed: false,
      };
    }
    if (input.sessionId) {
      const pointed = await input.updatePointer(input.sessionId, loaded.build.id);
      if (!pointed.ok) {
        return {
          selection: { ...input.selection, error: pointed.error },
          changed: false,
        };
      }
    }
    const selection = selectListedBuild(input.selection, loaded.build);
    return {
      selection,
      changed: selection.buildId !== input.selection.buildId,
    };
  }

  if (!input.row.projectRoot || !input.row.relativePath) {
    return { selection: input.selection, changed: false };
  }

  const opened = await input.openUnbound(input.row);
  if (!opened.ok) {
    return {
      selection: { ...input.selection, error: opened.error },
      changed: false,
    };
  }
  const selection = openEphemeralPackageStudio({
    draft: opened.draft,
    rows: input.selection.rows,
  });
  return {
    selection,
    changed: true,
  };
}

function selectListedBuild(
  selection: StudioSelection,
  build: WorkshopBuildView,
): StudioSelection {
  return {
    buildId: build.id,
    draft: build.draft,
    rows: mergeFocusedBuild(selection.rows, build),
    error: null,
  };
}

function mergeFocusedBuild(
  rows: readonly StudioPickerRow[],
  build: WorkshopBuildView,
): StudioPickerRow[] {
  const nextRow: StudioPickerRow = {
    id: build.id,
    name: pickerRowName(build.draft.pipeline.id),
    projectRoot: build.projectRoot,
    relativePath: build.relativePath,
  };
  const pathKey =
    build.projectRoot && build.relativePath
      ? `${build.projectRoot}\0${build.relativePath}`
      : null;
  let placed = false;
  const next: StudioPickerRow[] = [];
  for (const row of rows) {
    const sameId = row.id != null && row.id === build.id;
    const samePath =
      pathKey != null &&
      row.projectRoot === build.projectRoot &&
      row.relativePath === build.relativePath;
    if (sameId || samePath) {
      if (!placed) {
        next.push(nextRow);
        placed = true;
      }
      continue;
    }
    next.push({ ...row });
  }
  if (!placed) next.push(nextRow);
  return next;
}
