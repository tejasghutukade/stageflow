import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessagePartText,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Markdown } from "@astryxdesign/core/Markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PipelineTrackProjection, StageSnapshot } from "../api";
import { SpatialRunMap } from "../components/SpatialRunMap";
import { layoutSpatialTrack } from "../track/layoutPipelineTrack";
import type { SpatialNodeChrome } from "../workspace/resolveRunWorkspace";

const CHAT_DEFAULT_W = 420;
const CHAT_MIN_W = 280;
const MAP_MIN_W = 320;
const CHAT_ARROW_STEP = 32;

const LAB_PROJECTION: PipelineTrackProjection = {
  nodes: [
    {
      stage_id: "intake",
      status: "succeeded",
      readiness: "succeeded",
      layer: 0,
      layer_order: 0,
      attempt_count: 1,
    },
    {
      stage_id: "implement",
      status: "running",
      readiness: "running",
      layer: 1,
      layer_order: 0,
      attempt_count: 1,
    },
    {
      stage_id: "review",
      status: "waiting_for_input",
      readiness: "waiting",
      layer: 2,
      layer_order: 0,
      attempt_count: 1,
      gate_kinds: ["confirm"],
      blocked_by: ["implement"],
    },
    {
      stage_id: "ship",
      status: "pending",
      readiness: "blocked",
      layer: 3,
      layer_order: 0,
      blocked_by: ["review"],
    },
  ],
  edges: [
    { from: "intake", to: "implement" },
    { from: "implement", to: "review" },
    { from: "review", to: "ship" },
  ],
};

const LAB_STAGES: StageSnapshot[] = [
  {
    stage_id: "intake",
    status: "succeeded",
    events: [],
    envelope: null,
    artifacts: ["intake/brief.md"],
    attempt_count: 1,
    last_at: "2026-09-29T12:00:00.000Z",
  },
  {
    stage_id: "implement",
    status: "running",
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    last_at: "2026-09-29T12:05:00.000Z",
  },
  {
    stage_id: "review",
    status: "waiting_for_input",
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    last_at: "2026-09-29T12:08:00.000Z",
  },
  {
    stage_id: "ship",
    status: "pending",
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 0,
  },
];

const LAB_CHROME: SpatialNodeChrome[] = [
  {
    stageId: "intake",
    title: "Intake",
    kicker: "stage · succeeded",
    status: "succeeded",
    attemptCount: 1,
    readinessLine: "Brief captured",
    meta: "1 artifact",
    isWaitingAttention: false,
  },
  {
    stageId: "implement",
    title: "Implement",
    kicker: "stage · running",
    status: "running",
    attemptCount: 1,
    readinessLine: "Writing changes…",
    isWaitingAttention: false,
  },
  {
    stageId: "review",
    title: "Review",
    kicker: "gate · waiting",
    status: "waiting_for_input",
    attemptCount: 1,
    gateKinds: ["confirm"],
    promptSummary: "Approve the implementation?",
    readinessLine: "Needs operator confirm",
    isWaitingAttention: true,
  },
  {
    stageId: "ship",
    title: "Ship",
    kicker: "stage · pending",
    status: "pending",
    readinessLine: "Blocked on review",
    isWaitingAttention: false,
  },
];

const SEED_MESSAGES: ThreadMessageLike[] = [
  {
    role: "assistant",
    content:
      "Welcome to **Workshop** — a frontend look prototype.\n\nDescribe a pipeline change on the left; the mock run map on the right shows how the live DAG canvas feels.",
  },
  {
    role: "user",
    content: "Add a review gate after implement, then ship.",
  },
  {
    role: "assistant",
    content:
      "Sketched a four-stage flow:\n\n1. **intake** — succeeded\n2. **implement** — running\n3. **review** — waiting for confirm\n4. **ship** — pending\n\nSelect a node on the map to preview selection chrome. Replies here are local mock text only.",
  },
];

const labChatModel: ChatModelAdapter = {
  async *run() {
    yield {
      content: [
        {
          type: "text",
          text: "*(Lab mock)* Got it — no backend on this page. Use this pane to judge chat density, composer height, and how the thread sits next to the run map.",
        },
      ],
    };
  },
};

