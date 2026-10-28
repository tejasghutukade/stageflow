import { ThreadListItemPrimitive, ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { LuMessageSquarePlus } from "react-icons/lu";
import { navigate, guidePath } from "../../routes";
import { useGuideActivity } from "./runtime";
import { GUIDE_SECTIONS } from "./sections";

function WorkingDot() {
  return (
    <span
      className="sf-guide-working-dot size-1.5 shrink-0 rounded-full bg-[var(--sf-running)]"
      role="status"
      aria-label="Working"
    />
  );
}

function Conversation() {
  const remoteId = useAuiState((state) => state.threadListItem.remoteId);
  const localRunning = useAuiState((state) => state.threadListItem.isRunning);
  const { runningIds } = useGuideActivity();
  const working = localRunning || (remoteId != null && runningIds.has(remoteId));

  return (
    <ThreadListItemPrimitive.Root className="group flex rounded-lg data-[active]:bg-[var(--sf-active)] hover:bg-[var(--sf-active)]">
      <ThreadListItemPrimitive.Trigger className="flex min-w-0 flex-1 items-center gap-2 truncate rounded-lg px-2.5 py-2 text-left text-[13px] text-[var(--sf-text-2)] group-data-[active]:font-medium group-data-[active]:text-[var(--sf-text-1)]">
        {working ? <WorkingDot /> : null}
        <span className="min-w-0 flex-1 truncate">
          <ThreadListItemPrimitive.Title fallback="New chat" />
        </span>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}

export function GuideSidebar({ active, sessionId }: { active: string; sessionId?: string }) {
  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-[var(--sf-hairline)] bg-[var(--sf-panel)]" aria-label="Guide">
      <div className="flex flex-col gap-0.5 px-2 pt-3">
        <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Sections</div>
        <nav aria-label="Guide sections" className="flex flex-col gap-0.5">
          {GUIDE_SECTIONS.map((section) => {
            const selected = section.id === active;
            const href = guidePath(
              section.id,
              sessionId && section.id === "chat" ? { session: sessionId } : undefined,
            );
            return (
              <a
                key={section.id}
                href={`#${href}`}
                aria-current={selected ? "page" : undefined}
                className={`flex h-8 items-center rounded-lg px-2.5 text-[13px] no-underline${
                  selected ? " bg-[var(--sf-active)] font-medium text-[var(--sf-text-1)]" : " text-[var(--sf-text-2)]"
                }`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(href);
                }}
              >
                {section.label}
              </a>
            );
          })}
        </nav>
      </div>
      {active === "chat" ? (
        <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-3 pt-4">
          <ThreadListPrimitive.New className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] px-2.5 text-[13px] font-medium text-[var(--sf-text-1)] hover:bg-[var(--sf-active)]">
            <LuMessageSquarePlus aria-hidden className="size-3.5" />
            New chat
          </ThreadListPrimitive.New>
          <nav aria-label="Conversations" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            <ThreadListPrimitive.Items>{() => <Conversation />}</ThreadListPrimitive.Items>
          </nav>
        </ThreadListPrimitive.Root>
      ) : null}
    </aside>
  );
}
