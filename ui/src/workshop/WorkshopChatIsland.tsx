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
 *
 * U2 hook: pass `tools.by_name.draft_mutation` (MutationCardToolUI).
 * U3: remount via parent `key={`${sessionId}:${threadEpoch}`}`; place model
 * picker beside Composer outside registry internals (or as `children` above Thread).
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
        {children}
        <Thread tools={tools} />
      </AssistantRuntimeProvider>
    </div>
  );
}