function LabAssistantText() {
  const { text } = useMessagePartText();
  return (
    <div className="workshop-lab__bubble-md">
      <Markdown headingLevelStart={3} contentWidth="100%">
        {text}
      </Markdown>
    </div>
  );
}

function LabUserText() {
  const { text } = useMessagePartText();
  return <p>{text}</p>;
}

function LabUserMessage() {
  return (
    <MessagePrimitive.Root className="workshop-lab__msg" data-role="user">
      <div className="workshop-lab__bubble" data-role="user">
        <div className="eyebrow">you</div>
        <MessagePrimitive.Parts components={{ Text: LabUserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function LabAssistantMessage() {
  return (
    <MessagePrimitive.Root className="workshop-lab__msg" data-role="assistant">
      <div className="workshop-lab__bubble" data-role="assistant">
        <div className="eyebrow">assistant</div>
        <MessagePrimitive.Parts components={{ Text: LabAssistantText }} />
        <ActionBarPrimitive.Root className="workshop-lab__action-bar">
          <ActionBarPrimitive.Copy className="btn btn--ghost workshop-lab__action">
            Copy
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function LabWelcome() {
  return (
    <div className="workshop-lab__welcome">
      <div className="eyebrow">Workshop · prototype</div>
      <p>
        Frontend-only chat + run map. Send a message to see LocalRuntime reply
        with mock text.
      </p>
    </div>
  );
}

function LabThread() {
  return (
    <ThreadPrimitive.Root className="workshop-lab__thread">
      <ThreadPrimitive.Viewport className="workshop-lab__transcript">
        <ThreadPrimitive.Empty>
          <LabWelcome />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage: LabUserMessage,
            AssistantMessage: LabAssistantMessage,
          }}
        />
        <ThreadPrimitive.ScrollToBottom className="btn btn--ghost workshop-lab__scroll-bottom">
          ↓ Latest
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="workshop-lab__composer">
        <ComposerPrimitive.Input
          className="input workshop-lab__composer-input"
          placeholder="Describe a stage or workflow change…"
          rows={3}
          submitMode="enter"
        />
        <ComposerPrimitive.Send className="btn btn--primary">
          Send
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

export function WorkshopPage() {
  const layout = useMemo(() => layoutSpatialTrack(LAB_PROJECTION), []);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(
    "review",
  );
  const runtime = useLocalRuntime(labChatModel, {
    initialMessages: SEED_MESSAGES,
  });
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
  const splitMin = bodyWidth > 0 && bodyWidth < CHAT_MIN_W + MAP_MIN_W
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

  const selectedChrome = selectedStageId
    ? LAB_CHROME.find((c) => c.stageId === selectedStageId)
    : null;

  return (
    <div
      className={`pane workshop-lab${splitDragging ? " is-resizing-x" : ""}`}
    >
      <div className="topbar">
        <div className="topbar__title">Workshop</div>
        <div className="topbar__sub">
          Look prototype · mock chat · mock run map
        </div>
        <div className="topbar__spacer" />
      </div>

      <div
        ref={bodyRef}
        className="workshop-lab__body"
        style={{ ["--chat-w" as string]: `${chatWidth}px` }}
      >
        <section className="workshop-lab__chat" aria-label="Workshop chat">
          <div className="eyebrow">Chat</div>
          <div className="workshop-lab__chat-body">
            <AssistantRuntimeProvider runtime={runtime}>
              <LabThread />
            </AssistantRuntimeProvider>
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

        <section className="workshop-lab__map" aria-label="Mock run map">
          <div className="workshop-lab__map-head">
            <div className="eyebrow">Run map · mock</div>
            {selectedChrome ? (
              <p className="workshop-lab__selection muted">
                Selected: {selectedChrome.title}
                {selectedChrome.promptSummary
                  ? ` — ${selectedChrome.promptSummary}`
                  : ""}
              </p>
            ) : (
              <p className="workshop-lab__selection muted">
                Select a stage node
              </p>
            )}
          </div>
          <div className="workspace workshop-lab__workspace">
            <SpatialRunMap
              layout={layout}
              stages={LAB_STAGES}
              nodeChrome={LAB_CHROME}
              selectedStageId={selectedStageId}
              onSelectStage={setSelectedStageId}
              onDeselect={() => setSelectedStageId(null)}
              runId="workshop-lab-mock"
              showHint
            />
          </div>
        </section>
      </div>
    </div>
  );
}
