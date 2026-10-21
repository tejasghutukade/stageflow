import { useEffect, useState } from "react";
import { fetchMemories, type DraftPackagePayload, type MemorySummary } from "../../api";
import { readPipelineMemories, writePipelineMemories } from "./pipelineMemories";

export function PipelineMemoriesSection({
  draft,
  onDraftChange,
}: {
  draft: DraftPackagePayload;
  onDraftChange: (draft: DraftPackagePayload) => void;
}) {
  const [available, setAvailable] = useState<MemorySummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchMemories().then(
      (body) => { if (live) setAvailable(body.memories); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, []);

  const selected = readPipelineMemories(draft);

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
    onDraftChange(writePipelineMemories(draft, next));
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="pipeline-memories">
      <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[#8b8f98]">Memories</span>
      <p className="text-xs leading-[1.45] text-[#8b8f98]">
        Every stage in this pipeline can read and replace these pages.
      </p>
      {failed ? <p className="text-xs text-[#e8a0a0]">Memories could not be loaded.</p> : null}
      {available && available.length === 0 ? (
        <p className="text-xs text-[#8b8f98]">
          No memories yet.{" "}
          <a href="#/memories" className="text-[#ecedee] underline-offset-2 hover:underline">Create one from Memories</a>.
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {(available ?? []).map((item) => (
          <li key={item.id}>
            <label className="flex items-start gap-2 text-xs text-[#ecedee]">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={() => toggle(item.id)}
              />
              <span>
                <span className="font-['Geist_Mono',monospace]">{item.id}</span>
                <span className="mt-0.5 block text-[#8b8f98]">{item.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
