import type { Ref } from "react";
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react";
import type {
  DraftPackagePayload,
  ValidationFinding,
  WorkshopSessionSummary,
} from "../../api";
import type { StudioPickerRow } from "../../pages/workshopStudio";
import type { WorkshopToolActivityRow } from "../../workshop/workshopChatView";
import type { WorkshopChatAttachment } from "./chat/attachments";
import {
  WorkshopChatColumn,
  type WorkshopChatColumnProps,
} from "./chat/WorkshopChatColumn";
import type { WorkshopComposerHandle } from "./chat/WorkshopComposer";
import type { WorkshopMutationCardView } from "./chat/WorkshopDraftChangeCard";
import { DiskChangeBanner } from "./DiskChangeBanner";
import {
  WorkshopDrawer,
  type WorkshopDrawerProps,
} from "./drawer/WorkshopDrawer";
import { WorkshopGraph } from "./graph/WorkshopGraph";
import { WorkshopInspectorPanel } from "./inspector/WorkshopInspectorPanel";
import { ResumeAutosaveBanner } from "./ResumeAutosaveBanner";
import {
  SaveToCatalogDialogV2,
  type SaveToCatalogDialogV2Props,
} from "./save/SaveToCatalogDialogV2";
import { SaveToast, type SaveToastProps } from "./save/SaveToast";
import {
  WorkshopToolbarV2,
  type WorkshopToolbarV2Props,
} from "./WorkshopToolbarV2";
import {
  WORKSHOP_CHAT_MAX_WIDTH,
  WORKSHOP_CHAT_MIN_WIDTH,
  clampWorkshopChatWidth,
} from "./workshopPageModel";

const CHAT_ARROW_STEP = 32;

export type WorkshopRedesignViewProps = {
  chatWidth: number;
  onChatWidthChange: (width: number) => void;
  seedMessages: ThreadMessageLike[];
  adapter: ChatModelAdapter;
  toolActivity: readonly WorkshopToolActivityRow[];
  onStop: () => void;
  threadKey: string;
  ready: boolean;
  bootError: string | null;
  sessionTitle: string | null;
  chatCards: ReadonlyMap<string, WorkshopMutationCardView>;
  onAccept: WorkshopChatColumnProps["onAccept"];
  onReject: WorkshopChatColumnProps["onReject"];
  sessions: readonly WorkshopSessionSummary[];
  activeSessionId: string | null;
  historyLoading: boolean;
  historyError: string | null;
  onHistoryOpen: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  pickerRows: readonly StudioPickerRow[];
  selectedBuildId: string | null;
  onPickRow: (row: StudioPickerRow) => void;
  models: string[];
  model: string | null;
  defaultModel: string | null;
  onModelChange: (model: string) => void;
  hasTask: boolean;
  attachments: readonly WorkshopChatAttachment[];
  onAttachmentsChange: (next: WorkshopChatAttachment[]) => void;
  docsContext: boolean;
  onDocsContextChange: (next: boolean) => void;
  composerHandle: Ref<WorkshopComposerHandle>;
  onStarter: WorkshopChatColumnProps["onStarter"];
  toolbar: WorkshopToolbarV2Props;
  resumeBanner: {
    updatedAt: string;
    pipelineId?: string | null;
    onResume: () => void;
    onDiscard: () => void;
    onDismiss: () => void;
  } | null;
  diskBanner: {
    changedPaths: string[];
    onReload: () => void;
    onKeep: () => void;
    onDismiss?: () => void;
  } | null;
  studioError: string | null;
  draft: DraftPackagePayload;
  baseline: DraftPackagePayload | null;
  selectedStageId: string | null;
  graphFindings: ValidationFinding[];
  onSelectStage: (id: string | null) => void;
  onAddStage: () => void;
  drawer: WorkshopDrawerProps;
  inspector: {
    tab: "stage" | "pipeline";
    onTabChange: (tab: "stage" | "pipeline") => void;
    onDraftChange: (draft: DraftPackagePayload) => void;
    onDeleteStage: (stageId: string) => void;
    onRenameStage: (fromId: string, toId: string) => void;
    focusField: { stageId: string; field: string; nonce: number } | null;
    pipelinePath?: string | null;
  };
  saveDialog: SaveToCatalogDialogV2Props;
  toast: Omit<SaveToastProps, "autoDismissMs"> | null;
};

