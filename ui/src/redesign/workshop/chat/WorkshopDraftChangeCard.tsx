import { useMemo, useState } from "react";
import {
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuFilePlus,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import type { WorkshopChatProposalPayload } from "../../../api";
import { mutationCardActionsLocked } from "../../../workshop/draftMutationTools";
import { changeFileRows, changeTotals, proposalChangeSummary } from "./changeCardModel";
import { WorkshopFileDiffList } from "./WorkshopFileDiffList";

export type WorkshopMutationCardStatus = "pending" | "accepted" | "rejected" | "conflict";

export type WorkshopMutationCardView = {
  proposal: WorkshopChatProposalPayload;
  status: WorkshopMutationCardStatus;
  notice?: string;
  autoApplied?: boolean;
};

export type WorkshopDraftChangeCardProps = {
  summary: string;
  card: WorkshopMutationCardView | undefined;
  threadRunning: boolean;
  onAccept: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onAskToChange: () => void;
};

const MONO = "font-['Geist_Mono',monospace]";

function PendingCard({
  summary,
  proposal,
  locked,
  onAccept,
  onReject,
  onAskToChange,
}: {
  summary: string;
  proposal: WorkshopChatProposalPayload | undefined;
  locked: boolean;
  onAccept: () => void;
  onReject: () => void;
  onAskToChange: () => void;
}) {
  const artifacts = proposal?.artifacts ?? [];
  const rows = useMemo(() => changeFileRows(artifacts), [artifacts]);
  const totals = changeTotals(rows);
  const title =
    rows.length > 0
      ? `Applied to draft · ${rows.length} change${rows.length === 1 ? "" : "s"}`
      : "Applied to draft";

  return (
    <div
      data-status="pending"
      className="flex min-w-0 flex-col overflow-clip rounded-[10px] border border-[#ffffff1a] bg-[#131418]"
    >
      <div className="flex h-9 items-center gap-2 border-b border-b-[#ffffff12] px-3">
        <LuFilePlus aria-hidden className="size-3.5 shrink-0 text-[#a7aab2]" />
        <span
          title={summary}
          className="min-w-0 flex-1 truncate text-[13px] font-medium leading-normal text-[#ecedee]"
        >
          {title}
        </span>
        {rows.length > 0 ? (
          <>
            <span className={`${MONO} text-[11px] leading-normal text-[#4cc38a]`}>
              +{totals.added}
            </span>
            <span className={`${MONO} text-[11px] leading-normal text-[#f2645a]`}>
              −{totals.removed}
            </span>
          </>
        ) : null}
      </div>
      {rows.length === 0 && summary ? (
        <div className="px-3 py-2 text-xs leading-[1.45] text-[#a7aab2]">{summary}</div>
      ) : null}
      <WorkshopFileDiffList artifacts={artifacts} />
      <div className="flex items-center gap-2 border-t border-t-[#ffffff12] px-3 py-2.5">
        <button
          type="button"
          disabled={locked}
          onClick={onAccept}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#ecedee] px-3 disabled:cursor-not-allowed disabled:bg-[#2a2d33]"
        >
          <span className={`text-[13px] font-medium leading-normal ${locked ? "text-[#8b8f98]" : "text-[#0c0d0f]"}`}>
            Accept
          </span>
          <span className={`${MONO} text-[11px] leading-normal text-[#5a5e66]`}>↵</span>
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={onReject}
          className="flex h-8 shrink-0 items-center rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium leading-normal text-[#ecedee] disabled:cursor-not-allowed disabled:border-[#ffffff0d] disabled:bg-[#131418] disabled:text-[#8b8f98]"
        >
          Reject · undo
        </button>
        <button
          type="button"
          onClick={onAskToChange}
          className="flex h-8 shrink-0 items-center rounded-lg px-2 text-[13px] font-medium leading-normal text-[#a7aab2] hover:text-[#ecedee]"
        >
          Ask to change
        </button>
      </div>
    </div>
  );
}

function SettledCard({
  summary,
  card,
}: {
  summary: string;
  card: WorkshopMutationCardView;
}) {
  const [open, setOpen] = useState(false);
  const change = useMemo(() => proposalChangeSummary(card.proposal), [card.proposal]);
  const rejected = card.status === "rejected";
  const conflict = card.status === "conflict";
  const Chevron = open ? LuChevronDown : LuChevronRight;
  const hasFiles = card.proposal.artifacts.length > 0;
  const line = change.line || summary;

  return (
    <div
      data-status={card.status}
      className={`flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-[#ffffff12] bg-[#0f1013] px-3 py-2.5 ${rejected ? "opacity-70" : ""}`}
    >
      <button
        type="button"
        disabled={!hasFiles}
        aria-expanded={hasFiles ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"
      >
        {rejected ? (
          <LuX aria-hidden className="size-3.5 shrink-0 text-[#8b8f98]" />
        ) : conflict ? (
          <LuTriangleAlert aria-hidden className="size-3.5 shrink-0 text-[#f5b544]" />
        ) : (
          <LuCheck aria-hidden className="size-3.5 shrink-0 text-[#4cc38a]" />
        )}
        <span
          className={`shrink-0 text-xs font-medium leading-normal ${rejected ? "text-[#a7aab2]" : "text-[#ecedee]"}`}
        >
          {rejected ? "Rejected · undone" : conflict ? "Could not undo" : "Applied to draft"}
        </span>
        {card.autoApplied && !rejected ? (
          <span className={`flex h-4 shrink-0 items-center rounded-sm border border-[#ffffff1a] px-1 ${MONO} text-[10px] text-[#8b8f98]`}>
            auto
          </span>
        ) : null}
        <span className={`min-w-0 truncate ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
          {change.countLine}
        </span>
        {hasFiles ? (
          <Chevron aria-hidden className="ml-auto size-3 shrink-0 text-[#8b8f98]" />
        ) : null}
      </button>
      {line ? (
        <div
          title={summary}
          className={`min-w-0 truncate ${MONO} text-xs leading-normal ${rejected ? "text-[#8b8f98] line-through" : "text-[#a7aab2]"}`}
        >
          {line}
        </div>
      ) : null}
      {conflict ? (
        <div className="text-xs leading-[1.45] text-[#a7aab2]">
          {card.notice ?? "Could not undo — ask the agent to reverse it."}
        </div>
      ) : null}
      {open && hasFiles ? (
        <div className="-mx-3 -mb-2.5 mt-1 overflow-clip rounded-b-[10px] border-t border-t-[#ffffff12]">
          <WorkshopFileDiffList artifacts={card.proposal.artifacts} />
        </div>
      ) : null}
    </div>
  );
}

export function WorkshopDraftChangeCard({
  summary,
  card,
  threadRunning,
  onAccept,
  onReject,
  onAskToChange,
}: WorkshopDraftChangeCardProps) {
  const [busy, setBusy] = useState(false);
  const status = card?.status ?? "pending";
  const locked = mutationCardActionsLocked(threadRunning, busy);

  const decide = async (next: "accept" | "reject") => {
    if (locked || status !== "pending") return;
    setBusy(true);
    try {
      if (next === "accept") await onAccept();
      else await onReject();
    } finally {
      setBusy(false);
    }
  };

  if (status === "pending" || !card) {
    return (
      <PendingCard
        summary={summary || card?.proposal.summary || ""}
        proposal={card?.proposal}
        locked={locked}
        onAccept={() => void decide("accept")}
        onReject={() => void decide("reject")}
        onAskToChange={onAskToChange}
      />
    );
  }
  return <SettledCard summary={summary || card.proposal.summary} card={card} />;
}
