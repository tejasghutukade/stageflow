import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheck,
  LuChevronDown,
  LuCircleX,
  LuInfo,
  LuLightbulb,
  LuPanelBottomClose,
  LuTerminal,
  LuTriangleAlert,
} from "react-icons/lu";
import { yamlPathsMatch } from "./draftYaml";
import {
  formatEditorLocation,
  formatRelativeAgo,
  type EditorFinding,
} from "./editorProblemsModel";

export type EditorProblemsFilter = "all" | "file" | "stages";

export type EditorProblemsPanelProps = {
  findings: EditorFinding[];
  activeFilePath: string | null;
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  selectedKey: string | null;
  onSelectFinding: (finding: EditorFinding) => void;
  onQuickFix: (finding: EditorFinding) => void;
  onValidate: () => void;
  validatedAt: number | null;
  validatedMs: number | null;
  stageCount: number;
  schemaCount: number;
  findingKey: (finding: EditorFinding) => string;
  quickFixFor?: (finding: EditorFinding) => string | undefined;
};

function countTextClass(count: number): string {
  return count > 0 ? "text-[#ecedee]" : "text-[#8b8f98]";
}

function severityIconClass(severity: EditorFinding["severity"]): string {
  if (severity === "error") return "text-[#e5484d]";
  if (severity === "warning") return "text-[#a7aab2]";
  return "text-[#8b8f98]";
}

function SeverityGlyph({
  severity,
  className,
}: {
  severity: EditorFinding["severity"];
  className: string;
}) {
  if (severity === "error") return <LuCircleX className={className} aria-hidden />;
  if (severity === "warning") return <LuTriangleAlert className={className} aria-hidden />;
  return <LuInfo className={className} aria-hidden />;
}

function validationStatus(loading: boolean, validatedAt: number | null, now: number): string {
  if (loading) return "Validating…";
  if (validatedAt === null) return "Not validated yet";
  return `Last validated ${formatRelativeAgo(now - validatedAt)}`;
}

const FILTERS: { id: EditorProblemsFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "file", label: "This file" },
  { id: "stages", label: "Stages" },
];

