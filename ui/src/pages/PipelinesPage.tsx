import { useCallback, useEffect, useState } from "react";
import {
  fetchPipelines,
  fetchTasks,
  type PipelineListing,
  type TaskListing,
} from "../api";
import { resolvePipelineListing } from "../routes";
import { PipelineEditorPage } from "../redesign/editor/PipelineEditorPage";
import { PipelinesRedesign } from "../redesign/editor/PipelinesRedesign";

export function PipelinesPage({
  pipelineId,
  projectRoot,
  onNew,
}: {
  pipelineId?: string;
  projectRoot?: string;
  onNew: (path: string) => void;
}) {
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([fetchPipelines(), fetchTasks()]);
      setPipelines(p.pipelines);
      setTasks(t.tasks);
    } catch {
      // The editor reports a missing pipeline; the list page loads its own data.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pipelineId) void load();
  }, [pipelineId, load]);

  if (!pipelineId) return <PipelinesRedesign />;

  if (loading) {
    return (
      <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">
        Loading pipeline…
      </p>
    );
  }
  const selected = resolvePipelineListing(pipelines, pipelineId, projectRoot);
  if (!selected) {
    return (
      <div className="px-5 py-8">
        <p className="text-[13px] text-[var(--sf-text-2)]">
          {pipelineId} is not in the current manifest catalog.
        </p>
      </div>
    );
  }
  return (
    <PipelineEditorPage
      pipelineId={pipelineId}
      pipeline={selected}
      pipelines={pipelines}
      tasks={tasks}
      onNew={onNew}
    />
  );
}
