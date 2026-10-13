import { useMemo } from "react";
import type { PipelineListing } from "../../api";
import { normalizeYamlPath } from "./draftYaml";
import { PipelineEditorPage } from "./PipelineEditorPage";

export type StageEditorPageProps = {
  stagePath: string;
  projectRoot?: string;
};

function stageIdFromPath(path: string): string {
  const base = normalizeYamlPath(path).split("/").pop() ?? path;
  return base.replace(/\.ya?ml$/i, "") || base;
}

export function StageEditorPage({
  stagePath,
  projectRoot,
}: StageEditorPageProps) {
  const normalizedPath = normalizeYamlPath(stagePath);
  const stageId = stageIdFromPath(normalizedPath);
  const listing = useMemo<PipelineListing>(
    () => ({
      id: stageId,
      path: `${normalizedPath}.stage-editor.pipeline.yaml`,
      stages: [{ id: stageId, uses_path: normalizedPath }],
      ...(projectRoot ? { project_root: projectRoot } : {}),
    }),
    [normalizedPath, projectRoot, stageId],
  );

  return (
    <PipelineEditorPage
      mode="stage"
      pipelineId={stageId}
      pipeline={listing}
      tasks={[]}
      stagePath={normalizedPath}
      projectRoot={projectRoot}
      onNew={() => {}}
    />
  );
}
