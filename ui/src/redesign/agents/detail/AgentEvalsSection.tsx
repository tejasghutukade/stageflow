import { useEffect, useState } from "react";
import { LuChevronRight, LuPlus } from "react-icons/lu";
import { fetchEvals } from "../../../api";
import { evalNewPath, navigate } from "../../../routes";
import { MONO } from "../agentsTokens";
import {
  AGENT_EVALS_EMPTY,
  agentEvaluateHref,
  buildAgentEvalsModel,
  type AgentEvalsModel,
} from "./agentEvalsModel";

export type AgentEvalsState = { status: "loading" } | { status: "error" } | { status: "ok"; model: AgentEvalsModel };

export function useAgentEvals(agentId: string): AgentEvalsState {
  const [state, setState] = useState<AgentEvalsState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchEvals({ agent: agentId }).then(
      (res) => {
        if (!cancelled) setState({ status: "ok", model: buildAgentEvalsModel(agentId, res.items, Date.now()) });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return state;
}

/** Until the list loads, Evaluate falls back to the wizard so it never opens a wrong eval. */
export function agentEvaluateTarget(agentId: string, state: AgentEvalsState): string {
  return state.status === "ok" ? state.model.evaluateHref : agentEvaluateHref(agentId, []);
}

export function AgentEvalsSection({ agentId, state }: { agentId: string; state: AgentEvalsState }) {
  const newHref = state.status === "ok" ? state.model.newEvalHref : evalNewPath({ agent: agentId });
  return (
    <section className="flex flex-col gap-3" aria-label="Evals" data-testid="agent-evals">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold leading-normal text-[var(--sf-text-1)]">Evals</h2>
        {state.status === "ok" ? (
          <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-2)]`}>{state.model.total}</span>
        ) : null}
        <span className="block flex-1" />
        <button
          type="button"
          onClick={() => navigate(newHref)}
          className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[var(--sf-text-2)] hover:bg-[var(--sf-raised)] hover:text-[var(--sf-text-1)]"
        >
          <LuPlus className="size-3" aria-hidden />
          <span className="text-xs font-medium leading-normal">New eval</span>
        </button>
      </div>
      {state.status === "loading" ? (
        <span className="text-xs text-[var(--sf-text-3)]">Loading evals…</span>
      ) : state.status === "error" ? (
        <span className="text-xs text-[var(--sf-fail)]">Could not load evals.</span>
      ) : state.model.total === 0 ? (
        <span className="text-xs leading-[1.5] text-[var(--sf-text-3)]">{AGENT_EVALS_EMPTY}</span>
      ) : (
        <>
          <div className="flex flex-col rounded-[10px] border border-[var(--sf-hairline)]">
            {state.model.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => navigate(row.href)}
                className="flex min-h-10 w-full items-center gap-2.5 border-b border-b-[var(--sf-hairline)] px-2.5 py-1.5 text-left last:border-b-0 hover:bg-[var(--sf-raised)]"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`truncate ${MONO} text-xs leading-normal text-[var(--sf-text-1)]`}>{row.id}</span>
                  <span className="truncate text-[11px] leading-normal text-[var(--sf-text-3)]">{row.meta}</span>
                </span>
                {row.passRate !== null ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="block h-1 w-10 overflow-hidden rounded-full bg-[var(--sf-hairline)]">
                      <span className="block h-full rounded-full bg-[var(--sf-ok)]" style={{ width: `${Math.round(row.passRate * 100)}%` }} />
                    </span>
                    <span className={`${MONO} text-xs leading-normal text-[var(--sf-text-1)]`}>{row.passRateLabel}</span>
                  </span>
                ) : null}
                <LuChevronRight className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
              </button>
            ))}
          </div>
          {state.model.guidance ? (
            <span className="text-[11px] leading-[1.4] text-[var(--sf-text-3)]">{state.model.guidance}</span>
          ) : null}
        </>
      )}
    </section>
  );
}
