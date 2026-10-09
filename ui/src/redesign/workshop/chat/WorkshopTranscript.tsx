import { useAuiState } from "@assistant-ui/react";
import { Markdown } from "@astryxdesign/core/Markdown";
import { useLayoutEffect, useMemo, useRef } from "react";
import { LuLightbulb, LuLoaderCircle, LuPaperclip, LuSparkles } from "react-icons/lu";
import type { WorkshopToolActivityRow } from "../../../workshop/workshopChatView";
import { formatBytes } from "./attachments";
import { tipForProposal } from "./workshopTips";
import {
  buildTranscript,
  formatClock,
  userMetaLine,
  type TranscriptAgentTurn,
  type TranscriptMessageInput,
  type TranscriptUserTurn,
} from "./transcriptModel";
import {
  WorkshopDraftChangeCard,
  type WorkshopMutationCardView,
} from "./WorkshopDraftChangeCard";
import { WorkshopEmptyThread, type WorkshopStarterKind } from "./WorkshopEmptyThread";
import { WorkshopToolCallGroup } from "./WorkshopToolCallGroup";

export type WorkshopTranscriptProps = {
  toolActivity?: readonly WorkshopToolActivityRow[];
  mutationCards: ReadonlyMap<string, WorkshopMutationCardView>;
  onAccept: (mutationId: string) => void | Promise<void>;
  onReject: (mutationId: string) => void | Promise<void>;
  onAskToChange: (summary: string) => void;
  onStarter: (kind: WorkshopStarterKind) => void;
};

const MONO = "font-['Geist_Mono',monospace]";
const MARKDOWN_CLASS =
  "min-w-0 text-[13px] leading-[1.55] text-[#ecedee] [&_p]:my-0 [&_p]:text-[13px] [&_p]:leading-[1.55] [&_p]:text-[#ecedee] [&_li]:text-[13px] [&_li]:leading-[1.55] [&_li]:text-[#ecedee] [&_code]:font-['Geist_Mono',monospace] [&_code]:text-[12px] [&_a]:text-[#6ca6ff]";

type ThreadMessageView = {
  id?: string;
  role: string;
  createdAt?: Date;
  content?: unknown;
  metadata?: { custom?: Record<string, unknown> };
};

function toTranscriptInput(message: ThreadMessageView): TranscriptMessageInput {
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt ?? null,
    metadata: message.metadata ?? null,
    content:
      typeof message.content === "string" || Array.isArray(message.content)
        ? (message.content as TranscriptMessageInput["content"])
        : [],
  };
}

