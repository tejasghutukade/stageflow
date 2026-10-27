import type { InternalAgent, InternalAgentsResponse } from "../../../api/internalAgents";
import { useInternalAgents } from "../../agents/useInternalAgents";
import { MONO } from "./parts";

export const INTERNAL_TARGET_NOTE = "Built into Stageflow. An eval runs read-only: writes are recorded and not executed.";

export function filterInternalAgents(agents: InternalAgent[], query: string): InternalAgent[] {
  const q = query.trim().toLowerCase();
  if (q === "") return agents;
  return agents.filter((agent) => agent.id.toLowerCase().includes(q) || agent.title.toLowerCase().includes(q));
}

export function InternalAgentTargetsView({
  data,
  query,
  selectedId,
  onPick,
}: {
  data: InternalAgentsResponse;
  query: string;
  selectedId?: string;
  onPick?: (agent: InternalAgent) => void;
}) {
  if (!data.visible) return null;
  const shown = filterInternalAgents(data.agents, query);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="internal-agent-targets">
      <p className="text-xs text-[var(--sf-text-3)]">{INTERNAL_TARGET_NOTE}</p>
      <div className="rounded-lg border border-dashed border-[var(--sf-hairline-strong)]" aria-label="Internal agents">
        {shown.map((agent) => {
          const selected = selectedId === agent.id;
          return (
            <button
              key={agent.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onPick?.(agent)}
              className={`grid w-full grid-cols-[18px_minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-3 border-b border-b-[var(--sf-hairline)] px-3 py-2.5 text-left text-[13px] last:border-b-0 ${selected ? "bg-[var(--sf-raised)]" : ""}`}
            >
              <span className={`mt-0.5 size-3.5 rounded-full border ${selected ? "border-[var(--sf-text-1)] bg-[var(--sf-text-1)]" : "border-[var(--sf-hairline-strong)]"}`} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[var(--sf-text-1)]">{agent.title}</span>
                <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>{agent.id}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="rounded border border-[var(--sf-hairline-strong)] px-1.5 py-px text-[11px] text-[var(--sf-text-2)]">Internal</span>
                <span className="text-xs text-[var(--sf-text-3)]">{agent.tools.length} tools</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function InternalAgentTargets({
  query,
  selectedId,
  onPick,
}: {
  query: string;
  selectedId?: string;
  onPick?: (agent: InternalAgent) => void;
}) {
  const data = useInternalAgents();
  return <InternalAgentTargetsView data={data} query={query} selectedId={selectedId} onPick={onPick} />;
}
