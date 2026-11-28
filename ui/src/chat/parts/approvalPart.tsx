import { useEffect, useState } from "react";
import { LuCheck, LuUserCheck, LuX } from "react-icons/lu";
import { AgentApiError, agentsApi, type AgentApproval } from "../../api/agents";
import { approvalPartHeadline, parseUiPartApproval, UI_PART_KIND_APPROVAL } from "../../../../src/artifacts/uiPartApproval.ts";
import { lookupUiPart, registerUiPart, type UiPartRendererProps } from "./registry";

const RISK_LABEL: Record<"read" | "write" | "destructive" | "external", string> = {
  read: "Read-only",
  write: "Writes data",
  destructive: "Destructive",
  external: "Reaches outside",
};

function ApprovalPart({ part, context }: UiPartRendererProps) {
  const parsed = parseUiPartApproval(part);
  const [approval, setApproval] = useState<AgentApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  const card = parsed.ok ? parsed.part : null;

  const approvalId = card?.approvalId;
  const agentId = context.chat?.agentId;
  const sessionId = context.chat?.sessionId;

  useEffect(() => {
    if (!approvalId || !agentId || !sessionId) return;
    let cancelled = false;
    agentsApi
      .session(agentId, sessionId)
      .then((detail) => {
        if (cancelled) return;
        const match = detail.approvals.find((row) => row.id === approvalId) ?? null;
        setApproval(match);
        if (match?.status && match.status !== "pending") setLocalStatus(match.status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [approvalId, agentId, sessionId]);

  if (!card) return lookupUiPart("")({ part, context });

  const status = localStatus ?? approval?.status ?? card.status ?? "pending";
  const pending = status === "pending";
  const interactive = Boolean(context.chat) && pending;

  async function decide(decision: "approve" | "deny") {
    if (!context.chat || busy || !pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await agentsApi.decide(context.chat.agentId, context.chat.sessionId, decision);
      const match = result.approval.id === approvalId ? result.approval : result.session.approvals.find((row) => row.id === approvalId);
      if (match) setApproval(match);
      setLocalStatus(decision === "approve" ? "approved" : "denied");
    } catch (err) {
      setError(err instanceof AgentApiError ? err.message : "Could not record the decision");
    } finally {
      setBusy(false);
    }
  }

  const risk = card.risk ? RISK_LABEL[card.risk] : null;

  return (
    <div className="flex flex-col overflow-clip rounded-lg border border-[color-mix(in_srgb,var(--sf-needs)_35%,transparent)] bg-[color-mix(in_srgb,var(--sf-needs)_4%,transparent)]">
      <div className="flex items-center gap-2 border-b border-b-[color-mix(in_srgb,var(--sf-needs)_15%,transparent)] px-4 py-3">
        <LuUserCheck aria-hidden className="size-3.5 text-[var(--sf-needs)]" />
        <span className="text-xs font-medium text-[var(--sf-needs)]">{approvalPartHeadline(card)}</span>
        {risk ? <span className="text-[11px] text-[var(--sf-text-3)]">{risk}</span> : null}
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3 pb-1">
        <p className="m-0 text-[13px] leading-normal text-[var(--sf-text-1)]">{card.summary}</p>
        {approval?.tool && approval.tool !== card.tool ? (
          <p className="m-0 text-[11px] text-[var(--sf-text-3)]">
            Tool: <span className="font-mono">{approval.tool}</span>
          </p>
        ) : (
          <p className="m-0 text-[11px] text-[var(--sf-text-3)]">
            Tool: <span className="font-mono">{card.tool}</span>
          </p>
        )}
      </div>
      {interactive ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("approve")}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--sf-text-1)] px-3 text-xs font-medium text-[var(--sf-ground)] disabled:opacity-50"
          >
            <LuCheck aria-hidden className="size-3.5" />
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("deny")}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-3 text-xs font-medium text-[var(--sf-text-1)] disabled:opacity-50"
          >
            <LuX aria-hidden className="size-3.5 text-[var(--sf-fail)]" />
            Deny
          </button>
        </div>
      ) : (
        <p className="m-0 px-4 py-3 text-[12px] capitalize text-[var(--sf-text-2)]">
          {pending ? card.fallback.text : status}
        </p>
      )}
      {error ? <p className="m-0 px-4 pb-3 text-[12px] text-[var(--sf-fail)]">{error}</p> : null}
    </div>
  );
}

let registered = false;

export function ensureApprovalPartRegistered(): void {
  if (registered) return;
  registerUiPart(UI_PART_KIND_APPROVAL, ApprovalPart);
  registered = true;
}