import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  getExternalStoreMessages,
  useAuiState,
  useExternalStoreRuntime,
  useMessagePartText,
  type AppendMessage,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Markdown } from "@astryxdesign/core/Markdown";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  WORKSHOP_PROPOSAL_TOOL_NAME,
  isProposalToolInteractive,
  type ChatMessage,
  type WorkshopProposal,
  type WorkshopProposalToolArgs,
  type WorkshopProposalToolResult,
} from "./draft";
import {
  ArtifactDiffList,
  WorkshopProposalCard,
} from "./WorkshopProposalCard";
import {
  convertChatMessage,
  extractAppendText,
} from "./workshopChatRuntime";

export { ArtifactDiffList, WorkshopProposalCard } from "./WorkshopProposalCard";

export type WorkshopChatPanelProps = {
  messages: ChatMessage[];
  pending: WorkshopProposal | null;
  busy: boolean;
  autoApply: boolean;
  onSendMessage: (text: string) => void;
  onAccept: () => void;
  onReject: () => void;
};

type ProposalActions = {
  pendingId: string | null;
  onAccept: () => void;
  onReject: () => void;
};

const ProposalActionsContext = createContext<ProposalActions>({
  pendingId: null,
  onAccept: () => {},
  onReject: () => {},
});

function useProposalActions(): ProposalActions {
  return useContext(ProposalActionsContext);
}

function WorkshopProposalToolUI(
  props: ToolCallMessagePartProps<
    WorkshopProposalToolArgs,
    WorkshopProposalToolResult
  >,
) {
  const { args, result } = props;
  const { pendingId, onAccept, onReject } = useProposalActions();
  const proposalId =
    typeof args?.proposalId === "string" ? args.proposalId : "";
  const interactive =
    !result && isProposalToolInteractive(pendingId, proposalId);
  const summary =
    typeof args?.summary === "string" && args.summary.length > 0
      ? args.summary
      : "Proposed draft changes";
  const artifacts = Array.isArray(args?.artifacts) ? args.artifacts : [];

  return (
    <WorkshopProposalCard
      summary={summary}
      artifacts={artifacts}
      interactive={interactive}
      onAccept={onAccept}
      onReject={onReject}
    />
  );
}

function AstryxAssistantText() {
  const { text } = useMessagePartText();
  return (
    <div className="workshop__bubble-md">
      <Markdown headingLevelStart={3} contentWidth="100%">
        {text}
      </Markdown>
    </div>
  );
}

function PlainMessageText() {
  const { text } = useMessagePartText();
  return <p>{text}</p>;
}

function MessageArtifacts() {
  const message = useAuiState((s) => s.message);
  const originals = getExternalStoreMessages<ChatMessage>(message);
  const original = originals[0];
  if (original?.proposalId) return null;
  const artifacts = original?.artifacts;
  if (!artifacts?.length) return null;
  return <ArtifactDiffList artifacts={artifacts} />;
}

const ASSISTANT_PARTS = {
  Text: AstryxAssistantText,
  tools: {
    by_name: {
      [WORKSHOP_PROPOSAL_TOOL_NAME]: WorkshopProposalToolUI,
    },
  },
};

function UserMessage() {
  return (
    <MessagePrimitive.Root className="workshop__bubble" data-role="user">
      <div className="eyebrow">user</div>
      <MessagePrimitive.Parts components={{ Text: PlainMessageText }} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="workshop__bubble" data-role="assistant">
      <div className="eyebrow">assistant</div>
      <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
      <MessageArtifacts />
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="workshop__bubble" data-role="system">
      <div className="eyebrow">system</div>
      <MessagePrimitive.Parts components={{ Text: PlainMessageText }} />
    </MessagePrimitive.Root>
  );
}

const MESSAGE_COMPONENTS = {
  UserMessage,
  AssistantMessage,
  SystemMessage,
};

function WorkshopThread({
  pending,
}: {
  pending: WorkshopProposal | null;
}) {
  return (
    <ThreadPrimitive.Root className="workshop__thread">
      <ThreadPrimitive.Viewport className="workshop__transcript">
        <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="workshop__composer">
        <ComposerPrimitive.Input
          className="input workshop__composer-input"
          placeholder={
            pending
              ? "Accept or Reject the pending proposal first"
              : "Describe a stage, task, or workflow…"
          }
          rows={2}
          submitMode="enter"
        />
        <ComposerPrimitive.Send className="btn btn--primary">
          Send
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function ProposalActionsProvider({
  pendingId,
  onAccept,
  onReject,
  children,
}: {
  pendingId: string | null;
  onAccept: () => void;
  onReject: () => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ pendingId, onAccept, onReject }),
    [pendingId, onAccept, onReject],
  );
  return (
    <ProposalActionsContext.Provider value={value}>
      {children}
    </ProposalActionsContext.Provider>
  );
}

export function WorkshopChatPanel({
  messages,
  pending,
  busy,
  onSendMessage,
  onAccept,
  onReject,
}: WorkshopChatPanelProps) {
  const pendingId = pending?.id ?? null;

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractAppendText(message);
      if (!text) return;
      onSendMessage(text);
    },
    [onSendMessage],
  );

  const convertMessage = useCallback(
    (message: ChatMessage) => convertChatMessage(message, { pendingId }),
    [pendingId],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: busy,
    isDisabled: busy || Boolean(pending),
    convertMessage,
    onNew,
  });

  return (
    <section className="workshop__chat" aria-label="Workshop Author chat">
      <div className="eyebrow">Workshop Author</div>
      <AssistantRuntimeProvider runtime={runtime}>
        <ProposalActionsProvider
          pendingId={pendingId}
          onAccept={onAccept}
          onReject={onReject}
        >
          <WorkshopThread pending={pending} />
        </ProposalActionsProvider>
      </AssistantRuntimeProvider>
    </section>
  );
}
