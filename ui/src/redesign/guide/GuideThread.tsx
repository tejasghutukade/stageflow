import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { lazy, Suspense, useState } from "react";
import { LuArrowDown, LuArrowUp, LuFile, LuPaperclip, LuSquare, LuTriangleAlert, LuX } from "react-icons/lu";
import { ModelPicker } from "../../components/ModelPicker";
import { friendlyMessage } from "../../chat/errors";
import { GUIDE_TOOLS } from "./GuideTools";
import { useGuideActivity, useGuideModel } from "./runtime";

const MarkdownText = lazy(() => import("../../chat/MarkdownText"));

const STARTERS = [
  "I do the same job every week by hand. Help me decide what to build.",
  "When should I use a pipeline, and when should I use an agent?",
  "What can I connect, schedule, or remember?",
];

function PlainText({ text }: { text: string }) {
  return <p className="m-0 whitespace-pre-wrap">{text}</p>;
}

function TextPart({ text }: { text?: string }) {
  return (
    <Suspense fallback={<PlainText text={text ?? ""} />}>
      <MarkdownText />
    </Suspense>
  );
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label="Stageflow is replying">
      {[0, 1, 2].map((i) => (
        <span key={i} className="sf-chat-dot size-1.5 rounded-full bg-[var(--sf-text-3)]" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </span>
  );
}

function Starter({ text }: { text: string }) {
  const aui = useAui();
  return (
    <button
      type="button"
      className="w-full rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3 py-2 text-left text-[13px] leading-snug text-[var(--sf-text-2)] hover:bg-[var(--sf-active)]"
      onClick={() => {
        aui.thread().append({ role: "user", content: [{ type: "text", text }] });
      }}
    >
      {text}
    </button>
  );
}

function CopyReply() {
  const text = useAuiState((state) =>
    state.message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim(),
  );
  const complete = useAuiState((state) => state.message.status?.type === "complete");
  const [copied, setCopied] = useState(false);
  if (!complete || !text) return null;
  return (
    <button
      type="button"
      className="self-start text-[12px] text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function UserMessage() {
  const hasText = useAuiState((state) => state.message.content.some((part) => part.type === "text" && part.text.length > 0));
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1.5">
        <MessagePrimitive.Attachments>
          {({ attachment }) => (
            <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2 py-1 text-[12px] text-[var(--sf-text-2)]">
              <LuFile aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{attachment.name}</span>
            </span>
          )}
        </MessagePrimitive.Attachments>
        {hasText ? (
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--sf-raised)] px-4 py-2.5 text-[15px] leading-relaxed text-[var(--sf-text-1)]">
            <MessagePrimitive.Parts />
          </div>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const status = useAuiState((state) => state.message.status);
  const hasContent = useAuiState((state) =>
    state.message.content.some((part) => (part.type === "text" && part.text.length > 0) || part.type === "tool-call"),
  );
  const awaitingMore = useAuiState((state) => {
    const last = state.message.content.at(-1);
    return !last || (last.type === "text" && last.text.length === 0) || (last.type === "tool-call" && last.result !== undefined);
  });
  const running = status?.type === "running";
  const error = status?.type === "incomplete" && status.reason === "error" ? status.error : null;
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;

  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="flex w-full min-w-0 max-w-[92%] flex-col gap-1.5 break-words text-[15px] leading-relaxed text-[var(--sf-text-1)]">
        {hasContent ? <MessagePrimitive.Parts components={{ Text: TextPart, tools: GUIDE_TOOLS }} /> : null}
        {running && awaitingMore ? <Dots /> : null}
        {code ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-fail-bg)] px-3 py-2 text-[13px] text-[var(--sf-text-1)]">
            <LuTriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sf-fail)]" />
            <span>{friendlyMessage(code)}</span>
          </div>
        ) : null}
        <CopyReply />
      </div>
    </MessagePrimitive.Root>
  );
}

function StopButton() {
  const { stopCurrent } = useGuideActivity();
  return (
    <button
      type="button"
      aria-label="Stop replying"
      className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
      onClick={() => {
        void stopCurrent();
      }}
    >
      <LuSquare aria-hidden className="size-3.5 fill-current" />
    </button>
  );
}

function Composer() {
  const { model, setModel } = useGuideModel();
  const localRunning = useAuiState((state) => state.thread.isRunning);
  const { isResuming } = useGuideActivity();
  const busy = localRunning || isResuming;
  return (
    <ComposerPrimitive.Root className="flex flex-col gap-2 rounded-2xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3 py-2 focus-within:border-[var(--sf-text-3)]">
      <ComposerPrimitive.Attachments>
        {({ attachment }) => {
          const failed = attachment.status.type === "incomplete" ? attachment.status.message : null;
          return (
            <span
              className="inline-flex max-w-full items-center gap-1 self-start rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 py-1 text-[12px] text-[var(--sf-text-2)]"
              title={failed ?? attachment.name}
            >
              <LuFile aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{failed ?? attachment.name}</span>
              <AttachmentPrimitive.Remove aria-label={`Remove ${attachment.name}`} className="flex size-4 items-center justify-center text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]">
                <LuX aria-hidden className="size-3" />
              </AttachmentPrimitive.Remove>
            </span>
          );
        }}
      </ComposerPrimitive.Attachments>
      <div className="flex items-end gap-2">
        <ComposerPrimitive.AddAttachment
          multiple
          aria-label="Attach files"
          title="Attach text files, up to 5, 256 KB each"
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--sf-text-2)] hover:bg-[var(--sf-active)]"
        >
          <LuPaperclip aria-hidden className="size-4" />
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          aria-label="Message"
          placeholder="Describe what you want to get done"
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
        />
        {busy ? (
          <StopButton />
        ) : (
          <ComposerPrimitive.Send
            aria-label="Send message"
            className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--sf-text-1)] text-[var(--sf-ground)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            <LuArrowUp aria-hidden className="size-4" />
          </ComposerPrimitive.Send>
        )}
      </div>
      <ModelPicker
        variant="chip"
        placement="up"
        ariaLabel="Guide model"
        value={model}
        onChange={setModel}
      />
    </ComposerPrimitive.Root>
  );
}

export function GuideThread({ agentName, greeting }: { agentName: string; greeting: string }) {
  const { isResuming } = useGuideActivity();
  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth px-4 pt-6">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5">
          <ThreadPrimitive.Empty>
            <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-16">
              <div className="flex flex-col items-center gap-2 text-center">
                <h2 className="m-0 text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">{agentName}</h2>
                <p className="m-0 max-w-md text-balance text-[15px] leading-relaxed text-[var(--sf-text-2)]">{greeting}</p>
              </div>
              <div className="flex w-full max-w-md flex-col gap-2">
                {STARTERS.map((starter) => (
                  <Starter key={starter} text={starter} />
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
          {isResuming ? <Dots /> : null}
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
