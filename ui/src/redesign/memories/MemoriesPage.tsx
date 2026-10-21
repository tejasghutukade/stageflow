import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { LuArchive, LuBookOpen, LuInfo, LuPlus, LuSearch, LuX } from "react-icons/lu";
import {
  createMemory,
  deleteMemoryCard,
  fetchMemories,
  fetchMemory,
  fetchMemoryCard,
  fetchMemoryCards,
  fetchPreviousMemoryCard,
  fetchPreviousMemoryCover,
  replaceMemoryCover,
  updateMemoryCard,
  type MemoryDetail,
  type MemoryRequestError,
  type MemorySummary,
} from "../../api";
import { memoryPath, navigate } from "../../routes";
import { CardsSection, CoverPanel, DeleteCardDialog, PAGE_LIMIT } from "./MemoryDetailParts";

const MONO = "sf-mono";

const HOW_MEMORY_TILES = [
  { title: "Cover page", text: "One short page of what matters most. Every stage reads it." },
  { title: "Cards", text: "Details filed by key — a ticket, an order, a release." },
  { title: "Attach", text: "Point a pipeline at the memory and its stages can use it." },
] as const;

export type MemoryPageLoaded = {
  detail: MemoryDetail;
  previousCover: string | null;
  keys: string[];
  card: { key: string; body: string; previous: string | null } | null;
};

function failureCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as MemoryRequestError).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function MemoriesPage({ memoryId, loaded }: { memoryId?: string; loaded?: MemoryPageLoaded }) {
  const [memories, setMemories] = useState<MemorySummary[] | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(loaded?.detail ?? null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [coverDraft, setCoverDraft] = useState(loaded?.detail.body ?? "");
  const [previousCover, setPreviousCover] = useState<string | null>(loaded?.previousCover ?? null);
  const [savingCover, setSavingCover] = useState(false);
  const [keys, setKeys] = useState<string[]>(loaded?.keys ?? []);
  const [selectedKey, setSelectedKey] = useState<string | null>(loaded?.card?.key ?? null);
  const [cardBody, setCardBody] = useState<string | null>(loaded?.card?.body ?? null);
  const [previousCard, setPreviousCard] = useState<string | null>(loaded?.card?.previous ?? null);
  const [cardDraft, setCardDraft] = useState(loaded?.card?.body ?? "");
  const [savingCard, setSavingCard] = useState(false);
  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [coverEditing, setCoverEditing] = useState(false);
  const [coverPrevious, setCoverPrevious] = useState(false);
  const [cardEditing, setCardEditing] = useState(false);
  const [cardPrevious, setCardPrevious] = useState(false);
  const [cardFilter, setCardFilter] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const memoryIdRef = useRef(memoryId);
  const openCardKey = useRef<string | null>(loaded?.card?.key ?? null);
  memoryIdRef.current = memoryId;

  useEffect(() => {
    let live = true;
    void fetchMemories().then(
      (body) => { if (live) setMemories(body.memories); },
      () => { if (live) setPageError("Memories could not be loaded."); },
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    setPageError(null);
  }, [memoryId]);

  useEffect(() => {
    if (loaded) return;
    if (!memoryId) {
      setDetail(null);
      setCoverDraft("");
      setPreviousCover(null);
      setKeys([]);
      setSelectedKey(null);
      setCardBody(null);
      setPreviousCard(null);
      setCardDraft("");
      return;
    }
    let live = true;
    setCoverEditing(false);
    setCoverPrevious(false);
    setCardEditing(false);
    setCardPrevious(false);
    setCardFilter("");
    setDeleteOpen(false);
    setDetail(null);
    setCoverDraft("");
    setPreviousCover(null);
    setKeys([]);
    setSelectedKey(null);
    openCardKey.current = null;
    setCardBody(null);
    setPreviousCard(null);
    setCardDraft("");
    void (async () => {
      try {
        const [page, cards] = await Promise.all([fetchMemory(memoryId), fetchMemoryCards(memoryId)]);
        if (!live) return;
        setDetail(page);
        setCoverDraft(page.body);
        setKeys(cards.keys);
      } catch {
        if (live) setPageError(`Memory "${memoryId}" could not be opened.`);
        return;
      }
      try {
        const previous = await fetchPreviousMemoryCover(memoryId);
        if (live) setPreviousCover(previous);
      } catch {
        if (live) setPreviousCover(null);
      }
    })();
    return () => { live = false; };
  }, [memoryId, loaded]);

  function hasUnsavedEdits(): boolean {
    if (!detail) return false;
    if (coverEditing && coverDraft !== detail.body) return true;
    if (cardEditing && cardBody !== null && cardDraft !== cardBody) return true;
    return false;
  }

  function navigateToMemory(nextId: string) {
    if (nextId === memoryId) return;
    if (hasUnsavedEdits() && !window.confirm("Discard unsaved edits?")) return;
    navigate(`#${memoryPath(nextId)}`);
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createMemory({ id: id.trim(), description: description.trim() });
      setMemories((current) => {
        const next = [
          ...(current ?? []).filter((item) => item.id !== created.id),
          { id: created.id, description: created.description, cardCount: created.cardCount ?? 0 },
        ];
        next.sort((a, b) => a.id.localeCompare(b.id));
        return next;
      });
      setId("");
      setDescription("");
      setCreateOpen(false);
      navigate(`#${memoryPath(created.id)}`);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "That memory could not be created. Check the id and description.");
    } finally {
      setCreating(false);
    }
  }

  async function onSaveCover(event: FormEvent) {
    event.preventDefault();
    if (!memoryId || !detail || detail.id !== memoryId) return;
    const savedId = memoryId;
    const body = coverDraft;
    if (body.length > PAGE_LIMIT) {
      setPageError("That text is too long.");
      return;
    }
    const previous = detail.body;
    setSavingCover(true);
    setPageError(null);
    try {
      const updated = await replaceMemoryCover(savedId, body);
      if (memoryIdRef.current !== savedId) return;
      setPreviousCover(previous);
      setDetail(updated);
      setCoverDraft(updated.body);
      setCoverEditing(false);
      setCoverPrevious(false);
    } catch (caught) {
      setPageError(failureCode(caught) === "MEMORY_TOO_LARGE" ? "That text is too long." : "That cover could not be saved.");
    } finally {
      setSavingCover(false);
    }
  }

  async function openCard(key: string) {
    if (!memoryId) return;
    setSelectedKey(key);
    setCardEditing(false);
    setCardPrevious(false);
    openCardKey.current = key;
    setCardDraft("");
    setCardBody(null);
    setPreviousCard(null);
    setPageError(null);
    setCardLoading(true);
    try {
      const card = await fetchMemoryCard(memoryId, key);
      if (openCardKey.current !== key) return;
      setCardBody(card.body);
      setCardDraft(card.body);
    } catch {
      if (openCardKey.current !== key) return;
      setCardBody(null);
      setPreviousCard(null);
      setPageError("That card could not be opened.");
      return;
    } finally {
      if (openCardKey.current === key) setCardLoading(false);
    }
    try {
      const previous = await fetchPreviousMemoryCard(memoryId, key);
      if (openCardKey.current !== key) return;
      setPreviousCard(previous);
    } catch {
      if (openCardKey.current !== key) return;
      setPreviousCard(null);
    }
  }

  async function onCorrect(event: FormEvent) {
    event.preventDefault();
    if (!memoryId || !selectedKey) return;
    const savedId = memoryId;
    const key = selectedKey;
    const draft = cardDraft;
    if (draft.length > PAGE_LIMIT) {
      setPageError("That text is too long.");
      return;
    }
    const previous = cardBody;
    setSavingCard(true);
    setPageError(null);
    try {
      const updated = await updateMemoryCard(savedId, key, draft);
      if (memoryIdRef.current !== savedId || openCardKey.current !== key) return;
      setPreviousCard(previous);
      setCardBody(updated.body);
      setCardDraft(updated.body);
      setCardEditing(false);
      setCardPrevious(false);
    } catch (caught) {
      setPageError(failureCode(caught) === "MEMORY_TOO_LARGE" ? "That text is too long." : "That card could not be saved.");
    } finally {
      setSavingCard(false);
    }
  }

  async function onRestore() {
    if (!memoryId || !selectedKey || previousCard === null) return;
    const savedId = memoryId;
    const key = selectedKey;
    const restored = previousCard;
    const current = cardBody;
    setSavingCard(true);
    setPageError(null);
    try {
      const updated = await updateMemoryCard(savedId, key, restored);
      if (memoryIdRef.current !== savedId || openCardKey.current !== key) return;
      setPreviousCard(current);
      setCardBody(updated.body);
      setCardDraft(updated.body);
      setCardPrevious(false);
    } catch (caught) {
      setPageError(failureCode(caught) === "MEMORY_TOO_LARGE" ? "That text is too long." : "That card could not be restored.");
    } finally {
      setSavingCard(false);
    }
  }

  async function onDelete() {
    if (!memoryId || !selectedKey) return;
    const key = selectedKey;
    setSavingCard(true);
    setPageError(null);
    try {
      await deleteMemoryCard(memoryId, key);
      const nextKeys = keys.filter((item) => item !== key);
      setKeys(nextKeys);
      setMemories((current) => current?.map((item) => (item.id === memoryId ? { ...item, cardCount: nextKeys.length } : item)) ?? null);
      openCardKey.current = null;
      setSelectedKey(null);
      setCardBody(null);
      setPreviousCard(null);
      setCardDraft("");
      setCardEditing(false);
      setCardPrevious(false);
      setDeleteOpen(false);
    } catch {
      setDeleteOpen(false);
      setPageError("That card could not be deleted.");
    } finally {
      setSavingCard(false);
    }
  }

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (memories ?? []).filter((item) => {
      if (!query) return true;
      return item.id.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
    });
  }, [filter, memories]);
  const empty = memories !== null && memories.length === 0;
  const cardTotal = memories === null
    ? null
    : memories.reduce((sum, item) => sum + (item.id === memoryId && detail ? keys.length : item.cardCount), 0);

  useEffect(() => {
    if (!memoryId || !detail) return;
    setMemories((current) => current?.map((item) => (item.id === memoryId ? { ...item, cardCount: keys.length } : item)) ?? null);
  }, [memoryId, detail, keys.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (!memories || memories.length === 0 || visible.length === 0) return;
      const index = visible.findIndex((item) => item.id === memoryId);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const nextIndex = event.key === "ArrowDown"
          ? Math.min(visible.length - 1, index < 0 ? 0 : index + 1)
          : Math.max(0, index < 0 ? 0 : index - 1);
        const next = visible[nextIndex];
        if (next) navigateToMemory(next.id);
      }
      if (event.key === "Enter" && index < 0) {
        const next = visible[0];
        if (next) navigateToMemory(next.id);
      }
      if (event.key === "e" || event.key === "E") {
        if (!detail || createOpen || deleteOpen || helpOpen) return;
        if (selectedKey && cardBody !== null && !cardLoading && !cardEditing) {
          event.preventDefault();
          setCardDraft(cardBody);
          setCardEditing(true);
          return;
        }
        if (!coverEditing && (!selectedKey || cardBody === null)) {
          event.preventDefault();
          setCoverDraft(detail.body);
          setCoverEditing(true);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardBody, cardDraft, cardEditing, cardLoading, coverDraft, coverEditing, createOpen, deleteOpen, detail, filter, helpOpen, memories, memoryId, selectedKey, visible]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[var(--sf-ground)] text-[var(--sf-text-1)]" data-testid="memories-page">
      <header className="flex flex-col gap-3 border-b border-b-[var(--sf-hairline)] px-7 pb-4 pt-5">
        <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Connect</p>
        <div className="flex items-center justify-between gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-2xl font-semibold leading-[1.33] tracking-[-0.5px] text-[var(--sf-text-1)]">Memories</h1>
            <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">
              A filing cabinet your pipelines and agents keep reading — a cover page for the gist, cards for the details.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
          >
            <LuPlus className="size-3.5" aria-hidden />
            New memory
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <MemoryRail
          items={visible}
          selectedId={memoryId}
          openCardCount={detail && memoryId ? keys.length : null}
          filter={filter}
          disabled={empty}
          empty={empty}
          onFilter={setFilter}
          onSelect={navigateToMemory}
        />
        {empty ? (
          <MemoryEmpty onCreate={() => setCreateOpen(true)} onHelp={() => setHelpOpen(true)} />
        ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-auto px-7 py-6" data-testid="memory-page">
          {pageError ? <p className="text-xs text-[var(--sf-fail)]">{pageError}</p> : null}
          {detail ? (
            <>
              <div className="flex items-start justify-between gap-6">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center gap-2.5">
                    <h2 className={`${MONO} text-xl font-semibold leading-[1.4] tracking-[-0.3px]`}>{detail.id}</h2>
                    <span className={`${MONO} rounded-full border border-[var(--sf-hairline-strong)] px-2 py-px text-[11px] leading-normal text-[var(--sf-text-3)]`}>v1</span>
                  </div>
                  <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">{detail.description}</p>
                </div>
              </div>
              <CoverPanel
                body={detail.body}
                draft={coverDraft}
                previous={previousCover}
                editing={coverEditing}
                showPrevious={coverPrevious}
                saving={savingCover}
                onDraft={setCoverDraft}
                onEdit={() => { setCoverDraft(detail.body); setCoverEditing(true); }}
                onCancel={() => { setCoverDraft(detail.body); setCoverEditing(false); }}
                onShowPrevious={setCoverPrevious}
                onSubmit={(event) => void onSaveCover(event)}
              />
              <CardsSection
                keys={keys}
                filter={cardFilter}
                selectedKey={selectedKey}
                body={cardBody}
                previous={previousCard}
                draft={cardDraft}
                editing={cardEditing}
                showPrevious={cardPrevious}
                saving={savingCard}
                loading={cardLoading}
                onFilter={setCardFilter}
                onOpen={(key) => void openCard(key)}
                onDraft={setCardDraft}
                onEdit={() => { setCardDraft(cardBody ?? ""); setCardEditing(true); }}
                onCancel={() => { setCardDraft(cardBody ?? ""); setCardEditing(false); }}
                onShowPrevious={setCardPrevious}
                onSubmit={(event) => void onCorrect(event)}
                onRestore={() => void onRestore()}
                onDelete={() => setDeleteOpen(true)}
              />
            </>
          ) : (
            <p className="text-sm text-[var(--sf-text-3)]">Open a memory to read its page.</p>
          )}
        </div>
        )}
      </div>
      <footer className="flex h-11 shrink-0 items-center justify-between border-t border-t-[var(--sf-hairline)] px-7">
        <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
          {memories === null
            ? ""
            : `${countPhrase(memories.length, "memory", "memories")}${cardTotal === null ? "" : ` · ${countPhrase(cardTotal, "card", "cards")}`}`}
        </p>
        <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">↑ ↓ to move · ↵ to open · E edit</p>
      </footer>
      {deleteOpen && memoryId && selectedKey ? (
        <DeleteCardDialog
          memoryId={memoryId}
          cardKey={selectedKey}
          busy={savingCard}
          onKeep={() => setDeleteOpen(false)}
          onDelete={() => void onDelete()}
        />
      ) : null}
      {createOpen ? (
        <NewMemoryDialog
          id={id}
          description={description}
          creating={creating}
          createError={createError}
          onId={setId}
          onDescription={setDescription}
          onClose={() => { setCreateOpen(false); setCreateError(null); }}
          onSubmit={(event) => void onCreate(event)}
        />
      ) : null}
      {helpOpen ? (
        <MemoryHelpDialog onClose={() => setHelpOpen(false)} />
      ) : null}
    </div>
  );
}