export function EditorProblemsPanel({
  findings,
  activeFilePath,
  loading,
  error,
  collapsed,
  onCollapsedChange,
  selectedKey,
  onSelectFinding,
  onQuickFix,
  onValidate,
  validatedAt,
  validatedMs,
  stageCount,
  schemaCount,
  findingKey,
  quickFixFor,
}: EditorProblemsPanelProps) {
  const [filter, setFilter] = useState<EditorProblemsFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const appliedSelection = useRef(selectedKey);

  const filtered = useMemo(() => {
    if (filter === "file" && activeFilePath) {
      return findings.filter((finding) => yamlPathsMatch(finding.path, activeFilePath));
    }
    if (filter === "stages") return findings.filter((finding) => Boolean(finding.stageId));
    return findings;
  }, [activeFilePath, filter, findings]);

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const infos = findings.filter((finding) => finding.severity === "info").length;

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (appliedSelection.current === selectedKey) return;
    appliedSelection.current = selectedKey;
    if (!selectedKey) return;
    const visible = filtered.some((row) => findingKey(row) === selectedKey);
    if (!visible && findings.some((row) => findingKey(row) === selectedKey)) {
      setFilter("all");
    }
  }, [filtered, findingKey, findings, selectedKey]);

  useEffect(() => {
    if (!selectedKey || collapsed) return;
    const node = document.querySelector(`[data-problem-key="${CSS.escape(selectedKey)}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  }, [collapsed, filter, selectedKey]);

  const showList = Boolean(error) || filtered.length > 0;
  const showEmpty = !loading && !error && filtered.length === 0;

  return (
    <section
      className="flex w-full shrink-0 flex-col border-t border-t-[#ffffff12] bg-[#131418]"
      aria-label="Problems"
    >
      <div className="flex h-[34px] w-full items-center gap-2.5 border-b border-b-[#ffffff12] px-3.5 py-0">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand problems" : "Collapse problems"}
          className="flex size-[13px] shrink-0 items-center justify-center text-[#8b8f98] hover:text-[#ecedee]"
          onClick={() => onCollapsedChange(!collapsed)}
        >
          <LuChevronDown
            className={`size-[13px] ${collapsed ? "-rotate-90" : ""}`}
            aria-hidden
          />
        </button>
        <span className="font-sans text-xs font-medium leading-normal text-[#ecedee]">
          Problems
        </span>
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1">
            <LuCircleX className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
            <span
              className={`font-['Geist_Mono',monospace] text-[11px] leading-normal ${countTextClass(errors)}`}
            >
              {errors}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <LuTriangleAlert className="size-3 shrink-0 text-[#a7aab2]" aria-hidden />
            <span
              className={`font-['Geist_Mono',monospace] text-[11px] leading-normal ${countTextClass(warnings)}`}
            >
              {warnings}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <LuInfo className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
            <span
              className={`font-['Geist_Mono',monospace] text-[11px] leading-normal ${countTextClass(infos)}`}
            >
              {infos}
            </span>
          </span>
        </div>
        <span className="flex-1" />
        <div className="flex h-[22px] items-center rounded-md border border-[#ffffff12] bg-[#0c0d0f] p-0.5">
          {FILTERS.map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={active}
                className={
                  active
                    ? "inline-flex h-4 items-center rounded-sm bg-[#1a1c21] px-[7px] py-0 font-sans text-[11px] leading-normal text-[#ecedee]"
                    : "inline-flex h-4 items-center px-[7px] py-0 font-sans text-[11px] leading-normal text-[#8b8f98] hover:text-[#ecedee]"
                }
                onClick={() => setFilter(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={collapsed ? "Expand problems" : "Collapse problems"}
          className="flex size-3.5 shrink-0 items-center justify-center text-[#8b8f98] hover:text-[#ecedee]"
          onClick={() => onCollapsedChange(!collapsed)}
        >
          <LuPanelBottomClose className="size-3.5" aria-hidden />
        </button>
      </div>
      {collapsed ? null : (
        <>
          {showList || showEmpty ? (
            <div className="flex max-h-[150px] w-full flex-col overflow-y-auto px-0 py-1">
              {error ? (
                <div className="flex h-[30px] items-center px-3.5 text-[13px] leading-normal text-[#e5484d]">
                  {error}
                </div>
              ) : null}
              {showEmpty ? (
                <div className="flex h-[30px] items-center px-3.5 text-xs leading-normal text-[#8b8f98]">
                  No problems
                </div>
              ) : (
                filtered.map((finding, index) => {
                  const key = findingKey(finding);
                  const selected = selectedKey === key;
                  const fix = selected ? quickFixFor?.(finding) : undefined;
                  const info = finding.severity === "info";
                  return (
                    <div
                      key={`${key}:${index}`}
                      data-problem-key={key}
                      className={`flex h-[30px] w-full items-center gap-3 px-3.5 py-0 ${
                        selected ? "bg-[#ffffff0a]" : "hover:bg-[#ffffff08]"
                      }`}
                    >
                      <button
                        type="button"
                        aria-selected={selected}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => onSelectFinding(finding)}
                      >
                        <span className="flex w-[78px] shrink-0 items-center gap-1.5">
                          <SeverityGlyph
                            severity={finding.severity}
                            className={`size-[13px] shrink-0 ${severityIconClass(finding.severity)}`}
                          />
                          <span
                            className={
                              info
                                ? "font-sans text-xs leading-normal text-[#a7aab2]"
                                : "font-sans text-xs font-medium leading-normal text-[#ecedee]"
                            }
                          >
                            {finding.severity}
                          </span>
                        </span>
                        <span
                          className={`w-[210px] shrink-0 truncate font-['Geist_Mono',monospace] text-xs leading-normal ${
                            info ? "text-[#8b8f98]" : "text-[#a7aab2]"
                          }`}
                          title={formatEditorLocation(finding.path, finding.line, finding.lineEnd)}
                        >
                          {formatEditorLocation(finding.path, finding.line, finding.lineEnd)}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate font-sans text-[13px] leading-normal ${
                            info ? "text-[#a7aab2]" : "text-[#ecedee]"
                          }`}
                          title={finding.message}
                        >
                          {finding.message}
                        </span>
                      </button>
                      {fix ? (
                        <button
                          type="button"
                          title={fix}
                          className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-[7px] py-0 hover:bg-[#ffffff08]"
                          onClick={() => onQuickFix(finding)}
                        >
                          <LuLightbulb className="size-3 shrink-0 text-[#ecedee]" aria-hidden />
                          <span className="font-sans text-xs leading-normal text-[#ecedee]">
                            Quick fix
                          </span>
                          <span className="font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#8b8f98]">
                            ⌘.
                          </span>
                        </button>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
          <footer className="flex h-7 w-full items-center gap-2.5 border-t border-t-[#ffffff12] bg-[#0c0d0f] px-3.5 py-0">
            {errors === 0 ? (
              <LuCheck className="size-3 shrink-0 text-[#4cc38a]" aria-hidden />
            ) : (
              <LuCircleX className="size-3 shrink-0 text-[#e5484d]" aria-hidden />
            )}
            <span className="font-sans text-xs leading-normal text-[#a7aab2]">
              {validationStatus(loading, validatedAt, now)}
            </span>
            <span className="font-sans text-xs leading-normal text-[#8b8f98]">·</span>
            <button
              type="button"
              title="Run validation now"
              className="flex items-center gap-[5px] hover:text-[#ecedee]"
              onClick={onValidate}
            >
              <LuTerminal className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
              <span className="font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#a7aab2]">
                sf validate --strict
              </span>
            </button>
            <span className="flex-1" />
            {validatedMs != null ? (
              <span className="font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#8b8f98]">
                {`checked ${stageCount} stages, ${schemaCount} schemas in ${validatedMs}ms`}
              </span>
            ) : null}
          </footer>
        </>
      )}
    </section>
  );
}
