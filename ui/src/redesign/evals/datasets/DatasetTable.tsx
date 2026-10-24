import { useRef, useState } from "react";
import { LuTrash2 } from "react-icons/lu";
import type { EvalDatasetCase } from "../../../api/evalTypes";
import { MONO } from "./DialogShell";
import {
  caseIsInvalid,
  cellText,
  checkLabel,
  currentCellValue,
  type CellKey,
  type ColumnDef,
} from "./datasetModel";

const HEAD = "text-xs text-[var(--sf-text-3)]";

function widthFor(col: ColumnDef): string {
  if (col.id === "#") return "w-10 shrink-0";
  if (col.check) return "w-[130px] shrink-0";
  if (col.cell?.kind === "tags") return "w-[150px] shrink-0";
  if (col.cell?.kind === "expected") return "w-[190px] shrink-0";
  return "min-w-0 flex-1 basis-0";
}

function cellDisplay(c: EvalDatasetCase, cell: CellKey): string {
  const value = currentCellValue(c, cell);
  if (cell.kind === "tags") return (c.tags ?? []).join(" ");
  return cellText(value);
}

export type DatasetTableProps = {
  columns: ColumnDef[];
  moreExpected: number;
  cases: EvalDatasetCase[];
  offset: number;
  editable: boolean;
  requiredNames: ReadonlySet<string>;
  onCommit: (c: EvalDatasetCase, cell: CellKey, text: string) => void;
  onDelete: (c: EvalDatasetCase) => void;
};

export function DatasetTable({
  columns,
  moreExpected,
  cases,
  offset,
  editable,
  requiredNames,
  onCommit,
  onDelete,
}: DatasetTableProps) {
  const [editing, setEditing] = useState<{ id: string; col: string } | null>(null);

  return (
    <div role="grid" aria-label="Cases" className="overflow-hidden">
      <div role="row" className="flex w-full items-center gap-4 border-b border-b-[var(--sf-hairline)] px-4 py-2.5">
        {columns.map((col) => (
          <span key={col.id} role="columnheader" className={`${HEAD} ${widthFor(col)} ${col.id.startsWith("input.") || col.id.startsWith("expected") ? MONO : ""}`}>
            {col.label}
            {col.id === "tags" && moreExpected > 0 ? null : null}
          </span>
        ))}
        {moreExpected > 0 ? <span className={`${HEAD} w-10 shrink-0`}>+{moreExpected}</span> : null}
        {editable ? <span className="w-6 shrink-0" /> : null}
      </div>
      {cases.map((c, index) => {
        const invalid = caseIsInvalid(c);
        const check = checkLabel(c);
        return (
          <div
            role="row"
            key={c.id}
            data-case-id={c.id}
            data-invalid={invalid || undefined}
            className={`group flex w-full items-start gap-4 border-b border-b-[var(--sf-hairline)] px-4 py-2.5 last:border-b-0 ${
              invalid ? "bg-[var(--sf-needs-bg)]" : ""
            }`}
          >
            {columns.map((col) => {
              if (col.id === "#") {
                return (
                  <span key={col.id} role="cell" className={`${widthFor(col)} pt-0.5 text-xs text-[var(--sf-text-3)]`} title={c.id}>
                    {offset + index + 1}
                  </span>
                );
              }
              if (col.check) {
                return (
                  <span key={col.id} role="cell" className={`${widthFor(col)} flex items-center gap-1.5 pt-0.5 text-xs`}>
                    {check.kind === "none" ? (
                      <span className="text-[var(--sf-text-3)]">—</span>
                    ) : (
                      <>
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: check.kind === "valid" ? "var(--sf-ok)" : "var(--sf-needs)" }}
                        />
                        <span
                          title={check.title}
                          className="truncate"
                          style={{ color: check.kind === "valid" ? "var(--sf-text-2)" : "var(--sf-needs)" }}
                        >
                          {check.label}
                        </span>
                      </>
                    )}
                  </span>
                );
              }
              const cell = col.cell as CellKey;
              const text = cellDisplay(c, cell);
              const isEditing = editing?.id === c.id && editing.col === col.id;
              const missing =
                invalid && cell.kind === "input" && text === "" && requiredNames.has(cell.name) ? `${cell.name} is missing` : null;
              return (
                <div key={col.id} role="cell" className={`${widthFor(col)}`}>
                  {isEditing ? (
                    <CellEditor
                      initial={text}
                      mono={cell.kind !== "tags" && !(cell.kind === "input" && typeof currentCellValue(c, cell) === "string")}
                      onDone={(next) => {
                        setEditing(null);
                        if (next !== null && next !== text) onCommit(c, cell, next);
                      }}
                    />
                  ) : cell.kind === "tags" ? (
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => setEditing({ id: c.id, col: col.id })}
                      className="flex min-h-5 w-full flex-wrap items-center gap-1 text-left disabled:cursor-default"
                      aria-label={`Edit tags of ${c.id}`}
                    >
                      {(c.tags ?? []).map((t) => (
                        <span key={t} className={`${MONO} rounded-sm border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-2)]`}>
                          {t}
                        </span>
                      ))}
                      {(c.tags ?? []).length === 0 && editable ? <span className="text-xs text-[var(--sf-text-3)]">add</span> : null}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => setEditing({ id: c.id, col: col.id })}
                      aria-label={`Edit ${col.label} of ${c.id}`}
                      className={`block w-full text-left text-[13px] leading-[1.4] disabled:cursor-default ${
                        col.id.startsWith("input.") && typeof currentCellValue(c, cell) !== "string" ? MONO : ""
                      }`}
                    >
                      {missing ? (
                        <span className={`${MONO} text-[var(--sf-needs)]`}>{missing}</span>
                      ) : text === "" ? (
                        <span className="text-[var(--sf-text-3)]">{cell.kind === "expected" ? "(none expected)" : ""}</span>
                      ) : (
                        <span className={`line-clamp-2 break-words text-[var(--sf-text-1)] ${cell.kind === "input" && col.id === columns[1]?.id ? MONO : ""}`}>
                          {text}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
            {moreExpected > 0 ? <span className="w-10 shrink-0" /> : null}
            {editable ? (
              <button
                type="button"
                aria-label={`Delete case ${c.id}`}
                onClick={() => onDelete(c)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--sf-text-3)] opacity-0 hover:bg-[var(--sf-raised)] hover:text-[var(--sf-fail)] focus:opacity-100 group-hover:opacity-100"
              >
                <LuTrash2 className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CellEditor({
  initial,
  mono,
  onDone,
}: {
  initial: string;
  mono: boolean;
  onDone: (next: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const finished = useRef(false);
  function finish(next: string | null) {
    if (finished.current) return;
    finished.current = true;
    onDone(next);
  }
  return (
    <textarea
      autoFocus
      aria-label="Cell value"
      value={text}
      rows={Math.min(8, Math.max(2, text.split("\n").length))}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(text);
        }
      }}
      className={`w-full rounded-md border border-[#ecedee73] bg-[var(--sf-raised)] px-2 py-1 text-[13px] text-[var(--sf-text-1)] outline-none ${mono ? MONO : ""}`}
    />
  );
}
