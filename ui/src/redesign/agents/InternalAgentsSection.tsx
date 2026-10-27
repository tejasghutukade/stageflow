import { useState } from "react";
import { LuChevronRight, LuLock } from "react-icons/lu";
import type { InternalAgent, InternalAgentsResponse } from "../../api/internalAgents";
import { MONO, NOWRAP } from "./agentsTokens";
import { Dialog } from "./editor/Dialogs";
import { useInternalAgents } from "./useInternalAgents";

function toolCount(agent: InternalAgent): string {
  return `${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"}`;
}

function InternalAgentDialog({ agent, onClose }: { agent: InternalAgent; onClose: () => void }) {
  return (
    <Dialog title={`${agent.title} (internal, read-only)`} onClose={onClose}>
      <div className="flex flex-col gap-4 px-4 py-4" data-testid="internal-agent-detail">
        <p className={`${MONO} text-xs text-[var(--sf-text-3)]`}>{agent.id}</p>
        {agent.greeting ? <p className="text-[13px] text-[var(--sf-text-2)]">{agent.greeting}</p> : null}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Tools</span>
          {agent.tools.length === 0 ? (
            <p className="text-[13px] text-[var(--sf-text-2)]">No tools on this Host.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agent.tools.map((tool) => (
                <span key={tool} className={`${MONO} rounded-md border border-[var(--sf-hairline-strong)] px-1.5 py-0.5 text-xs text-[var(--sf-text-1)]`}>
                  {tool}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Playbook</span>
          <pre className={`${MONO} whitespace-pre-wrap rounded-md border border-[var(--sf-hairline)] p-3 text-xs leading-[1.6] text-[var(--sf-text-2)]`}>{agent.playbook}</pre>
        </div>
      </div>
    </Dialog>
  );
}

export function InternalAgentsView({
  data,
  openId,
  onOpen,
  onClose,
}: {
  data: InternalAgentsResponse;
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  if (!data.visible || data.agents.length === 0) return null;
  const open = openId ? data.agents.find((agent) => agent.id === openId) : undefined;
  return (
    <section className="flex flex-col gap-2" data-testid="internal-agents">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Internal agents</h2>
        <span className="text-xs text-[var(--sf-text-3)]">Built into Stageflow · read-only · shown because STAGEFLOW_SHOW_INTERNAL_AGENTS=1</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
        {data.agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onOpen(agent.id)}
            className="flex w-full items-center gap-3 border-b border-b-[var(--sf-hairline)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--sf-panel)]"
            data-testid="internal-agent-row"
          >
            <LuLock aria-hidden className="size-3 shrink-0 text-[var(--sf-text-3)]" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-1)]">{agent.title}</span>
            <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>{agent.id}</span>
            <span className={`text-xs text-[var(--sf-text-3)] ${NOWRAP}`}>{toolCount(agent)}</span>
            <LuChevronRight aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
          </button>
        ))}
      </div>
      {open ? <InternalAgentDialog agent={open} onClose={onClose} /> : null}
    </section>
  );
}

/** Operator profiles (Workshop author, agent author, Guide), listed only when the Host shows internal agents. */
export function InternalAgentsSection() {
  const data = useInternalAgents();
  const [openId, setOpenId] = useState<string | null>(null);
  return <InternalAgentsView data={data} openId={openId} onOpen={setOpenId} onClose={() => setOpenId(null)} />;
}