function countPhrase(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function MemoryRail({
  items,
  selectedId,
  openCardCount,
  filter,
  disabled,
  empty,
  onFilter,
  onSelect,
}: {
  items: MemorySummary[];
  selectedId?: string;
  openCardCount: number | null;
  filter: string;
  disabled: boolean;
  empty: boolean;
  onFilter: (value: string) => void;
  onSelect: (memoryId: string) => void;
}) {
  return (
    <aside className="flex w-[272px] shrink-0 flex-col gap-3 border-r border-r-[var(--sf-hairline)] p-4">
      <label className="flex h-8 items-center gap-2 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] px-2.5">
        <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
        <input
          value={filter}
          disabled={disabled}
          onChange={(event) => onFilter(event.target.value)}
          placeholder="Filter memories…"
          className="min-w-0 flex-1 bg-transparent text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)] disabled:cursor-default"
        />
      </label>
      {empty ? (
        <div className="flex flex-col gap-1 rounded-lg border border-dashed border-[var(--sf-hairline-strong)] px-3 py-4">
          <p className="text-[13px] font-medium leading-normal text-[var(--sf-text-2)]">Nothing filed yet</p>
          <p className="text-xs leading-[1.4] text-[var(--sf-text-3)]">Memories you create will list here with their card counts.</p>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto" data-testid="memory-list">
          {items.map((item) => {
            const selected = item.id === selectedId;
            const count = selected && openCardCount !== null ? openCardCount : item.cardCount;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={selected ? "true" : undefined}
                  className={`flex w-full flex-col gap-1.5 rounded-lg p-3 text-left ${selected ? "border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)]" : "border border-transparent"}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`size-1.5 shrink-0 rounded-full ${selected ? "bg-[var(--sf-needs)]" : "bg-[#3a3d44]"}`} />
                    <span className={`${MONO} min-w-0 flex-1 truncate text-[13px] leading-normal ${selected ? "font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}>{item.id}</span>
                    <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-text-3)]`}>{count}</span>
                  </span>
                  <span className="text-xs leading-[1.4] text-[var(--sf-text-3)]">{item.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function MemoryEmpty({ onCreate, onHelp }: { onCreate: () => void; onHelp: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center px-7 py-10">
      <div className="flex w-[560px] max-w-full flex-col items-center gap-6">
        <div className="flex size-14 items-center justify-center rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)]">
          <LuArchive className="size-6 text-[var(--sf-text-2)]" aria-hidden />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-xl font-semibold leading-[1.4] tracking-[-0.3px] text-[var(--sf-text-1)]">No memories yet</h2>
          <p className="max-w-[440px] text-center text-[13px] leading-[1.55] text-[var(--sf-text-2)]">
            A memory is a page your pipelines and agents can keep reading, plus cards for the details. Create one, then attach it to a pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCreate}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
          >
            <LuPlus className="size-3.5" aria-hidden />
            Create your first memory
          </button>
          <button
            type="button"
            onClick={onHelp}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-2)]"
          >
            <LuBookOpen className="size-3.5" aria-hidden />
            How memory works
          </button>
        </div>
        <div className="grid w-full grid-cols-3 gap-3 pt-2">
          {HOW_MEMORY_TILES.map((tile) => (
            <HowTile key={tile.title} title={tile.title} text={tile.text} />
          ))}
        </div>
      </div>
    </div>
  );
}

function HowTile({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-3.5">
      <p className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{title}</p>
      <p className="text-xs leading-[1.45] text-[var(--sf-text-3)]">{text}</p>
    </div>
  );
}

function MemoryHelpDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#000000a6] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-[560px] max-w-full flex-col gap-5 rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] p-6 shadow-[0px_24px_64px_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-help-title"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="memory-help-title" className="text-base font-semibold leading-normal text-[var(--sf-text-1)]">How memory works</h2>
          <button type="button" onClick={onClose} className="text-[var(--sf-text-3)]" aria-label="Close">
            <LuX className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {HOW_MEMORY_TILES.map((tile) => (
            <HowTile key={tile.title} title={tile.title} text={tile.text} />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function NewMemoryDialog({
  id,
  description,
  creating,
  createError,
  onId,
  onDescription,
  onClose,
  onSubmit,
}: {
  id: string;
  description: string;
  creating: boolean;
  createError: string | null;
  onId: (value: string) => void;
  onDescription: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#000000a6]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-memory-title"
        className="flex w-[480px] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] shadow-[0px_24px_64px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-start gap-3 border-b border-b-[var(--sf-hairline)] px-5 py-4">
          <div className="flex flex-1 flex-col gap-1">
            <h2 id="new-memory-title" className="text-base font-semibold leading-normal text-[var(--sf-text-1)]">New memory</h2>
            <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">Give it an id pipelines can refer to, and say what it is for.</p>
          </div>
          <button type="button" onClick={onClose} className="text-[var(--sf-text-3)]" aria-label="Close">
            <LuX className="size-4" />
          </button>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Id</span>
            <input
              value={id}
              onChange={(event) => onId(event.target.value)}
              data-testid="memory-id"
              className={`${MONO} h-9 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-3 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none`}
            />
            <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Lowercase letters, numbers and dashes. Can&apos;t be changed later.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-2)]">Description</span>
            <input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              placeholder="People this pipeline has already sourced."
              data-testid="memory-description"
              className="h-9 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-3 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
            />
          </label>
          <div className="flex items-start gap-2 rounded-lg bg-[var(--sf-running-bg)] px-3 py-2.5">
            <LuInfo className="mt-px size-3.5 shrink-0 text-[var(--sf-running)]" aria-hidden />
            <p className="text-xs leading-[1.45] text-[var(--sf-text-2)]">The memory starts empty. Write its cover page after you create it, then attach it to a pipeline.</p>
          </div>
          {createError ? <p className="text-xs text-[var(--sf-fail)]">{createError}</p> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-t-[var(--sf-hairline)] bg-[var(--sf-ground)] px-5 py-3">
          <button type="button" onClick={onClose} className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-2)]">
            Cancel
          </button>
          <button
            type="submit"
            disabled={creating || id.trim().length === 0 || description.trim().length === 0}
            className="flex h-8 items-center rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)] disabled:opacity-40"
          >
            Create memory
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
