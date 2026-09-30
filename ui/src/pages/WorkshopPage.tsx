import {
  useAuiState,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
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
  createWorkshopSession,
  fetchModels,
  fetchSettings,
  getWorkshopSession,
  listWorkshopSessions,
  sendWorkshopChatTurnStreaming,
  undoWorkshopSessionMutation,
  type DraftPackagePayload,
  type PipelineTrackProjection,
  type StageSnapshot,
  type WorkshopChatProposalPayload,
  type WorkshopSessionSummary,
} from "../api";
import { SpatialRunMap } from "../components/SpatialRunMap";
import { layoutSpatialTrack } from "../track/layoutPipelineTrack";
import type { SpatialNodeChrome } from "../workspace/resolveRunWorkspace";
import { WorkshopChatIsland } from "../workshop/WorkshopChatIsland";
import {
  buildDraftMutationToolParts,
  buildDraftMutationTools,
  mutationCardActionsLocked,
} from "../workshop/draftMutationTools";
import {
  DEFAULT_WORKSHOP_MODEL,
  resolveWorkshopModel,
} from "../workshop/modelSettings";

const CHAT_DEFAULT_W = 420;
const CHAT_MIN_W = 280;
const MAP_MIN_W = 320;
const CHAT_ARROW_STEP = 32;

type MutationCardStatus = "pending" | "accepted" | "rejected" | "conflict";

type MutationCardState = {
  proposal: WorkshopChatProposalPayload;
  status: MutationCardStatus;
  notice?: string;
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
  setDraft: (draft: DraftPackagePayload) => void;
  registerMutations: (proposals: WorkshopChatProposalPayload[]) => void;
};

const EMPTY_DRAFT: DraftPackagePayload = {
  pipeline: { id: "untitled", stages: [] },
};

const GREETING =
  "What are we building? Describe a workflow and I’ll sketch stages on the studio as we go.";

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
  return [{ role: "assistant", content: GREETING }];
}

