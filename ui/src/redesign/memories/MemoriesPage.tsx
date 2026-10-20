import { useEffect, useState, type FormEvent } from "react";
import { createMemory, fetchMemories, fetchMemory, type MemoryDetail, type MemorySummary } from "../../api";
import { navigate } from "../../routes";
import { PageHeader } from "../shell/PageHeader";

const MONO = "font-['Geist_Mono',monospace]";

export function MemoriesPage({ memoryId }: { memoryId?: string }) {
  const [memories, setMemories] = useState<MemorySummary[] | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchMemories().then(
      (body) => { if (live) setMemories(body.memories); },
      () => { if (live) setError("Memories could not be loaded."); },
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!memoryId) {
      setDetail(null);
      return;
    }
    let live = true;
    void fetchMemory(memoryId).then(
      (body) => { if (live) setDetail(body); },
      () => { if (live) setError(`Memory "${memoryId}" could not be opened.`); },
    );
    return () => { live = false; };
  }, [memoryId]);

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
                className={`h-8 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2 text-[#ecedee] ${MONO}`}
                placeholder="candidate-pool"
                data-testid="memory-id"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[#a7aab2]">
              Description
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="h-8 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2 text-[#ecedee]"
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
              <pre className={`mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[#ecedee] ${MONO}`}>
                {detail.body.length > 0 ? detail.body : "This page is empty."}
              </pre>
            </>
          ) : (
            <p className="text-sm text-[#8b8f98]">Open a memory to read its page.</p>
          )}
        </div>
      </div>
    </div>
  );
}
