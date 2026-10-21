import { useEffect, useRef, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@astryxdesign/core/Markdown";
import { LuBookOpen, LuClock, LuLock, LuPencil, LuRotateCcw, LuSave, LuSearch, LuTrash2, LuTriangleAlert, LuX } from "react-icons/lu";
import { lineDiff } from "./lineDiff";

const MONO = "sf-mono";
const GHOST_BTN = "flex h-7 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] px-2.5 text-xs font-medium leading-[1.33333]";
const PRIMARY_BTN = "flex h-7 items-center gap-1.5 rounded-md bg-[var(--sf-text-1)] px-3 text-xs font-medium leading-[1.33333] text-[var(--sf-ground)] disabled:opacity-40";
export const PAGE_LIMIT = 64_000;
export const CARD_LIMIT = 200;

function chars(text: string): string {
  return text.length.toLocaleString("en-US");
}

function VersionToggle({ previous, onChange }: { previous: boolean; onChange: (previous: boolean) => void }) {
  return (
    <div className="flex h-7 items-center rounded-md bg-[var(--sf-ground)] p-0.5">
      <button
        type="button"
        aria-pressed={!previous}
        onClick={() => onChange(false)}
        className={`h-6 rounded-sm px-2.5 text-xs leading-[1.33333] ${previous ? "text-[var(--sf-text-3)]" : "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"}`}
      >
        Current
      </button>
      <button
        type="button"
        aria-pressed={previous}
        onClick={() => onChange(true)}
        className={`h-6 rounded-sm px-2.5 text-xs leading-[1.33333] ${previous ? "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}
      >
        Previous
      </button>
    </div>
  );
}

function DiffSurface({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;
  return (
    <>
      <div className="flex items-center gap-3 border-b border-b-[var(--sf-hairline)] bg-[var(--sf-ground)] px-4 py-2">
        <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-ok)]`}>+{added} added</span>
        <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-fail)]`}>−{removed} removed</span>
        <span className="flex-1 text-right text-xs leading-[1.33333] text-[var(--sf-text-3)]">Read-only — agents cannot open this copy</span>
      </div>
      <div className="flex flex-1 flex-col overflow-auto bg-[var(--sf-ground)] py-2" data-testid="memory-diff">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`flex min-h-6 items-center gap-3 px-4 ${line.kind === "added" ? "bg-[var(--sf-ok-bg)]" : line.kind === "removed" ? "bg-[var(--sf-fail-bg)]" : ""}`}
          >
            <span className={`${MONO} w-3 text-center text-[13px] leading-normal ${line.kind === "added" ? "text-[var(--sf-ok)]" : line.kind === "removed" ? "text-[var(--sf-fail)]" : "text-[var(--sf-queued-dim)]"}`}>
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
            </span>
            <span className={`${MONO} flex-1 whitespace-pre-wrap break-words text-[13px] leading-normal ${line.kind === "same" ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-1)]"}`}>{line.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SourceEditor({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  const count = Math.max(1, value.split("\n").length);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  return (
    <div className="flex min-h-48 flex-1 gap-4 bg-[var(--sf-ground)] px-4 py-3">
      <div className={`${MONO} w-5 shrink-0 select-none text-right text-xs leading-[22px] text-[var(--sf-queued-dim)]`} aria-hidden>
        {Array.from({ length: count }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <textarea
        ref={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        rows={count}
        className={`${MONO} min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-[22px] text-[var(--sf-text-1)] outline-none`}
        data-testid={testId}
      />
    </div>
  );
}

export function CoverPanel({
  body,
  draft,
  previous,
  editing,
  showPrevious,
  saving,
  onDraft,
  onEdit,
  onCancel,
  onShowPrevious,
  onSubmit,
}: {
  body: string;
  draft: string;
  previous: string | null;
  editing: boolean;
  showPrevious: boolean;
  saving: boolean;
  onDraft: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onShowPrevious: (value: boolean) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const diffing = showPrevious && previous !== null && !editing;
  return (
    <form
      onSubmit={onSubmit}
      className={`flex flex-col overflow-hidden rounded-lg border bg-[var(--sf-panel)] ${editing ? "border-[var(--sf-needs-border)]" : "border-[var(--sf-hairline-strong)]"}`}
      data-testid="memory-cover-panel"
    >
      <div className="flex h-10 items-center gap-2.5 border-b border-b-[var(--sf-hairline)] px-4">
        <LuBookOpen className="size-3.5 text-[var(--sf-text-2)]" aria-hidden />
        <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Cover page</span>
        {editing ? (
          <span className="rounded-full bg-[var(--sf-needs-bg)] px-2 py-px text-[11px] font-medium leading-normal text-[var(--sf-needs)]">Editing</span>
        ) : null}
        <span className="flex-1" />
        <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-text-3)]`}>
          {chars(editing ? draft : body)} / {PAGE_LIMIT.toLocaleString("en-US")}
        </span>
        {editing ? (
          <span key="cover-editing" className="flex items-center gap-1.5">
            <button type="button" onClick={onCancel} className={`${GHOST_BTN} text-[var(--sf-text-2)]`}>
              <LuX className="size-3" aria-hidden />
              Cancel
            </button>
            <button type="submit" disabled={saving} className={PRIMARY_BTN}>
              <LuSave className="size-3" aria-hidden />
              Save cover
            </button>
          </span>
        ) : (
          <span key="cover-reading" className="flex items-center gap-1.5">
            {previous !== null ? <VersionToggle previous={showPrevious} onChange={onShowPrevious} /> : null}
            <button
              type="button"
              onClick={(event) => { event.preventDefault(); onEdit(); }}
              className={`${GHOST_BTN} text-[var(--sf-text-1)]`}
            >
              <LuPencil className="size-3" aria-hidden />
              Edit cover
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <>
          <SourceEditor value={draft} onChange={onDraft} testId="memory-cover" />
          <div className="flex items-center gap-2 border-t border-t-[var(--sf-hairline)] px-4 py-2.5">
            <LuLock className="size-3 text-[var(--sf-text-3)]" aria-hidden />
            <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Every stage reads the cover. Saving keeps today&apos;s text as the previous copy.</span>
          </div>
        </>
      ) : diffing ? (
        <div className="flex flex-col" data-testid="memory-previous-cover">
          <DiffSurface before={previous} after={body} />
        </div>
      ) : (
        <div className="flex flex-col px-5 py-4" data-testid="memory-cover">
          {body.trim() ? (
            <Markdown headingLevelStart={2} density="compact" contentWidth="680px">{body}</Markdown>
          ) : (
            <p className="text-[13px] leading-[1.55] text-[var(--sf-text-3)]">The cover page is empty. Write what every stage should know first.</p>
          )}
        </div>
      )}
    </form>
  );
}

export function CardsSection({
  keys,
  filter,
  selectedKey,
  body,
  previous,
  draft,
  editing,
  showPrevious,
  saving,
  loading,
  onFilter,
  onOpen,
  onDraft,
  onEdit,
  onCancel,
  onShowPrevious,
  onSubmit,
  onRestore,
  onDelete,
}: {
  keys: string[];
  filter: string;
  selectedKey: string | null;
  body: string | null;
  previous: string | null;
  draft: string;
  editing: boolean;
  showPrevious: boolean;
  saving: boolean;
  loading: boolean;
  onFilter: (value: string) => void;
  onOpen: (key: string) => void;
  onDraft: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onShowPrevious: (value: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const query = filter.trim().toLowerCase();
  const shown = query ? keys.filter((key) => key.toLowerCase().includes(query)) : keys;
  const diffing = showPrevious && previous !== null && !editing;
  return (
    <section className="flex flex-1 flex-col gap-3" data-testid="memory-cards">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold leading-[1.42857] text-[var(--sf-text-1)]">Cards</h3>
          <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Detail an agent filed by key. You can correct or remove any card.</p>
        </div>
        <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-text-3)]`}>{keys.length} of {CARD_LIMIT}</span>
      </div>
      <div className="grid flex-1 grid-cols-[236px_1fr] gap-4">
        <div className="flex min-h-0 flex-col gap-2">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-2.5">
            <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
            <input
              value={filter}
              onChange={(event) => onFilter(event.target.value)}
              placeholder="Search cards…"
              aria-label="Filter cards"
              className="min-w-0 flex-1 bg-transparent text-xs leading-[1.33333] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
            />
          </label>
          {keys.length === 0 ? (
            <p className="px-2.5 text-xs leading-[1.4] text-[var(--sf-text-3)]">No cards yet. Agents file them as they work.</p>
          ) : (
            <ul className="flex flex-col gap-0.5" data-testid="memory-card-list">
              {shown.map((key) => {
                const selected = key === selectedKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => onOpen(key)}
                      className={`flex w-full flex-col rounded-lg border px-2.5 py-2 text-left ${selected ? "border-[var(--sf-hairline-strong)]" : "border-transparent"}`}
                      data-testid="memory-card-key"
                    >
                      <span className={`${MONO} truncate text-[13px] leading-normal ${selected ? "font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>{key}</span>
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 ? <li className="px-2.5 text-xs leading-[1.33333] text-[var(--sf-text-3)]">No cards match.</li> : null}
            </ul>
          )}
        </div>
        {selectedKey ? (
          <form
            onSubmit={onSubmit}
            className={`flex min-w-0 flex-col overflow-hidden rounded-lg border bg-[var(--sf-panel)] ${editing ? "border-[var(--sf-needs-border)]" : "border-[var(--sf-hairline-strong)]"}`}
            data-testid="memory-open-card"
          >
            <div className="flex items-center gap-3 border-b border-b-[var(--sf-hairline)] px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h4 className={`${MONO} truncate text-[15px] font-semibold leading-normal text-[var(--sf-text-1)]`}>{selectedKey}</h4>
                  {editing ? (
                    <span className="rounded-full bg-[var(--sf-needs-bg)] px-2 py-px text-[11px] font-medium leading-normal text-[var(--sf-needs)]">Editing</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  <LuClock className="size-3 text-[var(--sf-text-3)]" aria-hidden />
                  <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                    {editing
                      ? "Markdown source · saving keeps today's text as the previous copy"
                      : `${chars(body ?? "")} chars`}
                  </span>
                </div>
              </div>
              {editing ? (
                <span key="card-editing" className="flex items-center gap-1.5">
                  <button type="button" onClick={onCancel} className={`${GHOST_BTN} text-[var(--sf-text-2)]`}>
                    <LuX className="size-3" aria-hidden />
                    Cancel
                  </button>
                  <button type="submit" disabled={saving} className={PRIMARY_BTN}>
                    <LuSave className="size-3" aria-hidden />
                    Save card
                  </button>
                </span>
              ) : (
                <span key="card-reading" className="flex items-center gap-1.5">
                  {previous !== null ? <VersionToggle previous={showPrevious} onChange={onShowPrevious} /> : null}
                  {diffing ? (
                    <button type="button" disabled={saving} onClick={onRestore} className={`${GHOST_BTN} text-[var(--sf-text-1)] disabled:opacity-40`}>
                      <LuRotateCcw className="size-3" aria-hidden />
                      Restore this copy
                    </button>
                  ) : (
                    <>
                      <button type="button" disabled={loading} onClick={onEdit} className={`${GHOST_BTN} text-[var(--sf-text-1)] disabled:opacity-40`}>
                        <LuPencil className="size-3" aria-hidden />
                        Edit
                      </button>
                      <button type="button" disabled={saving} onClick={onDelete} className={`${GHOST_BTN} text-[var(--sf-fail)] disabled:opacity-40`}>
                        <LuTrash2 className="size-3" aria-hidden />
                        Delete
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            {loading ? (
              <div className="flex flex-1 items-center justify-center px-5 py-10" data-testid="memory-card-loading">
                <p className="text-[13px] leading-normal text-[var(--sf-text-3)]">Opening card…</p>
              </div>
            ) : editing ? (
              <SourceEditor value={draft} onChange={onDraft} testId="memory-card-draft" />
            ) : diffing ? (
              <div className="flex flex-1 flex-col" data-testid="memory-previous-card">
                <DiffSurface before={previous} after={body ?? ""} />
              </div>
            ) : (
              <div className="flex flex-1 flex-col px-5 py-4" data-testid="memory-card-body">
                <Markdown headingLevelStart={3} density="compact" contentWidth="680px">{body ?? ""}</Markdown>
              </div>
            )}
            <div className={`flex items-center gap-2 border-t border-t-[var(--sf-hairline)] px-4 py-2.5 ${editing ? "bg-[var(--sf-panel)]" : diffing ? "bg-[var(--sf-panel)]" : "bg-[var(--sf-ground)]"}`}>
              <LuLock className="size-3 text-[var(--sf-text-3)]" aria-hidden />
              <span className="flex-1 text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                {editing
                  ? "Agents see your correction the next time they read this card."
                  : diffing
                    ? "Only the last copy is kept. Restoring swaps it with the current text."
                    : "Agents can read and update this card. Only you can delete it or open the previous copy."}
              </span>
              {editing ? (
                <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-text-3)]`}>
                  {chars(draft)} / {PAGE_LIMIT.toLocaleString("en-US")}
                </span>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-6 py-10">
            <p className="text-[13px] leading-normal text-[var(--sf-text-3)]">{keys.length === 0 ? "Nothing to open yet." : "Pick a card to read it."}</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function DeleteCardDialog({
  memoryId,
  cardKey,
  busy,
  onKeep,
  onDelete,
}: {
  memoryId: string;
  cardKey: string;
  busy: boolean;
  onKeep: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onKeep();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#000000a6]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onKeep();
      }}
      data-testid="memory-delete-dialog"
    >
      <div
        className="flex w-[440px] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] shadow-[0px_24px_64px_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-delete-title"
      >
        <div className="flex gap-4 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--sf-fail-bg)]">
            <LuTriangleAlert className="size-4 text-[var(--sf-fail)]" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h2 id="memory-delete-title" className="break-words text-base font-semibold leading-[1.3] text-[var(--sf-text-1)]">Delete ‘{cardKey}’?</h2>
            <p className="text-[13px] leading-[1.55] text-[var(--sf-text-2)]">
              This removes the card and its previous copy from {memoryId}. Agents lose it the next time they read this memory. This can’t be undone.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-t-[var(--sf-hairline)] bg-[var(--sf-ground)] px-5 py-3">
          <button type="button" onClick={onKeep} className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">
            Keep card
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            className="flex h-8 items-center rounded-lg bg-[var(--sf-fail)] px-3 text-[13px] font-medium leading-normal text-[var(--sf-ground)] disabled:opacity-40"
          >
            Delete card
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
