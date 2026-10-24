import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LuArrowUp, LuCheck, LuCpu, LuRotateCcw } from "react-icons/lu";
import { AgentApiError, sendAgentAuthorTurn, undoAgentAuthorTurn, type AgentDefinition } from "../../../api/agents";
import { fetchSettings } from "../../../api/client";
import { ModelPicker } from "../../../components/ModelPicker";
import { completeDefinition } from "../model/definition";

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; changes?: Array<{ label: string; value: string }>; failed?: boolean };

const GREETING =
  "Who is this agent for, and what does a good result look like? I'll ask a few questions before I fill the config.";

export function authorMessagesFromTranscript(
  transcript: Array<{ id: string; role: "user" | "assistant"; text: string; summaryLines?: Array<{ label: string; value: string }> }>,
): ChatMessage[] {
  return [
    { id: "greeting", role: "assistant", text: GREETING },
    ...transcript.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.summaryLines && message.summaryLines.length > 0 ? { changes: message.summaryLines } : {}),
    })),
  ];
}

function ChangeCard({
  changes,
  pending,
  onKeep,
  onUndo,
}: {
  changes: Array<{ label: string; value: string }>;
  pending: boolean;
  onKeep: () => void;
  onUndo: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]" data-status={pending ? "pending" : "kept"}>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        {changes.map((line) => (
          <div key={line.label} className="flex min-w-0 items-start gap-2">
            <span className="w-[78px] shrink-0 text-xs leading-[1.33333] text-[var(--sf-text-3)]">{line.label}</span>
            <span className="min-w-0 break-words text-xs leading-[1.33333] text-[var(--sf-text-1)]">{line.value}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-t-[var(--sf-hairline)] px-3 py-2">
        {pending ? (
          <>
            <button type="button" onClick={onKeep} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--sf-text-1)] px-2.5">
              <LuCheck aria-hidden className="size-3 shrink-0 text-[var(--sf-ground)]" />
              <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-ground)]">Keep</span>
            </button>
            <button
              type="button"
              onClick={onUndo}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] px-2.5"
            >
              <LuRotateCcw aria-hidden className="size-3 shrink-0 text-[var(--sf-text-2)]" />
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-1)]">Undo</span>
            </button>
          </>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] leading-normal text-[var(--sf-text-3)]">
          {pending ? "Applied to the config" : "Kept"}
        </span>
      </div>
    </div>
  );
}

/**
 * Chat with the agent author. Each turn sends the current draft (including
 * the operator's direct edits); changes apply to the config immediately and
 * the last one can be undone.
 */
