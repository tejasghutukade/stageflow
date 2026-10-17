import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { LuTriangleAlert } from "react-icons/lu";
import type { ChatMessageError } from "./adapters";

const MarkdownText = lazy(() => import("./MarkdownText"));

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
    <span className="inline-flex items-center gap-1" role="status" aria-label="The assistant is typing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="sf-chat-dot size-1.5 rounded-full bg-[var(--sf-text-3)]" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </span>
  );
}

/** Counts down a rate-limit wait so the visitor knows when to try again. */
function RetryCountdown({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(Math.max(0, Math.ceil(seconds)));
  useEffect(() => {
    if (left <= 0) return;
    const timer = window.setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left]);
  return (
    <span className="tabular-nums text-[var(--sf-text-2)]" aria-live="polite">
      {left > 0 ? `You can try again in ${left}s.` : "You can try again now."}
    </span>
  );
}

function isChatError(value: unknown): value is ChatMessageError {
  return typeof value === "object" && value !== null && typeof (value as { friendly?: unknown }).friendly === "string";
}

export function AssistantMessageBody() {
  const status = useAuiState((s) => s.message.status);
  const waiting = useAuiState((s) => (s.message.metadata as { custom?: { waiting?: boolean } } | undefined)?.custom?.waiting === true);
  const hasText = useAuiState((s) => s.message.content.some((part) => part.type === "text" && part.text.length > 0));
  const running = status?.type === "running";
  const error = status?.type === "incomplete" && status.reason === "error" && isChatError(status.error) ? status.error : null;

  return (
    <div className="flex min-w-0 flex-col gap-2 text-[15px] leading-relaxed text-[var(--sf-text-1)]">
      {hasText ? <MessagePrimitive.Parts components={{ Text: TextPart }} /> : null}
      {running && waiting ? (
        <p className="m-0 text-sm text-[var(--sf-needs)]" role="status">
          Checking with the team…
        </p>
      ) : running && !hasText ? (
        <Dots />
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-fail-bg)] px-3 py-2 text-sm text-[var(--sf-text-1)]"
        >
          <LuTriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sf-fail)]" />
          <div className="flex flex-col gap-0.5">
            <span>{error.friendly}</span>
            {error.code === "web_chat.rate_limited" && error.retryAfterSec ? <RetryCountdown seconds={error.retryAfterSec} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
