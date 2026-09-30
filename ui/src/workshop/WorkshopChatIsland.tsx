import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import type { ComponentType, ReactNode } from "react";
import { Thread } from "../components/assistant-ui";

export type WorkshopChatIslandProps = {
  seedMessages: ThreadMessageLike[];
  adapter: ChatModelAdapter;
  tools?: {
    by_name?: Record<string, ToolCallMessagePartComponent | undefined>;
  };
  Welcome?: ComponentType;
  /** Model picker (and similar) rendered in the composer action slot. */
  composerActions?: ReactNode;
};

/**
 * Stageflow-owned runtime + stock Thread island (inline column, not `.aui-root` modal).
 * Remount via parent `key={`${sessionId}:${threadEpoch}`}`.
 */
export function WorkshopChatIsland({
  seedMessages,
  adapter,
  tools,
  Welcome,
  composerActions,
}: WorkshopChatIslandProps) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages: seedMessages,
  });

  return (
    <div className="workshop-lab__aui-island">
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="workshop-lab__aui-thread-wrap">
          <Thread
            tools={tools}
            Welcome={Welcome}
            composerActions={composerActions}
          />
        </div>
      </AssistantRuntimeProvider>
    </div>
  );
}
