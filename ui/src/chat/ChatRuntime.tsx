import { AssistantRuntimeProvider, useAui, useLocalRuntime, useRemoteThreadListRuntime, type ThreadHistoryAdapter } from "@assistant-ui/react";
import { ExportedMessageRepository } from "@assistant-ui/react";
import { useMemo, type ReactNode } from "react";
import { createChatModelAdapter, createThreadListAdapter, toThreadMessages } from "./adapters";
import type { ChatApi } from "./api";

/** One conversation's runtime: sends through the public API and loads its stored history. */
function useConversationRuntime(api: ChatApi) {
  const aui = useAui();
  const adapters = useMemo(() => {
    // A conversation gets its server id when it is first used; a fresh one is created on demand.
    const threadId = async (): Promise<string> => {
      const item = aui.threadListItem;
      return item.getState().remoteId ?? (await item.initialize()).remoteId;
    };
    const history: ThreadHistoryAdapter = {
      async load() {
        const remoteId = aui.threadListItem.getState().remoteId;
        if (!remoteId) return ExportedMessageRepository.fromArray([]);
        const detail = await api.getThread(remoteId);
        return ExportedMessageRepository.fromArray(toThreadMessages(detail.messages));
      },
      // The server stores every turn itself.
      async append() {},
    };
    return { model: createChatModelAdapter(api, threadId), history };
  }, [api, aui]);
  return useLocalRuntime(adapters.model, { adapters: { history: adapters.history } });
}

export function ChatRuntimeProvider({ api, children }: { api: ChatApi; children: ReactNode }) {
  const threadListAdapter = useMemo(() => createThreadListAdapter(api), [api]);
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useConversationRuntime(api),
    adapter: threadListAdapter,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
