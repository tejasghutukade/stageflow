import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react";
import { LuMessageSquarePlus } from "react-icons/lu";

function Item({ onPick }: { onPick: () => void }) {
  return (
    <ThreadListItemPrimitive.Root className="group flex data-[active]:bg-[var(--sf-active)] rounded-lg hover:bg-[var(--sf-active)]">
      <ThreadListItemPrimitive.Trigger
        onClick={onPick}
        className="min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm text-[var(--sf-text-2)] group-data-[active]:font-medium group-data-[active]:text-[var(--sf-text-1)]"
      >
        <ThreadListItemPrimitive.Title fallback="New chat" />
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}

export function ThreadSidebar({ agentName, onPick }: { agentName: string; onPick: () => void }) {
  return (
    <ThreadListPrimitive.Root className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="truncate px-2 pt-1 text-sm font-semibold text-[var(--sf-text-1)]">{agentName}</div>
      <ThreadListPrimitive.New
        onClick={onPick}
        className="flex items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-3 py-2 text-sm font-medium text-[var(--sf-text-1)] hover:bg-[var(--sf-active)]"
      >
        <LuMessageSquarePlus aria-hidden className="size-4" />
        New chat
      </ThreadListPrimitive.New>
      <nav aria-label="Conversations" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        <ThreadListPrimitive.Items>{() => <Item onPick={onPick} />}</ThreadListPrimitive.Items>
      </nav>
    </ThreadListPrimitive.Root>
  );
}
