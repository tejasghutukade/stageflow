import { MessagePrimitive, ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { LuTriangleAlert } from "react-icons/lu";
import type { ChatMessageError } from "./adapters";
import { needsNewConversation } from "./errors";
import { registerBuiltinUiParts } from "./parts/builtins";
import { InlinePreviewCard } from "./parts/artifactRefPart";
import { renderUiPart, type UiPartRendererContext } from "./parts/registry";
import { useVisitorArtifactLoader } from "./visitorArtifactContext";

registerBuiltinUiParts();

const NO_PARTS: readonly unknown[] = Object.freeze([]);

/** Returns the stored array itself (or one shared empty array) so store selectors stay referentially stable. */
export function uiPartsFromMetadata(metadata: unknown): readonly unknown[] {
  if (typeof metadata !== "object" || metadata === null) return NO_PARTS;
  const custom = (metadata as { custom?: { uiParts?: unknown } }).custom;
  return Array.isArray(custom?.uiParts) ? custom.uiParts : NO_PARTS;
}

export function UiMessageParts({
  parts,
  onOpenConsole,
  chat,
  loadVisitorArtifact,
}: {
  parts: readonly unknown[];
  onOpenConsole?: UiPartRendererContext["onOpenConsole"];
  chat?: UiPartRendererContext["chat"];
  loadVisitorArtifact?: UiPartRendererContext["loadVisitorArtifact"];
}) {
  if (parts.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {parts.map((part, index) => (
        <div key={index}>{renderUiPart(part, { onOpenConsole, chat, loadVisitorArtifact })}</div>
      ))}
    </div>
  );
}

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

function uiPreviewOf(metadata: unknown): { phase?: string; message?: string } | undefined {
  return (metadata as { custom?: { uiPreview?: { phase?: string; message?: string } } } | undefined)?.custom?.uiPreview;
}

export function AssistantMessageBody() {
  const status = useAuiState((s) => s.message.status);
  const waiting = useAuiState((s) => (s.message.metadata as { custom?: { waiting?: boolean } } | undefined)?.custom?.waiting === true);
  const hasText = useAuiState((s) => s.message.content.some((part) => part.type === "text" && part.text.length > 0));
  const uiParts = useAuiState((s) => uiPartsFromMetadata(s.message.metadata));
  const previewPhase = useAuiState((s) => uiPreviewOf(s.message.metadata)?.phase);
  const previewMessage = useAuiState((s) => uiPreviewOf(s.message.metadata)?.message);
  const loadVisitorArtifact = useVisitorArtifactLoader() ?? undefined;
  const preview =
    previewPhase === "error"
      ? { phase: "error" as const, message: previewMessage }
      : previewPhase === "skeleton"
        ? { phase: "skeleton" as const }
        : null;
  const running = status?.type === "running";
  const error = status?.type === "incomplete" && status.reason === "error" && isChatError(status.error) ? status.error : null;

  return (
    <div className="flex min-w-0 flex-col gap-2 text-[15px] leading-relaxed text-[var(--sf-text-1)]">
      {hasText ? <MessagePrimitive.Parts components={{ Text: TextPart }} /> : null}
      {preview && uiParts.length === 0 ? <InlinePreviewCard phase={preview.phase} message={preview.message} /> : null}
      <UiMessageParts parts={uiParts} loadVisitorArtifact={loadVisitorArtifact} />
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
            {needsNewConversation(error.code) ? (
              <ThreadListPrimitive.New className="mt-1 self-start rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3 py-1 text-sm font-medium text-[var(--sf-text-1)] hover:bg-[var(--sf-active)]">
                Start a new chat
              </ThreadListPrimitive.New>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
