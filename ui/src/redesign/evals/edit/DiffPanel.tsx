import { useMemo } from "react";
import type { ValidationFinding } from "../../../api/types";
import { CARD, FindingsList, MONO } from "../newEval/parts";
import { OUTSIDE_NOTE } from "./editModel";
import { collapseDiff, diffCounts, lineDiff } from "./lineDiffView";

const ROW_TONE = {
  add: "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)]",
  remove: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
  same: "text-[var(--sf-text-2)]",
} as const;
const MARK = { add: "+", remove: "-", same: " " } as const;

export function DiffPanel({ fileText, derivedYaml, findings, loading }: { fileText: string; derivedYaml: string; findings: ValidationFinding[]; loading: boolean }) {
  const lines = useMemo(() => (derivedYaml === "" ? [] : lineDiff(fileText, derivedYaml)), [fileText, derivedYaml]);
  const { added, removed } = diffCounts(lines);
  const rows = useMemo(() => collapseDiff(lines, 2), [lines]);
  return (
    <section className={`${CARD} overflow-hidden`} aria-label="Changes to the file">
      <header className="flex items-center justify-between border-b border-b-[var(--sf-hairline)] px-3.5 py-3">
        <h2 className="text-[14px] font-semibold text-[var(--sf-text-1)]">Changes to the file</h2>
        <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>{loading ? "updating…" : `+${added} −${removed}`}</span>
      </header>
      {added + removed === 0 ? (
        <p className="px-3.5 py-3 text-[13px] text-[var(--sf-text-3)]">{derivedYaml === "" ? "Checking the draft…" : "No changes to the file."}</p>
      ) : (
        <pre className={`${MONO} max-h-[360px] overflow-auto py-2 text-xs leading-[1.6]`}>
          {rows.map((r, i) =>
            r.op === "skip" ? (
              <div key={i} className="px-3.5 text-[var(--sf-text-3)]">⋯ {r.count} unchanged {r.count === 1 ? "line" : "lines"}</div>
            ) : (
              <div key={i} className={`whitespace-pre px-3.5 ${ROW_TONE[r.op]}`}>{MARK[r.op]} {r.text}</div>
            ),
          )}
        </pre>
      )}
      <div className="flex flex-col gap-2 border-t border-t-[var(--sf-hairline)] px-3.5 py-3">
        {findings.length > 0 ? <FindingsList findings={findings} /> : null}
        <p className="text-xs text-[var(--sf-text-3)]">{OUTSIDE_NOTE}</p>
      </div>
    </section>
  );
}
