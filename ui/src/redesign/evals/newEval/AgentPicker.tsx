import { useMemo, useState } from "react";
import { LuSearch } from "react-icons/lu";
import type { EvalAgentTarget } from "../../../api/evalTypes";
import { INPUT } from "../datasets/DialogShell";
import { agentRowView, filterAgents, pickerNotice, type RiskBadge } from "./agentPickerModel";
import { MONO } from "./parts";
import type { WizardTarget } from "./wizardModel";

type Props = {
  items: EvalAgentTarget[];
  loading: boolean;
  error: string | null;
  target: WizardTarget | null;
  onPick: (agent: EvalAgentTarget) => void;
  onRetry?: () => void;
  listClass?: string;
};

const BADGE_TONE: Record<RiskBadge["tone"], string> = {
  ok: "bg-[var(--sf-ok-bg)] text-[var(--sf-ok)] border-transparent",
  needs: "bg-[var(--sf-needs-bg)] text-[var(--sf-needs)] border-transparent",
  fail: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)] border-transparent",
  running: "bg-[var(--sf-running-bg)] text-[var(--sf-running)] border-transparent",
  unknown: "border-dashed border-[var(--sf-needs)] text-[var(--sf-needs)]",
  neutral: "bg-[var(--sf-raised)] text-[var(--sf-text-2)] border-transparent",
};

export function RiskBadges({ badges }: { badges: RiskBadge[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((b) => (
        <span key={b.key} className={`rounded border px-1.5 py-px text-[11px] ${BADGE_TONE[b.tone]}`}>
          {b.label} {b.count}
        </span>
      ))}
    </span>
  );
}

/** The wizard's agent list: search, one row per agent with model, revision, tool risk badges and what asks first. */
export function AgentPicker({ items, loading, error, target, onPick, onRetry, listClass = "max-h-[300px]" }: Props) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterAgents(items, query), [items, query]);
  const notice = pickerNotice({ loading, error, items, shown });

  return (
    <>
      <div className="relative">
        <LuSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--sf-text-3)]" aria-hidden />
        <input className={`${INPUT} pl-8`} placeholder="Search agents by name, id or model" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search agents" />
      </div>
      <div className={`${listClass} overflow-y-auto rounded-lg border border-[var(--sf-hairline)]`} role="radiogroup" aria-label="Agents">
        {notice ? (
          <p role={notice.tone === "error" ? "alert" : undefined} className={`flex items-center gap-3 p-3 text-xs ${notice.tone === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`}>
            {notice.text}
            {notice.tone === "error" && onRetry ? (
              <button type="button" onClick={onRetry} className="rounded-md border border-[var(--sf-hairline-strong)] px-2 py-1 text-[var(--sf-text-1)]">Retry</button>
            ) : null}
          </p>
        ) : null}
        {shown.map((agent) => {
          const row = agentRowView(agent);
          const active = target?.kind === "agent" && target.agentId === agent.id;
          return (
            <button
              key={agent.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!row.selectable}
              title={row.title ?? undefined}
              onClick={() => onPick(agent)}
              className={`grid w-full grid-cols-[18px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)_64px] items-start gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2.5 text-left text-[13px] last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50 ${active ? "bg-[var(--sf-raised)]" : ""}`}
            >
              <span className={`mt-0.5 size-3.5 rounded-full border ${active ? "border-[var(--sf-text-1)] bg-[var(--sf-text-1)]" : "border-[var(--sf-hairline-strong)]"}`} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[var(--sf-text-1)]">{row.name}</span>
                <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>{row.id}</span>
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className={`${MONO} break-all text-xs text-[var(--sf-text-2)]`}>{row.model}</span>
                  <span className={`${MONO} rounded bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-2)]`}>{row.revision}</span>
                </span>
                {row.chip ? (
                  <span className={`w-fit rounded border px-1.5 py-px text-[11px] ${row.state === "disabled" ? "border-[#e5a50a55] text-[var(--sf-warn,#e5a50a)]" : "border-[var(--sf-hairline-strong)] text-[var(--sf-text-2)]"}`}>
                    {row.chip}
                  </span>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <RiskBadges badges={row.badges} />
                {row.askFirst ? <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>{row.askFirst}</span> : null}
              </span>
              <span className="text-right text-xs text-[var(--sf-text-3)]">{row.evalsText}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
