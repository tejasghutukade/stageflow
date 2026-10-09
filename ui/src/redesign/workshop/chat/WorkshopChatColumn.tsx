import {
  AssistantRuntimeProvider,
  useAuiState,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import type { WorkshopSessionSummary } from "../../../api";
import type { StudioPickerRow } from "../../../pages/workshopStudio";
import type { WorkshopToolActivityRow } from "../../../workshop/workshopChatView";
import type { WorkshopChatAttachment } from "./attachments";
import { askToChangePrefill } from "./changeCardModel";
import { WorkshopChatHeader } from "./WorkshopChatHeader";
import { WorkshopComposer, type WorkshopComposerHandle } from "./WorkshopComposer";
import type { WorkshopMutationCardView } from "./WorkshopDraftChangeCard";
import type { WorkshopStarterKind } from "./WorkshopEmptyThread";
import { WorkshopHistoryPopover } from "./WorkshopHistoryPopover";
import { WorkshopTranscript } from "./WorkshopTranscript";

export type WorkshopChatColumnProps = {
  seedMessages: ThreadMessageLike[];
  adapter: ChatModelAdapter;
  toolActivity?: readonly WorkshopToolActivityRow[];
  onStop?: () => void;
  threadKey?: string;
  ready?: boolean;
  bootError?: string | null;
  sessionTitle: string | null;
  mutationCards: ReadonlyMap<string, WorkshopMutationCardView>;
  onAccept: (mutationId: string) => void | Promise<void>;
  onReject: (mutationId: string) => void | Promise<void>;
  sessions: readonly WorkshopSessionSummary[];
  activeSessionId?: string | null;
  historyLoading?: boolean;
  historyError?: string | null;
  onHistoryOpen?: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  pickerRows: readonly StudioPickerRow[];
  selectedBuildId?: string | null;
  onPickRow: (row: StudioPickerRow) => void;
  models: readonly string[];
  model: string | null;
  defaultModel: string | null;
  onModelChange: (model: string) => void;
  hasTask: boolean;
  attachments: readonly WorkshopChatAttachment[];
  onAttachmentsChange: (next: WorkshopChatAttachment[]) => void;
  docsContext: boolean;
  onDocsContextChange: (next: boolean) => void;
  composerHandle?: Ref<WorkshopComposerHandle>;
  onStarter: (kind: WorkshopStarterKind) => void;
  className?: string;
};

type ThreadBodyProps = Omit<
  WorkshopChatColumnProps,
  | "seedMessages"
  | "adapter"
  | "threadKey"
  | "ready"
  | "bootError"
  | "sessionTitle"
  | "sessions"
  | "activeSessionId"
  | "historyLoading"
  | "historyError"
  | "onHistoryOpen"
  | "onOpenSession"
  | "onNewSession"
  | "pickerRows"
  | "selectedBuildId"
  | "onPickRow"
  | "composerHandle"
  | "className"
> & { innerComposer: RefObject<WorkshopComposerHandle | null> };

function ThreadBody({
  toolActivity,
  onStop,
  mutationCards,
  onAccept,
  onReject,
  models,
  model,
  defaultModel,
  onModelChange,
  hasTask,
  attachments,
  onAttachmentsChange,
  docsContext,
  onDocsContextChange,
  onStarter,
  innerComposer,
}: ThreadBodyProps) {
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  return (
    <>
      <WorkshopTranscript
        toolActivity={toolActivity}
        mutationCards={mutationCards}
        onAccept={onAccept}
        onReject={onReject}
        onAskToChange={(summary) => innerComposer.current?.prefill(askToChangePrefill(summary))}
        onStarter={onStarter}
      />
      <WorkshopComposer
        handleRef={innerComposer}
        emptyThread={isEmpty}
        models={models}
        model={model}
        defaultModel={defaultModel}
        onModelChange={onModelChange}
        hasTask={hasTask}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        docsContext={docsContext}
        onDocsContextChange={onDocsContextChange}
        onStop={onStop}
      />
    </>
  );
}

function ThreadRuntime({
  seedMessages,
  adapter,
  ...rest
}: ThreadBodyProps & { seedMessages: ThreadMessageLike[]; adapter: ChatModelAdapter }) {
  const runtime = useLocalRuntime(adapter, { initialMessages: seedMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadBody {...rest} />
    </AssistantRuntimeProvider>
  );
}

export function WorkshopChatColumn({
  seedMessages,
  adapter,
  threadKey,
  ready = true,
  bootError,
  sessionTitle,
  sessions,
  activeSessionId,
  historyLoading,
  historyError,
  onHistoryOpen,
  onOpenSession,
  onNewSession,
  pickerRows,
  selectedBuildId,
  onPickRow,
  composerHandle,
  onStarter,
  className,
  ...threadProps
}: WorkshopChatColumnProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const innerComposer = useRef<WorkshopComposerHandle | null>(null);

  useImperativeHandle(
    composerHandle,
    () => ({
      prefill: (text: string) => innerComposer.current?.prefill(text),
      focus: () => innerComposer.current?.focus(),
      send: (text: string) => innerComposer.current?.send(text),
    }),
    [],
  );

  useEffect(() => {
    if (!historyOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (historyRef.current?.contains(target)) return;
      if (target?.closest?.("[data-workshop-history-toggle]")) return;
      setHistoryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [historyOpen]);

  const openHistory = () => {
    setHistoryOpen(true);
    onHistoryOpen?.();
  };

  const handleStarter = (kind: WorkshopStarterKind) => {
    if (kind === "open") openHistory();
    if (kind === "describe") innerComposer.current?.focus();
    onStarter(kind);
  };

  return (
    <div
      className={`relative flex h-full min-h-0 w-full min-w-0 flex-col bg-[#0c0d0f] ${className ?? ""}`}
    >
      <WorkshopChatHeader
        sessionTitle={sessionTitle}
        historyOpen={historyOpen}
        onToggleHistory={() => (historyOpen ? setHistoryOpen(false) : openHistory())}
        onNewSession={() => {
          setHistoryOpen(false);
          onNewSession();
        }}
      />
      {historyOpen ? (
        <div ref={historyRef}>
          <WorkshopHistoryPopover
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={historyLoading}
            error={historyError}
            pickerRows={pickerRows}
            selectedBuildId={selectedBuildId}
            onOpenSession={(id) => {
              setHistoryOpen(false);
              onOpenSession(id);
            }}
            onPickRow={(row) => {
              setHistoryOpen(false);
              onPickRow(row);
            }}
          />
        </div>
      ) : null}
      {bootError ? (
        <div role="alert" className="border-b border-b-[#ffffff12] px-4 py-2 text-xs leading-[1.45] text-[#f2645a]">
          {bootError}
        </div>
      ) : null}
      {ready ? (
        <ThreadRuntime
          key={threadKey}
          seedMessages={seedMessages}
          adapter={adapter}
          onStarter={handleStarter}
          innerComposer={innerComposer}
          {...threadProps}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-[#8b8f98]">
          Starting session…
        </div>
      )}
    </div>
  );
}
