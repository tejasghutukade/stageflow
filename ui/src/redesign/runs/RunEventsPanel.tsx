import { useEffect, useMemo, useRef, useState } from "react";
import type { StageLogEvent } from "../../api";
import {
  buildEventRows,
  filterEventsByKinds,
  uniqueEventKinds,
} from "./runEventsView";

export function RunEventsPanel({
  events,
  stageLabel,
}: {
  events: StageLogEvent[];
  stageLabel: string;
}) {
  const kinds = useMemo(() => uniqueEventKinds(events), [events]);
  const [activeKinds, setActiveKinds] = useState<ReadonlySet<string> | null>(null);
  const [followTail, setFollowTail] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => filterEventsByKinds(events, activeKinds),
    [events, activeKinds],
  );
  const rows = useMemo(() => buildEventRows(filtered), [filtered]);

  useEffect(() => {
    if (!followTail || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [followTail, rows.length, rows[rows.length - 1]?.id]);

  function toggleKind(kind: string) {
    setActiveKinds((prev) => {
      const base = prev ?? new Set(kinds);
      const next = new Set(base);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      if (next.size === kinds.length) return null;
      if (next.size === 0) return new Set();
      return next;
    });
  }

  const allSelected = activeKinds === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-b-[#ffffff12] px-3 py-2">
        <span className="font-sans text-[11px] uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          Events
        </span>
        <span className="text-[12px] text-[var(--sf-text-2)]">· {stageLabel}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={`sf-btn sf-btn--sm${allSelected ? " sf-btn--selected" : ""}`}
            onClick={() => setActiveKinds(null)}
          >
            All
          </button>
          {kinds.map((kind) => {
            const on =
              allSelected || (activeKinds?.has(kind) ?? false);
            return (
              <button
                key={kind}
                type="button"
                className={`sf-btn sf-btn--sm${on ? " sf-btn--selected" : ""}`}
                onClick={() => toggleKind(kind)}
              >
                {kind}
              </button>
            );
          })}
          <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--sf-text-2)]">
            <input
              type="checkbox"
              checked={followTail}
              onChange={(e) => setFollowTail(e.target.checked)}
            />
            Follow tail
          </label>
        </div>
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto font-['Geist_Mono',monospace] text-xs"
      >
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-[13px] font-sans text-[var(--sf-text-2)]">
            No events match the current filters.
          </p>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-[var(--sf-panel)]">
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">
                <th className="px-3 py-1.5 font-medium">Time</th>
                <th className="px-3 py-1.5 font-medium">Kind</th>
                <th className="px-3 py-1.5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-t-[#ffffff08] text-[var(--sf-text-1)]"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 text-[var(--sf-text-2)]">
                    {row.timeLabel}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-[var(--sf-text-2)]">
                    {row.kind}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="text-[var(--sf-text-1)]">{row.label}</span>
                    {row.detail ? (
                      <span className="mt-0.5 block text-[var(--sf-text-2)]">
                        {row.detail}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
