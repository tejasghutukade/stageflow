import { useEffect, useMemo, useState } from "react";
import { fetchCatalogFile } from "../../api";
import type { DraftPackagePayload } from "../../api";

export type YamlPanelProps = {
  draft: DraftPackagePayload | null;
  pipelinePath: string | null;
  projectRoot?: string;
  activePath?: string | null;
  onActivePathChange?: (path: string) => void;
};

type Tab = { path: string; label: string };

export function YamlPanel({
  draft,
  pipelinePath,
  projectRoot,
  activePath,
  onActivePathChange,
}: YamlPanelProps) {
  const tabs = useMemo((): Tab[] => {
    if (!draft || !pipelinePath) return [];
    const out: Tab[] = [{ path: pipelinePath, label: "pipeline" }];
    for (const file of draft.stages ?? []) {
      out.push({
        path: file.path,
        label: file.path.split("/").pop() ?? file.path,
      });
    }
    return out;
  }, [draft, pipelinePath]);

  const [internalPath, setInternalPath] = useState<string | null>(null);
  const selectedPath =
    activePath ?? internalPath ?? tabs[0]?.path ?? pipelinePath;
  const [content, setContent] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void fetchCatalogFile({
      path: selectedPath,
      ...(projectRoot ? { project_root: projectRoot } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
      })
      .catch((err) => {
        if (cancelled) return;
        setContent("");
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, selectedPath]);

  const lines = content ? content.split("\n") : [];
  const lineCount = lines.length;

  function pickTab(path: string) {
    if (onActivePathChange) onActivePathChange(path);
    else setInternalPath(path);
  }

  if (!pipelinePath) {
    return (
      <div className="flex w-[400px] shrink-0 flex-col border-r border-r-[#ffffff12] bg-[var(--sf-panel)]">
        <p className="p-3 text-xs text-[var(--sf-text-3)]">YAML unavailable</p>
      </div>
    );
  }

  return (
    <div className="flex w-[400px] shrink-0 flex-col border-r border-r-[#ffffff12] bg-[var(--sf-panel)]">
      <div
        className="flex h-9 w-full shrink-0 items-end gap-0.5 border-b border-b-[#ffffff12] px-2"
        role="tablist"
      >
        {tabs.map((tab) => {
          const active = tab.path === selectedPath;
          return (
            <button
              key={tab.path}
              type="button"
              role="tab"
              aria-selected={active}
              className={`rounded-t px-2 py-1 font-['Geist_Mono',monospace] text-xs${
                active
                  ? " bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
                  : " text-[var(--sf-text-3)]"
              }`}
              onClick={() => pickTab(tab.path)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-auto px-0 py-2.5 font-['Geist_Mono',monospace] text-xs leading-[1.66667]"
        aria-readonly="true"
      >
        {loading ? (
          <p className="px-3 text-[var(--sf-text-3)]">Loading…</p>
        ) : null}
        {loadError ? (
          <p className="px-3 text-[var(--sf-fail)]">{loadError}</p>
        ) : null}
        {!loading && !loadError ? (
          <pre className="m-0">
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-[2.5rem_1fr] gap-2 px-2">
                <span className="text-right text-[var(--sf-text-3)] select-none">
                  {index + 1}
                </span>
                <span className="text-[var(--sf-text-1)]">{line || " "}</span>
              </div>
            ))}
          </pre>
        ) : null}
      </div>
      <footer className="flex h-[30px] shrink-0 items-center gap-3 border-t border-t-[#ffffff12] px-3 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
        {lineCount} {lineCount === 1 ? "line" : "lines"} · read-only
      </footer>
    </div>
  );
}
