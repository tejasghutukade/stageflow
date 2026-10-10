import { useEffect, useMemo, useRef, useState } from "react";
import { LuChevronRight } from "react-icons/lu";
import type { ValidationFinding } from "../api";
import { findingDedupeKey, lastValidatedFooter, problemCounts } from "./editor/pipelineEditorModel";
import { formatFindingLocation } from "./problemsLocation";

export type ProblemsFilter = "all" | "file" | "stages";

export type ProblemsPanelProps = {
  findings: ValidationFinding[];
  activeFilePath?: string | null;
  loading?: boolean;
  error?: string | null;
  onValidate?: () => void;
  validateLabel?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  selectedKey?: string | null;
  onSelectFinding?: (finding: ValidationFinding) => void;
  validatedMs?: number | null;
};

function severityColor(severity: ValidationFinding["severity"]): string {
  if (severity === "error") return "text-[var(--sf-fail)]";
  if (severity === "warning") return "text-[var(--sf-needs)]";
  return "text-[var(--sf-text-2)]";
}

function FindingRow({
  finding,
  selected,
  onSelect,
}: {
  finding: ValidationFinding;
  selected: boolean;
  onSelect?: (finding: ValidationFinding) => void;
}) {
  const body = (
    <>
      <span
        className={`w-14 shrink-0 text-[11px] uppercase ${severityColor(finding.severity)}`}
      >
        {finding.severity}
      </span>
      <span
        className="w-40 shrink-0 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]"
        title={formatFindingLocation(finding.path, finding.line)}
      >
        {formatFindingLocation(finding.path, finding.line)}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-xs text-[var(--sf-text-2)]"
        title={finding.message}
      >
        {finding.message}
      </span>
    </>
  );
  if (!onSelect) {
    return <div className="flex h-[30px] items-center gap-3 px-3.5">{body}</div>;
  }
  return (
    <button
      type="button"
      aria-selected={selected}
      data-problem-key={findingDedupeKey(finding)}
      className={`flex h-[30px] w-full items-center gap-3 px-3.5 text-left ${
        selected ? "bg-[var(--sf-raised)]" : "hover:bg-[#ffffff08]"
      }`}
      onClick={() => onSelect(finding)}
    >
      {body}
    </button>
  );
}

export function ProblemsPanel({
  findings,
  activeFilePath,
  loading,
  error,
  onValidate,
  validateLabel = "Validate",
  collapsible = false,
  collapsed: collapsedProp,
  onCollapsedChange,
  selectedKey = null,
  onSelectFinding,
  validatedMs,
}: ProblemsPanelProps) {
  const [filter, setFilter] = useState<ProblemsFilter>("all");
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = collapsible && (collapsedProp ?? internalCollapsed);

  function setCollapsed(next: boolean) {
    onCollapsedChange?.(next);
    if (collapsedProp === undefined) setInternalCollapsed(next);
  }

  const filtered = useMemo(() => {
    if (filter === "all") return findings;
    if (filter === "file" && activeFilePath) {
      return findings.filter((f) => f.path === activeFilePath);
    }
    if (filter === "stages") {
      return findings.filter((f) => Boolean(f.stageId));
    }
    return findings;
  }, [activeFilePath, filter, findings]);

  const { errors, warnings } = problemCounts(findings);
  const appliedSelection = useRef(selectedKey);

  useEffect(() => {
    if (appliedSelection.current === selectedKey) return;
    appliedSelection.current = selectedKey;
    if (!selectedKey) return;
    const visible = filtered.some((row) => findingDedupeKey(row) === selectedKey);
    if (!visible && findings.some((row) => findingDedupeKey(row) === selectedKey)) {
      setFilter("all");
    }
  }, [filtered, findings, selectedKey]);

  useEffect(() => {
    if (!selectedKey || collapsed) return;
    const node = document.querySelector(
      `[data-problem-key="${CSS.escape(selectedKey)}"]`,
    );
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  }, [collapsed, filter, selectedKey]);

  const filterTabs = [
    { id: "all" as const, label: "All" },
    { id: "file" as const, label: "This file" },
    { id: "stages" as const, label: "Stages" },
  ];

  return (
    <section
      className="flex w-full shrink-0 flex-col border-t border-t-[#ffffff12] bg-[var(--sf-panel)]"
      aria-label="Problems"
    >
      <header className="flex h-[34px] items-center gap-2.5 border-b border-b-[#ffffff12] px-3.5">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand problems" : "Collapse problems"}
            className="flex size-4 items-center justify-center text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]"
            onClick={() => setCollapsed(!collapsed)}
          >
            <LuChevronRight
              className={`size-3.5 ${collapsed ? "" : "rotate-90"}`}
              aria-hidden
            />
          </button>
        ) : null}
        <span className="text-xs font-medium text-[var(--sf-text-1)]">Problems</span>
        <div className="flex items-center gap-2.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
          <span>{errors} errors</span>
          <span>{warnings} warnings</span>
        </div>
        <span className="flex-1" />
        <div className="flex h-[22px] items-center rounded-md border border-[#ffffff12] bg-[var(--sf-ground)] p-0.5">
          {filterTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`rounded px-2 py-0 text-[11px]${
                filter === tab.id
                  ? " bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
                  : " text-[var(--sf-text-3)]"
              }`}
              onClick={() => setFilter(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {onValidate ? (
          <button
            type="button"
            className="sf-btn sf-btn--ghost sf-btn--sm"
            disabled={loading}
            onClick={onValidate}
          >
            {validateLabel}
          </button>
        ) : null}
      </header>
      {collapsed ? null : (
        <>
          {error ? (
            <p className="px-3.5 py-2 text-xs text-[var(--sf-fail)]">{error}</p>
          ) : null}
          {loading ? (
            <p className="px-3.5 py-2 text-xs text-[var(--sf-text-3)]">Validating…</p>
          ) : null}
          {!loading && filtered.length === 0 ? (
            <p className="px-3.5 py-2 text-xs text-[var(--sf-text-3)]">No problems</p>
          ) : (
            <ul className="flex flex-col py-1">
              {filtered.map((finding, index) => {
                const key = findingDedupeKey(finding);
                return (
                  <li key={`${key}:${index}`}>
                    <FindingRow
                      finding={finding}
                      selected={selectedKey === key}
                      onSelect={onSelectFinding}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="flex h-7 items-center gap-2.5 border-t border-t-[#ffffff12] bg-[var(--sf-ground)] px-3.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
            {validatedMs !== undefined
              ? lastValidatedFooter(validatedMs)
              : `${errors} errors · ${warnings} warnings · sf validate --strict`}
          </footer>
        </>
      )}
    </section>
  );
}
