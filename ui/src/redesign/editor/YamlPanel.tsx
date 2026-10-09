import { useEffect, useMemo, useRef, useState } from "react";
import type { DraftPackagePayload } from "../../api";
import {
  draftFileYaml,
  findingLineForFile,
  yamlDisplayLines,
  yamlFooterLabel,
  yamlPathsMatch,
  type YamlActiveFinding,
} from "./draftYaml";
import { highlightYaml, type YamlToken } from "./yamlHighlight";

export type YamlPanelProps = {
  draft: DraftPackagePayload | null;
  pipelinePath: string | null;
  activePath?: string | null;
  onActivePathChange?: (path: string) => void;
  activeFinding?: YamlActiveFinding | null;
};

type Tab = { path: string; label: string };

const TOKEN_CLASS: Record<YamlToken["kind"], string> = {
  plain: "text-[var(--sf-text-1)]",
  key: "text-[var(--sf-running)]",
  string: "text-[var(--sf-ok)]",
  comment: "text-[var(--sf-text-3)]",
};

export function YamlPanel({
  draft,
  pipelinePath,
  activePath,
  onActivePathChange,
  activeFinding = null,
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
  const scrollerRef = useRef<HTMLDivElement>(null);

  const content =
    draft && selectedPath
      ? draftFileYaml(draft, selectedPath, pipelinePath)
      : "";
  const lines = yamlDisplayLines(content);
  const highlighted = highlightYaml(content);
  const findingLine = findingLineForFile(activeFinding, selectedPath);
  const findingMessage =
    findingLine !== undefined && activeFinding?.message?.trim()
      ? activeFinding.message
      : null;

  useEffect(() => {
    if (findingLine === undefined) return;
    const node = scrollerRef.current?.querySelector(
      `[data-yaml-line="${findingLine}"]`,
    );
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
  }, [findingLine, content]);

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
        className="flex h-9 w-full shrink-0 items-end gap-0.5 overflow-x-auto border-b border-b-[#ffffff12] px-2"
        role="tablist"
      >
        {tabs.map((tab) => {
          const active = selectedPath != null && yamlPathsMatch(tab.path, selectedPath);
          const findingMatch =
            activeFinding != null && yamlPathsMatch(activeFinding.path, tab.path);
          return (
            <button
              key={tab.path}
              type="button"
              role="tab"
              aria-selected={active}
              data-finding-match={findingMatch ? "true" : "false"}
              className={`shrink-0 rounded-t px-2 py-1 font-['Geist_Mono',monospace] text-xs${
                active ? " bg-[var(--sf-raised)]" : ""
              }${
                findingMatch
                  ? " text-[var(--sf-needs)] shadow-[inset_0_-2px_0_var(--sf-needs)]"
                  : active
                    ? " text-[var(--sf-text-1)]"
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
        ref={scrollerRef}
        className="flex min-h-0 flex-1 flex-col overflow-auto px-0 py-2.5 font-['Geist_Mono',monospace] text-xs leading-[1.66667]"
        aria-readonly="true"
      >
        <pre className="m-0">
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const hit = findingLine === lineNumber;
            const tokens = highlighted[index] ?? [
              { kind: "plain" as const, text: line },
            ];
            return (
              <div key={lineNumber} data-yaml-line={lineNumber}>
                <div
                  className={`grid grid-cols-[2.5rem_1fr] gap-2 px-2${
                    hit ? " bg-[var(--sf-needs-bg)]" : ""
                  }`}
                >
                  <span className="text-right text-[var(--sf-text-3)] select-none">
                    {lineNumber}
                  </span>
                  <span>
                    {tokens.length > 0 ? (
                      tokens.map((token, tokenIndex) => (
                        <span key={tokenIndex} className={TOKEN_CLASS[token.kind]}>
                          {token.text}
                        </span>
                      ))
                    ) : (
                      " "
                    )}
                  </span>
                </div>
                {hit && findingMessage ? (
                  <p className="mx-2 my-1 rounded border border-[var(--sf-needs-border)] bg-[var(--sf-needs-bg)] px-2 py-1 text-[11px] text-[var(--sf-needs)]">
                    {findingMessage}
                  </p>
                ) : null}
              </div>
            );
          })}
        </pre>
      </div>
      <footer className="flex h-[30px] shrink-0 items-center gap-3 border-t border-t-[#ffffff12] px-3 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
        {yamlFooterLabel(lines.length, findingLine)}
      </footer>
    </div>
  );
}
