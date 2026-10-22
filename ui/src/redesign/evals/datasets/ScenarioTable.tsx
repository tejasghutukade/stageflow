import { LuPencil, LuTrash2 } from "react-icons/lu";
import type { EvalConversationMode, EvalDatasetCase } from "../../../api/evalTypes";
import { MONO } from "./DialogShell";
import { caseIsInvalid, checkLabel } from "./datasetModel";
import { modeLabel, scenarioRow } from "./scenarioModel";

const HEAD = "text-xs text-[var(--sf-text-3)]";
const GRID = "grid grid-cols-[40px_84px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)_120px_130px_52px] items-start gap-4 px-4";

type Props = {
  cases: EvalDatasetCase[];
  offset: number;
  defaultMode: EvalConversationMode;
  editable: boolean;
  onEdit: (c: EvalDatasetCase) => void;
  onDelete: (c: EvalDatasetCase) => void;
};

/** Agent datasets: one row per scenario (#, Mode, Title, Opening or first message, Expected tools, Tags, Input check). */
export function ScenarioTable({ cases, offset, defaultMode, editable, onEdit, onDelete }: Props) {
  return (
    <div role="grid" aria-label="Scenarios" className="overflow-hidden">
      <div role="row" className={`${GRID} items-center border-b border-b-[var(--sf-hairline)] py-2.5`}>
        {["#", "Mode", "Title", "Opening / first message", "Expected tools", "Tags", "Input check", ""].map((label, i) => (
          <span key={i} role="columnheader" className={HEAD}>{label}</span>
        ))}
      </div>
      {cases.map((c, index) => {
        const row = scenarioRow(c, defaultMode, offset + index);
        const check = checkLabel(c);
        const invalid = caseIsInvalid(c);
        return (
          <div
            key={c.id}
            role="row"
            data-case-id={c.id}
            data-invalid={invalid || undefined}
            className={`group ${GRID} border-b border-b-[var(--sf-hairline)] py-2.5 last:border-b-0 ${invalid ? "bg-[var(--sf-needs-bg)]" : ""}`}
          >
            <span role="cell" className="pt-0.5 text-xs text-[var(--sf-text-3)]" title={c.id}>{offset + index + 1}</span>
            <span role="cell" className="text-[13px] text-[var(--sf-text-2)]">{modeLabel(row.mode)}</span>
            <span role="cell" className="line-clamp-2 break-words text-[13px] text-[var(--sf-text-1)]">{row.title || c.id}</span>
            <span role="cell" className={`${MONO} line-clamp-2 break-words text-xs text-[var(--sf-text-2)]`}>{row.opening}</span>
            <span role="cell" className={`${MONO} line-clamp-2 break-words text-xs text-[var(--sf-text-2)]`}>{row.expectedTools || <span className="text-[var(--sf-text-3)]">none</span>}</span>
            <span role="cell" className="flex flex-wrap gap-1">
              {(c.tags ?? []).map((t) => (
                <span key={t} className={`${MONO} rounded-sm border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-2)]`}>{t}</span>
              ))}
            </span>
            <span role="cell" className="flex items-center gap-1.5 pt-0.5 text-xs">
              {check.kind === "none" ? (
                <span className="text-[var(--sf-text-3)]">—</span>
              ) : (
                <>
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: check.kind === "valid" ? "var(--sf-ok)" : "var(--sf-needs)" }} />
                  <span title={check.title} className="truncate" style={{ color: check.kind === "valid" ? "var(--sf-text-2)" : "var(--sf-needs)" }}>
                    {check.label}
                  </span>
                </>
              )}
            </span>
            <span role="cell" className="flex gap-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" disabled={!editable} aria-label={`Edit scenario ${c.id}`} onClick={() => onEdit(c)} className="flex size-6 items-center justify-center rounded-md text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-text-1)] disabled:opacity-40">
                <LuPencil className="size-3.5" aria-hidden />
              </button>
              <button type="button" disabled={!editable} aria-label={`Delete scenario ${c.id}`} onClick={() => onDelete(c)} className="flex size-6 items-center justify-center rounded-md text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-fail)] disabled:opacity-40">
                <LuTrash2 className="size-3.5" aria-hidden />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