export function AgentAuthorChatColumn({
  definition,
  onDefinitionChange,
  sessionId,
  initialMessages,
  initialModel,
  ensureSession,
  onSessionId,
}: {
  definition: AgentDefinition;
  onDefinitionChange: (
    next: AgentDefinition,
    source: "author" | ReadonlyArray<{ label: string; value?: string }>,
    sent?: AgentDefinition,
  ) => void;
  sessionId?: string;
  initialMessages?: ChatMessage[];
  initialModel?: string;
  ensureSession: () => Promise<string>;
  onSessionId?: (sessionId: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? [{ id: "greeting", role: "assistant", text: GREETING }]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState(initialModel ?? "");
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | undefined>(sessionId);
  const definitionRef = useRef(definition);
  const ensureRef = useRef(ensureSession);
  const onChangeRef = useRef(onDefinitionChange);
  definitionRef.current = definition;
  ensureRef.current = ensureSession;
  onChangeRef.current = onDefinitionChange;
  const modelRef = useRef(initialModel ?? "");
  modelRef.current = chatModel;

  useEffect(() => {
    if (sessionId) sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void fetchSettings()
      .then((settings) => {
        if (cancelled) return;
        const next = settings.defaultModel?.trim() ?? "";
        setDefaultModel(next || null);
        setChatModel((current) => current || next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function append(message: ChatMessage) {
    setMessages((prev) => [...prev, message]);
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }));
  }

  async function onSubmit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setPendingId(null);
    append({ id: `u-${Date.now()}`, role: "user", text });
    setSending(true);
    try {
      const idForTurn = await ensureRef.current();
      sessionRef.current = idForTurn;
      const sent = definitionRef.current;
      const result = await sendAgentAuthorTurn({
        message: text,
        sessionId: idForTurn,
        draft: sent,
        ...(modelRef.current ? { model: modelRef.current } : {}),
      });
      sessionRef.current = result.sessionId;
      onSessionId?.(result.sessionId);
      const id = `a-${Date.now()}`;
      if (result.summaryLines.length > 0) {
        onChangeRef.current(result.draft as AgentDefinition, result.summaryLines, sent);
        setPendingId(id);
      }
      append({
        id,
        role: "assistant",
        text: result.text || (result.summaryLines.length > 0 ? "I updated the draft." : "No changes."),
        ...(result.summaryLines.length > 0 ? { changes: result.summaryLines } : {}),
      });
    } catch (error) {
      append({
        id: `a-${Date.now()}`,
        role: "assistant",
        failed: true,
        text: error instanceof AgentApiError ? `The author could not finish that turn (${error.code}).` : "The author could not finish that turn.",
      });
    } finally {
      setSending(false);
    }
  }

  async function onUndo() {
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    try {
      const restored = await undoAgentAuthorTurn(sessionId);
      onDefinitionChange(completeDefinition(restored.draft), "author");
      setMessages((prev) => prev.map((message) => (message.id === pendingId && message.role === "assistant" ? { ...message, changes: undefined, text: `${message.text}\n\nUndone.` } : message)));
      setPendingId(null);
    } catch (error) {
      append({
        id: `a-${Date.now()}`,
        role: "assistant",
        failed: true,
        text:
          error instanceof AgentApiError && error.code === "agent.conflict"
            ? "Can't undo: you edited those fields since. Change them back in the config."
            : "Undo failed.",
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSubmit();
    }
  }

  const sendable = input.trim().length > 0 && !sending;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-11 w-full shrink-0 items-center border-b border-b-[var(--sf-hairline)] px-5">
        <div className="flex items-center gap-2">
          <LuCpu aria-hidden className="size-3.5 text-[#a78bfa]" />
          <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Agent author</span>
        </div>
      </div>
      <div ref={listRef} className="flex min-h-[280px] flex-1 flex-col gap-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex flex-col gap-1 rounded-lg bg-[var(--sf-raised)] px-3 py-2.5">
              <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">You</span>
              <p className="whitespace-pre-wrap text-[13px] leading-[1.6] text-[var(--sf-text-1)]">{message.text}</p>
            </div>
          ) : (
            <div key={message.id} className="flex min-w-0 flex-col gap-2">
              <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">Agent author</span>
              <p
                className={`whitespace-pre-wrap text-[13px] leading-[1.6] ${message.failed ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-1)]"}`}
              >
                {message.text}
              </p>
              {message.changes ? (
                <ChangeCard
                  changes={message.changes}
                  pending={message.id === pendingId}
                  onKeep={() => setPendingId(null)}
                  onUndo={() => void onUndo()}
                />
              ) : null}
            </div>
          ),
        )}
        {sending ? <p className="text-[13px] text-[var(--sf-text-3)]">Working…</p> : null}
      </div>
      <form onSubmit={onSubmit} className="shrink-0 px-4 pb-4">
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3 py-2.5 focus-within:border-[#ffffff33]">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Describe a change, like “read files but never edit them” or “ask before Notion writes”"
            aria-label="Message the agent author"
            className="w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
          />
          <div className="flex items-center gap-1.5">
            <ModelPicker
              variant="chip"
              placement="up"
              ariaLabel="Agent author model"
              value={chatModel || null}
              defaultModel={defaultModel}
              onChange={(next) => next && setChatModel(next)}
            />
            {chatModel && chatModel === defaultModel ? (
              <span className="whitespace-nowrap text-[11px] leading-normal text-[var(--sf-text-3)]">Default</span>
            ) : null}
            <span className="flex-1" />
            <button
              type="submit"
              aria-label="Send"
              disabled={!sendable}
              className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
                sendable ? "bg-[var(--sf-text-1)] text-[var(--sf-ground)]" : "cursor-not-allowed bg-[var(--sf-raised)] text-[var(--sf-text-2)]"
              }`}
            >
              <LuArrowUp aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
