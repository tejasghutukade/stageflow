import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { LuArrowDown, LuArrowUp, LuSquare } from "react-icons/lu";
import { AssistantMessageBody } from "./MessageParts";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--sf-raised)] px-4 py-2.5 text-[15px] leading-relaxed text-[var(--sf-text-1)]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="min-w-0 max-w-[92%] break-words">
        <AssistantMessageBody />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3 py-2 focus-within:border-[var(--sf-text-3)]">
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        aria-label="Message"
        placeholder="Write a message…"
        className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send
          aria-label="Send message"
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--sf-text-1)] text-[var(--sf-ground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
        >
          <LuArrowUp aria-hidden className="size-4" />
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel
          aria-label="Stop replying"
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
        >
          <LuSquare aria-hidden className="size-3.5 fill-current" />
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}

export function Thread({ agentName, greeting }: { agentName: string; greeting: string | null }) {
  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-col bg-[var(--sf-ground)]">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth px-4 pt-6">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5">
          <ThreadPrimitive.Empty>
            <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-16 text-center">
              <h2 className="m-0 text-xl font-semibold text-[var(--sf-text-1)]">{agentName}</h2>
              <p className="m-0 max-w-md text-[15px] leading-relaxed text-[var(--sf-text-2)]">{greeting || "How can I help you today?"}</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
        </div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto flex w-full max-w-3xl flex-col gap-2 bg-[var(--sf-ground)] pb-4 pt-3">
          <ThreadPrimitive.ScrollToBottom
            aria-label="Scroll to latest message"
            className="absolute -top-10 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] text-[var(--sf-text-2)] disabled:hidden"
          >
            <LuArrowDown aria-hidden className="size-4" />
          </ThreadPrimitive.ScrollToBottom>
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
