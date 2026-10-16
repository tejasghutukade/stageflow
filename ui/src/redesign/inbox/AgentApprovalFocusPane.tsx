import { useEffect, useState } from "react";
import { LuBot, LuCheck, LuX } from "react-icons/lu";
import { AgentApiError, agentsApi } from "../../api/agents";
import { showToast } from "../../toast";
import { relativeTime } from "../../catalogJoin";
import { Keycap } from "../Keycap";
import type { GateFocusHotkeys } from "./GateFocusPane";
import type { AgentApprovalItem } from "./needsQueue";

const MONO = "font-['Geist_Mono',monospace]";

export function AgentApprovalFocusPane({
  approval,
  index,
  total,
  onDecided,
  onOpenSession,
  onRegisterHotkeys,
}: {
  approval: AgentApprovalItem;
  index: number;
  total: number;
  onDecided: () => void;
  onOpenSession: (agentId: string, sessionId: string) => void;
  onRegisterHotkeys?: (actions: GateFocusHotkeys | null) => void;
}) {
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = approval.agentName ?? approval.agentId;

  useEffect(() => {
    setDeciding(false);
    setError(null);
  }, [approval.id]);

  async function decide(decision: "approve" | "deny") {
    if (deciding) return;
    setDeciding(true);
    setError(null);
    try {
      await agentsApi.decide(approval.agentId, approval.sessionId, decision);
      showToast(decision === "approve" ? `Approved · ${approval.tool}` : `Denied · ${approval.tool}`);
      onDecided();
    } catch (err) {
      setError(err instanceof AgentApiError || err instanceof Error ? err.message : "Could not record the decision");
      onDecided();
    } finally {
      setDeciding(false);
    }
  }

  useEffect(() => {
    if (!onRegisterHotkeys) return undefined;
    onRegisterHotkeys({
      accept: () => void decide("approve"),
      reject: () => void decide("deny"),
      focusNote: () => {},
      openRun: () => onOpenSession(approval.agentId, approval.sessionId),
      locked: deciding,
      canReject: true,
    });
    return () => onRegisterHotkeys(null);
    // decide closes over deciding/approval; re-register when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval, deciding, onRegisterHotkeys, onOpenSession]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip" data-testid="agent-approval-pane">
      <header className="flex shrink-0 flex-col gap-3.5 border-b border-b-[#ffffff0f] px-8 pb-[18px] pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className={`flex min-w-0 items-center gap-2 ${MONO} text-xs text-[var(--sf-text-3)]`}>
            <LuBot aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">Agent · {agent}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">approval</span>
          </div>
          <span className={`shrink-0 ${MONO} text-xs text-[var(--sf-text-3)]`}>{total > 0 ? `${index + 1} / ${total}` : "—"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[22px] font-semibold tracking-[-0.44px] text-[var(--sf-text-1)]">Run {approval.tool}?</h2>
          <span className="flex h-6 items-center gap-1.5 rounded-full border border-[#f5b5444d] bg-[#f5b5441f] px-2 text-xs font-medium text-[var(--sf-needs)]">
            Waiting on you
          </span>
        </div>
        <span className={`${MONO} text-xs text-[var(--sf-text-3)]`}>asked {relativeTime(approval.createdAt)}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-7">
        <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-3.5 text-[13px] leading-normal text-[var(--sf-text-2)]">
          <span className="font-medium text-[var(--sf-text-1)]">Why this needs you.</span> {approval.tool} is marked ask-first in {agent}’s
          configuration, so the session is paused until someone decides.
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={`${MONO} text-[10px] uppercase tracking-[0.5px] text-[var(--sf-text-3)]`}>What will run</span>
          <pre className={`${MONO} max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-3 text-[11px] leading-[1.5] text-[var(--sf-text-1)]`}>
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        </div>
        {error ? (
          <p className="text-xs text-[var(--sf-fail)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-t-[#ffffff0f] px-8 py-4">
        <button
          type="button"
          disabled={deciding}
          onClick={() => void decide("approve")}
          className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--sf-text-1)] px-3.5 text-xs font-medium text-[var(--sf-ground)] disabled:opacity-60"
        >
          <LuCheck aria-hidden className="size-3.5" />
          Approve and run
          <Keycap className="border-[#0c0d0f2e] text-[#5a5d66]">1</Keycap>
        </button>
        <button
          type="button"
          disabled={deciding}
          onClick={() => void decide("deny")}
          className="flex h-9 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] px-3 text-xs text-[var(--sf-text-1)] disabled:opacity-60"
        >
          <LuX aria-hidden className="size-3.5 text-[var(--sf-fail)]" />
          Deny
          <Keycap>3</Keycap>
        </button>
        <button
          type="button"
          onClick={() => onOpenSession(approval.agentId, approval.sessionId)}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-md px-3 text-xs text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
        >
          Open session
          <Keycap>O</Keycap>
        </button>
      </footer>
    </div>
  );
}
