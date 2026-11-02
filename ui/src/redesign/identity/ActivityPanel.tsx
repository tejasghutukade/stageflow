import { useState } from "react";
import { LuActivity, LuRefreshCw } from "react-icons/lu";
import type { IdentityAssignment, IdentityAuditEvent } from "../../api/identity";
import { CARD, EmptyState, IdentityAuditTable, SECONDARY } from "./identityParts";
import { auditSummary } from "./identityView";

type Filter = "all" | "allow" | "deny";

export function ActivityPanel({
  events,
  assignments = [],
  busy,
  now,
  onRefresh,
}: {
  events: readonly IdentityAuditEvent[];
  assignments?: readonly IdentityAssignment[];
  busy: boolean;
  now: number;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const totals = auditSummary(events);
  const people = Object.fromEntries(assignments.map((row) => [row.id, row.subject]));
  const shown = filter === "all" ? events : events.filter((event) => event.outcome === filter);
  const tabs: Array<{ id: Filter; label: string; count: number }> = [
    { id: "all", label: "All", count: events.length },
    { id: "allow", label: "Allowed", count: totals.allowed },
    { id: "deny", label: "Denied", count: totals.denied },
  ];

  if (events.length === 0) {
    return (
      <EmptyState icon={<LuActivity className="block size-4 text-[#a7aab2]" aria-hidden />} title="No activity yet">
        <p>Every sign-in, order read and denial is recorded here, without order contents or tokens.</p>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist" aria-label="Outcome">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] ${filter === tab.id ? "bg-[#1a1c21] font-medium text-[#ecedee]" : "text-[#a7aab2] hover:bg-[#16171b]"}`}
            >
              {tab.label}
              <span className="rounded-sm bg-[#1a1c21] px-[5px] text-[11px] text-[#8b8f98] [font-family:'Geist_Mono',_monospace]">{tab.count}</span>
            </button>
          ))}
        </div>
        <button type="button" className={SECONDARY} onClick={onRefresh} disabled={busy}>
          <LuRefreshCw className={`block size-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>
      <div className={`${CARD} overflow-x-auto`}>
        {shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-[#8b8f98]">Nothing in this view.</p>
        ) : (
          <IdentityAuditTable events={shown} now={now} people={people} />
        )}
      </div>
      <p className="text-xs text-[#8b8f98]">Showing the latest {events.length} events. Order contents, tokens and secrets are never recorded.</p>
    </div>
  );
}
