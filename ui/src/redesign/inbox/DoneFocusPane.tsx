import type { RunSummary } from "../../api";
import { runTaskLabel } from "../../catalog/displayCatalogPath";
import { LuInfo } from "react-icons/lu";

export function DoneFocusPane({ run }: { run: RunSummary | null }) {
  if (!run) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[var(--sf-panel)] px-8">
        <p className="text-sm text-[var(--sf-text-3)]">
          Select a run to review, or wait for gate-answer history (coming soon).
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--sf-panel)] px-8 py-7">
      <div className="flex max-w-[640px] flex-col gap-4">
        <h2 className="text-lg font-semibold text-[var(--sf-text-1)]">
          {runTaskLabel(run)}
        </h2>
        <div className="flex items-start gap-2.5 rounded-xl border border-[#ffffff12] bg-[var(--sf-ground)] p-4">
          <LuInfo className="mt-0.5 size-4 shrink-0 text-[var(--sf-text-3)]" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-[var(--sf-text-2)]">
            Done today shows gates you answered today with timelines and undo.
            That needs server-side answer history; for now this list is finished
            runs from the catalog. Open the run for full transcript.
          </p>
        </div>
      </div>
    </div>
  );
}
