import {
  useAuiState,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  acceptWorkshopSessionMutation,
  attachTaskArtifact,
  clearWorkshopAutosave,
  createDraftPackageWithDetails,
  createWorkshopSession,
  fetchModels,
  fetchPipelines,
  fetchSettings,
  fetchTasks,
  focusWorkshopBuild,
  getWorkshopAutosave,
  getWorkshopBuild,
  getWorkshopSession,
  listWorkshopPicker,
  listWorkshopSessions,
  openDraftPackage,
  overwriteDraftPackageWithDetails,
  planDraftPackage,
  putWorkshopAutosave,
  sendWorkshopChatTurnStreaming,
  stopWorkshopChat,
  undoWorkshopSessionMutation,
  updateWorkshopSessionActiveBuild,
  validateDraftPackage,
  checkWorkshopDiskChange,
  type DraftPackagePayload,
  type DraftPlanResult,
  type DraftValidationResult,
  type ValidationFinding,
  type WorkshopAutosavePayload,
  type PipelineTrackProjection,
  type StageSnapshot,
  type WorkshopChatProposalPayload,
  type WorkshopSessionSummary,
} from "../api";
import { SpatialRunMap } from "../components/SpatialRunMap";
import { layoutSpatialTrack } from "../track/layoutPipelineTrack";
import type { SpatialNodeChrome } from "../workspace/resolveRunWorkspace";
import {
  WorkshopChatIsland,
  type WorkshopMutationCardProps,
} from "../workshop/WorkshopChatIsland";
import {
  CHAT_FAILED_PREFIX,
  type WorkshopToolActivityRow,
} from "../workshop/workshopChatView";
import {
  buildDraftMutationToolParts,
  mutationCardActionsLocked,
} from "../workshop/draftMutationTools";
import {
  applyPointerChange,
  chooseStudioRow,
  draftFrameApplies,
  historyBuildName,
  mutationMapAfterChange,
  openSessionStudio,
  pickerRowLabel,
  pickerRowValue,
  rowsAfterPickerLoad,
  startNewChatStudio,
  type StudioPickerRow,
  type StudioSelection,
} from "./workshopStudio";
import { cloneDraft } from "../redesign/editor/draftMutators";
import { useRedesign } from "../redesign/flag";
import { useHotkeys } from "../redesign/keys";
import type { WorkshopChatAttachment } from "../redesign/workshop/chat/attachments";
import type { WorkshopComposerHandle } from "../redesign/workshop/chat/WorkshopComposer";
import type { WorkshopMutationCardView } from "../redesign/workshop/chat/WorkshopDraftChangeCard";
import { workshopSeedMessages } from "../redesign/workshop/chat/transcriptModel";
import { findingLocation, type WorkshopDrawerTab, type WorkshopTaskOption } from "../redesign/workshop/drawer/drawerModel";
import {
  isUntitledPipelineId,
  locateFindingField,
  setPipelineId,
} from "../redesign/workshop/inspector/stageFields";
import type { SaveDestination } from "../redesign/workshop/save/SaveToCatalogDialogV2";
import { WorkshopChangeCard } from "../redesign/workshop/WorkshopChangeCard";
import { WorkshopRedesignView } from "../redesign/workshop/WorkshopRedesignView";
import { addStage, deleteStage, renameStage } from "../redesign/workshop/stageMutators";
import { workshopAutosaveKey } from "../redesign/workshop/workshopAutosaveKey";
import {
  AUTOSAVE_DEBOUNCE_MS,
  CREATE_TASK_PREFILL,
  WORKSHOP_CHAT_DEFAULT_WIDTH,
  askAgentToFixPrompt,
  attachmentChipsFromAutosave,
  autosaveArtifactsForAttachments,
  catalogRoots,
  clampWorkshopChatWidth,
  escapeWorkshopAction,
  initialDrawerTab,
  latestPendingMutationId,
  mutationCardOnRegister,
  openDraftInput,
  pipelineFilenameFor,
  planDraftInput,
  projectRootField,
  saveAsIntent,
  saveIntent,
  savedFileCount,
  seedTranscriptFromAutosave,
  workshopBootTarget,
  workshopChangeCount,
  workshopSaveState,
  type CatalogRoot,
} from "../redesign/workshop/workshopPageModel";
import { navigate, newRunPath, pipelinePath } from "../routes";

const CHAT_DEFAULT_W = 420;
const CHAT_MIN_W = 280;
const MAP_MIN_W = 320;
const CHAT_ARROW_STEP = 32;

type MutationCardStatus = "pending" | "accepted" | "rejected" | "conflict";

type MutationCardState = {
  proposal: WorkshopChatProposalPayload;
  status: MutationCardStatus;
  notice?: string;
  auto?: boolean;
  at?: number;
};

type DraftStage = {
  stageId: string;
  title: string;
  promptSummary: string;
  ioSummary: string;
  verifySummary: string;
  hitlFlags: string[];
  mutationStatus: MutationCardStatus | "applied";
};

type MutationApi = {
  getCard: (mutationId: string) => MutationCardState | undefined;
  accept: (mutationId: string) => Promise<void>;
  reject: (mutationId: string) => Promise<void>;
};

export type LiveChatRefs = {
  sessionId: MutableRefObject<string | null>;
  draft: MutableRefObject<DraftPackagePayload>;
  model: MutableRefObject<string>;
  selectedBuildId: MutableRefObject<string | null>;
  setDraft: (draft: DraftPackagePayload) => void;
  onPointerChange?: (frame: {
    buildId: string;
    draft: DraftPackagePayload;
  }) => void;
  registerMutations: (proposals: WorkshopChatProposalPayload[]) => void;
  pushActivity: (update: WorkshopToolActivityRow) => void;
  clearActivity: () => void;
  /** Set for the duration of a turn. Composer stop calls this. */
  stop: MutableRefObject<(() => void) | null>;
  attachments?: MutableRefObject<
    Array<{ name: string; mediaType: string; size: number; content: string }>
  >;
  docsContext?: MutableRefObject<boolean>;
  autoApply?: MutableRefObject<boolean>;
};

export type { WorkshopToolActivityRow };

const EMPTY_DRAFT: DraftPackagePayload = {
  pipeline: { id: "untitled", stages: [] },
};

const GREETING =
  "What are we building? Tell me the workflow in your own words — I’ll ask where it changes the draft.";

const EMPTY_PROJECTION: PipelineTrackProjection = { nodes: [], edges: [] };

const WorkshopMutationContext = createContext<MutationApi | null>(null);