export function WorkshopRedesignView({
  chatWidth,
  onChatWidthChange,
  seedMessages,
  adapter,
  toolActivity,
  onStop,
  threadKey,
  ready,
  bootError,
  sessionTitle,
  chatCards,
  onAccept,
  onReject,
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
  models,
  model,
  defaultModel,
  onModelChange,
  hasTask,
  attachments,
  onAttachmentsChange,
  docsContext,
  onDocsContextChange,
  composerHandle,
  onStarter,
  toolbar,
  resumeBanner,
  diskBanner,
  studioError,
  draft,
  baseline,
  selectedStageId,
  graphFindings,
  onSelectStage,
  onAddStage,
  drawer,
  inspector,
  saveDialog,
  toast,
}: WorkshopRedesignViewProps) {
  const resizeChat = (next: number) => onChatWidthChange(clampWorkshopChatWidth(next));

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-[#0c0d0f]">
      <section
        className="flex h-full min-h-0 shrink-0 flex-col"
        style={{ width: chatWidth }}
        aria-label="Workshop chat"
      >
        <WorkshopChatColumn
          seedMessages={seedMessages}
          adapter={adapter}
          toolActivity={toolActivity}
          onStop={onStop}
          threadKey={threadKey}
          ready={ready}
          bootError={bootError}
          sessionTitle={sessionTitle}
          mutationCards={chatCards}
          onAccept={onAccept}
          onReject={onReject}
          sessions={sessions}
          activeSessionId={activeSessionId}
          historyLoading={historyLoading}
          historyError={historyError}
          onHistoryOpen={onHistoryOpen}
          onOpenSession={onOpenSession}
          onNewSession={onNewSession}
          pickerRows={pickerRows}
          selectedBuildId={selectedBuildId}
          onPickRow={onPickRow}
          models={models}
          model={model}
          defaultModel={defaultModel}
          onModelChange={onModelChange}
          hasTask={hasTask}
          attachments={attachments}
          onAttachmentsChange={onAttachmentsChange}
          docsContext={docsContext}
          onDocsContextChange={onDocsContextChange}
          composerHandle={composerHandle}
          onStarter={onStarter}
        />
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat"
        aria-valuemin={WORKSHOP_CHAT_MIN_WIDTH}
        aria-valuemax={WORKSHOP_CHAT_MAX_WIDTH}
        aria-valuenow={Math.round(chatWidth)}
        tabIndex={0}
        className="w-1.5 shrink-0 cursor-col-resize bg-[#ffffff12]"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const handle = event.currentTarget;
          handle.setPointerCapture(event.pointerId);
          const originX = event.clientX;
          const originW = chatWidth;
          const move = (ev: PointerEvent) => {
            if (ev.pointerId !== event.pointerId) return;
            resizeChat(originW + (ev.clientX - originX));
          };
          const up = (ev: PointerEvent) => {
            if (ev.pointerId !== event.pointerId) return;
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", up);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            resizeChat(chatWidth - CHAT_ARROW_STEP);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            resizeChat(chatWidth + CHAT_ARROW_STEP);
          } else if (event.key === "Home") {
            event.preventDefault();
            resizeChat(WORKSHOP_CHAT_MIN_WIDTH);
          } else if (event.key === "End") {
            event.preventDefault();
            resizeChat(WORKSHOP_CHAT_MAX_WIDTH);
          }
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkshopToolbarV2 {...toolbar} />
        {diskBanner ? (
          <DiskChangeBanner
            changedPaths={diskBanner.changedPaths}
            onReload={diskBanner.onReload}
            onKeep={diskBanner.onKeep}
            onDismiss={diskBanner.onDismiss}
          />
        ) : resumeBanner ? (
          <ResumeAutosaveBanner
            updatedAt={resumeBanner.updatedAt}
            pipelineId={resumeBanner.pipelineId}
            onResume={resumeBanner.onResume}
            onDiscard={resumeBanner.onDiscard}
            onDismiss={resumeBanner.onDismiss}
          />
        ) : null}
        {studioError ? (
          <p className="border-b border-b-[#ffffff12] px-4 py-1.5 text-xs text-[#f2645a]">
            {studioError}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WorkshopGraph
              draft={draft}
              baseline={baseline}
              selectedStageId={selectedStageId}
              findings={graphFindings}
              onSelectStage={onSelectStage}
              onAddStage={onAddStage}
              defaultModel={defaultModel}
            />
            <WorkshopDrawer {...drawer} />
          </div>
          <WorkshopInspectorPanel
            draft={draft}
            baseline={baseline}
            selectedStageId={selectedStageId}
            tab={inspector.tab}
            onTabChange={inspector.onTabChange}
            onDraftChange={inspector.onDraftChange}
            onDeleteStage={inspector.onDeleteStage}
            onRenameStage={inspector.onRenameStage}
            findings={graphFindings}
            models={models}
            defaultModel={defaultModel}
            focusField={inspector.focusField}
            pipelinePath={inspector.pipelinePath}
          />
        </div>
      </div>
      <SaveToCatalogDialogV2 {...saveDialog} />
      {toast ? <SaveToast {...toast} /> : null}
    </div>
  );
}
