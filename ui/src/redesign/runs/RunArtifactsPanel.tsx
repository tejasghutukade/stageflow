import { useEffect, useState } from "react";
import type { RunDetail, StageSnapshot } from "../../api";
import { authorizationHeaders } from "../../api/controlToken";
import {
  ArtifactReader,
  formatByteSize,
  isImageArtifactPath,
} from "../../components/ArtifactReader";
import {
  artifactFileName,
  resolveDiskArtifactPath,
} from "../../components/EnvelopeFields";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";

function artifactUrl(runId: string, path: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
}

async function fetchArtifactByteSize(runId: string, path: string): Promise<number | null> {
  try {
    const res = await fetch(artifactUrl(runId, path), {
      method: "HEAD",
      headers: { ...authorizationHeaders() },
    });
    if (res.ok) {
      const len = res.headers.get("content-length");
      if (len) return Number.parseInt(len, 10);
    }
    const full = await fetch(artifactUrl(runId, path), {
      headers: { ...authorizationHeaders() },
    });
    if (!full.ok) return null;
    if (isImageArtifactPath(path)) {
      const blob = await full.blob();
      return blob.size;
    }
    const text = await full.text();
    return new TextEncoder().encode(text).length;
  } catch {
    return null;
  }
}

function useArtifactSizes(runId: string, paths: string[]): Record<string, number | null> {
  const [sizes, setSizes] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let cancelled = false;
    setSizes({});
    for (const path of paths) {
      void fetchArtifactByteSize(runId, path).then((bytes) => {
        if (cancelled) return;
        setSizes((prev) => ({ ...prev, [path]: bytes }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [runId, paths.join("|")]);

  return sizes;
}

/**
 * Pick the selected disk path for the Artifacts panel.
 * When `initialPath` is set but absent from disk, return selected=null (never coerce to paths[0]).
 */
export function resolveArtifactsPanelSelection(
  diskPaths: readonly string[],
  initialPath?: string | null,
  currentSelected?: string | null,
): { selected: string | null; missingClaim: string | null } {
  if (initialPath != null && initialPath !== "") {
    const resolved = resolveDiskArtifactPath(initialPath, diskPaths);
    if (resolved) {
      return { selected: resolved, missingClaim: null };
    }
    return { selected: null, missingClaim: initialPath };
  }
  if (currentSelected && diskPaths.includes(currentSelected)) {
    return { selected: currentSelected, missingClaim: null };
  }
  return { selected: diskPaths[0] ?? null, missingClaim: null };
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
  const sizes = useArtifactSizes(runId, paths);
  const [selected, setSelected] = useState<string | null>(() => {
    return resolveArtifactsPanelSelection(paths, initialPath).selected;
  });
  const [missingClaim, setMissingClaim] = useState<string | null>(() => {
    return resolveArtifactsPanelSelection(paths, initialPath).missingClaim;
  });

  useEffect(() => {
    const next = resolveArtifactsPanelSelection(paths, initialPath, selected);
    setSelected(next.selected);
    setMissingClaim(next.missingClaim);
  }, [stage.stage_id, paths.join("|"), initialPath]);

  const label = stageCloneLabel(run, stage.stage_id);

  if (paths.length === 0) {
    if (missingClaim) {
      return (
        <p className="px-6 py-4 text-[13px] text-[var(--sf-text-2)]">
          {artifactFileName(missingClaim)} is not on disk for {label}.
        </p>
      );
    }
    return (
      <p className="px-6 py-4 text-[13px] text-[var(--sf-text-2)]">
        No artifacts for {label}.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--sf-ground)]">
      <div className="flex w-[280px] shrink-0 flex-col border-r border-r-[#ffffff12] py-2">
        <h3 className="px-3 pb-2 text-[11px] uppercase tracking-[0.88px] text-[#8b8f98]">
          Artifacts · {label}
        </h3>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {paths.map((path) => {
            const active = selected === path;
            const bytes = sizes[path];
            return (
              <li key={path}>
                <button
                  type="button"
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left ${
                    active
                      ? "border-l-2 border-l-[#6ca6ff] bg-[#16171b] text-[var(--sf-text-1)]"
                      : "border-l-2 border-l-transparent text-[var(--sf-text-2)] hover:bg-[#ffffff08]"
                  }`}
                  onClick={() => {
                    setSelected(path);
                    setMissingClaim(null);
                  }}
                >
                  <span className="font-['Geist_Mono',monospace] text-xs leading-[1.33]">
                    {artifactFileName(path)}
                  </span>
                  <span className="font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
                    {bytes != null ? formatByteSize(bytes) : "…"}
                  </span>
                </button>
              </li>
            );
          })}
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
        ) : missingClaim ? (
          <p className="px-4 py-3 text-[13px] text-[var(--sf-text-3)]">
            {artifactFileName(missingClaim)} is not on disk.
          </p>
        ) : (
          <p className="px-4 py-3 text-[13px] text-[var(--sf-text-3)]">
            Select an artifact.
          </p>
        )}
      </div>
    </div>
  );
}