function useWorkshopMutation(): MutationApi {
  const ctx = useContext(WorkshopMutationContext);
  if (!ctx) {
    throw new Error("WorkshopMutationContext missing");
  }
  return ctx;
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function emptySeedMessages(): ThreadMessageLike[] {
  return [];
}

function transcriptToSeedMessages(
  transcript: Array<{ role: string; text: string }>,
): ThreadMessageLike[] {
  if (transcript.length === 0) return [];
  return transcript.map((msg) => ({
    role:
      msg.role === "user" || msg.role === "system" || msg.role === "assistant"
        ? msg.role
        : "assistant",
    content: msg.text,
  }));
}

function stageBodyFor(
  draft: DraftPackagePayload,
  stageId: string,
): Record<string, unknown> | null {
  const art = (draft.stages ?? []).find((s) => {
    if (typeof s.body.id === "string" && s.body.id === stageId) return true;
    const pathId = s.path.replace(/^\.\//, "").replace(/\.ya?ml$/, "");
    return pathId === stageId;
  });
  return art?.body ?? null;
}

function summarizeIo(body: Record<string, unknown> | null): string {
  if (!body || body.io == null) return "IO not set yet";
  try {
    return JSON.stringify(body.io);
  } catch {
    return "IO present";
  }
}

function summarizeVerify(body: Record<string, unknown> | null): string {
  if (!body) return "Verify not set yet";
  if (body.verify != null) {
    try {
      return JSON.stringify(body.verify);
    } catch {
      return "Verify present";
    }
  }
  return "Verify not set yet";
}

function hitlFlagsFromBody(body: Record<string, unknown> | null): string[] {
  if (!body) return [];
  const flags: string[] = [];
  if (body.ask_operator === true || body.hitl === true) flags.push("confirm");
  if (Array.isArray(body.gates)) {
    for (const gate of body.gates) {
      if (typeof gate === "string") flags.push(gate);
    }
  }
  return flags;
}

function draftStagesFromPackage(
  draft: DraftPackagePayload,
  mutationCards: Map<string, MutationCardState>,
): DraftStage[] {
  const pendingByStage = new Map<string, MutationCardStatus>();
  for (const card of mutationCards.values()) {
    if (card.status !== "pending") continue;
    for (const stageId of card.proposal.affectedStageIds) {
      pendingByStage.set(stageId, "pending");
    }
  }

  return draft.pipeline.stages.map((stage, index) => {
    const stageId =
      typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`;
    const body = stageBodyFor(draft, stageId);
    const prompt =
      typeof body?.system_prompt === "string"
        ? body.system_prompt
        : typeof body?.systemPrompt === "string"
          ? body.systemPrompt
          : `Stage ${stageId}`;
    return {
      stageId,
      title: titleCase(stageId),
      promptSummary: prompt,
      ioSummary: summarizeIo(body),
      verifySummary: summarizeVerify(body),
      hitlFlags: hitlFlagsFromBody(body),
      mutationStatus: pendingByStage.get(stageId) ?? "applied",
    };
  });
}

function toProjection(stages: DraftStage[]): PipelineTrackProjection {
  return {
    nodes: stages.map((stage, index) => {
      const pending = stage.mutationStatus === "pending";
      return {
        stage_id: stage.stageId,
        status: pending ? "waiting_for_input" : "succeeded",
        readiness: pending ? "waiting" : "succeeded",
        layer: index,
        layer_order: 0,
        attempt_count: pending ? 0 : 1,
        gate_kinds: pending ? (["confirm"] as const) : undefined,
        blocked_by: index > 0 ? [stages[index - 1]!.stageId] : undefined,
      };
    }),
    edges: stages.slice(1).map((stage, index) => ({
      from: stages[index]!.stageId,
      to: stage.stageId,
    })),
  };
}

function toSnapshots(stages: DraftStage[]): StageSnapshot[] {
  return stages.map((stage) => {
    const pending = stage.mutationStatus === "pending";
    return {
      stage_id: stage.stageId,
      status: pending ? "waiting_for_input" : "succeeded",
      events: [],
      envelope: null,
      artifacts: [],
      attempt_count: pending ? 0 : 1,
    };
  });
}

function toChrome(stages: DraftStage[]): SpatialNodeChrome[] {
  return stages.map((stage) => {
    const pending = stage.mutationStatus === "pending";
    return {
      stageId: stage.stageId,
      title: stage.title,
      kicker: pending ? "mutation · pending" : "stage · draft",
      status: pending ? "waiting_for_input" : "succeeded",
      attemptCount: pending ? undefined : 1,
      readinessLine: pending ? "Awaiting Accept / Reject" : undefined,
      gateKinds: pending ? ["confirm"] : undefined,
      titleOnly: true,
      isWaitingAttention: pending,
      isSuperseded: false,
    };
  });
}

function extractUserText(messages: ChatModelRunOptions["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
  }
  return "";
}

function assistantTextFromEvents(
  events: Array<{ type: string; role?: string; text?: string; message?: string }>,
): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "message" && event.role === "assistant" && event.text) {
      parts.push(event.text);
    } else if (event.type === "error" && event.message) {
      parts.push(event.message);
    }
  }
  return parts.join("\n\n").trim();
}

export function createLiveChatModel(refs: LiveChatRefs): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const userText = extractUserText(messages);
      if (!userText) {
        yield { content: [{ type: "text", text: GREETING }] };
        return;
      }

      refs.clearActivity();

      const sessionId = refs.sessionId.current;
      if (!sessionId) {
        yield {
          content: [
            {
              type: "text",
              text: "Workshop session is still starting. Try again in a moment.",
            },
          ],
        };
        return;
      }

      let assistantText = "";
      const proposals: WorkshopChatProposalPayload[] = [];

      type QueueItem =
        | { kind: "delta" }
        | { kind: "aborted" }
        | { kind: "done"; result: Awaited<ReturnType<typeof sendWorkshopChatTurnStreaming>> };
      const queue: QueueItem[] = [];
      let wake: (() => void) | undefined;
      const enqueue = (item: QueueItem) => {
        queue.push(item);
        wake?.();
        wake = undefined;
      };
      const wait = () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        });

      const stopController = new AbortController();
      const requestStop = () => {
        if (stopController.signal.aborted) return;
        stopController.abort();
        enqueue({ kind: "aborted" });
      };
      refs.stop.current = requestStop;
      if (abortSignal?.aborted) requestStop();
      else abortSignal?.addEventListener("abort", requestStop, { once: true });

      type TurnAttachment = { name: string; mediaType: string; size: number; content: string };
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const custom = (lastUser?.metadata?.custom ?? {}) as {
        attachments?: unknown;
        context?: { docs?: unknown };
      };
      const fromMessage = Array.isArray(custom.attachments)
        ? custom.attachments.filter(
            (item): item is TurnAttachment =>
              !!item &&
              typeof item === "object" &&
              typeof (item as TurnAttachment).name === "string" &&
              typeof (item as TurnAttachment).content === "string",
          )
        : [];
      const attachments =
        fromMessage.length > 0 ? fromMessage : (refs.attachments?.current ?? []);
      const docs =
        custom.context?.docs === true || refs.docsContext?.current === true;
      const turnInput: Parameters<typeof sendWorkshopChatTurnStreaming>[0] = {
        sessionId,
        message: userText,
        draft: refs.draft.current,
        model: refs.model.current,
        autoApply: refs.autoApply?.current === true,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map(({ name, mediaType, size, content }) => ({
                name,
                mediaType,
                size,
                content,
              })),
            }
          : {}),
        ...(docs ? { context: { docs: true } } : {}),
      };

      const turnPromise = sendWorkshopChatTurnStreaming(
        turnInput,
        {
          onDelta: (text) => {
            assistantText += text;
            enqueue({ kind: "delta" });
          },
          onActivity: (update) => {
            if (refs.sessionId.current !== sessionId) return;
            if (
              update.draft !== null &&
              typeof update.draft === "object" &&
              draftFrameApplies(refs.selectedBuildId.current, update.buildId)
            ) {
              refs.setDraft(update.draft as DraftPackagePayload);
            }
            refs.pushActivity({
              id: update.id,
              name: update.name,
              status: update.status,
              ...(update.target !== undefined ? { target: update.target } : {}),
              ...(update.errorMessage !== undefined
                ? { errorMessage: update.errorMessage }
                : {}),
              textOffset: assistantText.length,
            });
          },
          onEvent: (event) => {
            if (event.type === "proposal") {
              proposals.push(event.proposal);
            }
          },
          onPointerChange: (frame) => {
            if (refs.sessionId.current !== sessionId) return;
            refs.selectedBuildId.current = frame.buildId;
            refs.setDraft(frame.draft);
            refs.onPointerChange?.(frame);
          },
          signal: stopController.signal,
        },
      ).then((result) => {
        enqueue({ kind: "done", result });
        return result;
      });

      try {
      while (true) {
        if (queue.length === 0) await wait();
        const item = queue.shift()!;
        if (item.kind === "delta") {
          yield {
            content: [{ type: "text", text: assistantText || "…" }],
          };
          continue;
        }

        if (item.kind === "aborted") {
          const stopped = await stopWorkshopChat(sessionId);
          const stopApplies =
            refs.sessionId.current === sessionId &&
            draftFrameApplies(refs.selectedBuildId.current, stopped?.buildId);
          if (stopped?.draft && stopApplies) refs.setDraft(stopped.draft);
          if (
            stopApplies &&
            stopped?.pending &&
            !proposals.some((proposal) => proposal.id === stopped.pending?.id)
          ) {
            proposals.push(stopped.pending);
          }
          if (stopApplies && proposals.length > 0) refs.registerMutations(proposals);
          yield {
            content: [
              {
                type: "text",
                text: assistantText.trim() || "Stopped.",
              },
              ...buildDraftMutationToolParts(proposals),
            ],
          };
          return;
        }

        await turnPromise;
        const result = item.result;
        if (!result.ok) {
          const stopped =
            stopController.signal.aborted || result.error === "Stopped.";
          yield {
            content: [
              {
                type: "text",
                text: stopped
                  ? assistantText.trim() || "Stopped."
                  : `${CHAT_FAILED_PREFIX} ${result.error}`,
              },
            ],
          };
          return;
        }

        const doneApplies =
          refs.sessionId.current === sessionId &&
          draftFrameApplies(refs.selectedBuildId.current, result.buildId);
        if (doneApplies) refs.setDraft(result.draft);
        const fromEvents = assistantTextFromEvents(result.events);
        const finalText =
          assistantText.trim() ||
          fromEvents ||
          (proposals.length > 0
            ? "Updated the draft. Accept or Reject the mutation cards below."
            : `No draft change. ${refs.model.current} finished without updating the studio.`);
        if (doneApplies && proposals.length > 0) {
          refs.registerMutations(proposals);
        } else if (doneApplies && result.pending) {
          refs.registerMutations([result.pending]);
          proposals.push(result.pending);
        }

        yield {
          content: [
            { type: "text", text: finalText },
            ...buildDraftMutationToolParts(proposals),
          ],
        };
        return;
      }
      } finally {
        if (refs.stop.current === requestStop) refs.stop.current = null;
        abortSignal?.removeEventListener("abort", requestStop);
      }
    },
  };
}

function MutationCardToolUI({ args }: WorkshopMutationCardProps) {
  const api = useWorkshopMutation();
  const redesignOn = useRedesign();
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const mutationId =
    typeof args?.mutationId === "string" ? args.mutationId : "";
  const card = mutationId ? api.getCard(mutationId) : undefined;
  const summary =
    typeof args?.summary === "string"
      ? args.summary
      : (card?.proposal.summary ?? "Draft mutation");
  const stageIds =
    Array.isArray(args?.affectedStageIds) && args.affectedStageIds.length > 0
      ? args.affectedStageIds
      : (card?.proposal.affectedStageIds ?? []);
  const status = card?.status ?? "pending";
  const [busy, setBusy] = useState(false);
  const locked = mutationCardActionsLocked(threadRunning, busy);

  const decide = async (next: "accepted" | "rejected") => {
    if (!mutationId || locked || status !== "pending") return;
    setBusy(true);
    try {
      if (next === "accepted") await api.accept(mutationId);
      else await api.reject(mutationId);
    } finally {
      setBusy(false);
    }
  };

  if (redesignOn) {
    return (
      <WorkshopChangeCard
        summary={summary}
        proposal={card?.proposal}
        stageIds={stageIds}
        status={status}
        notice={card?.notice}
        locked={locked}
        onAccept={() => void decide("accepted")}
        onReject={() => void decide("rejected")}
      />
    );
  }

  return (
    <div
      className="workshop-lab__proposal"
      data-status={status}
      data-tool="draft_mutation"
    >
      <div className="workshop-lab__proposal-head">
        <div className="eyebrow">Draft mutation</div>
        <strong className="workshop-lab__proposal-title">{summary}</strong>
        {stageIds.length > 0 ? (
          <span className="workshop-lab__proposal-id muted">
            {stageIds.join(", ")}
          </span>
        ) : null}
      </div>
      <p className="workshop-lab__proposal-summary">
        Applied to the studio. Accept confirms; Reject soft-undos when the draft
        is unchanged.
      </p>
      {status === "pending" ? (
        <div className="workshop-lab__proposal-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={locked}
            onClick={() => void decide("accepted")}
          >
            Accept
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={locked}
            onClick={() => void decide("rejected")}
          >
            Reject
          </button>
        </div>
      ) : (
        <p className="workshop-lab__proposal-status muted">
          {status === "accepted"
            ? "Accepted"
            : status === "rejected"
              ? "Rejected · undone"
              : (card?.notice ?? "Could not undo — ask the agent to reverse it")}
        </p>
      )}
    </div>
  );
}

function HistoryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3.5V8l3 1.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.2 4.2 2 3M3.2 4.2 4.5 3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3.5v9M3.5 8h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LabChatHeader({
  onHistory,
  onNew,
  historyOpen,
}: {
  onHistory: () => void;
  onNew: () => void;
  historyOpen: boolean;
}) {
  return (
    <header className="workshop-lab__chat-header">
      <div className="workshop-lab__chat-title">Chat</div>
      <div className="workshop-lab__chat-actions">
        <button
          type="button"
          className="workshop-lab__icon-btn"
          aria-label="Chat history"
          aria-expanded={historyOpen}
          onClick={onHistory}
        >
          <HistoryIcon />
        </button>
        <button
          type="button"
          className="workshop-lab__icon-btn"
          aria-label="New chat"
          onClick={onNew}
        >
          <NewChatIcon />
        </button>
      </div>
    </header>
  );
}

function HistoryPanel({
  sessions,
  pickerRows,
  activeSessionId,
  loading,
  error,
  onClose,
  onSelect,
}: {
  sessions: WorkshopSessionSummary[];
  pickerRows: StudioPickerRow[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <div className="workshop-lab__history" role="dialog" aria-label="Chat history">
      <div className="workshop-lab__history-head">
        <div className="eyebrow">History</div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
      {loading ? (
        <p className="muted workshop-lab__history-empty">Loading sessions…</p>
      ) : error ? (
        <p className="muted workshop-lab__history-empty">{error}</p>
      ) : sessions.length === 0 ? (
        <p className="muted workshop-lab__history-empty">No prior sessions yet.</p>
      ) : (
        <ul className="workshop-lab__history-list">
          {sessions.map((session) => {
            const title = session.title.trim() || "Untitled session";
            const when = new Date(session.updatedAt).toLocaleString();
            const buildName = historyBuildName(session.activeBuildId, pickerRows);
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className="workshop-lab__history-item"
                  data-active={session.id === activeSessionId ? "true" : "false"}
                  onClick={() => onSelect(session.id)}
                >
                  <strong>{title}</strong>
                  {buildName ? <span>{buildName}</span> : null}
                  <span className="muted">{when}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StageDetailPopup({
  stage,
  onClose,
}: {
  stage: DraftStage;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hitl =
    stage.hitlFlags.length > 0 ? stage.hitlFlags.join(", ") : "None";

  return (
    <div className="workshop-lab__popup-root">
      <button
        type="button"
        className="workshop-lab__popup-scrim"
        aria-label="Close stage details"
        onClick={onClose}
      />
      <div
        className="workshop-lab__popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workshop-stage-popup-title"
      >
        <div className="workshop-lab__popup-head">
          <h2 id="workshop-stage-popup-title" className="workshop-lab__popup-title">
            {stage.title}
          </h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <dl className="workshop-lab__popup-fields">
          <div className="workshop-lab__popup-field">
            <dt>Name</dt>
            <dd>{stage.stageId}</dd>
          </div>
          <div className="workshop-lab__popup-field">
            <dt>Title</dt>
            <dd>{stage.title}</dd>
          </div>
          <div className="workshop-lab__popup-field">
            <dt>Prompt</dt>
            <dd>{stage.promptSummary}</dd>
          </div>
          <div className="workshop-lab__popup-field">
            <dt>IO</dt>
            <dd>{stage.ioSummary}</dd>
          </div>
          <div className="workshop-lab__popup-field">
            <dt>Verify</dt>
            <dd>{stage.verifySummary}</dd>
          </div>
          <div className="workshop-lab__popup-field">
            <dt>HITL</dt>
            <dd>{hitl}</dd>
          </div>
          <div className="workshop-lab__popup-field">
            <dt>Mutation</dt>
            <dd>{stage.mutationStatus}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function MapEmptyState() {
  return (
    <div className="workshop-lab__map-empty">
      <div className="eyebrow">Studio</div>
      <p>Pipeline appears here as you build</p>
    </div>
  );
}

const WORKSHOP_FALLBACK_MODEL = "cursor/auto";

export function composerModelFromSettings(
  defaultModel: string | null | undefined,
): string {
  const trimmed = defaultModel?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : WORKSHOP_FALLBACK_MODEL;
}

function modelTail(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.endsWith(":free") ? tail.slice(0, -":free".length) : tail;
}

function shortModelLabels(ids: readonly string[]): Map<string, string> {
  const tails = ids.map(modelTail);
  const counts = new Map<string, number>();
  for (const tail of tails) counts.set(tail, (counts.get(tail) ?? 0) + 1);
  const labels = new Map<string, string>();
  ids.forEach((id, index) => {
    const tail = tails[index] ?? id;
    const provider = id.split("/")[0] ?? id;
    labels.set(id, (counts.get(tail) ?? 0) > 1 ? `${provider}/${tail}` : tail);
  });
  return labels;
}

function WorkshopModelPicker({
  model,
  models,
  settingsDefault,
  onChange,
}: {
  model: string;
  models: string[];
  settingsDefault: string | null;
  onChange: (model: string) => void;
}) {
  const options =
    models.length > 0
      ? models
      : [composerModelFromSettings(settingsDefault)];
  const ids = options.includes(model) ? options : [model, ...options];
  const shorts = shortModelLabels(ids);
  const current = shorts.get(model) ?? modelTail(model);

  return (
    <DropdownMenu
      placement="above"
      menuWidth={420}
      button={{
        label: "Workshop chat model",
        variant: "ghost",
        size: "sm",
        children: current,
      }}
    >
      <DropdownMenuRadioGroup
        label="Workshop chat model"
        value={model}
        onChange={onChange}
      >
        {ids.map((id) => (
          <DropdownMenuRadioItem
            key={id}
            value={id}
            label={id === settingsDefault ? `${id} (default)` : id}
          />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}

export function WorkshopPage({
  pipelinePath: linkedPipelinePath,
  taskPath: linkedTaskPath,
  projectRoot: linkedProjectRoot,
}: {
  pipelinePath?: string;
  taskPath?: string;
  projectRoot?: string;
} = {}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftPackagePayload>(EMPTY_DRAFT);
  const [mutationCards, setMutationCards] = useState<
    Map<string, MutationCardState>
  >(() => new Map());
  const [seedMessages, setSeedMessages] = useState<ThreadMessageLike[]>([]);
  const [threadEpoch, setThreadEpoch] = useState(0);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySessions, setHistorySessions] = useState<
    WorkshopSessionSummary[]
  >([]);
  const [pickerRows, setPickerRows] = useState<StudioPickerRow[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState(WORKSHOP_FALLBACK_MODEL);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [settingsDefault, setSettingsDefault] = useState<string | null>(null);
  const redesignOn = useRedesign();
  const [autoApply, setAutoApply] = useState(false);
  const [draftValidation, setDraftValidation] =
    useState<DraftValidationResult | null>(null);
  const [validateBusy, setValidateBusy] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [autosaveOffer, setAutosaveOffer] = useState<WorkshopAutosavePayload | null>(
    null,
  );
  const [showAutosaveBanner, setShowAutosaveBanner] = useState(false);
  const [diskChangedPaths, setDiskChangedPaths] = useState<string[]>([]);
  const [showDiskBanner, setShowDiskBanner] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"stage" | "pipeline">("stage");
  const [saveDestination, setSaveDestination] = useState<{
    directory: string;
    pipelineFilename?: string;
  } | null>(null);
  const [savedPipelinePath, setSavedPipelinePath] = useState<string | null>(null);
  const [savedTaskPath, setSavedTaskPath] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<DraftPackagePayload | null>(null);
  const [attachments, setAttachments] = useState<WorkshopChatAttachment[]>([]);
  const [docsContext, setDocsContext] = useState(false);
  const [activeProjectRoot, setActiveProjectRoot] = useState<string | undefined>(
    linkedProjectRoot,
  );
  const [validatedAt, setValidatedAt] = useState<number | null>(null);
  const [autosavedAt, setAutosavedAt] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<WorkshopDrawerTab>(() =>
    initialDrawerTab(EMPTY_DRAFT),
  );
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [focusField, setFocusField] = useState<{
    stageId: string;
    field: string;
    nonce: number;
  } | null>(null);
  const [taskOptions, setTaskOptions] = useState<WorkshopTaskOption[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [catalogRootOptions, setCatalogRootOptions] = useState<CatalogRoot[]>([
    { value: ".", label: "." },
  ]);
  const [saveMode, setSaveMode] = useState<"create" | "overwrite">("create");
  const [allowInvalidInitial, setAllowInvalidInitial] = useState(false);
  const [savePlan, setSavePlan] = useState<DraftPlanResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveToast, setSaveToast] = useState<{
    pipelineId: string;
    fileCount: number;
    canRun: boolean;
    pipelinePath: string;
    taskPath?: string;
    projectRoot?: string;
  } | null>(null);
  const [redesignChatWidth, setRedesignChatWidth] = useState(WORKSHOP_CHAT_DEFAULT_WIDTH);
  const diskFingerprintsRef = useRef<Record<string, string>>({});
  const attachmentsRef = useRef<WorkshopChatAttachment[]>([]);
  const docsContextRef = useRef(false);
  const autoApplyRef = useRef(false);
  const projectRootRef = useRef<string | undefined>(linkedProjectRoot);
  const acceptMutationRef = useRef<(mutationId: string) => Promise<void>>(
    async () => {},
  );
  const composerHandle = useRef<WorkshopComposerHandle>(null);
  const focusNonceRef = useRef(0);
  const planRequestRef = useRef(0);
  const saveOpenRef = useRef(false);

  const sessionIdRef = useRef<string | null>(null);
  const draftRef = useRef<DraftPackagePayload>(EMPTY_DRAFT);
  const modelRef = useRef<string>(WORKSHOP_FALLBACK_MODEL);
  const stopChatRef = useRef<(() => void) | null>(null);
  const selectedBuildIdRef = useRef<string | null>(null);
  const cardsBuildIdRef = useRef<string | null>(null);
  const pickerRowsRef = useRef<StudioPickerRow[]>([]);
  const selectionRef = useRef<StudioSelection>(startNewChatStudio([]));
  const studioRequestRef = useRef(0);
  const onPointerChangeRef = useRef<
    (frame: { buildId: string; draft: DraftPackagePayload }) => void
  >(() => {});
  sessionIdRef.current = sessionId;
  draftRef.current = draft;
  modelRef.current = chatModel;
  attachmentsRef.current = attachments;
  docsContextRef.current = docsContext;
  autoApplyRef.current = autoApply;
  projectRootRef.current = activeProjectRoot;
  saveOpenRef.current = saveOpen;

  const applyDraft = useCallback((next: DraftPackagePayload) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const applyStudio = useCallback(
    (next: StudioSelection) => {
      selectionRef.current = next;
      pickerRowsRef.current = next.rows;
      selectedBuildIdRef.current = next.buildId;
      cardsBuildIdRef.current = next.buildId;
      setPickerRows(next.rows);
      setSelectedBuildId(next.buildId);
      setStudioError(next.error);
      applyDraft(next.draft);
    },
    [applyDraft],
  );

  const replacePickerRows = useCallback((rows: StudioPickerRow[]) => {
    pickerRowsRef.current = rows;
    selectionRef.current = { ...selectionRef.current, rows };
    setPickerRows(rows);
  }, []);

  const refreshPicker = useCallback(async () => {
    const listed = await listWorkshopPicker();
    if (!listed.ok) return;
    const selected =
      selectionRef.current.rows.find(
        (row) => row.id != null && row.id === selectedBuildIdRef.current,
      ) ?? null;
    replacePickerRows(rowsAfterPickerLoad(listed.rows, selected));
  }, [replacePickerRows]);

  const [toolActivity, setToolActivity] = useState<WorkshopToolActivityRow[]>([]);
  const pushActivity = useCallback((update: WorkshopToolActivityRow) => {
    setToolActivity((prev) => {
      const index = prev.findIndex((call) => call.id === update.id);
      if (index < 0) return [...prev, update].slice(-12);
      const next = prev.slice();
      next[index] = update;
      return next;
    });
  }, []);
  const clearActivity = useCallback(() => {
    setToolActivity([]);
  }, []);

  const registerMutations = useCallback(
    (proposals: WorkshopChatProposalPayload[]) => {
      const auto = autoApplyRef.current;
      const at = Date.now();
      setMutationCards((prev) => {
        const next = new Map(prev);
        for (const proposal of proposals) {
          const registered = mutationCardOnRegister(auto, at);
          next.set(proposal.id, { proposal, ...registered });
        }
        return next;
      });
      if (!auto) return;
      for (const proposal of proposals) {
        void acceptMutationRef.current(proposal.id);
      }
    },
    [],
  );

  const liveRefs = useMemo<LiveChatRefs>(
    () => ({
      sessionId: sessionIdRef,
      draft: draftRef,
      model: modelRef,
      selectedBuildId: selectedBuildIdRef,
      setDraft: applyDraft,
      onPointerChange: (frame) => onPointerChangeRef.current(frame),
      registerMutations,
      pushActivity,
      clearActivity,
      stop: stopChatRef,
      attachments: attachmentsRef,
      docsContext: docsContextRef,
      autoApply: autoApplyRef,
    }),
    [applyDraft, registerMutations, pushActivity, clearActivity],
  );

  const chatAdapter = useMemo(
    () => createLiveChatModel(liveRefs),
    [liveRefs],
  );

  onPointerChangeRef.current = (frame) => {
    const previous = {
      sessionId: sessionIdRef.current,
      buildId: cardsBuildIdRef.current,
    };
    const next = applyPointerChange(selectionRef.current, frame);
    applyStudio(next);
    setMutationCards((cards) =>
      mutationMapAfterChange(
        previous,
        { sessionId: sessionIdRef.current, buildId: next.buildId },
        cards,
      ),
    );
    void refreshPicker();
  };

  useEffect(() => {
    void refreshPicker();
  }, [refreshPicker]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, models] = await Promise.all([
          fetchSettings(),
          fetchModels(),
        ]);
        if (cancelled) return;
        const nextDefault = composerModelFromSettings(settings.defaultModel);
        setSettingsDefault(nextDefault);
        setAvailableModels(models.models);
        setChatModel(nextDefault);
      } catch {
        if (cancelled) return;
        setAvailableModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startNewSession = useCallback(async (opts?: { keepBootError?: boolean }) => {
    const request = ++studioRequestRef.current;
    if (!opts?.keepBootError) setBootError(null);
    setHistoryOpen(false);
    const previous = {
      sessionId: sessionIdRef.current,
      buildId: cardsBuildIdRef.current,
    };
    const created = await createWorkshopSession();
    if (studioRequestRef.current !== request) return;
    if (!created.ok) {
      setBootError(created.error);
      return;
    }
    sessionIdRef.current = created.session.id;
    const next = startNewChatStudio(pickerRowsRef.current);
    applyStudio(next);
    setSessionId(created.session.id);
    setMutationCards((cards) =>
      mutationMapAfterChange(
        previous,
        { sessionId: created.session.id, buildId: null },
        cards,
      ),
    );
    setSelectedStageId(null);
    setSeedMessages(emptySeedMessages());
    setThreadEpoch((n) => n + 1);
    setBaseline(null);
    setSavedPipelinePath(null);
    setSavedTaskPath(null);
    setSaveDestination(null);
    setAttachments([]);
    setAutosavedAt(null);
    setDrawerTab("task");
    setFocusField(null);
  }, [applyStudio]);

  const bootOpenedPackage = useCallback(
    async (path: string, task?: string, root?: string) => {
      const request = ++studioRequestRef.current;
      setBootError(null);
      setHistoryOpen(false);
      setMutationCards(new Map());
      setSelectedStageId(null);
      setBaseline(null);
      setSavedPipelinePath(null);
      setSavedTaskPath(null);
      setSaveDestination(null);
      const created = await createWorkshopSession();
      if (studioRequestRef.current !== request) return;
      if (!created.ok) {
        setBootError(created.error);
        void startNewSession({ keepBootError: true });
        return;
      }
      const opened = await openDraftPackage(openDraftInput({ path, task, projectRoot: root }));
      if (studioRequestRef.current !== request) return;
      if (!opened.ok) {
        setBootError(opened.error);
        void startNewSession({ keepBootError: true });
        return;
      }
      sessionIdRef.current = created.session.id;
      setSessionId(created.session.id);
      applyDraft(opened.draft);
      setMutationCards(new Map());
      setSelectedStageId(null);
      setSeedMessages(emptySeedMessages());
      setThreadEpoch((n) => n + 1);
      setSavedPipelinePath(opened.pipelinePath);
      setSaveDestination(opened.destination);
      setSavedTaskPath(opened.taskPath ?? null);
      setBaseline(cloneDraft(opened.draft));
      setDrawerTab(initialDrawerTab(opened.draft));
      setFocusField(null);
      setAttachments([]);
      if (root) setActiveProjectRoot(root);
    },
    [applyDraft, startNewSession],
  );

  useEffect(() => {
    if (workshopBootTarget(linkedPipelinePath) === "package" && linkedPipelinePath) {
      void bootOpenedPackage(linkedPipelinePath, linkedTaskPath, linkedProjectRoot);
      return;
    }
    void startNewSession();
  }, [
    bootOpenedPackage,
    linkedPipelinePath,
    linkedProjectRoot,
    linkedTaskPath,
    startNewSession,
  ]);

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    const [listed, picker] = await Promise.all([
      listWorkshopSessions(),
      listWorkshopPicker(),
    ]);
    setHistoryLoading(false);
    if (picker.ok) {
      const selected =
        selectionRef.current.rows.find(
          (row) => row.id != null && row.id === selectedBuildIdRef.current,
        ) ?? null;
      replacePickerRows(rowsAfterPickerLoad(picker.rows, selected));
    }
    if (!listed.ok) {
      setHistoryError(listed.error);
      setHistorySessions([]);
      return;
    }
    setHistorySessions(listed.sessions);
  }, [replacePickerRows]);

  const openSession = useCallback(
    async (id: string) => {
      const request = ++studioRequestRef.current;
      setHistoryLoading(true);
      setHistoryError(null);
      const previous = {
        sessionId: sessionIdRef.current,
        buildId: cardsBuildIdRef.current,
      };
      const got = await getWorkshopSession(id);
      if (studioRequestRef.current !== request) return;
      setHistoryLoading(false);
      if (!got.ok) {
        setHistoryError(got.error);
        return;
      }
      sessionIdRef.current = got.session.id;
      applyStudio(startNewChatStudio(pickerRowsRef.current));
      setMutationCards((cards) =>
        mutationMapAfterChange(
          previous,
          { sessionId: got.session.id, buildId: null },
          cards,
        ),
      );
      let build = null;
      let loadError: string | null = null;
      if (got.session.activeBuildId) {
        const loaded = await getWorkshopBuild(got.session.activeBuildId);
        if (studioRequestRef.current !== request) return;
        if (loaded.ok) build = loaded.build;
        else loadError = loaded.error;
      }
      const next = openSessionStudio({
        activeBuildId: got.session.activeBuildId,
        build,
        rows: pickerRowsRef.current,
        error: loadError,
      });
      const beforeBuild = cardsBuildIdRef.current;
      applyStudio(next);
      setSessionId(got.session.id);
      setMutationCards((cards) =>
        mutationMapAfterChange(
          { sessionId: got.session.id, buildId: beforeBuild },
          { sessionId: got.session.id, buildId: next.buildId },
          cards,
        ),
      );
      setSelectedStageId(null);
      setSeedMessages(
        redesignOn
          ? workshopSeedMessages(got.session.transcript)
          : transcriptToSeedMessages(got.session.transcript),
      );
      setThreadEpoch((n) => n + 1);
      setHistoryOpen(false);
      setBaseline(null);
      setSavedPipelinePath(null);
      setSavedTaskPath(null);
      setSaveDestination(null);
      setAttachments([]);
      setFocusField(null);
    },
    [applyStudio, redesignOn],
  );

  const pickStudioRow = useCallback(
    async (row: StudioPickerRow) => {
      const sessionIdAtPick = sessionIdRef.current;
      if (!sessionIdAtPick) return;
      const request = studioRequestRef.current;
      const previous = {
        sessionId: sessionIdAtPick,
        buildId: cardsBuildIdRef.current,
      };
      const result = await chooseStudioRow({
        sessionId: sessionIdAtPick,
        row,
        selection: selectionRef.current,
        focus: async (picked) => {
          if (!picked.projectRoot || !picked.relativePath) {
            return { ok: false, error: "project root and path are required" };
          }
          const focused = await focusWorkshopBuild({
            projectRoot: picked.projectRoot,
            relativePath: picked.relativePath,
          });
          if (!focused.ok) return { ok: false, error: focused.error };
          return { ok: true, build: focused.build };
        },
        updatePointer: async (sessionId, activeBuildId) => {
          const updated = await updateWorkshopSessionActiveBuild({
            sessionId,
            activeBuildId,
          });
          if (!updated.ok) return { ok: false, error: updated.error };
          return { ok: true };
        },
        loadBuild: async (buildId) => {
          const loaded = await getWorkshopBuild(buildId);
          if (!loaded.ok) return { ok: false, error: loaded.error };
          return { ok: true, build: loaded.build };
        },
      });
      if (
        studioRequestRef.current !== request ||
        sessionIdRef.current !== sessionIdAtPick
      ) {
        return;
      }
      applyStudio(result.selection);
      setMutationCards((cards) =>
        mutationMapAfterChange(
          previous,
          {
            sessionId: sessionIdAtPick,
            buildId: result.selection.buildId,
          },
          cards,
        ),
      );
      setSelectedStageId(null);
    },
    [applyStudio],
  );

  const acceptMutation = useCallback(
    async (mutationId: string) => {
      if (!sessionId) return;
      const result = await acceptWorkshopSessionMutation({
        sessionId,
        draft: draftRef.current,
        mutationId,
      });
      if (result.ok) {
        applyDraft(result.draft);
        setMutationCards((prev) => {
          const next = new Map(prev);
          const card = next.get(mutationId);
          if (card) next.set(mutationId, { ...card, status: "accepted" });
          return next;
        });
        return;
      }
      if (result.draft) applyDraft(result.draft);
      setMutationCards((prev) => {
        const next = new Map(prev);
        const card = next.get(mutationId);
        if (card) {
          next.set(mutationId, {
            ...card,
            status: "conflict",
            notice: result.notice ?? result.error,
          });
        }
        return next;
      });
    },
    [applyDraft, sessionId],
  );
  acceptMutationRef.current = acceptMutation;

  const rejectMutation = useCallback(
    async (mutationId: string) => {
      if (!sessionId) return;
      const result = await undoWorkshopSessionMutation({
        sessionId,
        draft: draftRef.current,
        mutationId,
      });
      if (result.ok) {
        applyDraft(result.draft);
        setMutationCards((prev) => {
          const next = new Map(prev);
          const card = next.get(mutationId);
          if (card) next.set(mutationId, { ...card, status: "rejected" });
          return next;
        });
        return;
      }
      if (result.draft) applyDraft(result.draft);
      setMutationCards((prev) => {
        const next = new Map(prev);
        const card = next.get(mutationId);
        if (card) {
          next.set(mutationId, {
            ...card,
            status: "conflict",
            notice: result.notice ?? result.error,
          });
        }
        return next;
      });
    },
    [applyDraft, sessionId],
  );

  const mutationApi = useMemo<MutationApi>(
    () => ({
      getCard: (id) => mutationCards.get(id),
      accept: acceptMutation,
      reject: rejectMutation,
    }),
    [acceptMutation, mutationCards, rejectMutation],
  );

  const draftStages = useMemo(
    () => draftStagesFromPackage(draft, mutationCards),
    [draft, mutationCards],
  );
  const projection = useMemo(
    () => (draftStages.length ? toProjection(draftStages) : EMPTY_PROJECTION),
    [draftStages],
  );
  const layout = useMemo(() => layoutSpatialTrack(projection), [projection]);
  const snapshots = useMemo(() => toSnapshots(draftStages), [draftStages]);
  const nodeChrome = useMemo(() => toChrome(draftStages), [draftStages]);
  const selectedStage =
    draftStages.find((s) => s.stageId === selectedStageId) ?? null;
  const pendingIds = useMemo(
    () =>
      new Set(
        draftStages
          .filter((s) => s.mutationStatus === "pending")
          .map((s) => s.stageId),
      ),
    [draftStages],
  );
  const highlightActive = Boolean(selectedStageId) || pendingIds.size > 0;

  const bodyRef = useRef<HTMLDivElement>(null);
  const splitGestureRef = useRef<{ id: number; x: number; w: number } | null>(
    null,
  );
  const [bodyWidth, setBodyWidth] = useState(0);
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT_W);
  const [splitDragging, setSplitDragging] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setBodyWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const splitMax = Math.max(CHAT_MIN_W, bodyWidth - MAP_MIN_W);
  const splitMin =
    bodyWidth > 0 && bodyWidth < CHAT_MIN_W + MAP_MIN_W
      ? Math.max(160, Math.floor(bodyWidth / 2))
      : CHAT_MIN_W;

  const applyChatWidth = useCallback(
    (requested: number) => {
      const maxByMap = bodyWidth > 0 ? bodyWidth - MAP_MIN_W : requested;
      const next = Math.max(
        splitMin,
        Math.min(requested, Math.max(splitMin, maxByMap)),
      );
      setChatWidth(next);
    },
    [bodyWidth, splitMin],
  );

  useEffect(() => {
    if (bodyWidth <= 0) return;
    const maxByMap = bodyWidth - MAP_MIN_W;
    setChatWidth((w) =>
      Math.max(splitMin, Math.min(w, Math.max(splitMin, maxByMap))),
    );
  }, [bodyWidth, splitMin]);

  const closePopup = useCallback(() => setSelectedStageId(null), []);
  const onSelectStage = useCallback((stageId: string | null) => {
    setSelectedStageId(stageId);
    if (stageId) setInspectorTab("stage");
  }, []);

  const autosaveSlotKey = workshopAutosaveKey(savedPipelinePath);

  const persistAutosave = useCallback(async () => {
    if (!redesignOn || !sessionId) return;
    const messages = seedMessages
      .filter((msg) => msg.role === "user" || msg.role === "assistant" || msg.role === "system")
      .map((msg, index) => {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        const chips = attachmentChipsFromAutosave({
          attachments: msg.metadata?.custom?.attachments,
        });
        const artifacts = autosaveArtifactsForAttachments(chips);
        return {
          id: `m-${index}`,
          role: msg.role as "user" | "assistant" | "system",
          text,
          ...(artifacts ? { artifacts } : {}),
        };
      });
    const saved = await putWorkshopAutosave({
      version: 1,
      key: autosaveSlotKey,
      updatedAt: new Date().toISOString(),
      draft: draftRef.current,
      messages,
      autoApply,
      sessionModelOverride: chatModel,
      destination: saveDestination,
      savedPath: savedPipelinePath,
      savedTaskPath,
      diskFingerprints: diskFingerprintsRef.current,
      ...projectRootField(projectRootRef.current),
    });
    if (saved.ok) setAutosavedAt(saved.autosave.updatedAt);
  }, [
    autoApply,
    autosaveSlotKey,
    chatModel,
    redesignOn,
    saveDestination,
    savedPipelinePath,
    savedTaskPath,
    seedMessages,
    sessionId,
  ]);

  useEffect(() => {
    if (!redesignOn) return;
    const timer = setTimeout(() => {
      void persistAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, seedMessages, autoApply, chatModel, persistAutosave, redesignOn]);

  useEffect(() => {
    if (!redesignOn) return;
    let cancelled = false;
    void getWorkshopAutosave({
      key: workshopAutosaveKey(linkedPipelinePath ?? null),
      ...projectRootField(linkedProjectRoot),
    }).then((got) => {
      if (cancelled || !got.ok || !got.autosave) return;
      setAutosaveOffer(got.autosave);
      setShowAutosaveBanner(true);
    });
    return () => {
      cancelled = true;
    };
  }, [linkedPipelinePath, linkedProjectRoot, redesignOn]);

  const runDraftValidate = useCallback(async () => {
    setValidateBusy(true);
    setValidateError(null);
    try {
      const result = await validateDraftPackage(
        draftRef.current,
        projectRootRef.current,
      );
      setDraftValidation(result);
      setValidatedAt(Date.now());
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidateBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!redesignOn || !savedPipelinePath) return;
    let cancelled = false;
    void checkWorkshopDiskChange({
      pipelinePath: savedPipelinePath,
      draft: draftRef.current,
      baseline: diskFingerprintsRef.current,
      ...projectRootField(projectRootRef.current),
    }).then((result) => {
      if (cancelled || !result.ok) return;
      diskFingerprintsRef.current = result.fingerprints;
      if (result.changed) {
        setDiskChangedPaths(result.changedPaths);
        setShowDiskBanner(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draft, redesignOn, savedPipelinePath]);

  const applySaveFindings = useCallback((findings: ValidationFinding[]) => {
    setDraftValidation({
      scope: "full",
      ok: false,
      summary: {
        errors: findings.filter((finding) => finding.severity === "error").length,
        warnings: findings.filter((finding) => finding.severity === "warning").length,
      },
      findings,
    });
    setValidatedAt(Date.now());
  }, []);

  const refreshPlan = useCallback(
    async (dest: SaveDestination, mode: "create" | "overwrite") => {
      const request = ++planRequestRef.current;
      setPlanLoading(true);
      const planned = await planDraftPackage(
        planDraftInput({
          destination: dest,
          draft: draftRef.current,
          mode,
          projectRoot: projectRootRef.current,
          filename: saveDestination?.pipelineFilename,
        }),
      );
      if (planRequestRef.current !== request) return;
      setPlanLoading(false);
      if (!planned.ok) {
        setSavePlan(null);
        setSaveError(planned.error);
        return;
      }
      setSavePlan({
        pipelinePath: planned.pipelinePath,
        directory: planned.directory,
        files: planned.files,
        pipelineIdTaken: planned.pipelineIdTaken,
      });
    },
    [saveDestination?.pipelineFilename],
  );

  const dialogInitialDestination = useCallback((): SaveDestination => {
    return {
      root: saveDestination?.directory || catalogRootOptions[0]?.value || ".",
      pipelineId: draftRef.current.pipeline.id,
    };
  }, [catalogRootOptions, saveDestination?.directory]);

  const openSaveDialog = useCallback(
    (
      intent: { mode: "create" | "overwrite"; allowInvalidInitial: boolean },
      error?: string,
    ) => {
      setSaveMode(intent.mode);
      setAllowInvalidInitial(intent.allowInvalidInitial);
      setSaveError(error ?? null);
      setSavePlan(null);
      setSaveOpen(true);
      void refreshPlan(dialogInitialDestination(), intent.mode);
    },
    [dialogInitialDestination, refreshPlan],
  );

  const commitSave = useCallback(
    async (
      dest: SaveDestination,
      allowInvalid: boolean,
      mode: "create" | "overwrite",
    ) => {
      setSaving(true);
      setSaveError(null);
      const previousId = draftRef.current.pipeline.id;
      const pipelineId = dest.pipelineId.trim() || previousId;
      let nextDraft = draftRef.current;
      if (pipelineId !== previousId) {
        nextDraft = setPipelineId(nextDraft, pipelineId);
        applyDraft(nextDraft);
      }
      const filename = pipelineFilenameFor(pipelineId, {
        id: previousId,
        filename: saveDestination?.pipelineFilename,
      });
      const input = {
        directory: dest.root,
        pipelineFilename: filename,
        draft: nextDraft,
        allowInvalid,
        ...projectRootField(projectRootRef.current),
      };
      const result =
        mode === "overwrite"
          ? await overwriteDraftPackageWithDetails(input)
          : await createDraftPackageWithDetails(input);
      setSaving(false);
      if (!result.ok) {
        if (result.findings) applySaveFindings(result.findings);
        setSaveError(result.error);
        if (!saveOpenRef.current) {
          setSaveMode(mode);
          setAllowInvalidInitial(allowInvalid);
          setSaveOpen(true);
        }
        return;
      }
      setSavedPipelinePath(result.pipelinePath);
      setSaveDestination({ directory: dest.root, pipelineFilename: filename });
      setBaseline(cloneDraft(nextDraft));
      if (result.taskPath) setSavedTaskPath(result.taskPath);
      setSaveOpen(false);
      await clearWorkshopAutosave({
        key: workshopAutosaveKey(result.pipelinePath),
        ...projectRootField(projectRootRef.current),
      });
      setShowAutosaveBanner(false);
      setSaveToast({
        pipelineId: result.pipeline.id,
        fileCount: savedFileCount(result),
        canRun: Boolean(nextDraft.task),
        pipelinePath: result.pipelinePath,
        ...(result.taskPath ? { taskPath: result.taskPath } : {}),
        ...(projectRootRef.current ? { projectRoot: projectRootRef.current } : {}),
      });
      void runDraftValidate();
    },
    [applyDraft, applySaveFindings, runDraftValidate, saveDestination?.pipelineFilename],
  );

  const errorCount = draftValidation?.summary.errors ?? 0;
  const hasDestination = Boolean(savedPipelinePath);

  const onToolbarSave = useCallback(() => {
    const intent = saveIntent({ hasDestination, errorCount });
    if (intent.kind === "overwrite-direct") {
      void commitSave(
        {
          root: saveDestination?.directory ?? "pipelines",
          pipelineId: draftRef.current.pipeline.id,
        },
        false,
        "overwrite",
      );
      return;
    }
    openSaveDialog(intent);
  }, [
    commitSave,
    errorCount,
    hasDestination,
    openSaveDialog,
    saveDestination?.directory,
  ]);

  const onToolbarSaveAs = useCallback(() => {
    const intent = saveAsIntent();
    if (intent.kind === "dialog") openSaveDialog(intent);
  }, [openSaveDialog]);

  const onToolbarSaveInvalid = useCallback(() => {
    const intent = saveIntent({ hasDestination, errorCount, invalid: true });
    if (intent.kind === "dialog") openSaveDialog(intent);
  }, [errorCount, hasDestination, openSaveDialog]);

  const handleAddStage = useCallback(() => {
    const result = addStage(draftRef.current);
    applyDraft(result.draft);
    setSelectedStageId(result.stageId);
    setInspectorTab("stage");
  }, [applyDraft]);

  const handleDeleteStage = useCallback(
    (stageId: string) => {
      applyDraft(deleteStage(draftRef.current, stageId));
      setSelectedStageId((current) => (current === stageId ? null : current));
    },
    [applyDraft],
  );

  const handleRenameStage = useCallback(
    (fromId: string, toId: string) => {
      applyDraft(renameStage(draftRef.current, fromId, toId));
      setSelectedStageId((current) => (current === fromId ? toId : current));
    },
    [applyDraft],
  );

  const handleRenamePipeline = useCallback(
    (id: string) => {
      applyDraft(setPipelineId(draftRef.current, id));
    },
    [applyDraft],
  );

  const goToFinding = useCallback((finding: ValidationFinding) => {
    const located = locateFindingField(finding, draftRef.current);
    if (located) {
      setSelectedStageId(located.stageId);
      setInspectorTab("stage");
      focusNonceRef.current += 1;
      setFocusField({
        stageId: located.stageId,
        field: located.field,
        nonce: focusNonceRef.current,
      });
      return;
    }
    if (finding.category === "pipeline" || finding.category === "catalog") {
      setInspectorTab("pipeline");
    }
  }, []);

  const askFix = useCallback((finding: ValidationFinding) => {
    composerHandle.current?.send(
      askAgentToFixPrompt(findingLocation(finding), finding.message),
    );
  }, []);

  const onAttachTask = useCallback(
    async (task: WorkshopTaskOption) => {
      const result = await attachTaskArtifact({
        task: task.path,
        ...projectRootField(projectRootRef.current),
      });
      if (!result.ok) {
        setStudioError(result.error);
        return;
      }
      setStudioError(null);
      applyDraft({ ...draftRef.current, task: result.task });
      setSavedTaskPath(result.taskPath);
    },
    [applyDraft],
  );

  const onDetachTask = useCallback(() => {
    const next = cloneDraft(draftRef.current);
    delete next.task;
    applyDraft(next);
    setSavedTaskPath(null);
  }, [applyDraft]);

  const onCreateTask = useCallback(() => {
    composerHandle.current?.prefill(CREATE_TASK_PREFILL);
    composerHandle.current?.focus();
  }, []);

  const onStarter = useCallback((kind: "describe" | "open" | "task") => {
    if (kind === "describe") composerHandle.current?.focus();
    if (kind === "task") {
      setDrawerTab("task");
      setDrawerCollapsed(false);
    }
  }, []);

  const validateAndShowProblems = useCallback(() => {
    setDrawerTab("problems");
    setDrawerCollapsed(false);
    void runDraftValidate();
  }, [runDraftValidate]);

  const onPickCatalogRow = useCallback(
    async (row: StudioPickerRow) => {
      if (!sessionIdRef.current) return;
      const request = studioRequestRef.current;
      await pickStudioRow(row);
      if (!row.relativePath || !row.projectRoot) return;
      if (studioRequestRef.current !== request || selectionRef.current.error) return;
      const filename =
        row.relativePath.split("/").pop() ?? `${draftRef.current.pipeline.id}.yaml`;
      const directory = row.relativePath.split("/").slice(0, -1).join("/") || ".";
      setSavedPipelinePath(row.relativePath);
      setSaveDestination({ directory, pipelineFilename: filename });
      setBaseline(cloneDraft(draftRef.current));
      setAttachments([]);
      if (row.projectRoot) setActiveProjectRoot(row.projectRoot);
    },
    [pickStudioRow],
  );

  const dismissBanner = useCallback(() => {
    if (showDiskBanner) {
      setShowDiskBanner(false);
      return;
    }
    setShowAutosaveBanner(false);
  }, [showDiskBanner]);

  useEffect(() => {
    if (linkedProjectRoot) setActiveProjectRoot(linkedProjectRoot);
  }, [linkedProjectRoot]);

  useEffect(() => {
    if (!redesignOn) return;
    let cancelled = false;
    setTasksLoading(true);
    void fetchTasks()
      .then((res) => {
        if (cancelled) return;
        setTaskOptions(res.tasks.map((task) => ({ id: task.id, path: task.path })));
      })
      .catch(() => {
        if (!cancelled) setTaskOptions([]);
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [redesignOn]);

  useEffect(() => {
    if (!redesignOn) return;
    let cancelled = false;
    void fetchPipelines()
      .then((res) => {
        if (!cancelled) setCatalogRootOptions(catalogRoots(res.pipelines));
      })
      .catch(() => {
        if (!cancelled) setCatalogRootOptions([{ value: ".", label: "." }]);
      });
    return () => {
      cancelled = true;
    };
  }, [redesignOn]);

  const changeCount = workshopChangeCount(draft, baseline);
  const saveState = workshopSaveState(savedPipelinePath, changeCount);
  const graphFindings = draftValidation?.findings ?? [];
  const drawerFindings = draftValidation ? draftValidation.findings : null;
  const sessionTitle =
    historySessions.find((session) => session.id === sessionId)?.title ?? null;
  const chatCards = useMemo(() => {
    const map = new Map<string, WorkshopMutationCardView>();
    for (const [id, card] of mutationCards) {
      map.set(id, {
        proposal: card.proposal,
        status: card.status,
        ...(card.notice ? { notice: card.notice } : {}),
        autoApplied: card.auto,
      });
    }
    return map;
  }, [mutationCards]);
  const bannerVisible = showDiskBanner || showAutosaveBanner;

  useHotkeys(
    redesignOn
      ? [
          {
            key: "v",
            scope: "workshop",
            when: () => !saveOpen,
            handler: (event) => {
              event.preventDefault();
              validateAndShowProblems();
            },
          },
          {
            key: "a",
            scope: "workshop",
            when: () => !saveOpen,
            handler: (event) => {
              event.preventDefault();
              handleAddStage();
            },
          },
          {
            key: "mod+s",
            scope: "workshop",
            when: () => !saveOpen,
            handler: (event) => {
              event.preventDefault();
              onToolbarSave();
            },
          },
          {
            key: "enter",
            scope: "workshop",
            when: () => !saveOpen,
            handler: (event) => {
              const id = latestPendingMutationId(mutationCards);
              if (!id) return;
              event.preventDefault();
              void acceptMutation(id);
            },
          },
          {
            key: "escape",
            scope: "workshop",
            handler: (event) => {
              const action = escapeWorkshopAction({
                bannerVisible,
                selectedStageId,
              });
              if (action === "none") return;
              event.preventDefault();
              if (action === "dismiss-banner") dismissBanner();
              else setSelectedStageId(null);
            },
          },
        ]
      : [],
    "workshop",
  );

  if (redesignOn) {
    return (
      <WorkshopRedesignView
        chatWidth={redesignChatWidth}
        onChatWidthChange={(width) => setRedesignChatWidth(clampWorkshopChatWidth(width))}
        seedMessages={seedMessages}
        adapter={chatAdapter}
        toolActivity={toolActivity}
        onStop={() => stopChatRef.current?.()}
        threadKey={`${sessionId ?? ""}:${threadEpoch}`}
        ready={Boolean(sessionId)}
        bootError={bootError}
        sessionTitle={sessionTitle}
        chatCards={chatCards}
        onAccept={acceptMutation}
        onReject={rejectMutation}
        sessions={historySessions}
        activeSessionId={sessionId}
        historyLoading={historyLoading}
        historyError={historyError}
        onHistoryOpen={() => void openHistory()}
        onOpenSession={(id) => void openSession(id)}
        onNewSession={() => void startNewSession()}
        pickerRows={pickerRows}
        selectedBuildId={selectedBuildId}
        onPickRow={(row) => void onPickCatalogRow(row)}
        models={availableModels}
        model={chatModel}
        defaultModel={settingsDefault}
        onModelChange={setChatModel}
        hasTask={Boolean(draft.task)}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        docsContext={docsContext}
        onDocsContextChange={setDocsContext}
        composerHandle={composerHandle}
        onStarter={onStarter}
        toolbar={{
          title: draft.pipeline.id,
          untitled: isUntitledPipelineId(draft.pipeline.id),
          saveState,
          changeCount,
          autosavedAt,
          autoApply,
          onAutoApplyChange: setAutoApply,
          onRename: handleRenamePipeline,
          stageCount: draft.pipeline.stages.length,
          errorCount,
          validateBusy,
          onValidate: validateAndShowProblems,
          hasDestination,
          saving,
          onSave: onToolbarSave,
          onSaveAs: onToolbarSaveAs,
          onSaveInvalid: onToolbarSaveInvalid,
          onErrorsClick: () => {
            setDrawerTab("problems");
            setDrawerCollapsed(false);
          },
        }}
        resumeBanner={
          showAutosaveBanner && autosaveOffer && !showDiskBanner
            ? {
                updatedAt: autosaveOffer.updatedAt,
                pipelineId: autosaveOffer.draft.pipeline.id,
                onResume: () => {
                  void (async () => {
                    applyDraft(autosaveOffer.draft);
                    setAutoApply(autosaveOffer.autoApply);
                    if (autosaveOffer.sessionModelOverride) {
                      setChatModel(autosaveOffer.sessionModelOverride);
                    }
                    setSeedMessages(
                      workshopSeedMessages(seedTranscriptFromAutosave(autosaveOffer.messages)),
                    );
                    setThreadEpoch((n) => n + 1);
                    setSavedPipelinePath(autosaveOffer.savedPath ?? null);
                    setSavedTaskPath(autosaveOffer.savedTaskPath ?? null);
                    setSaveDestination(autosaveOffer.destination ?? null);
                    diskFingerprintsRef.current = autosaveOffer.diskFingerprints ?? {};
                    if (autosaveOffer.savedPath) {
                      const opened = await openDraftPackage(
                        openDraftInput({
                          path: autosaveOffer.savedPath,
                          task: autosaveOffer.savedTaskPath ?? undefined,
                          projectRoot: projectRootRef.current,
                        }),
                      );
                      if (opened.ok) {
                        setBaseline(cloneDraft(opened.draft));
                        if (!autosaveOffer.destination) {
                          setSaveDestination(opened.destination);
                        }
                        if (!autosaveOffer.savedTaskPath && opened.taskPath) {
                          setSavedTaskPath(opened.taskPath);
                        }
                      } else {
                        setBaseline(null);
                        setStudioError(opened.error);
                      }
                    } else {
                      setBaseline(null);
                    }
                    setShowAutosaveBanner(false);
                  })();
                },
                onDiscard: () => {
                  if (
                    !window.confirm(
                      "Discard the autosaved draft? This cannot be undone.",
                    )
                  ) {
                    return;
                  }
                  void clearWorkshopAutosave({
                    key: autosaveOffer.key || autosaveSlotKey,
                    ...projectRootField(projectRootRef.current),
                  });
                  setShowAutosaveBanner(false);
                },
                onDismiss: () => setShowAutosaveBanner(false),
              }
            : null
        }
        diskBanner={
          showDiskBanner
            ? {
                changedPaths: diskChangedPaths,
                onReload: () => {
                  setShowDiskBanner(false);
                  if (!savedPipelinePath) return;
                  const row = pickerRows.find(
                    (item) => item.relativePath === savedPipelinePath,
                  );
                  if (!row) {
                    setStudioError(`Could not reload pipeline: ${savedPipelinePath}`);
                    return;
                  }
                  void onPickCatalogRow(row);
                },
                onKeep: () => setShowDiskBanner(false),
                onDismiss: dismissBanner,
              }
            : null
        }
        studioError={studioError}
        draft={draft}
        baseline={baseline}
        selectedStageId={selectedStageId}
        graphFindings={graphFindings}
        onSelectStage={onSelectStage}
        onAddStage={handleAddStage}
        drawer={{
          tab: drawerTab,
          onTabChange: setDrawerTab,
          collapsed: drawerCollapsed,
          onCollapsedChange: setDrawerCollapsed,
          task: draft.task
            ? {
                filename: draft.task.filename,
                body: draft.task.body,
                path: savedTaskPath,
              }
            : null,
          tasks: taskOptions,
          tasksLoading,
          onAttachTask: (task) => void onAttachTask(task),
          onCreateTask,
          onDetachTask,
          findings: drawerFindings,
          validatedAt,
          validateBusy,
          validateError,
          onAskFix: askFix,
          onGoToField: goToFinding,
          mutationCards,
          onAccept: (id) => void acceptMutation(id),
          onReject: (id) => void rejectMutation(id),
        }}
        inspector={{
          tab: inspectorTab,
          onTabChange: setInspectorTab,
          onDraftChange: applyDraft,
          onDeleteStage: handleDeleteStage,
          onRenameStage: handleRenameStage,
          focusField,
          pipelinePath: savedPipelinePath,
        }}
        saveDialog={{
          open: saveOpen,
          draft,
          roots: catalogRootOptions,
          initialRoot: saveDestination?.directory || catalogRootOptions[0]?.value || ".",
          initialPipelineId: draft.pipeline.id,
          mode: saveMode,
          plan: savePlan,
          planLoading,
          validation: draftValidation,
          allowInvalidInitial,
          saving,
          error: saveError,
          onChangeDestination: (dest) => {
            void refreshPlan(dest, saveMode);
          },
          onSave: (allowInvalid, dest) => {
            void commitSave(dest, allowInvalid, saveMode);
          },
          onSaveAs: (dest) => {
            setSaveMode("create");
            void commitSave(dest, false, "create");
          },
          onCancel: () => {
            setSaveOpen(false);
            setSaveError(null);
          },
          onFixInWorkshop: (finding) => {
            setSaveOpen(false);
            goToFinding(finding);
          },
        }}
        toast={
          saveToast
            ? {
                pipelineId: saveToast.pipelineId,
                fileCount: saveToast.fileCount,
                canRun: saveToast.canRun,
                onRun: () => {
                  navigate(
                    newRunPath({
                      pipeline: saveToast.pipelinePath,
                      ...(saveToast.taskPath ? { task: saveToast.taskPath } : {}),
                    }),
                  );
                },
                onOpenCatalog: () => {
                  navigate(
                    pipelinePath(saveToast.pipelineId, {
                      project_root: saveToast.projectRoot,
                    }),
                  );
                },
                onDismiss: () => setSaveToast(null),
              }
            : null
        }
      />
    );
  }

  return (
    <div
      className={`pane workshop-lab${splitDragging ? " is-resizing-x" : ""}`}
    >
      <div className="topbar">
        <div className="topbar__title">Workshop</div>
        <div className="topbar__sub">
          Live Author · draft mutates before Accept · Reject soft-undos
        </div>
        <div className="topbar__spacer" />
      </div>

      <div
        ref={bodyRef}
        className="workshop-lab__body"
        style={{ ["--chat-w" as string]: `${chatWidth}px` }}
      >
        <section className="workshop-lab__chat" aria-label="Workshop chat">
          <LabChatHeader
            historyOpen={historyOpen}
            onHistory={() => {
              if (historyOpen) setHistoryOpen(false);
              else void openHistory();
            }}
            onNew={() => void startNewSession()}
          />
          {bootError ? (
            <p className="workshop-lab__boot-error muted">{bootError}</p>
          ) : null}
          {historyOpen ? (
            <HistoryPanel
              sessions={historySessions}
              pickerRows={pickerRows}
              activeSessionId={sessionId}
              loading={historyLoading}
              error={historyError}
              onClose={() => setHistoryOpen(false)}
              onSelect={(id) => void openSession(id)}
            />
          ) : null}
          <div className="workshop-lab__chat-body">
            <WorkshopMutationContext.Provider value={mutationApi}>
              {sessionId ? (
                <WorkshopChatIsland
                  key={`${sessionId}:${threadEpoch}`}
                  seedMessages={seedMessages}
                  adapter={chatAdapter}
                  greeting={GREETING}
                  toolActivity={toolActivity}
                  MutationCard={MutationCardToolUI}
                  onStop={() => stopChatRef.current?.()}
                  composerActions={
                    <WorkshopModelPicker
                      model={chatModel}
                      models={availableModels}
                      settingsDefault={settingsDefault}
                      onChange={setChatModel}
                    />
                  }
                />
              ) : (
                <div className="workshop-lab__welcome">
                  <div className="eyebrow">Workshop</div>
                  <p>Starting session…</p>
                </div>
              )}
            </WorkshopMutationContext.Provider>
          </div>
        </section>

        <div
          className={`workshop-lab__split${splitDragging ? " is-dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and run map"
          aria-valuemin={Math.round(splitMin)}
          aria-valuemax={Math.round(splitMax)}
          aria-valuenow={Math.round(chatWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button != null && event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setSplitDragging(true);
            splitGestureRef.current = {
              id: event.pointerId,
              x: event.clientX,
              w: chatWidth,
            };
          }}
          onPointerMove={(event) => {
            const gesture = splitGestureRef.current;
            if (!gesture || gesture.id !== event.pointerId) return;
            applyChatWidth(gesture.w + (event.clientX - gesture.x));
          }}
          onPointerUp={(event) => {
            if (splitGestureRef.current?.id !== event.pointerId) return;
            splitGestureRef.current = null;
            setSplitDragging(false);
          }}
          onPointerCancel={(event) => {
            if (splitGestureRef.current?.id !== event.pointerId) return;
            splitGestureRef.current = null;
            setSplitDragging(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              applyChatWidth(chatWidth - CHAT_ARROW_STEP);
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              applyChatWidth(chatWidth + CHAT_ARROW_STEP);
            }
            if (event.key === "Home") {
              event.preventDefault();
              applyChatWidth(splitMin);
            }
            if (event.key === "End") {
              event.preventDefault();
              applyChatWidth(splitMax);
            }
          }}
        >
          <span className="workshop-lab__split-grip" aria-hidden="true" />
        </div>

        <section className="workshop-lab__map" aria-label="Workshop studio">
          <div className="workshop-lab__map-head">
            <div className="workshop-lab__map-switch">
              <div className="eyebrow">Studio · draft</div>
              <select
                className="select workshop-lab__pipeline-select"
                aria-label="Studio pipeline"
                value={selectedBuildId ? `build:${selectedBuildId}` : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const row = pickerRows.find(
                    (item) => pickerRowValue(item) === value,
                  );
                  if (row) void pickStudioRow(row);
                }}
              >
                <option value="">No pipeline</option>
                {pickerRows.map((row) => (
                  <option key={pickerRowValue(row)} value={pickerRowValue(row)}>
                    {pickerRowLabel(row)}
                  </option>
                ))}
              </select>
            </div>
            {studioError ? (
              <p className="workshop-lab__boot-error muted">{studioError}</p>
            ) : null}
            <p className="workshop-lab__selection muted">
              {draftStages.length === 0
                ? "Empty — stages appear when the Author mutates the draft"
                : selectedStage
                  ? `Selected: ${selectedStage.title}`
                  : "Click a stage for details"}
            </p>
          </div>
          <div
            className={`workspace workshop-lab__workspace${highlightActive ? " has-highlight" : ""}`}
          >
            {draftStages.length === 0 ? (
              <MapEmptyState />
            ) : (
              <SpatialRunMap
                layout={layout}
                stages={snapshots}
                nodeChrome={nodeChrome}
                selectedStageId={selectedStageId}
                onSelectStage={onSelectStage}
                onDeselect={closePopup}
                runId="workshop-lab-draft"
                showHint={false}
              />
            )}
          </div>
        </section>
      </div>

      {selectedStage ? (
        <StageDetailPopup stage={selectedStage} onClose={closePopup} />
      ) : null}
    </div>
  );
}
