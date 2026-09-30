import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  type ComponentType,
  type ReactNode,
} from "react";
import {
  mapWorkshopChatParts,
  maySend,
  type WorkshopChatMessageInput,
  type WorkshopChatMutationCardInput,
} from "./workshopChatView";
import "../components/assistant-ui/workshop-embed.css";

export type WorkshopMutationCardProps = {
  args: WorkshopChatMutationCardInput["args"];
};

export type WorkshopChatIslandProps = {
  seedMessages: ThreadMessageLike[];
  adapter: ChatModelAdapter;
  greeting: string;
  MutationCard: ComponentType<WorkshopMutationCardProps>;
  /** Model picker (and similar) rendered in the composer footer. */
  composerActions?: ReactNode;
};

function bubbleGroup(
  index: number,
  total: number,
): "first" | "middle" | "last" | undefined {
  if (total === 1) return undefined;
  if (index === 0) return "first";
  if (index === total - 1) return "last";
  return "middle";
}

function messageContent(
  message: ThreadMessageLike & { content?: unknown; parts?: unknown },
): WorkshopChatMessageInput["content"] {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content as WorkshopChatMessageInput["content"];
  }
  if (Array.isArray(message.parts)) {
    return message.parts as WorkshopChatMessageInput["content"];
  }
  return [];
}

function WorkshopAstryxColumn({
  greeting,
  MutationCard,
  composerActions,
}: {
  greeting: string;
  MutationCard: ComponentType<WorkshopMutationCardProps>;
  composerActions?: ReactNode;
}) {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  const messages = useAuiState((s) => s.thread.messages);
  const composerText = useAuiState((s) => s.composer.text);

  const viewParts = mapWorkshopChatParts(
    messages.map((message) => ({
      role: message.role,
      content: messageContent(message),
    })),
  );

  let currentTurnHasAssistantText = false;
  for (let index = viewParts.length - 1; index >= 0; index -= 1) {
    const part = viewParts[index];
    if (part.kind === "text" && part.role === "user") break;
    if (part.kind === "text" && part.role === "assistant") {
      currentTurnHasAssistantText = true;
      break;
    }
  }
  const showInProgressPlaceholder = isRunning && !currentTurnHasAssistantText;

  const onSubmit = (value: string) => {
    if (isRunning) return;
    if (!maySend(value)) return;
    aui.composer.setText(value);
    aui.composer.send();
  };

  const composer = (
    <ChatComposer
      value={composerText}
      onChange={(value) => aui.composer.setText(value)}
      onSubmit={onSubmit}
      isStopShown={false}
      isDisabled={isRunning}
      placeholder="Describe a stage or workflow change…"
      footerActions={composerActions}
      density="compact"
    />
  );

  if (isEmpty) {
    return (
      <Stack height="100%" minHeight={0} gap={3} padding={3}>
        <StackItem size="fill">
          <Stack height="100%" vAlign="center" hAlign="center" padding={3}>
            <Text type="body" justify="center" as="p">
              {greeting}
            </Text>
          </Stack>
        </StackItem>
        {composer}
      </Stack>
    );
  }

  const rendered: ReactNode[] = [];
  let pendingUserTexts: string[] = [];
  let pendingAssistant: ReactNode[] = [];

  const flushUser = () => {
    if (pendingUserTexts.length === 0) return;
    const texts = pendingUserTexts;
    pendingUserTexts = [];
    rendered.push(
      <ChatMessage key={`user-${rendered.length}`} sender="user">
        {texts.map((text, index) => (
          <ChatMessageBubble
            key={index}
            group={bubbleGroup(index, texts.length)}
          >
            {text}
          </ChatMessageBubble>
        ))}
      </ChatMessage>,
    );
  };

  const flushAssistant = () => {
    if (pendingAssistant.length === 0) return;
    const children = pendingAssistant;
    pendingAssistant = [];
    rendered.push(
      <ChatMessage key={`assistant-${rendered.length}`} sender="assistant">
        {children}
      </ChatMessage>,
    );
  };

  for (const part of viewParts) {
    if (part.kind === "text" && part.role === "user") {
      flushAssistant();
      pendingUserTexts.push(part.text);
      continue;
    }
    if (part.kind === "text" && part.role === "assistant") {
      flushUser();
      pendingAssistant.push(
        <ChatMessageBubble key={`text-${pendingAssistant.length}`} variant="ghost">
          <Markdown isStreaming={false} density="compact" contentWidth="100%">
            {part.text}
          </Markdown>
        </ChatMessageBubble>,
      );
      continue;
    }
    if (part.kind === "text") {
      flushUser();
      flushAssistant();
      rendered.push(
        <ChatMessage key={`system-${rendered.length}`} sender="system">
          <Text type="supporting">{part.text}</Text>
        </ChatMessage>,
      );
      continue;
    }
    if (part.kind === "draft_mutation") {
      flushUser();
      pendingAssistant.push(
        <MutationCard key={part.toolCallId} args={part.args} />,
      );
    }
  }
  flushUser();
  flushAssistant();

  if (showInProgressPlaceholder) {
    rendered.push(
      <ChatMessage key="in-progress" sender="assistant">
        <ChatMessageBubble variant="ghost">
          <Text type="supporting">Working…</Text>
        </ChatMessageBubble>
      </ChatMessage>,
    );
  }

  return (
    <ChatLayout composer={composer}>
      <ChatMessageList isStreaming={isRunning} density="compact" gap={2}>
        {rendered}
      </ChatMessageList>
    </ChatLayout>
  );
}

/**
 * Stageflow-owned runtime + Astryx chat column (inline, not `.aui-root` modal).
 * Remount via parent `key={`${sessionId}:${threadEpoch}`}`.
 */
export function WorkshopChatIsland({
  seedMessages,
  adapter,
  greeting,
  MutationCard,
  composerActions,
}: WorkshopChatIslandProps) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages: seedMessages,
  });

  return (
    <div className="workshop-lab__aui-island">
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="workshop-lab__aui-thread-wrap">
          <WorkshopAstryxColumn
            greeting={greeting}
            MutationCard={MutationCard}
            composerActions={composerActions}
          />
        </div>
      </AssistantRuntimeProvider>
    </div>
  );
}
