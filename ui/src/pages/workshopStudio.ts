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
  return (
    typeof frameBuildId === "string" &&
    frameBuildId.length > 0 &&
    frameBuildId === selectedBuildId
  );
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

export async function chooseStudioRow(input: {
  sessionId: string;
  row: StudioPickerRow;
  selection: StudioSelection;
  focus: (
    row: StudioPickerRow,
  ) => Promise<
    { ok: true; build: WorkshopBuildView } | { ok: false; error: string }
  >;
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
    const pointed = await input.updatePointer(input.sessionId, loaded.build.id);
    if (!pointed.ok) {
      return {
        selection: { ...input.selection, error: pointed.error },
        changed: false,
      };
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

  const focused = await input.focus(input.row);
  if (!focused.ok) {
    return {
      selection: { ...input.selection, error: focused.error },
      changed: false,
    };
  }
  const pointed = await input.updatePointer(
    input.sessionId,
    focused.build.id,
  );
  if (!pointed.ok) {
    return {
      selection: { ...input.selection, error: pointed.error },
      changed: false,
    };
  }
  const selection = selectListedBuild(input.selection, focused.build);
  return {
    selection,
    changed: selection.buildId !== input.selection.buildId,
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