function transcriptToSeedMessages(
  transcript: Array<{ role: string; text: string }>,
): ThreadMessageLike[] {
  if (transcript.length === 0) return emptySeedMessages();
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
      readinessLine: pending
        ? "Awaiting Accept / Reject"
        : stage.promptSummary,
      gateKinds: pending ? ["confirm"] : undefined,
      promptSummary: pending ? stage.promptSummary : undefined,
      meta: stage.ioSummary,
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
    async *run({ messages }) {
      const userText = extractUserText(messages);
      if (!userText) {
        yield { content: [{ type: "text", text: GREETING }] };
        return;
      }

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

      const turnPromise = sendWorkshopChatTurnStreaming(
        {
          sessionId,
          message: userText,
          draft: refs.draft.current,
          model: refs.model.current,
        },
        {
          onDelta: (text) => {
            assistantText += text;
            enqueue({ kind: "delta" });
          },
          onEvent: (event) => {
            if (event.type === "proposal") {
              proposals.push(event.proposal);
            }
          },
        },
      ).then((result) => {
        enqueue({ kind: "done", result });
        return result;
      });

      while (true) {
        if (queue.length === 0) await wait();
        const item = queue.shift()!;
        if (item.kind === "delta") {
          yield {
            content: [{ type: "text", text: assistantText || "…" }],
          };
          continue;
        }

        await turnPromise;
        const result = item.result;
        if (!result.ok) {
          yield {
            content: [
              {
                type: "text",
                text: `Chat failed: ${result.error}`,
              },
            ],
          };
          return;
        }

        refs.setDraft(result.draft);
        const fromEvents = assistantTextFromEvents(result.events);
        const finalText =
          assistantText.trim() ||
          fromEvents ||
          (proposals.length > 0
            ? "Updated the draft. Accept or Reject the mutation cards below."
            : "Done.");
        if (proposals.length > 0) {
          refs.registerMutations(proposals);
        } else if (result.pending) {
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
    },
  };
}

function MutationCardToolUI({
  args,
}: ToolCallMessagePartProps<
  {
    mutationId: string;
    summary: string;
    affectedStageIds: string[];
  },
  { status: "applied" }
>) {
  const api = useWorkshopMutation();
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
      <div className="workshop-lab__chat-title">Workshop</div>
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
  activeSessionId,
  loading,
  error,
  onClose,
  onSelect,
}: {
  sessions: WorkshopSessionSummary[];
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
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className="workshop-lab__history-item"
                  data-active={session.id === activeSessionId ? "true" : "false"}
                  onClick={() => onSelect(session.id)}
                >
                  <strong>{title}</strong>
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
      : [resolveWorkshopModel({ settingsDefault })];

  return (
    <label className="workshop-lab__model">
      <span className="muted">Model</span>
      <select
        className="select workshop-lab__model-select"
        value={model}
        aria-label="Workshop chat model"
        title={`Effective: ${model}`}
        onChange={(event) => onChange(event.target.value)}
      >
        {!options.includes(model) ? (
          <option value={model}>{model}</option>
        ) : null}
        {options.map((id) => (
          <option key={id} value={id}>
            {id === settingsDefault ? `${id} (default)` : id}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WorkshopPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftPackagePayload>(EMPTY_DRAFT);
  const [mutationCards, setMutationCards] = useState<
    Map<string, MutationCardState>
  >(() => new Map());
  const [seedMessages, setSeedMessages] =
    useState<ThreadMessageLike[]>(emptySeedMessages);
  const [threadEpoch, setThreadEpoch] = useState(0);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySessions, setHistorySessions] = useState<
    WorkshopSessionSummary[]
  >([]);
  const [chatModel, setChatModel] = useState(DEFAULT_WORKSHOP_MODEL);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [settingsDefault, setSettingsDefault] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const draftRef = useRef<DraftPackagePayload>(EMPTY_DRAFT);
  const modelRef = useRef<string>(DEFAULT_WORKSHOP_MODEL);
  sessionIdRef.current = sessionId;
  draftRef.current = draft;
  modelRef.current = chatModel;

  const applyDraft = useCallback((next: DraftPackagePayload) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const registerMutations = useCallback(
    (proposals: WorkshopChatProposalPayload[]) => {
      setMutationCards((prev) => {
        const next = new Map(prev);
        for (const proposal of proposals) {
          next.set(proposal.id, { proposal, status: "pending" });
        }
        return next;
      });
    },
    [],
  );

  const liveRefs = useMemo<LiveChatRefs>(
    () => ({
      sessionId: sessionIdRef,
      draft: draftRef,
      model: modelRef,
      setDraft: applyDraft,
      registerMutations,
    }),
    [applyDraft, registerMutations],
  );

  const chatAdapter = useMemo(
    () => createLiveChatModel(liveRefs),
    [liveRefs],
  );

  const draftMutationTools = useMemo(
    () => buildDraftMutationTools(MutationCardToolUI),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, models] = await Promise.all([
          fetchSettings(),
          fetchModels(),
        ]);
        if (cancelled) return;
        const nextDefault = settings.workshopModel ?? null;
        setSettingsDefault(nextDefault);
        setAvailableModels(models.models);
        setChatModel((current) =>
          current === DEFAULT_WORKSHOP_MODEL
            ? resolveWorkshopModel({ settingsDefault: nextDefault })
            : current,
        );
      } catch {
        if (cancelled) return;
        setAvailableModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startNewSession = useCallback(async () => {
    setBootError(null);
    setHistoryOpen(false);
    const created = await createWorkshopSession();
    if (!created.ok) {
      setBootError(created.error);
      return;
    }
    setSessionId(created.session.id);
    applyDraft(EMPTY_DRAFT);
    setMutationCards(new Map());
    setSelectedStageId(null);
    setSeedMessages(emptySeedMessages());
    setThreadEpoch((n) => n + 1);
  }, [applyDraft]);

  useEffect(() => {
    void startNewSession();
  }, [startNewSession]);

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    const listed = await listWorkshopSessions();
    setHistoryLoading(false);
    if (!listed.ok) {
      setHistoryError(listed.error);
      setHistorySessions([]);
      return;
    }
    setHistorySessions(listed.sessions);
  }, []);

  const openSession = useCallback(
    async (id: string) => {
      setHistoryLoading(true);
      setHistoryError(null);
      const got = await getWorkshopSession(id);
      setHistoryLoading(false);
      if (!got.ok) {
        setHistoryError(got.error);
        return;
      }
      setSessionId(got.session.id);
      applyDraft(EMPTY_DRAFT);
      setMutationCards(new Map());
      setSelectedStageId(null);
      setSeedMessages(transcriptToSeedMessages(got.session.transcript));
      setThreadEpoch((n) => n + 1);
      setHistoryOpen(false);
    },
    [applyDraft],
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
  const onSelectStage = useCallback((stageId: string) => {
    setSelectedStageId(stageId);
  }, []);

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
                  tools={draftMutationTools}
                >
                  <WorkshopModelPicker
                    model={chatModel}
                    models={availableModels}
                    settingsDefault={settingsDefault}
                    onChange={setChatModel}
                  />
                </WorkshopChatIsland>
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
            <div className="eyebrow">Studio · draft</div>
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
