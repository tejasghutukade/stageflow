import { newRunPath, pipelinePath, workshopPath } from "../../routes";

export function resolvePipelineSelection(
  pin: string | null | undefined,
  rowKeys: readonly string[],
): string | null {
  if (pin === null) return null;
  if (typeof pin === "string" && rowKeys.includes(pin)) return pin;
  return rowKeys[0] ?? null;
}

export function movePipelineSelection(
  rowKeys: readonly string[],
  selectedKey: string | null,
  delta: number,
): string | null {
  if (rowKeys.length === 0) return null;
  if (selectedKey == null) return rowKeys[0] ?? null;
  const index = rowKeys.indexOf(selectedKey);
  if (index < 0) return rowKeys[0] ?? null;
  const nextIndex = Math.min(Math.max(index + delta, 0), rowKeys.length - 1);
  return rowKeys[nextIndex] ?? null;
}

type EditorTarget = {
  pipeline: { id: string; project_root?: string };
};

type RunTarget = {
  catalogPath: string;
  defaultTaskPath?: string;
};

type WorkshopTarget = {
  catalogPath: string;
  pipeline?: { project_root?: string };
  project_root?: string;
};

export function pipelineEditorPath(
  row: EditorTarget | null | undefined,
): string | null {
  if (!row) return null;
  const root = row.pipeline.project_root;
  return pipelinePath(row.pipeline.id, root ? { project_root: root } : undefined);
}

export function pipelineStartRunPath(
  row: RunTarget | null | undefined,
): string | null {
  if (!row) return null;
  return newRunPath({
    pipeline: row.catalogPath,
    ...(row.defaultTaskPath ? { task: row.defaultTaskPath } : {}),
  });
}

export function pipelineWorkshopPath(
  row: WorkshopTarget | null | undefined,
): string | null {
  if (!row) return null;
  const root = row.project_root ?? row.pipeline?.project_root;
  return workshopPath({
    pipeline: row.catalogPath,
    ...(root ? { project_root: root } : {}),
  });
}
