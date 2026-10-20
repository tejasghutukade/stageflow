import { useEffect, useState, type FormEvent } from "react";
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
import { navigate } from "../../routes";
import { PageHeader } from "../shell/PageHeader";

const MONO = "font-['Geist_Mono',monospace]";
const FIELD = "rounded-lg border border-[#ffffff1a] bg-[#1a1c21] text-[#ecedee]";
const ACTION = "h-8 rounded-lg bg-[#ecedee] px-3 text-xs font-medium text-[#101114] disabled:opacity-40";

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
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    let live = true;
    void fetchMemories().then(
      (body) => { if (live) setMemories(body.memories); },
      () => { if (live) setError("Memories could not be loaded."); },
    );
    return () => { live = false; };
  }, []);

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
    setSelectedKey(null);
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
        if (live) setError(`Memory "${memoryId}" could not be opened.`);
        return;
      }
      try {
        const previous = await fetchPreviousMemoryCover(memoryId);
        if (live) setPreviousCover(previous.body);
      } catch (caught) {
        if (!live) return;
        if (failureCode(caught) === "MEMORY_NOT_FOUND") setPreviousCover(null);
        else setError(`Memory "${memoryId}" could not be opened.`);
      }
    })();
    return () => { live = false; };
  }, [memoryId, loaded]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await createMemory({ id: id.trim(), description: description.trim() });
      setMemories((current) => {
        const next = [...(current ?? []).filter((item) => item.id !== created.id), { id: created.id, description: created.description }];
        next.sort((a, b) => a.id.localeCompare(b.id));
        return next;
      });
      setId("");
      setDescription("");
      navigate(`#/memories/${encodeURIComponent(created.id)}`);
    } catch {
      setError("That memory could not be created. Check the id and description.");
    } finally {
      setCreating(false);
    }
  }

  async function onSaveCover(event: FormEvent) {
    event.preventDefault();
    if (!memoryId || !detail) return;
    setSavingCover(true);
    setError(null);
    try {
      const updated = await replaceMemoryCover(memoryId, coverDraft);
      setPreviousCover(detail.body);
      setDetail(updated);
      setCoverDraft(updated.body);
    } catch (caught) {
      setError(failureCode(caught) === "MEMORY_TOO_LARGE" ? "That text is too long." : "That cover could not be saved.");
    } finally {
      setSavingCover(false);
    }
  }

  async function openCard(key: string) {
    if (!memoryId) return;
    setSelectedKey(key);
    setError(null);
    try {
      const card = await fetchMemoryCard(memoryId, key);
      setCardBody(card.body);
      setCardDraft(card.body);
    } catch {
      setCardBody(null);
      setPreviousCard(null);
      setError("That card could not be opened.");
      return;
    }
    try {
      const previous = await fetchPreviousMemoryCard(memoryId, key);
      setPreviousCard(previous.body);
    } catch (caught) {
      if (failureCode(caught) === "MEMORY_CARD_NOT_FOUND") setPreviousCard(null);
      else setError("That card could not be opened.");
    }
  }

  async function onCorrect(event: FormEvent) {
    event.preventDefault();
    if (!memoryId || !selectedKey) return;
    setSavingCard(true);
    setError(null);
    try {
      const updated = await updateMemoryCard(memoryId, selectedKey, cardDraft);
      setPreviousCard(cardBody);
      setCardBody(updated.body);
      setCardDraft(updated.body);
    } catch (caught) {
      setError(failureCode(caught) === "MEMORY_TOO_LARGE" ? "That text is too long." : "That card could not be saved.");
    } finally {
      setSavingCard(false);
    }
  }

  async function onDelete() {
    if (!memoryId || !selectedKey) return;
    const key = selectedKey;
    setSavingCard(true);
    setError(null);
    try {
      await deleteMemoryCard(memoryId, key);
      setKeys((current) => current.filter((item) => item !== key));
      setSelectedKey(null);
      setCardBody(null);
      setPreviousCard(null);
      setCardDraft("");
    } catch {
      setError("That card could not be deleted.");
    } finally {
      setSavingCard(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#101114] text-[#ecedee]" data-testid="memories-page">
      <PageHeader
        title="Memories"
        crumbs={memoryId ? [{ label: "Memories", onClick: () => navigate("#/memories") }] : undefined}
        subtitle={memoryId ? memoryId : "A page a pipeline or an agent can keep reading."}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
        <div className="flex min-h-0 flex-col gap-4 overflow-auto border-r border-[#ffffff14] p-4">
          <form className="flex flex-col gap-2" onSubmit={(event) => void onCreate(event)}>
            <label className="flex flex-col gap-1 text-xs text-[#a7aab2]">
              Id
              <input
                value={id}
                onChange={(event) => setId(event.target.value)}
                className={`h-8 px-2 ${FIELD} ${MONO}`}
                placeholder="candidate-pool"
                data-testid="memory-id"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[#a7aab2]">
              Description
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className={`h-8 px-2 ${FIELD}`}
                placeholder="People this pipeline has already sourced."
                data-testid="memory-description"
              />
            </label>
            <button
              type="submit"
              disabled={creating || id.trim().length === 0 || description.trim().length === 0}
              className="h-8 rounded-lg bg-[#ecedee] text-xs font-medium text-[#101114] disabled:opacity-40"
            >
              Create memory
            </button>
          </form>
          {error ? <p className="text-xs text-[#e8a0a0]">{error}</p> : null}
          <ul className="flex flex-col gap-1" data-testid="memory-list">
            {(memories ?? []).map((item) => (
              <li key={item.id}>
                <a
                  href={`#/memories/${encodeURIComponent(item.id)}`}
                  className={`flex flex-col rounded-lg px-2 py-1.5 hover:bg-[#ffffff0a] ${item.id === memoryId ? "bg-[#ffffff0f]" : ""}`}
                >
                  <span className={`${MONO} text-[13px]`}>{item.id}</span>
                  <span className="text-xs text-[#8b8f98]">{item.description}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-h-0 overflow-auto p-6" data-testid="memory-page">
          {detail ? (
            <>
              <h2 className="text-lg font-medium">{detail.id}</h2>
              <p className="mt-1 text-sm text-[#a7aab2]">{detail.description}</p>
              <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
                <form className="flex flex-col gap-2" onSubmit={(event) => void onSaveCover(event)}>
                  <label className="flex flex-col gap-1 text-xs text-[#a7aab2]">
                    Cover
                    <textarea
                      value={coverDraft}
                      onChange={(event) => setCoverDraft(event.target.value)}
                      className={`min-h-40 p-3 text-sm leading-relaxed ${FIELD} ${MONO}`}
                      data-testid="memory-cover"
                    />
                  </label>
                  <button type="submit" disabled={savingCover} className={`w-fit ${ACTION}`}>
                    Save cover
                  </button>
                </form>
                {previousCover !== null ? (
                  <div data-testid="memory-previous-cover">
                    <p className="text-xs text-[#a7aab2]">Previous cover</p>
                    <pre className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[#8b8f98] ${MONO}`}>{previousCover}</pre>
                  </div>
                ) : null}
              </div>
              <div className="mt-8">
                <p className="text-xs text-[#a7aab2]">Cards</p>
                {keys.length === 0 ? <p className="mt-2 text-sm text-[#8b8f98]">No cards yet.</p> : null}
                <ul className="mt-2 flex flex-col gap-1" data-testid="memory-card-list">
                  {keys.map((key) => (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => void openCard(key)}
                        className={`flex w-full rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-[#ffffff0a] ${key === selectedKey ? "bg-[#ffffff0f]" : ""} ${MONO}`}
                        data-testid="memory-card-key"
                      >
                        {key}
                      </button>
                    </li>
                  ))}
                </ul>
                {selectedKey ? (
                  <div className="mt-4 grid items-start gap-4 lg:grid-cols-2" data-testid="memory-open-card">
                    <div>
                      <p className="text-xs text-[#a7aab2]">Card</p>
                      <pre className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed ${MONO}`} data-testid="memory-card-body">
                        {cardBody ?? ""}
                      </pre>
                      <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => void onCorrect(event)}>
                        <label className="flex flex-col gap-1 text-xs text-[#a7aab2]">
                          Correct
                          <textarea
                            value={cardDraft}
                            onChange={(event) => setCardDraft(event.target.value)}
                            className={`min-h-28 p-3 text-sm leading-relaxed ${FIELD} ${MONO}`}
                            data-testid="memory-card-draft"
                          />
                        </label>
                        <div className="flex gap-2">
                          <button type="submit" disabled={savingCard} className={ACTION}>
                            Save card
                          </button>
                          <button
                            type="button"
                            disabled={savingCard}
                            onClick={() => void onDelete()}
                            className="h-8 rounded-lg border border-[#ffffff1a] px-3 text-xs text-[#ecedee] disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </form>
                    </div>
                    {previousCard !== null ? (
                      <div data-testid="memory-previous-card">
                        <p className="text-xs text-[#a7aab2]">Previous card</p>
                        <pre className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[#8b8f98] ${MONO}`}>{previousCard}</pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-[#8b8f98]">Open a memory to read its page.</p>
          )}
        </div>
      </div>
    </div>
  );
}
