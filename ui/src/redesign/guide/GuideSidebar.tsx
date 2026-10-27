import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react";
import { LuMessageSquarePlus } from "react-icons/lu";
import { navigate, guidePath } from "../../routes";
import { GUIDE_SECTIONS } from "./sections";

function Conversation() {
  return (
    <ThreadListItemPrimitive.Root className="group flex rounded-lg data-[active]:bg-[var(--sf-active)] hover:bg-[var(--sf-active)]">
      <ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-[13px] text-[var(--sf-text-2)] group-data-[active]:font-medium group-data-[active]:text-[var(--sf-text-1)]">
        <ThreadListItemPrimitive.Title fallback="New chat" />
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
