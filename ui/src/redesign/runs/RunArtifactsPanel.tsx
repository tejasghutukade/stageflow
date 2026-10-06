import { useEffect, useState } from "react";
import type { RunDetail, StageSnapshot } from "../../api";
import { ArtifactReader } from "../../components/ArtifactReader";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function RunArtifactsPanel({
  runId,
  run,
  stage,
  initialPath,
  readOnly,
}: {
  runId: string;
  run: RunDetail;
  stage: StageSnapshot;
  initialPath?: string | null;
  readOnly?: boolean;
}) {
  const paths = stage.artifacts ?? [];
  const [selected, setSelected] = useState<string | null>(
    () => initialPath ?? paths[0] ?? null,
  );

  useEffect(() => {
    if (initialPath && paths.includes(initialPath)) {
      setSelected(initialPath);
      return;
    }
    if (selected && paths.includes(selected)) return;
    setSelected(paths[0] ?? null);
  }, [stage.stage_id, paths.join("|"), initialPath, selected]);

  const label = stageCloneLabel(run, stage.stage_id);

  if (paths.length === 0) {
    return (
      <p className="px-6 py-4 text-[13px] text-[var(--sf-text-2)]">
        No artifacts for {label}.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--sf-ground)]">
      <div className="flex w-[280px] shrink-0 flex-col border-r border-r-[#ffffff12]">
        <h3 className="border-b border-b-[#ffffff12] px-4 py-2.5 text-[12px] font-medium text-[var(--sf-text-1)]">
          Artifacts · {label}
        </h3>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {paths.map((path) => (
            <li key={path}>
              <button
                type="button"
                className={`flex w-full flex-col items-start px-4 py-2 text-left text-[12px] ${
                  selected === path
                    ? "bg-[#16171b] text-[var(--sf-text-1)]"
                    : "text-[var(--sf-text-2)] hover:bg-[#ffffff08]"
                }`}
                onClick={() => setSelected(path)}
              >
                <span className="font-['Geist_Mono',monospace]">
                  {fileName(path)}
                </span>
                <span className="w-full truncate text-[11px] text-[var(--sf-text-3)]">
                  {path}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <ArtifactReader
            variant="redesign"
            runId={runId}
            path={selected}
            readOnly={readOnly}
          />
        ) : (
          <p className="px-4 py-3 text-[13px] text-[var(--sf-text-3)]">
            Select an artifact.
          </p>
        )}
      </div>
    </div>
  );
}