function UserTurn({ turn }: { turn: TranscriptUserTurn }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
        {userMetaLine(turn.createdAt)}
      </div>
      <div className="block max-w-[300px] whitespace-pre-wrap break-words rounded-[10px] border border-[#ffffff0f] bg-[#1a1c21] px-3 py-2 text-[13px] leading-normal text-[#ecedee]">
        {turn.text}
      </div>
      {turn.attachments.length > 0 ? (
        <div className="flex max-w-[300px] flex-wrap justify-end gap-1">
          {turn.attachments.map((file) => (
            <span
              key={file.name}
              title={file.size > 0 ? `${file.name} · ${formatBytes(file.size)}` : file.name}
              className={`flex h-5 max-w-[180px] items-center gap-1 rounded-sm border border-[#ffffff1a] bg-[#131418] px-1.5 ${MONO} text-[11px] leading-normal text-[#a7aab2]`}
            >
              <LuPaperclip aria-hidden className="size-3 shrink-0 text-[#8b8f98]" />
              <span className="min-w-0 truncate">{file.name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentTurn({
  turn,
  mutationCards,
  threadRunning,
  onAccept,
  onReject,
  onAskToChange,
}: {
  turn: TranscriptAgentTurn;
  mutationCards: ReadonlyMap<string, WorkshopMutationCardView>;
  threadRunning: boolean;
  onAccept: (mutationId: string) => void | Promise<void>;
  onReject: (mutationId: string) => void | Promise<void>;
  onAskToChange: (summary: string) => void;
}) {
  const clock = formatClock(turn.createdAt);
  const tip = useMemo(() => {
    for (const mutation of turn.mutations) {
      const found = tipForProposal(mutationCards.get(mutation.args.mutationId)?.proposal);
      if (found) return found;
    }
    return null;
  }, [turn.mutations, mutationCards]);

  let lastTextIndex = -1;
  turn.segments.forEach((segment, index) => {
    if (segment.kind === "text" && segment.text.trim()) lastTextIndex = index;
  });

  const cards = turn.mutations.map((mutation) => {
    const card = mutationCards.get(mutation.args.mutationId);
    return { mutation, card, pending: !card || card.status === "pending" };
  });
  const renderCard = ({ mutation, card }: (typeof cards)[number]) => (
    <WorkshopDraftChangeCard
      key={mutation.toolCallId}
      summary={mutation.args.summary}
      card={card}
      threadRunning={threadRunning}
      onAccept={() => onAccept(mutation.args.mutationId)}
      onReject={() => onReject(mutation.args.mutationId)}
      onAskToChange={() => onAskToChange(mutation.args.summary || card?.proposal.summary || "")}
    />
  );

  const tipNode = tip ? (
    <div className="flex gap-2 rounded-lg border border-[#ffffff0f] bg-[#131418] px-2.5 py-2" title={tip.title}>
      <LuLightbulb aria-hidden className="mt-0.5 size-[13px] shrink-0 text-[#a7aab2]" />
      <div className="text-xs leading-normal text-[#a7aab2]">
        <span className="font-medium text-[#ecedee]">Tip: </span>
        <span>{tip.body}</span>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2.5">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-md border border-[#ffffff12] bg-[#1a1c21]">
          <LuSparkles aria-hidden className="size-[11px] text-[#a7aab2]" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium leading-normal text-[#ecedee]">Workshop Author</span>
            {clock ? (
              <span className={`${MONO} text-[11px] leading-normal text-[#8b8f98]`}>{clock}</span>
            ) : null}
          </div>
          {turn.segments.map((segment, index) => (
            <div key={index} className="flex min-w-0 flex-col gap-1.5">
              {segment.kind === "text" ? (
                segment.text.trim() ? (
                  turn.failed ? (
                    <p className="m-0 whitespace-pre-wrap text-[13px] leading-[1.55] text-[#f2645a]">
                      {segment.text}
                    </p>
                  ) : (
                    <Markdown
                      isStreaming={false}
                      density="compact"
                      contentWidth="100%"
                      className={MARKDOWN_CLASS}
                    >
                      {segment.text}
                    </Markdown>
                  )
                ) : null
              ) : (
                <div className="mt-1.5">
                  <WorkshopToolCallGroup calls={segment.calls} />
                </div>
              )}
              {index === lastTextIndex ? tipNode : null}
            </div>
          ))}
          {lastTextIndex < 0 ? tipNode : null}
          {turn.working ? (
            <div className="flex items-center gap-1.5 text-[13px] leading-[1.55] text-[#8b8f98]">
              <LuLoaderCircle aria-hidden className="size-3 animate-spin text-[#6ca6ff]" />
              Working…
            </div>
          ) : null}
          {cards.filter((entry) => !entry.pending).map(renderCard)}
        </div>
      </div>
      {cards.filter((entry) => entry.pending).map(renderCard)}
    </div>
  );
}

export function WorkshopTranscript({
  toolActivity,
  mutationCards,
  onAccept,
  onReject,
  onAskToChange,
  onStarter,
}: WorkshopTranscriptProps) {
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const turns = useMemo(
    () =>
      buildTranscript({
        messages: messages.map((message) => toTranscriptInput(message as ThreadMessageView)),
        toolActivity,
        isRunning,
      }),
    [messages, toolActivity, isRunning],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, mutationCards]);

  if (turns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <WorkshopEmptyThread onStarter={onStarter} />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex w-full min-w-0 flex-col gap-3 px-4 py-3.5">
        {turns.map((turn) =>
          turn.kind === "user" ? (
            <UserTurn key={turn.key} turn={turn} />
          ) : turn.kind === "agent" ? (
            <AgentTurn
              key={turn.key}
              turn={turn}
              mutationCards={mutationCards}
              threadRunning={isRunning}
              onAccept={onAccept}
              onReject={onReject}
              onAskToChange={onAskToChange}
            />
          ) : (
            <div key={turn.key} className="text-center text-[11px] leading-normal text-[#8b8f98]">
              {turn.text}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
