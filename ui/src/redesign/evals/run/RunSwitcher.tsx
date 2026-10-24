import { useEffect, useRef, useState } from "react";
import { LuCheck, LuChevronDown } from "react-icons/lu";
import { fetchEvalRuns } from "../../../api";
import type { EvalRunListItem } from "../../../api/evalTypes";
import { evalRunPath, navigate, type EvalRunTab } from "../../../routes";
import { switcherRows, type SwitcherTone } from "./runSwitcherModel";

const MONO = "font-['Geist_Mono',monospace]";

const TONE_COLOR: Record<SwitcherTone, string> = {
  ok: "var(--sf-ok)",
  fail: "var(--sf-fail)",
  running: "var(--sf-running)",
  muted: "var(--sf-text-3)",
};

export function RunSwitcher({ evalId, runNumber, tab }: { evalId: string; runNumber: number; tab?: EvalRunTab }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EvalRunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetchEvalRuns({ eval_id: evalId, limit: 200 }).then(
      (page) => {
        if (!cancelled) setItems(page.items);
      },
      (err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, evalId, runNumber]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const rows = items ? switcherRows(items, runNumber) : [];

  useEffect(() => {
    if (!open || rows.length === 0) return;
    const current = rows.findIndex((r) => r.current);
    setFocus(current >= 0 ? current : 0);
  }, [open, items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) options.current[focus]?.focus();
  }, [open, focus, items]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function choose(n: number) {
    setOpen(false);
    if (n !== runNumber) navigate(evalRunPath(evalId, n, tab ? { tab } : undefined));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus((f) => Math.min(rows.length - 1, f + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus((f) => Math.max(0, f - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setFocus(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setFocus(Math.max(0, rows.length - 1));
    }
  }

  return (
    <span ref={root} className="relative inline-flex" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Run #${runNumber}, switch run`}
        onClick={() => setOpen((v) => !v)}
        className={`${MONO} flex items-center gap-1 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 py-0.5 text-xs text-[var(--sf-text-1)]`}
      >
        Run #{runNumber}
        <LuChevronDown className="size-3 text-[var(--sf-text-3)]" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Runs of this eval"
          className="absolute left-0 top-full z-50 mt-1 flex max-h-[360px] w-[380px] flex-col overflow-y-auto rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] py-1 shadow-[0px_16px_48px_rgba(0,0,0,0.5)]"
        >
          {error ? (
            <p role="alert" className="px-3 py-2 text-xs text-[var(--sf-fail)]">
              {error}
            </p>
          ) : items === null ? (
            <p className="px-3 py-2 text-xs text-[var(--sf-text-3)]">Loading runs…</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--sf-text-3)]">No runs yet.</p>
          ) : (
            rows.map((row, index) => (
              <button
                key={row.runNumber}
                ref={(el) => {
                  options.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={row.current}
                tabIndex={index === focus ? 0 : -1}
                onClick={() => choose(row.runNumber)}
                className={`flex shrink-0 items-center gap-3 px-3 py-2 text-left text-xs hover:bg-[var(--sf-active)] focus:bg-[var(--sf-active)] focus:outline-none ${
                  row.current ? "bg-[var(--sf-active)]" : ""
                }`}
              >
                <span className="flex w-3 shrink-0 justify-center text-[var(--sf-text-1)]">
                  {row.current ? <LuCheck className="size-3" aria-hidden /> : null}
                </span>
                <span className={`${MONO} w-[40px] shrink-0 text-[var(--sf-text-1)]`}>#{row.runNumber}</span>
                <span className="flex w-[112px] shrink-0 items-center gap-1.5" style={{ color: TONE_COLOR[row.tone] }}>
                  <span className="block size-1.5 shrink-0 rounded-full" style={{ background: TONE_COLOR[row.tone] }} />
                  <span className="truncate">{row.statusText}</span>
                </span>
                <span className={`${MONO} w-[52px] shrink-0 text-[var(--sf-text-2)]`}>{row.metaText}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--sf-text-3)]">
                  {row.timeText}
                  {row.label ? ` · ${row.label}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </span>
  );
}
