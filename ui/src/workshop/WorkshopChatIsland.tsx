import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import type { ReactNode } from "react";
import { Thread } from "../components/assistant-ui";

export type WorkshopChatIslandProps = {
  seedMessages: ThreadMessageLike[];
  adapter: ChatModelAdapter;
  tools?: {
    by_name?: Record<string, ToolCallMessagePartComponent | undefined>;
  };
  /** Slot for U3 chrome that needs runtime context (e.g. model sticky read). */
  children?: ReactNode;
};

/**
 * Stageflow-owned runtime + stock Thread island under `.aui-root`.
 * Remount via parent `key={`${sessionId}:${threadEpoch}`}`.
 * Model picker lives in `children` (composer-adjacent chrome, outside registry Composer).
 */
export function WorkshopChatIsland({
  seedMessages,
  adapter,
  tools,
  children,
}: WorkshopChatIslandProps) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages: seedMessages,
  });

  return (
    <div className="aui-root workshop-lab__aui-island">
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="workshop-lab__aui-thread-wrap">
          <Thread tools={tools} />
        </div>
        {children ? (
          <div className="workshop-lab__composer-chrome">{children}</div>
        ) : null}
      </AssistantRuntimeProvider>
    </div>
  );
}
