import { useEffect, useState } from "react";
import type { StageSnapshot } from "../../api";
import { ArtifactReader } from "../../components/ArtifactReader";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function RunArtifactsPanel({
  runId,
  stage,
  stageLabel,
  selectedPath,
  readOnly,
  onSelectPath,
}: {
  runId: string;
  stage: StageSnapshot;
  stageLabel: string;
  selectedPath?: string;
  readOnly?: boolean;
  onSelectPath: (path: string) => void;
}) {
  const paths = stage.artifacts ?? [];
  const [localPath, setLocalPath] = useState<string | undefined>(selectedPath);

  useEffect(() => {
    setLocalPath(selectedPath);
  }, [selectedPath]);

  useEffect(() => {
    if (localPath && !paths.includes(localPath)) {
      setLocalPath(undefined);
    }
  }, [localPath, paths]);

  const activePath =
    localPath && paths.includes(localPath)
      ? localPath
      : paths.length === 1
        ? paths[0]
        : localPath;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-3 py-2">
        <span className="font-sans text-[11px] uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          Artifacts
        </span>
        <span className="text-[12px] text-[var(--sf-text-2)]">· {stageLabel}</span>
      </div>
      {paths.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">
          No artifacts for this stage.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-r-[#ffffff12] p-2">
            {paths.map((path) => {
              const selected = activePath === path;
              return (
                <button
                  key={path}
                  type="button"
                  className={`rounded-sm px-2 py-1.5 text-left font-['Geist_Mono',monospace] text-[11px]${
                    selected
                      ? " bg-[var(--sf-active)] text-[var(--sf-text-1)]"
                      : " text-[var(--sf-text-2)] hover:bg-[var(--sf-raised)]"
                  }`}
                  onClick={() => {
                    setLocalPath(path);
                    onSelectPath(path);
                  }}
                >
                  {fileName(path)}
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--sf-text-3)]">
                    {path}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="min-h-0 min-w-0 flex-1">
            {activePath ? (
              <ArtifactReader
                runId={runId}
                path={activePath}
                readOnly={readOnly}
                onBackToTranscript={() => setLocalPath(undefined)}
              />
            ) : (
              <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">
                Select an artifact to preview.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
