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
} from "@assistant-ui/react";
import { Markdown } from "@astryxdesign/core/Markdown";
import { useCallback } from "react";
import {
  formatArtifactDiffLine,
  type ChatMessage,
  type ProposalArtifactDiff,
  type WorkshopProposal,
} from "./draft";
import {
  convertChatMessage,
  extractAppendText,
} from "./workshopChatRuntime";

export function ArtifactDiffList({
  artifacts,
}: {
  artifacts: ProposalArtifactDiff[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <ul className="workshop__diff-list" aria-label="Per-artifact diff">
      {artifacts.map((diff) => (
        <li key={`${diff.kind}-${diff.path}`}>
          {formatArtifactDiffLine(diff)}
          {diff.after || diff.before ? (
            <pre>{diff.after ?? diff.before}</pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export type WorkshopChatPanelProps = {
  messages: ChatMessage[];
  pending: WorkshopProposal | null;
  busy: boolean;
  autoApply: boolean;
  onSendMessage: (text: string) => void;
  onAccept: () => void;
  onReject: () => void;
};

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
  const artifacts = originals[0]?.artifacts;
  if (!artifacts?.length) return null;
  return <ArtifactDiffList artifacts={artifacts} />;
}

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
      <MessagePrimitive.Parts components={{ Text: AstryxAssistantText }} />
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

export function WorkshopChatPanel({
  messages,
  pending,
  busy,
  onSendMessage,
}: WorkshopChatPanelProps) {
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractAppendText(message);
      if (!text) return;
      onSendMessage(text);
    },
    [onSendMessage],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: busy,
    isDisabled: busy || Boolean(pending),
    convertMessage: convertChatMessage,
    onNew,
  });

  return (
    <section className="workshop__chat" aria-label="Workshop Author chat">
      <div className="eyebrow">Workshop Author</div>
      <AssistantRuntimeProvider runtime={runtime}>
        <WorkshopThread pending={pending} />
      </AssistantRuntimeProvider>
    </section>
  );
}
