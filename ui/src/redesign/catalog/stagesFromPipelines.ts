import type { PipelineListing, StageGateKind } from "../../api";

export type StageRowFromPipelines = {
  rowKey: string;
  id: string;
  uses_path?: string;
  gate_kinds?: StageGateKind[];
  used_by_pipeline_ids: string[];
  project_root?: string;
};

export function stagesFromPipelines(
  pipelines: PipelineListing[],
): StageRowFromPipelines[] {
  const map = new Map<string, StageRowFromPipelines>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      const rowKey = `${pipeline.project_root ?? ""}:${stage.id}`;
      const existing = map.get(rowKey);
      if (existing) {
        if (!existing.used_by_pipeline_ids.includes(pipeline.id)) {
          existing.used_by_pipeline_ids.push(pipeline.id);
        }
        if (!existing.uses_path && stage.uses_path) {
          existing.uses_path = stage.uses_path;
        }
        if (
          existing.gate_kinds === undefined &&
          stage.gate_kinds !== undefined
        ) {
          existing.gate_kinds = [...stage.gate_kinds];
        }
      } else {
        map.set(rowKey, {
          rowKey,
          id: stage.id,
          project_root: pipeline.project_root,
          ...(stage.uses_path ? { uses_path: stage.uses_path } : {}),
          ...(stage.gate_kinds !== undefined
            ? { gate_kinds: [...stage.gate_kinds] }
            : {}),
          used_by_pipeline_ids: [pipeline.id],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    const rootA = a.project_root ?? "";
    const rootB = b.project_root ?? "";
    const rootCmp = rootA.localeCompare(rootB);
    if (rootCmp !== 0) return rootCmp;
    return a.id.localeCompare(b.id);
  });
}

export function stageRootLabel(row: StageRowFromPipelines): string {
  if (!row.project_root) return "project";
  const parts = row.project_root.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || row.project_root;
}
